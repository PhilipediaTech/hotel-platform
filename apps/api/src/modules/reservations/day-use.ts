import {
  addDays,
  localDate,
  QUOTE_MINUTES,
  zonedInstant,
  type CheckOutBody,
  type DayUseBody,
  type DayUseQuery,
  type DayUseRoomType,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { dayUseOffers, type DayUseOffer } from '../availability/quotes.ts';
import { dayUseFreeRooms, guarded, loadStay, lockRoom } from './rooms.ts';
import { bookableGuest, getReservation, newGuest, type ReservationDeps } from './service.ts';

// Day-use stays (PRD M3-10, M2-08, housekeeping rule 2 "a day-use end sets the room to dirty"; tab 4
// POST /day-use; T-052). A room is sold for a start time and duration on one date: the
// day-use plan's price that day covers the stay up to the plan's longest duration. It is not a
// room night (no room-type inventory is taken; reports count it as day-use revenue), so the
// same room can be sold again for the night. The room is held for exactly those hours.
// The guest checks in like any other; the desk ends the stay, and the room becomes dirty.

type Query = z.output<typeof DayUseQuery>;
type Body = z.output<typeof DayUseBody>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

/** When the stay starts and ends, checked against the property's today and clock. */
async function stayTimes(deps: ReservationDeps, tenant: TenantContext, q: Query, where: string) {
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
    select: { timeZone: true, baseCurrency: true, status: true, code: true },
  });
  const now = deps.clock();
  if (q.date < localDate(now, property.timeZone)) {
    throw invalid(`${where}.date`, 'The date is today or later');
  }
  const startsAt = zonedInstant(q.date, q.start, property.timeZone);
  const endsAt = new Date(startsAt.getTime() + q.minutes * 60_000);
  if (endsAt <= now) throw invalid(`${where}.start`, 'This time has already passed');
  return { property, now, startsAt, endsAt };
}

const tooLong = (offer: DayUseOffer, minutes: number) =>
  minutes > (offer.plan.dayUseMaxMinutes ?? 0);

export async function getDayUseAvailability(
  deps: ReservationDeps,
  tenant: TenantContext,
  query: Query,
) {
  const { property, startsAt, endsAt } = await stayTimes(deps, tenant, query, 'query');
  const { offers } = await dayUseOffers(deps.tenantDb, query.date, query.adults + query.children);
  const roomTypes: z.input<typeof DayUseRoomType>[] = [];
  for (const offer of offers) {
    let entry = roomTypes.find((t) => t.roomTypeId === offer.type.id);
    if (!entry) {
      const rooms = await dayUseFreeRooms(
        deps.tenantDb,
        offer.type.id,
        query.date,
        startsAt,
        endsAt,
      );
      entry = {
        roomTypeId: offer.type.id,
        code: offer.type.code,
        name: offer.type.name,
        maxOccupancy: offer.type.maxOccupancy,
        plans: [],
        rooms: rooms.map((r) => ({
          id: r.id,
          number: r.number,
          floor: r.floor,
          hkStatus: r.hkStatus,
        })),
      };
      roomTypes.push(entry);
    }
    entry.plans.push({
      ratePlanId: offer.plan.id,
      code: offer.plan.code,
      name: offer.plan.name,
      guarantee: offer.plan.guarantee,
      maxMinutes: offer.plan.dayUseMaxMinutes ?? 0,
      totalMinor: offer.night ? offer.totalMinor.toString() : null,
      sellable:
        offer.violations.length === 0 &&
        offer.night !== null &&
        !tooLong(offer, query.minutes) &&
        entry.rooms.length > 0,
      violations: offer.violations,
    });
  }
  return {
    date: query.date,
    startsAt: iso(startsAt),
    endsAt: iso(endsAt),
    currency: property.baseCurrency,
    roomTypes,
  };
}

