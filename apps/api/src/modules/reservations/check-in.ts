import {
  canTransition,
  ID_FIELDS,
  maskIdNumber,
  type CheckInBody,
  type CheckInResult,
  type KeyIssueItem,
  type RegistrationCardItem,
  type RegistrationField,
} from '@hotel/shared';
import type { z } from 'zod';
import { recordAudit } from '../../core/audit.ts';
import type { FileStore } from '../../core/files.ts';
import { defineJob } from '../../core/jobs.ts';
import { decryptSecret, encryptSecret } from '../../core/mfa.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { businessDate } from '../../core/business-day.ts';
import { registrationOf } from '../setup/service.ts';
import { openFolio } from '../folios/service.ts';
import { assign, loadStay, problemsOf } from './rooms.ts';
import type { ReservationDeps } from './service.ts';

// Check-in (PRD M3-08, M3-19, M3 rules 2 and 6; tab 4 POST /stays/{id}/check-in; T-051).
// The guest gets their room (it must be ready unless a manager approved giving it anyway),
// the desk collects the registration fields the property requires — nothing else is kept —
// and the card is signed on screen or on paper. ID details go to `id_documents`, the number
// encrypted, and are deleted after the property's retention period. Key cards are logged.
// The guest's folio opens with the check-in (T-060).

