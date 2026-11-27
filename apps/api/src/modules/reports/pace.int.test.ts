import { addDays } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { AiUnavailableError } from '../../core/ai.ts';

// Pickup and pace (Versions V2; T-165). Three rooms. For the night of 25 November: Bisi books
// on 10 November, Chidi on 19 November, Dayo on 20 November, when Bisi cancels. The report on
// the morning of the 20th shows who is on the books and what moved.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Night = {
  date: string;
  roomsAvailable: number;
  rooms: number;
  revenueMinor: string;
  occupancyBps: number;
  pickup: { d1: number; d7: number; d30: number };
  lastYear: { date: string; sameTime: number; final: number };
  forecast: {
    rooms: number;
    low: number;
    high: number;
    occupancyBps: number;
    method: string;
    usualPickup: number;
    compared: number;
  };
};
type Report = {
  from: string;
  days: number;
  nights: Night[];
  totals: {
    rooms: number;
    revenueMinor: string;
    pickup: { d1: number; d7: number; d30: number };
    forecast: { rooms: number; low: number; high: number; occupancyBps: number };
  };
};

async function hotel() {
  const h = await inHouse(db, clock, { checkIn: false });
  const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
  const bar = await db.ratePlan.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'BAR' } });
  for (const number of ['102', '103']) {
    await h.ok(h.gm.post('/rooms', { number, roomTypeId: type.id }));
  }
  /** Books one night at `at` (the desk signs in again: sessions expire). */
  const book = async (at: string, lastName: string, arrival = '2026-11-25') => {
    now = new Date(at);
    const fd = await h.as(h.fdId);
    const quote = await h.ok<{ quoteId: string }>(
      fd.post('/quotes', {
        roomTypeId: type.id,
        ratePlanId: bar.id,
        arrival,
        departure: addDays(arrival, 1),
        adults: 1,
      }),
    );
    return h.ok<{ id: string }>(
      fd.send('/reservations', {
        source: 'PHONE',
        booker: { firstName: 'Guest', lastName },
        stays: [{ quoteId: quote.quoteId }],
      }),
    );
  };
  const report = async (query = 'from=2026-11-20&days=10') => {
    const gm = await h.as(h.gmId);
    return h.ok<Report>(gm.get(`/reports/pace?${query}`));
  };
  return { ...h, book, report };
}

describe('pickup and pace (V2)', () => {
  it('shows each night on the books, what was picked up, and what was lost', async () => {
    const h = await hotel();
    const bisi = await h.book('2026-11-10T10:00:00Z', 'Bisi');
    await h.book('2026-11-19T08:00:00Z', 'Chidi');
    await h.book('2026-11-20T08:00:00Z', 'Dayo');
    // Bisi cancels the same morning.
    const fd = await h.as(h.fdId);
    await h.ok(fd.send(`/reservations/${bisi.id}/cancel`, { reason: 'GUEST_REQUEST' }));
    now = new Date('2026-11-20T09:30:00Z');

    const r = await h.report();
    expect(r).toMatchObject({ from: '2026-11-20', days: 10 });
    const night = r.nights.find((n) => n.date === '2026-11-25');
    expect(night).toMatchObject({
      roomsAvailable: 3,
      rooms: 2,
      revenueMinor: '20000000',
      occupancyBps: 6667,
      // A day ago: Bisi and Chidi (2). A week ago: Bisi (1). A month ago: nobody.
      pickup: { d1: 0, d7: 1, d30: 2 },
      lastYear: { date: '2025-11-26', sameTime: 0, final: 0 },
    });
    expect(r.nights.find((n) => n.date === '2026-11-24')).toMatchObject({ rooms: 0 });
    expect(r.totals).toMatchObject({ rooms: 2, revenueMinor: '20000000', pickup: { d7: 1 } });
  });

  it('compares with the same weekday 52 weeks earlier, as it stood then and as it finished', async () => {
    const h = await hotel();
    const early = await h.book('2026-11-10T10:00:00Z', 'Early');
    const late = await h.book('2026-11-10T11:00:00Z', 'Late');
    // Move both stays to last year's night: one booked well ahead, one at the last minute.
    for (const [r, made] of [
      [early, '2025-11-01T09:00:00Z'],
      [late, '2025-11-25T09:00:00Z'],
    ] as const) {
      const stay = await db.stay.findFirstOrThrow({ where: { reservationId: r.id } });
      await db.stayNight.updateMany({
        where: { stayId: stay.id },
        data: { date: new Date('2025-11-26') },
      });
      await db.reservation.update({ where: { id: r.id }, data: { createdAt: new Date(made) } });
    }
    now = new Date('2026-11-20T09:30:00Z');
    const night = (await h.report()).nights.find((n) => n.date === '2026-11-25');
    // 364 days before now is 21 November 2025: only the early booking was on the books then.
    expect(night?.lastYear).toEqual({ date: '2025-11-26', sameTime: 1, final: 2 });
  });

  it('starts today or later, at most 120 nights, and is for those who see reports', async () => {
    const h = await hotel();
    const past = await h.gm.get('/reports/pace?from=2026-11-01');
    expect(past.status).toBe(400);
    expect(errorOf(past).message).toBe('Start today or later');
    expect((await h.gm.get('/reports/pace?days=121')).status).toBe(400);
    const def = await h.ok<Report>(h.gm.get('/reports/pace'));
    expect(def).toMatchObject({ from: '2026-11-10', days: 90 });
    expect(def.nights).toHaveLength(90);
    // Ada's stay tonight is on the books (confirmed, not yet in house).
    expect(def.nights[0]).toMatchObject({ date: '2026-11-10', rooms: 1 });
    expect((await h.fd.get('/reports/pace')).status).toBe(403);
  });
});

