import {
  fileKind,
  ID_FIELDS,
  ID_TYPES,
  maskIdNumber,
  packFor,
  PaymentIntentBody,
  type FileContentType,
  type OnlineCheckInBody,
  type OnlineCheckInInfo,
  type OnlineCheckInForDesk,
  type RegistrationField,
} from '@hotel/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import { AppError } from '../../core/errors.ts';
import { fileStorageKey, incomingKey } from '../../core/files.ts';
import { decryptSecret, encryptSecret } from '../../core/mfa.ts';
import { runAsTenant, type TenantContext } from '../../core/tenancy.ts';
import { hashToken } from '../../core/tokens.ts';
import { createPaymentIntent } from '../payments/intents.ts';
import { registrationOf } from '../setup/service.ts';
import { guestTenant } from './after-payment.ts';
import { linkToken, type BookingEngineDeps } from './service.ts';

// Online check-in before arrival (PRD M3-20, M11-06; T-114), on the guest's secure link. The
// guest gives the details the hotel requires and may pay the balance; the desk finishes the
// check-in on arrival, so a room and a key are still given in person. Only the fields the hotel
// requires are kept, the ID number encrypted. The details leave this table at check-in, or a
// week after the stay ends if the guest never arrives.

const FILE_LIMIT = 5;
const KEEP_DAYS_AFTER_DEPARTURE = 7;

const day = (d: Date) => d.toISOString().slice(0, 10);
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const invalid = (issues: { path: string; message: string }[]) =>
  new AppError('VALIDATION_ERROR', 'Request validation failed.', {
    issues: issues.map((i) => ({ ...i, code: 'custom' })),
  });

const FIELD_LABEL: Record<RegistrationField, string> = {
  nationality: 'your nationality',
  address: 'your address',
  purpose: 'the purpose of your stay',
  idType: 'your ID type',
  idNumber: 'your ID number',
  idExpiry: 'your ID expiry date',
};

interface StoredDetails {
  nationality?: string;
  address?: string;
  purpose?: string;
  idType?: string;
  idExpiry?: string;
}

async function context(deps: BookingEngineDeps, token: string) {
  const link = await deps.db.guestLink.findUnique({
    where: { tokenHash: hashToken(deps.config.sessionSecret, token) },
  });
  if (!link) throw new AppError('NOT_FOUND', 'This link is not valid');
  const reservation = await deps.db.reservation.findUniqueOrThrow({
    where: { id: link.reservationId },
    include: {
      property: { include: { organisation: true } },
      booker: true,
      stays: { include: { quote: true } },
      depositEntries: true,
    },
  });
  const [stay] = reservation.stays;
  if (!stay) throw new AppError('NOT_FOUND', 'This link is not valid');
  const today = await businessDate(deps.db, reservation.propertyId, deps.clock);
  const total = reservation.stays.reduce((s, x) => s + x.quote.totalMinor, 0n);
  const paid = reservation.depositEntries.reduce((s, e) => s + e.amountMinor, 0n);
  return { link, reservation, stay, today, dueMinor: total > paid ? total - paid : 0n };
}
type Context = Awaited<ReturnType<typeof context>>;

function closedReason({ reservation, stay, today }: Context) {
  if (reservation.status === 'TENTATIVE') return 'PAY_FIRST' as const;
  if (reservation.status !== 'CONFIRMED') return 'NOT_ACTIVE' as const;
  if (day(stay.arrival) < today) return 'ARRIVAL_PASSED' as const;
  return null;
}

export async function getCheckInInfo(
  deps: BookingEngineDeps,
  token: string,
): Promise<z.input<typeof OnlineCheckInInfo>> {
  const ctx = await context(deps, token);
  const { reservation, stay } = ctx;
  const row = await deps.db.onlineCheckIn.findUnique({ where: { stayId: stay.id } });
  const pack = packFor(reservation.property.organisation);
  return {
    closedReason: closedReason(ctx),
    requiredFields: registrationOf(reservation.property).requiredFields,
    idTypes: [...(pack?.idTypes ?? ID_TYPES)],
    dataProtectionNotice: pack?.dataProtectionNotice ?? null,
    submittedAt: row ? iso(row.submittedAt) : null,
    dueMinor: ctx.dueMinor.toString(),
    currency: stay.quote.currency,
  };
}