export async function createDayUse(deps: ReservationDeps, tenant: TenantContext, body: Body) {
  const { property, now, startsAt, endsAt } = await stayTimes(deps, tenant, body, 'body');
  if (property.status !== 'LIVE') {
    throw new AppError('PROPERTY_NOT_LIVE', 'Bookings open once the property goes live');
  }
  const guests = body.adults + body.children;
  const { offers, hasRoomCode } = await dayUseOffers(deps.tenantDb, body.date, guests);
  if (!hasRoomCode) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'Add a room revenue code (Tax and FX) before selling rooms',
    );
  }
  const offer = offers.find((o) => o.type.id === body.roomTypeId && o.plan.id === body.ratePlanId);
  if (!offer) {
    throw invalid(
      'body.ratePlanId',
      'Choose an active day-use plan that sells this room type for these guests',
    );
  }
  if (tooLong(offer, body.minutes)) {
    const hours = (offer.plan.dayUseMaxMinutes ?? 0) / 60;
    throw invalid('body.minutes', `${offer.plan.name} sells at most ${hours} hours`);
  }
  if (offer.violations.length > 0 || !offer.night) {
    throw new AppError('RESTRICTION_VIOLATED', 'This day-use cannot be sold on this rate plan', {
      violations: offer.violations,
    });
  }
  const night = offer.night;

  const reservationId = await deps.tenantDb.$transaction(async (tx) => {
    const room = await tx.room.findUnique({ where: { id: body.roomId } });
    if (!room || !room.active || room.roomTypeId !== offer.type.id) {
      throw invalid('body.roomId', `Choose an active ${offer.type.name} room`);
    }
    await lockRoom(tx, room.id);
    const free = await dayUseFreeRooms(tx, room.roomTypeId, body.date, startsAt, endsAt);
    if (!free.some((r) => r.id === room.id)) {
      throw new AppError(
        'BOOKING_CONFLICT',
        `Room ${room.number} is blocked, has a guest that day, or is sold for day-use then`,
        { roomId: room.id },
      );
    }
    const booker = body.booker.guestId
      ? await bookableGuest(tx, body.booker.guestId, 'body.booker.guestId')
      : await newGuest(tx, body.booker);
    if (booker.doNotRent) {
      throw new AppError(
        'FORBIDDEN',
        'This guest is flagged do-not-rent; a manager must make the booking',
        { reason: 'DO_NOT_RENT' },
      );
    }

    // The price is kept on a quote, as every stay's is (M2 rule 4).
    const quote = await tx.quote.create({
      data: {
        ratePlanId: offer.plan.id,
        roomTypeId: offer.type.id,
        arrival: dbDate(body.date),
        departure: dbDate(addDays(body.date, 1)),
        nights: [night] as unknown as object,
        taxes: offer.taxes,
        totalMinor: offer.totalMinor,
        currency: property.baseCurrency,
        expiresAt: new Date(now.getTime() + QUOTE_MINUTES * 60_000),
        createdAt: now,
      } as never,
    });
    const n = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.CONFIRMATION);
    const confirmationNo = `${property.code}-${String(n).padStart(5, '0')}`;
    const reservation = await tx.reservation.create({
      data: {
        confirmationNo,
        bookerGuestId: booker.id,
        source: body.source,
        status: 'CONFIRMED',
        guarantee: body.guarantee,
        notes: body.notes,
        createdById: tenant.userId,
        createdAt: now,
        history: {
          create: { toStatus: 'CONFIRMED', reason: 'DAY_USE', byUserId: tenant.userId, at: now },
        },
      } as unknown as Prisma.ReservationUncheckedCreateInput, // tenant IDs come from the client
    });
    const stay = await tx.stay.create({
      data: {
        reservationId: reservation.id,
        guestId: booker.id,
        roomTypeId: offer.type.id,
        roomId: room.id,
        ratePlanId: offer.plan.id,
        quoteId: quote.id,
        arrival: dbDate(body.date),
        departure: dbDate(body.date),
        adults: body.adults,
        children: body.children,
        status: 'CONFIRMED',
        isDayUse: true,
        dayUseStart: startsAt,
        dayUseEnd: endsAt,
        nights: {
          create: {
            date: dbDate(body.date),
            amountMinor: BigInt(night.amountMinor),
            ratePlanId: night.pricedBy,
            ruleVersion: night.ruleVersion,
          },
        },
      } as unknown as Prisma.StayUncheckedCreateInput,
    });
    await guarded(() =>
      tx.roomAllocation.create({
        data: {
          propertyId: tenant.propertyId,
          stayId: stay.id,
          roomId: room.id,
          startDate: dbDate(body.date),
          endDate: dbDate(addDays(body.date, 1)),
          startsAt,
          endsAt,
        },
      }),
    );
    await recordAudit(tx, {
      action: 'reservation.created',
      entityType: 'reservation',
      entityId: reservation.id,
      after: {
        confirmationNo,
        status: 'CONFIRMED',
        source: body.source,
        bookerGuestId: booker.id,
        dayUse: { roomId: room.id, startsAt: iso(startsAt), endsAt: iso(endsAt) },
      },
    });
    await recordEvent(tx, {
      type: 'reservation.created',
      payload: { reservationId: reservation.id, confirmationNo, status: 'CONFIRMED' },
    });
    return reservation.id;
  });
  return getReservation(deps, reservationId);
}

