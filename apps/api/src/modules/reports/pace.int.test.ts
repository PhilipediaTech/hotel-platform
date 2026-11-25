import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

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
};
type Report = {
  from: string;
  days: number;
  nights: Night[];
  totals: { rooms: number; revenueMinor: string; pickup: { d1: number; d7: number; d30: number } };
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
        departure: '2026-11-26',
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