/** An upload link for the guest's ID, held against their link until they submit. */
export async function createIdUpload(
  deps: BookingEngineDeps,
  token: string,
  input: { contentType: FileContentType; sizeBytes: number },
) {
  const ctx = await context(deps, token);
  const closed = closedReason(ctx);
  if (closed) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Online check-in is closed for this booking', {
      reason: closed,
    });
  }
  const kind = fileKind('IdDocument');
  if (!kind) throw new Error('The IdDocument file kind is missing');
  if (!kind.contentTypes.includes(input.contentType)) {
    throw invalid([{ path: 'body.contentType', message: 'Use a photo or a PDF' }]);
  }
  if (input.sizeBytes > kind.maxBytes) {
    throw invalid([{ path: 'body.sizeBytes', message: 'The file is larger than 5 MB' }]);
  }
  const entityId = `guest-link:${ctx.link.id}`;
  if ((await deps.db.fileObject.count({ where: { entityId } })) >= FILE_LIMIT) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Too many files for this booking', {
      reason: 'TOO_MANY_FILES',
    });
  }
  const id = randomUUID();
  const { organisationId, propertyId } = ctx.reservation;
  const storageKey = fileStorageKey(organisationId, propertyId, id);
  await deps.db.fileObject.create({
    data: {
      id,
      organisationId,
      propertyId,
      storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      entityType: kind.entityType,
      entityId,
      retentionClass: kind.retentionClass,
      createdAt: deps.clock(),
    },
  });
  const link = await deps.store.presignUpload({
    key: incomingKey(storageKey),
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    expiresInSeconds: 900,
  });
  return {
    fileId: id,
    method: 'PUT' as const,
    url: link.url,
    headers: link.headers,
    expiresAt: link.expiresAt.toISOString(),
  };
}

export async function submitCheckIn(
  deps: BookingEngineDeps,
  token: string,
  body: z.output<typeof OnlineCheckInBody>,
): Promise<z.input<typeof OnlineCheckInInfo>> {
  const ctx = await context(deps, token);
  const { reservation, stay, link } = ctx;
  const closed = closedReason(ctx);
  if (closed) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Online check-in is closed for this booking', {
      reason: closed,
    });
  }
  const settings = registrationOf(reservation.property);
  const required = new Set<RegistrationField>(settings.requiredFields);
  const missing = settings.requiredFields.filter((f) => body[f] === undefined);
  if (missing.length > 0) {
    throw invalid(missing.map((f) => ({ path: `body.${f}`, message: `Enter ${FIELD_LABEL[f]}` })));
  }
  if (required.has('idExpiry') && body.idExpiry && body.idExpiry < day(stay.arrival)) {
    throw invalid([{ path: 'body.idExpiry', message: 'This ID expires before you arrive' }]);
  }
  const pack = packFor(reservation.property.organisation);
  if (required.has('idType') && body.idType && pack && !pack.idTypes.includes(body.idType)) {
    throw invalid([{ path: 'body.idType', message: 'This hotel can’t accept that ID' }]);
  }
  const collectsId = ID_FIELDS.some((f) => required.has(f));
  if (body.idFileId) {
    const file = await deps.db.fileObject.count({
      where: { id: body.idFileId, entityId: `guest-link:${link.id}`, scan: { not: 'INFECTED' } },
    });
    if (file === 0) {
      throw invalid([{ path: 'body.idFileId', message: 'Upload the ID again' }]);
    }
  }

  const details: StoredDetails = {
    ...(required.has('nationality') && body.nationality ? { nationality: body.nationality } : {}),
    ...(required.has('address') && body.address ? { address: body.address } : {}),
    ...(required.has('purpose') && body.purpose ? { purpose: body.purpose } : {}),
    ...(required.has('idType') && body.idType ? { idType: body.idType } : {}),
    ...(required.has('idExpiry') && body.idExpiry ? { idExpiry: body.idExpiry } : {}),
  };
  const now = deps.clock();
  const purgeAfter = new Date(stay.departure.getTime() + KEEP_DAYS_AFTER_DEPARTURE * 86_400_000);
  const data = {
    details: details as Prisma.InputJsonValue,
    idNumberEnc:
      required.has('idNumber') && body.idNumber
        ? encryptSecret(deps.config.idKey, body.idNumber)
        : null,
    idFileId: collectsId ? (body.idFileId ?? null) : null,
    arrivalTime: body.arrivalTime ?? null,
    submittedAt: now,
    purgeAfter,
  };
  await deps.db.$transaction(async (tx) => {
    await tx.onlineCheckIn.upsert({
      where: { stayId: stay.id },
      create: {
        stayId: stay.id,
        organisationId: reservation.organisationId,
        propertyId: reservation.propertyId,
        ...data,
      },
      update: data,
    });
    // Never the details themselves: only that they arrived.
    await recordAudit(tx, {
      organisationId: reservation.organisationId,
      propertyId: reservation.propertyId,
      actorType: 'SYSTEM',
      actorUserId: null,
      action: 'stay.online_check_in',
      entityType: 'stay',
      entityId: stay.id,
      after: { fields: Object.keys(details), idNumber: data.idNumberEnc !== null },
    });
  });
  return getCheckInInfo(deps, token);
}

