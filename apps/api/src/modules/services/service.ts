import {
  addDays,
  localDate,
  zonedInstant,
  type ServiceBody,
  type ServiceBookingBody,
  type ServiceBookingItem,
  type ServiceItem,
  type ServiceSlotsView,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, raisedBy, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { postChargeLines, routedWindow } from '../folios/service.ts';

// Other services (PRD M9-09; strategy 11.1 "the same availability and charge-to-folio rules";
// T-122). A service has opening hours and a booking window; its capacity is how many people,
// cars or items it takes at once. A booking is checked against all three and against what is
// already booked, with the service's row locked so two desks cannot both take the last place.
// A charge-to-bill service posts to the guest's folio when it is delivered.

export interface ServiceDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type TenantTx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Item = z.input<typeof ServiceItem>;
type Booking = z.input<typeof ServiceBookingItem>;

const MINUTE = 60_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });
const stateError = (message: string, details?: Record<string, unknown>) =>
  new AppError('STATE_TRANSITION_INVALID', message, details);

/** "HH:MM" of an instant in the hotel's time zone. */
function clockOf(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(at);
}

type ServiceRow = Prisma.ServiceGetPayload<{ include: { revenueCode: true } }>;

function itemOf(s: ServiceRow): Item {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    category: s.category as Item['category'],
    description: s.description,
    priceMinor: s.priceMinor.toString(),
    pricing: s.pricing as Item['pricing'],
    durationMinutes: s.durationMinutes,
    capacity: s.capacity,
    opensAt: s.opensAt,
    closesAt: s.closesAt,
    minNoticeMinutes: s.minNoticeMinutes,
    maxAdvanceDays: s.maxAdvanceDays,
    chargeToFolio: s.chargeToFolio,
    revenueCode: s.revenueCode.code,
    active: s.active,
  };
}

const BOOKING_INCLUDE = {
  service: { select: { id: true, name: true, category: true } },
  stay: { select: { id: true, room: { select: { number: true } } } },
} satisfies Prisma.ServiceBookingInclude;
type BookingRow = Prisma.ServiceBookingGetPayload<{ include: typeof BOOKING_INCLUDE }>;

function bookingOf(b: BookingRow): Booking {
  return {
    id: b.id,
    service: {
      id: b.service.id,
      name: b.service.name,
      category: b.service.category as Booking['service']['category'],
    },
    status: b.status as Booking['status'],
    startsAt: iso(b.startsAt),
    endsAt: iso(b.endsAt),
    quantity: b.quantity,
    guestName: b.guestName,
    stay: b.stay ? { id: b.stay.id, roomNumber: b.stay.room?.number ?? null } : null,
    amountMinor: b.amountMinor.toString(),
    charged: b.folioLineId !== null,
    notes: b.notes,
  };
}

// ── Setup (M9-09) ───────────────────────────────────────────────────────────────────────

export async function listServices(deps: ServiceDeps) {
  const rows = await deps.tenantDb.service.findMany({
    include: { revenueCode: true },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  });
  return { data: rows.map(itemOf) };
}

async function fieldsOf(tx: TenantTx, body: z.output<typeof ServiceBody>) {
  const code = await tx.revenueCode.findFirst({ where: { code: body.revenueCode, active: true } });
  if (!code) throw invalid('revenueCode', 'Choose an active revenue code of this property');
  return {
    code: body.code,
    name: body.name,
    category: body.category,
    description: body.description,
    priceMinor: BigInt(body.priceMinor),
    pricing: body.pricing,
    durationMinutes: body.durationMinutes,
    capacity: body.capacity,
    opensAt: body.opensAt,
    closesAt: body.closesAt,
    minNoticeMinutes: body.minNoticeMinutes,
    maxAdvanceDays: body.maxAdvanceDays,
    chargeToFolio: body.chargeToFolio,
    revenueCodeId: code.id,
    active: body.active,
  };
}