export interface CheckInDeps extends ReservationDeps {
  /** AES-256-GCM key for ID numbers (config.idKey). */
  idKey: Buffer;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Body = z.output<typeof CheckInBody>;
type CardData = {
  guest: { firstName: string; lastName: string; phone: string | null; email: string | null };
  roomNumber: string;
  roomTypeName: string;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  nationality?: string;
  address?: string;
  purpose?: string;
  signature: 'SCREEN' | 'PAPER';
};

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const invalid = (issues: { path: string; message: string }[]) =>
  new AppError('VALIDATION_ERROR', issues[0]?.message ?? 'Check the registration details', {
    issues: issues.map((i) => ({ ...i, code: 'custom' })),
  });

const FIELD_LABEL: Record<RegistrationField, string> = {
  nationality: 'nationality',
  address: 'address',
  purpose: 'purpose of stay',
  idType: 'ID type',
  idNumber: 'ID number',
  idExpiry: 'ID expiry date',
};

/** A date `months` calendar months after `date` (end of month when shorter). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return day(first);
}

/** An uploaded file of `entityType` for this property, not blocked by the scan. */
async function usableFile(tx: Tx, fileId: string, entityType: string, path: string) {
  const file = await tx.fileObject.findFirst({
    where: { id: fileId, entityType, scan: { not: 'INFECTED' } },
  });
  if (!file) {
    throw invalid([{ path, message: 'The file is missing, of another kind, or was blocked' }]);
  }
  return file;
}

export async function checkIn(
  deps: CheckInDeps,
  tenant: TenantContext,
  stayId: string,
  ifMatch: string,
  body: Body,
): Promise<z.input<typeof CheckInResult>> {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    let stay = await loadStay(tx, stayId);
    if (Number(/^"?(\d+)"?$/.exec(ifMatch.trim())?.[1] ?? -1) !== stay.version) {
      throw new AppError('VERSION_CONFLICT', 'Someone changed this stay; reload and try again', {
        version: stay.version,
      });
    }
    if (!canTransition(stay.status, 'CHECKED_IN')) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        stay.status === 'TENTATIVE'
          ? 'Confirm the booking before checking the guest in'
          : `A ${stay.status.toLowerCase().replace('_', '-')} stay cannot be checked in`,
        { from: stay.status, to: 'CHECKED_IN' },
      );
    }
    // M3 rule 2: on the arrival date (late arrivals too, until night audit marks no-shows).
    const today = await businessDate(tx, stay.propertyId, () => now);
    if (day(stay.arrival) > today) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `The guest arrives on ${day(stay.arrival)}; check-in opens that day`,
        { arrival: day(stay.arrival), today },
      );
    }
    // A day-use stay (M3-10): on its date, until its time is up.
    const ended = stay.isDayUse
      ? day(stay.arrival) < today || (stay.dayUseEnd ?? now) <= now
      : day(stay.departure) <= today;
    if (ended) {
      throw new AppError('STATE_TRANSITION_INVALID', 'This stay has already ended', {
        departure: day(stay.departure),
      });
    }

    // The room: given now (readiness checked there) or the one assigned before.
    const ctx = { tx, tenant, approvalRequestId: null, now };
    if (body.roomId && body.roomId !== stay.roomId) {
      await assign(ctx, stay.id, body.roomId, null);
      stay = await loadStay(tx, stay.id);
    }
    if (!stay.roomId) {
      throw invalid([{ path: 'body.roomId', message: 'Choose a room for the guest' }]);
    }
    const room = await tx.room.findUniqueOrThrow({ where: { id: stay.roomId } });
    const allocation = await tx.roomAllocation.findFirst({
      where: { stayId: stay.id, roomId: room.id, active: true },
    });
    // A room given with a manager's approved override keeps that approval (M3 rule 2).
    if (!allocation?.reason) {
      const problems = await problemsOf(tx, room, stay.id);
      if (problems.length > 0) {
        throw new AppError('ROOM_NOT_READY', `Room ${room.number} is not ready for a guest yet`, {
          roomId: room.id,
          hkStatus: room.hkStatus,
          problems,
        });
      }
    }

    // Registration: every required field, and only those are kept (M3 rule 6).
    const property = await tx.property.findUniqueOrThrow({ where: { id: stay.propertyId } });
    const settings = registrationOf(property);
    const required = new Set<RegistrationField>(settings.requiredFields);
    const reg = body.registration;
    const missing = settings.requiredFields.filter((f) => reg[f] === undefined);
    if (missing.length > 0) {
      throw invalid(
        missing.map((f) => ({
          path: `body.registration.${f}`,
          message: `Enter the guest’s ${FIELD_LABEL[f]}`,
        })),
      );
    }
    if (required.has('idExpiry') && reg.idExpiry && reg.idExpiry < today) {
      throw invalid([{ path: 'body.registration.idExpiry', message: 'This ID has expired' }]);
    }

    const guest = await tx.guest.findUniqueOrThrow({ where: { id: stay.guestId } });
    const collectsId = ID_FIELDS.some((f) => required.has(f));
    let idDocumentId: string | null = null;
    if (collectsId) {
      const scan = reg.idFileId
        ? await usableFile(tx, reg.idFileId, 'IdDocument', 'body.registration.idFileId')
        : null;
      const doc = await tx.idDocument.create({
        data: {
          propertyId: stay.propertyId,
          guestId: guest.id,
          docType: required.has('idType') ? (reg.idType ?? null) : null,
          numberEnc:
            required.has('idNumber') && reg.idNumber
              ? encryptSecret(deps.idKey, reg.idNumber)
              : null,
          expiry: required.has('idExpiry') && reg.idExpiry ? dbDate(reg.idExpiry) : null,
          fileId: scan?.id ?? null,
          purgeAfter: dbDate(addMonths(today, settings.idRetentionMonths)),
        },
      });
      if (scan) {
        await tx.fileObject.update({ where: { id: scan.id }, data: { entityId: doc.id } });
      }
      idDocumentId = doc.id;
    }
    if (required.has('nationality') && reg.nationality && guest.nationality !== reg.nationality) {
      await tx.guest.update({ where: { id: guest.id }, data: { nationality: reg.nationality } });
    }

    const signature = body.signatureFileId
      ? await usableFile(tx, body.signatureFileId, 'RegistrationCard', 'body.signatureFileId')
      : null;
    const roomType = await tx.roomType.findUniqueOrThrow({ where: { id: stay.roomTypeId } });
    const data: CardData = {
      guest: {
        firstName: guest.firstName,
        lastName: guest.lastName,
        phone: guest.phone,
        email: guest.email,
      },
      roomNumber: room.number,
      roomTypeName: roomType.name,
      arrival: day(stay.arrival),
      departure: day(stay.departure),
      adults: stay.adults,
      children: stay.children,
      ...(required.has('nationality') && reg.nationality ? { nationality: reg.nationality } : {}),
      ...(required.has('address') && reg.address ? { address: reg.address } : {}),
      ...(required.has('purpose') && reg.purpose ? { purpose: reg.purpose } : {}),
      signature: signature ? 'SCREEN' : 'PAPER',
    };
    const card = await tx.registrationCard.create({
      data: {
        propertyId: stay.propertyId,
        stayId: stay.id,
        idDocumentId,
        data: data,
        fileId: signature?.id ?? null,
        signedAt: now,
        signedById: tenant.userId,
      },
    });
    if (signature) {
      await tx.fileObject.update({ where: { id: signature.id }, data: { entityId: card.id } });
    }

    // The stay and, with its first guest in, the reservation.
    const claimed = await tx.stay.updateMany({
      where: { id: stay.id, version: stay.version },
      data: { status: 'CHECKED_IN', checkedInAt: now, version: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      throw new AppError('VERSION_CONFLICT', 'Someone changed this stay; reload and try again');
    }
    // The guest's folio (M4; T-060).
    const folioId = await openFolio(tx, stay);
    const reservation = await tx.reservation.findUniqueOrThrow({
      where: { id: stay.reservationId },
    });
    // History rows have no property column: they go in through the reservation.
    await tx.reservation.update({
      where: { id: reservation.id },
      data: {
        ...(reservation.status === 'CONFIRMED' ? { status: 'CHECKED_IN' as const } : {}),
        version: { increment: 1 },
        history: {
          create: {
            stayId: stay.id,
            fromStatus: stay.status,
            toStatus: 'CHECKED_IN',
            byUserId: tenant.userId,
            at: now,
          },
        },
      },
    });
    if (body.keysIssued > 0) {
      await tx.keyIssue.create({
        data: {
          propertyId: stay.propertyId,
          stayId: stay.id,
          roomId: room.id,
          count: body.keysIssued,
          issuedById: tenant.userId,
          issuedAt: now,
        },
      });
    }
    // The audit names what was collected, never the values (ID data stays encrypted).
    await recordAudit(tx, {
      action: 'stay.checked_in',
      entityType: 'stay',
      entityId: stay.id,
      before: { status: stay.status },
      after: {
        status: 'CHECKED_IN',
        roomId: room.id,
        collected: settings.requiredFields,
        signature: data.signature,
        keysIssued: body.keysIssued,
      },
    });
    await recordEvent(tx, {
      type: 'stay.checked_in',
      payload: { stayId: stay.id, reservationId: reservation.id, roomId: room.id },
    });
    return {
      stayId: stay.id,
      status: 'CHECKED_IN',
      folioId,
      roomId: room.id,
      version: stay.version + 1,
    };
  });
}