// ── Check-out (day-use; overnight check-out comes with folios, T-064) ───────────────────

export async function checkOut(
  deps: ReservationDeps,
  tenant: TenantContext,
  stayId: string,
  ifMatch: string,
  body: z.output<typeof CheckOutBody>,
) {
  const now = deps.clock();
  const reservationId = await deps.tenantDb.$transaction(async (tx) => {
    const stay = await loadStay(tx, stayId);
    if (Number(/^(?:W\/)?"?(\d+)"?$/.exec(ifMatch.trim())?.[1] ?? -1) !== stay.version) {
      throw new AppError('VERSION_CONFLICT', 'Someone changed this stay; reload and try again', {
        version: stay.version,
      });
    }
    if (stay.status !== 'CHECKED_IN' || !stay.roomId) {
      throw new AppError('STATE_TRANSITION_INVALID', 'Only a checked-in guest is checked out', {
        from: stay.status,
        to: 'CHECKED_OUT',
      });
    }
    if (!stay.isDayUse) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'Overnight guests are checked out with their bill, which is not available yet',
        { reason: 'NEEDS_FOLIO' },
      );
    }
    // The room is free from now on (or was never used, when it ends before its start).
    const allocations = await tx.roomAllocation.findMany({
      where: { stayId: stay.id, active: true },
    });
    for (const a of allocations) {
      if (a.startsAt && a.startsAt < now) {
        if (a.endsAt && a.endsAt > now) {
          await tx.roomAllocation.update({ where: { id: a.id }, data: { endsAt: now } });
        }
      } else {
        await tx.roomAllocation.update({ where: { id: a.id }, data: { active: false } });
      }
    }
    // Housekeeping rule 2: a day-use end sets the room to dirty.
    await tx.room.update({
      where: { id: stay.roomId },
      data: { hkStatus: 'DIRTY', hkStatusAt: now, version: { increment: 1 } },
    });
    if (body.keysReturned) {
      await tx.keyIssue.updateMany({
        where: { stayId: stay.id, returnedAt: null },
        data: { returnedAt: now },
      });
    }
    const claimed = await tx.stay.updateMany({
      where: { id: stay.id, version: stay.version },
      data: { status: 'CHECKED_OUT', checkedOutAt: now, version: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      throw new AppError('VERSION_CONFLICT', 'Someone changed this stay; reload and try again');
    }
    // The reservation is checked out once none of its guests is still in or to come.
    const left = await tx.stay.count({
      where: {
        reservationId: stay.reservationId,
        status: { notIn: ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] },
      },
    });
    await tx.reservation.update({
      where: { id: stay.reservationId },
      data: {
        ...(left === 0 ? { status: 'CHECKED_OUT' as const } : {}),
        version: { increment: 1 },
        history: {
          create: {
            stayId: stay.id,
            fromStatus: 'CHECKED_IN',
            toStatus: 'CHECKED_OUT',
            byUserId: tenant.userId,
            at: now,
          },
        },
      },
    });
    await recordAudit(tx, {
      action: 'stay.checked_out',
      entityType: 'stay',
      entityId: stay.id,
      before: { status: 'CHECKED_IN' },
      after: { status: 'CHECKED_OUT', roomId: stay.roomId, keysReturned: body.keysReturned },
    });
    await recordEvent(tx, {
      type: 'stay.checked_out',
      payload: { stayId: stay.id, reservationId: stay.reservationId, roomId: stay.roomId },
    });
    return stay.reservationId;
  });
  return getReservation(deps, reservationId);
}