const codeTaken = (err: unknown, code: string) =>
  pgErrorInfo(err)?.sqlState === '23505' &&
  pgErrorInfo(err)?.constraint === 'services_property_id_code_key'
    ? invalid('code', `Another service already has the code ${code}`)
    : err;

export async function createService(deps: ServiceDeps, body: z.output<typeof ServiceBody>) {
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const row = await tx.service.create({
        data: (await fieldsOf(tx, body)) as unknown as Prisma.ServiceUncheckedCreateInput,
        include: { revenueCode: true },
      });
      await recordAudit(tx, {
        action: 'service.created',
        entityType: 'service',
        entityId: row.id,
        after: itemOf(row),
      });
      return itemOf(row);
    });
  } catch (err) {
    throw codeTaken(err, body.code);
  }
}

export async function updateService(
  deps: ServiceDeps,
  serviceId: string,
  body: z.output<typeof ServiceBody>,
) {
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const before = await tx.service.findFirst({
        where: { id: serviceId },
        include: { revenueCode: true },
      });
      if (!before) throw new AppError('NOT_FOUND', 'Service not found');
      const row = await tx.service.update({
        where: { id: serviceId },
        data: await fieldsOf(tx, body),
        include: { revenueCode: true },
      });
      await recordAudit(tx, {
        action: 'service.updated',
        entityType: 'service',
        entityId: serviceId,
        before: itemOf(before),
        after: itemOf(row),
      });
      return itemOf(row);
    });
  } catch (err) {
    throw codeTaken(err, body.code);
  }
}

// ── Availability ────────────────────────────────────────────────────────────────────────

/** Places taken at a service between two instants, by bookings still standing. */
async function taken(db: TenantDb | TenantTx, serviceId: string, from: Date, until: Date) {
  const sum = await db.serviceBooking.aggregate({
    where: {
      serviceId,
      status: { in: ['BOOKED', 'COMPLETED'] },
      startsAt: { lt: until },
      endsAt: { gt: from },
    },
    _sum: { quantity: true },
  });
  return sum._sum.quantity ?? 0;
}

/** Why a booking at these times is outside the service's hours or window, or null. */
function outsideWindow(
  s: { opensAt: string; closesAt: string; minNoticeMinutes: number; maxAdvanceDays: number },
  startsAt: Date,
  endsAt: Date,
  now: Date,
  timeZone: string,
): string | null {
  const day = localDate(startsAt, timeZone);
  const end = clockOf(endsAt, timeZone);
  if (clockOf(startsAt, timeZone) < s.opensAt || localDate(endsAt, timeZone) !== day) {
    return `Open ${s.opensAt} to ${s.closesAt}`;
  }
  if (end > s.closesAt) return `Open ${s.opensAt} to ${s.closesAt}`;
  if (startsAt.getTime() < now.getTime() + s.minNoticeMinutes * MINUTE) {
    return s.minNoticeMinutes > 0
      ? `Book at least ${s.minNoticeMinutes} minutes ahead`
      : 'That time has passed';
  }
  if (day > addDays(localDate(now, timeZone), s.maxAdvanceDays)) {
    return `Bookings open ${s.maxAdvanceDays} days ahead`;
  }
  return null;
}

async function timeZoneOf(db: TenantDb | TenantTx, propertyId: string) {
  return (await db.property.findUniqueOrThrow({ where: { id: propertyId } })).timeZone;
}