/** A link to pay what is left, reusing one still open for the same amount. */
export async function payBalance(deps: BookingEngineDeps, token: string, returnUrl?: string) {
  const ctx = await context(deps, token);
  const { reservation, dueMinor } = ctx;
  if (reservation.status !== 'CONFIRMED') {
    throw new AppError('STATE_TRANSITION_INVALID', 'This booking can’t take a payment here', {
      status: reservation.status,
    });
  }
  if (dueMinor <= 0n) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Nothing is left to pay', {
      reason: 'NOTHING_DUE',
    });
  }
  if (!reservation.booker.email) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Please pay at the hotel', {
      reason: 'NO_EMAIL',
    });
  }
  if (returnUrl && new URL(returnUrl).origin !== deps.config.siteOrigin) {
    throw invalid([{ path: 'body.returnUrl', message: 'Return to the booking page' }]);
  }
  const open = await deps.db.paymentIntent.findFirst({
    where: {
      reservationId: reservation.id,
      status: 'CREATED',
      amountMinor: dueMinor,
      expiresAt: { gt: deps.clock() },
    },
  });
  if (open) return { paymentUrl: open.checkoutUrl, amountMinor: dueMinor.toString() };
  const tenant = guestTenant(reservation.property);
  const intent = await runAsTenant(tenant, () =>
    createPaymentIntent(
      deps,
      tenant,
      PaymentIntentBody.parse({
        reservationId: reservation.id,
        amountMinor: dueMinor.toString(),
        email: reservation.booker.email,
      }),
      { callbackUrl: returnUrl ?? null },
    ),
  );
  return {
    paymentUrl: intent.checkoutUrl,
    amountMinor: dueMinor.toString(),
  };
}

// ── The desk ────────────────────────────────────────────────────────────────────────────

export async function onlineCheckInForDesk(
  deps: BookingEngineDeps,
  stayId: string,
): Promise<z.input<typeof OnlineCheckInForDesk>> {
  const stay = await deps.tenantDb.stay.findFirst({ where: { id: stayId }, select: { id: true } });
  if (!stay) throw new AppError('NOT_FOUND', 'Stay not found');
  const row = await deps.tenantDb.onlineCheckIn.findFirst({ where: { stayId } });
  if (!row) return { submitted: null };
  const d = row.details as StoredDetails;
  return {
    submitted: {
      nationality: d.nationality ?? null,
      address: d.address ?? null,
      purpose: (d.purpose ?? null) as never,
      idType: (d.idType ?? null) as never,
      idExpiry: d.idExpiry ?? null,
      idNumberMasked: row.idNumberEnc
        ? maskIdNumber(decryptSecret(deps.config.idKey, row.idNumberEnc))
        : null,
      idFileId: row.idFileId,
      arrivalTime: row.arrivalTime,
      submittedAt: iso(row.submittedAt),
    },
  };
}

/** A private link for a booking made at the desk (M3-20), emailed to the guest. */
export async function sendGuestLink(
  deps: BookingEngineDeps,
  tenant: TenantContext,
  reservationId: string,
) {
  const reservation = await deps.tenantDb.reservation.findFirst({
    where: { id: reservationId },
    include: { booker: true },
  });
  if (!reservation) throw new AppError('NOT_FOUND', 'Reservation not found');
  const page = await deps.tenantDb.bookingEngineSettings.findFirst({});
  if (!page) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Set up the booking page first', {
      reason: 'NO_BOOKING_PAGE',
    });
  }
  if (reservation.status !== 'CONFIRMED') {
    throw new AppError('STATE_TRANSITION_INVALID', 'Only a confirmed booking can check in online', {
      status: reservation.status,
    });
  }
  if (!reservation.booker.email) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This guest has no email address', {
      reason: 'NO_EMAIL',
    });
  }
  let link = await deps.tenantDb.guestLink.findFirst({ where: { reservationId } });
  if (!link) {
    const id = randomUUID();
    link = await deps.tenantDb.guestLink.create({
      data: {
        id,
        reservationId,
        tokenHash: hashToken(deps.config.sessionSecret, linkToken(deps, id)),
        createdAt: deps.clock(),
      } as Prisma.GuestLinkUncheckedCreateInput,
    });
  }
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
  });
  await deps.email.send({
    to: reservation.booker.email,
    tag: 'online-check-in',
    subject: `Check in online for ${property.name}: ${reservation.confirmationNo}`,
    text: [
      `Save time on arrival at ${property.name} by giving your details now.`,
      '',
      `${deps.config.siteOrigin}/${page.slug}/manage?token=${linkToken(deps, link.id)}`,
      '',
      'Keep this link to yourself: anyone who has it can manage the booking.',
    ].join('\n'),
  });
  await recordAudit(deps.tenantDb, {
    action: 'reservation.guest_link_sent',
    entityType: 'reservation',
    entityId: reservationId,
  });
  return { sentTo: reservation.booker.email };
}