/** Moves a booking's one night to `night`, as if made at `made`. */
async function moveTo(reservationId: string, night: string, made: string) {
  const stay = await db.stay.findFirstOrThrow({ where: { reservationId } });
  await db.stayNight.updateMany({ where: { stayId: stay.id }, data: { date: new Date(night) } });
  await db.reservation.update({
    where: { id: reservationId },
    data: { createdAt: new Date(made) },
  });
}

describe('occupancy forecast (V3; T-179)', () => {
  it('with a year of history, adds what the same weekday picked up last year from this point', async () => {
    const h = await hotel();
    // Last year, each Wednesday around 26 November 2025 picked up one room in its last 5 days
    // (booked the day before), on top of one booked weeks ahead for the 26th.
    const lyNights = ['2025-11-19', '2025-11-26', '2025-12-03'];
    for (const [i, night] of lyNights.entries()) {
      const late = await h.book('2026-11-10T10:00:00Z', `Late${i}`, addDays('2026-11-21', i));
      await moveTo(late.id, night, `${addDays(night, -1)}T09:00:00Z`);
    }
    const early = await h.book('2026-11-10T10:00:00Z', 'Early', '2026-11-24');
    await moveTo(early.id, '2025-11-26', '2025-11-01T09:00:00Z');
    // This year, one room is on the books for the 25th so far.
    await h.book('2026-11-12T10:00:00Z', 'Now');
    now = new Date('2026-11-20T09:30:00Z');

    const r = await h.report();
    const night = r.nights.find((n) => n.date === '2026-11-25');
    expect(night?.lastYear).toEqual({ date: '2025-11-26', sameTime: 1, final: 2 });
    expect(night).toMatchObject({ rooms: 1, roomsAvailable: 3 });
    expect(night?.forecast).toEqual({
      rooms: 2,
      low: 2,
      high: 2,
      occupancyBps: 6667,
      method: 'LAST_YEAR',
      usualPickup: 1,
      compared: 3,
    });
    expect(r.totals.forecast.rooms).toBe(r.nights.reduce((sum, n) => sum + n.forecast.rooms, 0));
  });

  it('a new hotel uses the same weekday over recent weeks, only since it started', async () => {
    const h = await hotel();
    // Started on 10 November (Ada's booking). Saturdays 14 and 21 November picked up 1 and 2
    // rooms in their last 4 days; Saturday 7 November was before the hotel started.
    await h.book('2026-11-12T10:00:00Z', 'Sat14', '2026-11-14');
    await h.book('2026-11-19T10:00:00Z', 'Sat21a', '2026-11-21');
    await h.book('2026-11-19T11:00:00Z', 'Sat21b', '2026-11-21');
    await h.book('2026-11-20T10:00:00Z', 'Ahead', '2026-11-28');
    now = new Date('2026-11-24T10:00:00Z');

    const r = await h.report('from=2026-11-24&days=7');
    const night = r.nights.find((n) => n.date === '2026-11-28');
    expect(night?.forecast).toEqual({
      rooms: 2,
      low: 2,
      high: 3,
      occupancyBps: 6667,
      method: 'RECENT_WEEKS',
      usualPickup: 1,
      compared: 2,
    });
  });

  it('with no comparable nights, the forecast is what is on the books', async () => {
    const h = await hotel();
    const r = await h.report('from=2026-11-10&days=3');
    expect(r.nights[0]?.forecast).toMatchObject({
      rooms: 1,
      low: 1,
      high: 1,
      method: 'ON_THE_BOOKS',
      compared: 0,
    });
  });

  it('explains the forecast with AI from its own figures only, or not at all', async () => {
    const h = await hotel();
    const gm = await h.as(h.gmId);
    const explain = () => gm.post('/reports/pace/explain', { from: '2026-11-10', days: 3 });
    h.ai.respond = () => 'Expect 33% over the 3 nights; 2026-11-10 is the strongest night.';
    const ok = await explain();
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({
      note: 'Expect 33% over the 3 nights; 2026-11-10 is the strongest night.',
    });
    const request = h.ai.requests.at(-1);
    expect(request?.user).toContain(
      '2026-11-10: 1 of 3, forecast 1 (1 to 1), 33%, on the books only',
    );
    expect(
      (await db.usageCounter.findFirstOrThrow({ where: { metric: 'AI_FORECAST_NOTE' } })).count,
    ).toBe(1);

    // A number that isn't among the figures: no note.
    h.ai.respond = () => 'Raise prices by 15% to reach 90% occupancy.';
    expect(errorOf(await explain()).code).toBe('AI_UNAVAILABLE');
    h.ai.respond = () => {
      throw new AiUnavailableError('down');
    };
    expect(errorOf(await explain()).code).toBe('AI_UNAVAILABLE');
    expect((await h.fd.post('/reports/pace/explain', {})).status).toBe(403);
  });
});
