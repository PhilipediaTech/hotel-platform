import { addDays, localDate, type PaceReport } from '@hotel/shared';
import type { z } from 'zod';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { ReportDeps } from './service.ts';

// Pickup and pace (Versions V2 "revenue-management support"; T-165). For each coming night:
// rooms and revenue on the books, how that moved over the last 1, 7 and 30 days (pickup), and
// the same weekday a year earlier (52 weeks), both as it stood the same number of days before
// that night and as it finished. "On the books at a moment" is rebuilt from what is kept: a
// stay counts from when its reservation was made, until it was cancelled or became a no-show
// (the status history says when). Holds not yet confirmed and day-use are left out.

type Out = z.input<typeof PaceReport>;

const DEFINITIONS =
  'Rooms: overnight stays on the books for the night, confirmed, in house or checked out; holds not yet confirmed and day-use are left out. Revenue: those nights at their booked rate, before tax. Pickup: rooms on the books now less rooms on the books 1, 7 or 30 days ago (a cancellation counts against it). Last year: the same weekday 52 weeks earlier, as it stood the same number of days before that night, and as it finished. Rooms available: active rooms less those blocked for the night (and, tonight, those out of order or service).';

const DAY = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
const LOST = ['CANCELLED', 'NO_SHOW'] as const;

export async function paceReport(
  deps: ReportDeps,
  tenant: TenantContext,
  q: { from?: string | undefined; days: number },
): Promise<Out> {
  const db = deps.tenantDb;
  const property = await db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
  const now = deps.clock();
  const today = localDate(now, property.timeZone);
  const from = q.from ?? today;
  if (from < today) {
    throw new AppError('VALIDATION_ERROR', 'Start today or later', {
      issues: [{ path: 'query.from', code: 'custom', message: 'Start today or later' }],
    });
  }
  const dates = Array.from({ length: q.days }, (_, i) => addDays(from, i));
  const to = addDays(from, q.days); // excluded
  const lyFrom = addDays(from, -364);
  const lyTo = addDays(to, -364);

  // Stays are the property's (stay nights and status history have no property of their own).
  const inRange = {
    OR: [
      { date: { gte: new Date(from), lt: new Date(to) } },
      { date: { gte: new Date(lyFrom), lt: new Date(lyTo) } },
    ],
  };
  const stays = await db.stay.findMany({
    where: {
      isDayUse: false,
      status: { notIn: ['ENQUIRY', 'TENTATIVE'] },
      nights: { some: inRange },
    },
    select: {
      id: true,
      reservationId: true,
      reservation: {
        select: {
          createdAt: true,
          history: {
            where: { toStatus: { in: [...LOST] } },
            select: { stayId: true, at: true },
            orderBy: { at: 'asc' },
          },
        },
      },
      nights: { where: inRange, select: { date: true, amountMinor: true } },
    },
  });
  /** One row per night: when its reservation was made and when it left the books, if it did. */
  const nights = stays.flatMap((st) => {
    const lost =
      st.reservation.history.find((h) => h.stayId === null || h.stayId === st.id)?.at ?? null;
    return st.nights.map((n) => ({
      date: day(n.date),
      amountMinor: n.amountMinor,
      madeAt: st.reservation.createdAt,
      lostAt: lost,
    }));
  });

  /** Rooms and revenue on the books for `date`, as it stood at `at`. */
  const booked = (date: string, at: Date) => {
    let rooms = 0;
    let revenue = 0n;
    for (const n of nights) {
      if (n.date !== date) continue;
      if (n.madeAt > at) continue;
      if (n.lostAt && n.lostAt <= at) continue;
      rooms += 1;
      revenue += n.amountMinor;
    }
    return { rooms, revenue };
  };

  // Rooms that can be sold each night: active rooms less blocks (and tonight, out of order).
  const [rooms, blocks] = await Promise.all([
    db.room.findMany({ where: { active: true }, select: { id: true, hkStatus: true } }),
    db.roomBlock.findMany({
      where: { releasedAt: null, startDate: { lt: new Date(to) }, endDate: { gt: new Date(from) } },
      select: { roomId: true, startDate: true, endDate: true },
    }),
  ]);
  const roomIds = new Set(rooms.map((r) => r.id));
  const outTonight = new Set(
    rooms
      .filter((r) => r.hkStatus === 'OUT_OF_ORDER' || r.hkStatus === 'OUT_OF_SERVICE')
      .map((r) => r.id),
  );
  const availableOn = (date: string) => {
    const out = new Set(date === today ? outTonight : []);
    for (const b of blocks) {
      if (roomIds.has(b.roomId) && day(b.startDate) <= date && day(b.endDate) > date) {
        out.add(b.roomId);
      }
    }
    return rooms.length - out.size;
  };

  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const totals = {
    roomsAvailable: 0,
    rooms: 0,
    revenue: 0n,
    d1: 0,
    d7: 0,
    d30: 0,
    sameTime: 0,
    final: 0,
  };
  const out = dates.map((date) => {
    const current = booked(date, now);
    const available = availableOn(date);
    const pickup = {
      d1: current.rooms - booked(date, ago(1)).rooms,
      d7: current.rooms - booked(date, ago(7)).rooms,
      d30: current.rooms - booked(date, ago(30)).rooms,
    };
    const lyDate = addDays(date, -364);
    const lastYear = {
      date: lyDate,
      sameTime: booked(lyDate, ago(364)).rooms,
      final: booked(lyDate, now).rooms,
    };
    totals.roomsAvailable += available;
    totals.rooms += current.rooms;
    totals.revenue += current.revenue;
    totals.d1 += pickup.d1;
    totals.d7 += pickup.d7;
    totals.d30 += pickup.d30;
    totals.sameTime += lastYear.sameTime;
    totals.final += lastYear.final;
    return {
      date,
      roomsAvailable: available,
      rooms: current.rooms,
      revenueMinor: current.revenue.toString(),
      occupancyBps: available > 0 ? Math.round((current.rooms * 10_000) / available) : 0,
      pickup,
      lastYear,
    };
  });
  return {
    from,
    days: q.days,
    asOf: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    currency: property.baseCurrency,
    nights: out,
    totals: {
      roomsAvailable: totals.roomsAvailable,
      rooms: totals.rooms,
      revenueMinor: totals.revenue.toString(),
      occupancyBps:
        totals.roomsAvailable > 0 ? Math.round((totals.rooms * 10_000) / totals.roomsAvailable) : 0,
      pickup: { d1: totals.d1, d7: totals.d7, d30: totals.d30 },
      lastYear: { sameTime: totals.sameTime, final: totals.final },
    },
    definitions: DEFINITIONS,
  };
}