// ── Registration card (M3-08) ───────────────────────────────────────────────────────────

const ADDRESS_KEYS = ['line1', 'line2', 'city', 'state'] as const;

export async function getRegistrationCard(
  deps: CheckInDeps,
  stayId: string,
): Promise<z.input<typeof RegistrationCardItem>> {
  const card = await deps.tenantDb.registrationCard.findUnique({
    where: { stayId },
    include: {
      idDocument: true,
      stay: { include: { reservation: true, property: true } },
      signedBy: { select: { name: true } },
    },
  });
  if (!card) throw new AppError('NOT_FOUND', 'This stay has no registration card yet');
  const data = card.data as unknown as CardData;
  const doc = card.idDocument;
  const address = (card.stay.property.address ?? {}) as Record<string, unknown>;
  return {
    stayId: card.stayId,
    confirmationNo: card.stay.reservation.confirmationNo,
    property: {
      name: card.stay.property.name,
      address: ADDRESS_KEYS.map((k) => address[k])
        .filter((v): v is string => typeof v === 'string' && v !== '')
        .join(', '),
    },
    guest: data.guest,
    roomNumber: data.roomNumber,
    roomTypeName: data.roomTypeName,
    arrival: data.arrival,
    departure: data.departure,
    adults: data.adults,
    children: data.children,
    nationality: data.nationality ?? null,
    address: data.address ?? null,
    purpose: (data.purpose ?? null) as z.input<typeof RegistrationCardItem>['purpose'],
    idType: (doc?.docType ?? null) as z.input<typeof RegistrationCardItem>['idType'],
    idNumberMasked: doc?.numberEnc ? maskIdNumber(decryptSecret(deps.idKey, doc.numberEnc)) : null,
    idExpiry: doc?.expiry ? day(doc.expiry) : null,
    signature: data.signature,
    signatureFileId: card.fileId,
    checkedInAt: iso(card.signedAt),
    checkedInBy: card.signedBy?.name ?? null,
  };
}