export async function serviceSlots(
  deps: ServiceDeps,
  serviceId: string,
  date: string,
): Promise<z.input<typeof ServiceSlotsView>> {
  const s = await deps.tenantDb.service.findFirst({ where: { id: serviceId } });
  if (!s) throw new AppError('NOT_FOUND', 'Service not found');
  const tz = await timeZoneOf(deps.tenantDb, s.propertyId);
  const now = deps.clock();
  const close = zonedInstant(date, s.closesAt, tz);
  const slots: z.input<typeof ServiceSlotsView>['slots'] = [];
  for (
    let at = zonedInstant(date, s.opensAt, tz);
    at.getTime() + s.durationMinutes * MINUTE <= close.getTime() && slots.length < 200;
    at = new Date(at.getTime() + s.durationMinutes * MINUTE)
  ) {
    const end = new Date(at.getTime() + s.durationMinutes * MINUTE);
    slots.push({
      startsAt: iso(at),
      endsAt: iso(end),
      left: s.capacity === null ? null : s.capacity - (await taken(deps.tenantDb, s.id, at, end)),
      bookable: s.active && outsideWindow(s, at, end, now, tz) === null,
    });
  }
  return { service: { id: s.id, name: s.name, capacity: s.capacity }, slots };
}

// ── Bookings ────────────────────────────────────────────────────────────────────────────

export async function listBookings(deps: ServiceDeps, tenant: TenantContext, date: string) {
  const tz = await timeZoneOf(deps.tenantDb, tenant.propertyId);
  const rows = await deps.tenantDb.serviceBooking.findMany({
    where: {
      startsAt: {
        gte: zonedInstant(date, '00:00', tz),
        lt: zonedInstant(addDays(date, 1), '00:00', tz),
      },
    },
    include: BOOKING_INCLUDE,
    orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }],
    take: 500,
  });
  return { data: rows.map(bookingOf) };
}

const amountFor = (
  s: { pricing: string; priceMinor: bigint },
  quantity: number,
  minutes: number,
) =>
  s.pricing === 'PER_PERSON'
    ? s.priceMinor * BigInt(quantity)
    : s.pricing === 'PER_HOUR'
      ? (s.priceMinor * BigInt(minutes) * BigInt(quantity)) / 60n
      : s.priceMinor;

export async function createBooking(
  deps: ServiceDeps,
  tenant: TenantContext,
  body: z.output<typeof ServiceBookingBody>,
) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    // Locked so two desks cannot both take the last place.
    await tx.$queryRaw`SELECT id FROM services WHERE id = ${body.serviceId}::uuid FOR UPDATE`;
    const s = await tx.service.findFirst({ where: { id: body.serviceId, active: true } });
    if (!s) throw invalid('serviceId', 'Choose an active service of this property');
    const tz = await timeZoneOf(tx, s.propertyId);
    const minutes = body.durationMinutes ?? s.durationMinutes;
    if (s.pricing !== 'PER_HOUR' && minutes !== s.durationMinutes) {
      throw invalid('durationMinutes', `${s.name} lasts ${s.durationMinutes} minutes`);
    }
    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(startsAt.getTime() + minutes * MINUTE);
    const outside = outsideWindow(s, startsAt, endsAt, now, tz);
    if (outside) throw invalid('startsAt', outside);
    if (s.capacity !== null && s.capacity < body.quantity) {
      throw invalid('quantity', `${s.name} takes ${s.capacity} at a time`);
    }

    let guestName = body.guestName ?? '';
    if (body.stayId) {
      const stay = await tx.stay.findFirst({
        where: { id: body.stayId, status: { in: ['TENTATIVE', 'CONFIRMED', 'CHECKED_IN'] } },
        include: { guest: true },
      });
      if (!stay) throw invalid('stayId', 'Choose a guest staying or arriving');
      guestName = guestName || `${stay.guest.firstName} ${stay.guest.lastName}`.trim();
    } else if (s.chargeToFolio) {
      throw invalid('stayId', `${s.name} is charged to the bill: choose the guest`);
    }

    if (
      s.capacity !== null &&
      (await taken(tx, s.id, startsAt, endsAt)) + body.quantity > s.capacity
    ) {
      throw new AppError('BOOKING_CONFLICT', `${s.name} is full at that time`, {});
    }
    const row = await tx.serviceBooking.create({
      data: {
        serviceId: s.id,
        stayId: body.stayId,
        guestName,
        startsAt,
        endsAt,
        quantity: body.quantity,
        amountMinor: amountFor(s, body.quantity, minutes),
        notes: body.notes,
        createdById: tenant.userId,
        createdAt: now,
      } as unknown as Prisma.ServiceBookingUncheckedCreateInput,
      include: BOOKING_INCLUDE,
    });
    await recordAudit(tx, {
      action: 'service_booking.created',
      entityType: 'service_booking',
      entityId: row.id,
      after: { serviceId: s.id, startsAt: body.startsAt, quantity: body.quantity },
    });
    return bookingOf(row);
  });
}

