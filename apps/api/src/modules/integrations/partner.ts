import {
  daysBetween,
  MAX_PARTNER_AVAILABILITY_DAYS,
  type PartnerFolio,
  type PartnerProperty,
  type PartnerReservation,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { ApiKeyContext } from '../../core/api-keys.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { getInventory } from '../availability/service.ts';

// The partner API's reads (T-166). Run as the key's property (route.ts), so every query is
// scoped like a staff request; shapes of their own, so the hotel's internal ones can change.

export interface PartnerDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

export async function partnerProperty(
  deps: PartnerDeps,
  key: ApiKeyContext,
): Promise<z.input<typeof PartnerProperty>> {
  const property = await deps.db.property.findUniqueOrThrow({
    where: { id: key.tenant.propertyId },
  });
  const types = await deps.tenantDb.roomType.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, code: true, name: true },
  });
  return {
    id: property.id,
    name: property.name,
    timeZone: property.timeZone,
    currency: property.baseCurrency,
    checkInTime: property.checkInTime,
    checkOutTime: property.checkOutTime,
    roomTypes: types,
    scopes: [...key.scopes] as z.input<typeof PartnerProperty>['scopes'],
  };
}

export async function partnerAvailability(deps: PartnerDeps, query: { from: string; to: string }) {
  const span = daysBetween(query.from, query.to) + 1;
  if (span < 1 || span > MAX_PARTNER_AVAILABILITY_DAYS) {
    throw invalid('query.to', `Ask for 1 to ${MAX_PARTNER_AVAILABILITY_DAYS} nights`);
  }
  const [days, types] = await Promise.all([
    getInventory(deps, query),
    deps.tenantDb.roomType.findMany({ select: { id: true, code: true } }),
  ]);
  const code = new Map(types.map((t) => [t.id, t.code]));
  return {
    days: days.map((d) => ({
      date: d.date,
      roomTypeId: d.roomTypeId,
      roomTypeCode: code.get(d.roomTypeId) ?? '',
      available: d.available,
      capacity: d.capacity,
      sold: d.sold,
    })),
  };
}

const reservationInclude = {
  booker: { select: { firstName: true, lastName: true, email: true, phone: true } },
  company: { select: { name: true } },
  stays: {
    include: {
      roomType: { select: { code: true } },
      ratePlan: { select: { code: true } },
      room: { select: { number: true } },
    },
    orderBy: [{ arrival: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.ReservationInclude;

type ReservationRow = Prisma.ReservationGetPayload<{ include: typeof reservationInclude }>;

function reservationOut(r: ReservationRow, key: ApiKeyContext): z.input<typeof PartnerReservation> {
  const contact = key.scopes.has('guests:read');
  return {
    id: r.id,
    confirmationNo: r.confirmationNo,
    status: r.status,
    source: r.source,
    channelRef: r.channelRef,
    guarantee: r.guarantee,
    booker: {
      firstName: r.booker.firstName,
      lastName: r.booker.lastName,
      email: contact ? r.booker.email : null,
      phone: contact ? r.booker.phone : null,
    },
    companyName: r.company?.name ?? null,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    cancelledAt: r.cancelledAt ? iso(r.cancelledAt) : null,
    stays: r.stays.map((s) => ({
      id: s.id,
      status: s.status,
      arrival: day(s.arrival),
      departure: day(s.departure),
      adults: s.adults,
      children: s.children,
      isDayUse: s.isDayUse,
      roomTypeCode: s.roomType.code,
      ratePlanCode: s.ratePlan.code,
      roomNumber: s.room?.number ?? null,
      checkedInAt: s.checkedInAt ? iso(s.checkedInAt) : null,
      checkedOutAt: s.checkedOutAt ? iso(s.checkedOutAt) : null,
    })),
  };
}

/** `<updatedAt ms>.<id>`, base64url: where the next page starts. */
const encodeCursor = (r: { updatedAt: Date; id: string }) =>
  Buffer.from(`${r.updatedAt.getTime()}.${r.id}`).toString('base64url');

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [ms, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('.');
  const at = new Date(Number(ms));
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(at.getTime())) {
    throw invalid('query.cursor', 'Use the nextCursor of the page before');
  }
  return { at, id };
}

export async function listPartnerReservations(
  deps: PartnerDeps,
  key: ApiKeyContext,
  query: {
    updatedSince?: string | undefined;
    arrivalFrom?: string | undefined;
    arrivalTo?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  const arrival = {
    ...(query.arrivalFrom ? { gte: dbDate(query.arrivalFrom) } : {}),
    ...(query.arrivalTo ? { lte: dbDate(query.arrivalTo) } : {}),
  };
  const rows = await deps.tenantDb.reservation.findMany({
    where: {
      AND: [
        query.updatedSince ? { updatedAt: { gte: new Date(query.updatedSince) } } : {},
        after
          ? {
              OR: [{ updatedAt: { gt: after.at } }, { updatedAt: after.at, id: { gt: after.id } }],
            }
          : {},
        Object.keys(arrival).length > 0 ? { stays: { some: { arrival } } } : {},
      ],
    },
    include: reservationInclude,
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map((r) => reservationOut(r, key)),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
  };
}

export async function getPartnerReservation(deps: PartnerDeps, key: ApiKeyContext, id: string) {
  const r = await deps.tenantDb.reservation.findFirst({
    where: { id },
    include: reservationInclude,
  });
  if (!r) throw new AppError('NOT_FOUND', 'Reservation not found.');
  return reservationOut(r, key);
}

export async function listPartnerReservationFolios(deps: PartnerDeps, reservationId: string) {
  const reservation = await deps.tenantDb.reservation.findFirst({
    where: { id: reservationId },
    select: { id: true },
  });
  if (!reservation) throw new AppError('NOT_FOUND', 'Reservation not found.');
  const folios = await deps.tenantDb.folio.findMany({
    where: { reservationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const ids = folios.map((f) => f.id);
  const [charges, payments] = await Promise.all([
    deps.tenantDb.folioLine.groupBy({
      by: ['folioId'],
      where: { folioId: { in: ids } },
      _sum: { amountMinor: true },
    }),
    deps.tenantDb.payment.groupBy({
      by: ['folioId'],
      where: { folioId: { in: ids } },
      _sum: { baseAmountMinor: true },
    }),
  ]);
  const charged = new Map(charges.map((c) => [c.folioId, c._sum.amountMinor ?? 0n]));
  const paid = new Map(payments.map((p) => [p.folioId, p._sum.baseAmountMinor ?? 0n]));
  const data: z.input<typeof PartnerFolio>[] = folios.map((f) => {
    const c = charged.get(f.id) ?? 0n;
    const p = paid.get(f.id) ?? 0n;
    return {
      id: f.id,
      number: f.number,
      status: f.status,
      currency: f.currency,
      chargesMinor: c.toString(),
      paymentsMinor: p.toString(),
      balanceMinor: (c - p).toString(),
    };
  });
  return { data };
}