// ── Keys (M3-19) ────────────────────────────────────────────────────────────────────────

type KeyOut = z.input<typeof KeyIssueItem>;

const keyItem = (k: {
  id: string;
  count: number;
  issuedAt: Date;
  room: { number: string };
  issuedBy: { name: string | null };
}): KeyOut => ({
  id: k.id,
  roomNumber: k.room.number,
  count: k.count,
  issuedBy: k.issuedBy.name,
  issuedAt: iso(k.issuedAt),
});

export async function listKeys(deps: CheckInDeps, stayId: string) {
  await loadStay(deps.tenantDb, stayId);
  const keys = await deps.tenantDb.keyIssue.findMany({
    where: { stayId },
    include: { room: true, issuedBy: { select: { name: true } } },
    orderBy: { issuedAt: 'desc' },
  });
  return { data: keys.map(keyItem) };
}

export async function issueKeys(
  deps: CheckInDeps,
  tenant: TenantContext,
  stayId: string,
  count: number,
): Promise<KeyOut> {
  return deps.tenantDb.$transaction(async (tx) => {
    const stay = await loadStay(tx, stayId);
    if (stay.status !== 'CHECKED_IN' || !stay.roomId) {
      throw new AppError('STATE_TRANSITION_INVALID', 'Keys are issued to checked-in guests', {
        status: stay.status,
      });
    }
    const key = await tx.keyIssue.create({
      data: {
        propertyId: stay.propertyId,
        stayId: stay.id,
        roomId: stay.roomId,
        count,
        issuedById: tenant.userId,
        issuedAt: deps.clock(),
      },
      include: { room: true, issuedBy: { select: { name: true } } },
    });
    await recordAudit(tx, {
      action: 'stay.keys_issued',
      entityType: 'stay',
      entityId: stay.id,
      after: { roomId: stay.roomId, count },
    });
    return keyItem(key);
  });
}

// ── Purge (M3 rule 6) ───────────────────────────────────────────────────────────────────

/**
 * Deletes ID details whose retention has passed, with their scans. The registration card
 * keeps the rest of what the guest confirmed.
 */
export function idPurgeJob(deps: { store: FileStore }) {
  return defineJob({
    name: 'id-document-purge',
    // 02:30 UTC daily, after midnight everywhere we sell.
    schedule: { cron: '30 2 * * *' },
    async run(_data, { db, clock, logger }) {
      const today = day(clock());
      const due = await db.idDocument.findMany({
        where: { purgeAfter: { lte: dbDate(today) } },
        include: { file: true },
        take: 500,
      });
      for (const doc of due) {
        await db.$transaction(async (tx) => {
          await tx.idDocument.delete({ where: { id: doc.id } });
          if (doc.file) await tx.fileObject.delete({ where: { id: doc.file.id } });
        });
        if (doc.file) await deps.store.delete(doc.file.storageKey);
      }
      logger.info({ purged: due.length }, 'ID documents purged');
    },
  });
}