async function lockBooking(tx: TenantTx, bookingId: string) {
  await tx.$queryRaw`SELECT id FROM service_bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
  const b = await tx.serviceBooking.findFirst({
    where: { id: bookingId },
    include: { service: { include: { revenueCode: true } } },
  });
  if (!b) throw new AppError('NOT_FOUND', 'Booking not found');
  return b;
}

const loadItem = async (tx: TenantTx, id: string) =>
  bookingOf(await tx.serviceBooking.findUniqueOrThrow({ where: { id }, include: BOOKING_INCLUDE }));

export async function completeBooking(deps: ServiceDeps, tenant: TenantContext, bookingId: string) {
  const now = deps.clock();
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const b = await lockBooking(tx, bookingId);
      if (b.status !== 'BOOKED') throw stateError('Only a booked service is completed');
      let folioLineId: string | null = null;
      if (b.service.chargeToFolio && b.amountMinor > 0n) {
        const stay = b.stayId
          ? await tx.stay.findFirst({ where: { id: b.stayId, status: 'CHECKED_IN' } })
          : null;
        const folio = stay?.folioId
          ? await tx.folio.findFirst({
              where: { id: stay.folioId, status: 'OPEN' },
              include: { windows: true, routingRules: true },
            })
          : null;
        const windowId = folio ? routedWindow(folio, b.service.revenueCode) : undefined;
        if (!folio || !windowId) {
          throw stateError('The guest is not checked in with an open bill to charge this to');
        }
        const quantity = b.service.pricing === 'PER_PERSON' ? b.quantity : 1;
        const unit = quantity === 1 ? b.amountMinor : b.amountMinor / BigInt(quantity);
        const ids = await postChargeLines(
          { tx, tenant, approvalRequestId: null, now },
          {
            folio,
            windowId,
            code: b.service.revenueCode,
            description: b.service.name,
            quantity,
            unitAmountMinor: unit,
            note: b.notes,
            sourceType: 'SERVICE',
            sourceId: b.id,
          },
        );
        folioLineId = ids[0] ?? null;
      }
      await tx.serviceBooking.update({
        where: { id: bookingId },
        data: { status: 'COMPLETED', completedAt: now, folioLineId, version: { increment: 1 } },
      });
      await recordAudit(tx, {
        action: 'service_booking.completed',
        entityType: 'service_booking',
        entityId: bookingId,
        before: { status: 'BOOKED' },
        after: { status: 'COMPLETED', folioLineId, amountMinor: b.amountMinor.toString() },
      });
      return loadItem(tx, bookingId);
    });
  } catch (err) {
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
}

export async function cancelBooking(deps: ServiceDeps, bookingId: string, noShow: boolean) {
  return deps.tenantDb.$transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    if (b.status !== 'BOOKED') throw stateError('Only a booked service is cancelled');
    const status = noShow ? 'NO_SHOW' : 'CANCELLED';
    await tx.serviceBooking.update({
      where: { id: bookingId },
      data: { status, version: { increment: 1 } },
    });
    await recordAudit(tx, {
      action: noShow ? 'service_booking.no_show' : 'service_booking.cancelled',
      entityType: 'service_booking',
      entityId: bookingId,
      before: { status: 'BOOKED' },
      after: { status },
    });
    return loadItem(tx, bookingId);
  });
}
