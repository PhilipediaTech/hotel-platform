import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Other services (PRD M9-09: "set up other services (laundry, parking, transfers, spa, gym,
// tours) with capacity, booking window, price and charge-to-folio"; strategy 11.1 "follow the
// same availability and charge-to-folio rules"; T-122). The test hotel is in Lagos (UTC+1).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z'); // 10:00 in Lagos
});

type Service = { id: string; capacity: number | null };
type Booking = { id: string; status: string; amountMinor: string; charged: boolean };

const SPA = {
  code: 'SPA',
  name: 'Massage',
  category: 'SPA',
  priceMinor: '2500000',
  pricing: 'PER_PERSON',
  durationMinutes: 60,
  capacity: 2,
  opensAt: '09:00',
  closesAt: '18:00',
  minNoticeMinutes: 60,
  maxAdvanceDays: 14,
};
// 10:00 to 11:00 in Lagos tomorrow.
const TOMORROW_10 = '2026-11-11T09:00:00Z';

async function hotel(options: { checkIn?: boolean } = {}) {
  const h = await inHouse(db, clock, { checkIn: options.checkIn ?? true });
  const spa = await h.ok<Service>(h.gm.post('/services', SPA));
  const book = (body: object, as = h.fd) =>
    as.send('/service-bookings', {
      serviceId: spa.id,
      startsAt: TOMORROW_10,
      stayId: h.stayId,
      ...body,
    });
  return { ...h, spa, book };
}

describe('setting up services (M9-09)', () => {
  it('keeps capacity, opening hours, booking window, price and charge-to-bill', async () => {
    const h = await hotel();
    const list = await h.ok<{ data: Record<string, unknown>[] }>(h.fd.get('/services'));
    expect(list.data[0]).toMatchObject({
      name: 'Massage',
      capacity: 2,
      opensAt: '09:00',
      closesAt: '18:00',
      minNoticeMinutes: 60,
      maxAdvanceDays: 14,
      chargeToFolio: true,
      revenueCode: 'MISC',
      priceMinor: '2500000',
    });
  });

  it('refuses a second code, an unknown revenue code, and closing before opening', async () => {
    const h = await hotel();
    expect(errorOf(await h.gm.post('/services', SPA)).message).toContain('already has the code');
    expect((await h.gm.post('/services', { ...SPA, code: 'X', revenueCode: 'NOPE' })).status).toBe(
      400,
    );
    expect(
      (await h.gm.post('/services', { ...SPA, code: 'Y', opensAt: '18:00', closesAt: '09:00' }))
        .status,
    ).toBe(400);
  });

  it('needs service.manage to set up, folio.charge to book', async () => {
    const h = await hotel();
    expect((await h.fd.post('/services', { ...SPA, code: 'FD' })).status).toBe(403);
    expect((await h.book({})).status).toBe(201);
  });
});

describe('availability and booking window', () => {
  it('lists the day’s start times in hotel time, with places left', async () => {
    const h = await hotel();
    await h.ok(h.book({ quantity: 1 }));
    const view = await h.ok<{ slots: { startsAt: string; left: number; bookable: boolean }[] }>(
      h.fd.get(`/services/${h.spa.id}/slots?date=2026-11-11`),
    );
    expect(view.slots).toHaveLength(9);
    expect(view.slots[0]?.startsAt).toBe('2026-11-11T08:00:00Z');
    expect(view.slots.find((s) => s.startsAt === TOMORROW_10)?.left).toBe(1);
    const today = await h.ok<{ slots: { startsAt: string; bookable: boolean }[] }>(
      h.fd.get(`/services/${h.spa.id}/slots?date=2026-11-10`),
    );
    // 09:00 has passed and 10:00 is within the hour's notice; 11:00 can be booked.
    expect(today.slots.slice(0, 3).map((s) => s.bookable)).toEqual([false, false, true]);
  });

  it('refuses times outside opening hours, too soon, or too far ahead', async () => {
    const h = await hotel();
    const message = async (startsAt: string) => errorOf(await h.book({ startsAt })).message;
    expect(await message('2026-11-11T17:30:00Z')).toContain('Open 09:00 to 18:00');
    expect(await message('2026-11-11T07:00:00Z')).toContain('Open 09:00 to 18:00');
    expect(await message('2026-11-10T09:30:00Z')).toContain('at least 60 minutes ahead');
    expect(await message('2026-11-30T09:00:00Z')).toContain('14 days ahead');
  });

  it('a full time is refused with BOOKING_CONFLICT, and a cancellation frees it', async () => {
    const h = await hotel();
    const first = await h.ok<Booking>(h.book({ quantity: 2 }));
    const full = await h.book({ quantity: 1 });
    expect(full.status).toBe(409);
    expect(errorOf(full).code).toBe('BOOKING_CONFLICT');
    // An overlapping start (10:30) is full too.
    expect((await h.book({ startsAt: '2026-11-11T09:30:00Z' })).status).toBe(409);
    await h.ok(h.fd.post(`/service-bookings/${first.id}/cancel`, {}));
    expect((await h.book({ quantity: 1 })).status).toBe(201);
    expect((await h.book({ quantity: 3, startsAt: '2026-11-11T12:00:00Z' })).status).toBe(400);
  });
});

describe('price and charge to the bill', () => {
  it('prices per person, per hour or per booking', async () => {
    const h = await hotel();
    const spa = await h.ok<Booking>(h.book({ quantity: 2 }));
    expect(spa.amountMinor).toBe('5000000');
    const parking = await h.ok<Service>(
      h.gm.post('/services', {
        ...SPA,
        code: 'PARK',
        name: 'Parking',
        category: 'PARKING',
        pricing: 'PER_HOUR',
        priceMinor: '100000',
        capacity: 20,
        minNoticeMinutes: 0,
      }),
    );
    const parked = await h.ok<Booking>(
      h.book({ serviceId: parking.id, durationMinutes: 180, startsAt: '2026-11-11T12:00:00Z' }),
    );
    expect(parked.amountMinor).toBe('300000');
    // Only per-hour services may be booked for a different length.
    expect((await h.book({ durationMinutes: 120 })).status).toBe(400);
  });

  it('delivering a charge-to-bill service posts it to the guest’s folio, once', async () => {
    const h = await hotel();
    const b = await h.ok<Booking>(h.book({ quantity: 2 }));
    const done = await h.ok<Booking>(h.fd.send(`/service-bookings/${b.id}/complete`, {}));
    expect(done).toMatchObject({ status: 'COMPLETED', charged: true });
    const charge = await db.folioLine.findFirstOrThrow({
      where: { folioId: h.folioId, sourceType: 'SERVICE' },
    });
    expect(charge).toMatchObject({
      description: 'Massage',
      quantity: 2,
      unitAmountMinor: 2500000n,
    });
    expect(await db.folioLine.count({ where: { parentLineId: charge.id, kind: 'TAX' } })).toBe(
      await db.folioLine.count({ where: { parentLineId: charge.id } }),
    );
    expect((await h.fd.send(`/service-bookings/${b.id}/complete`, {})).status).toBe(409);
  });

  it('a charge-to-bill service needs a guest; a pay-at-service one can be for anyone', async () => {
    const h = await hotel();
    expect(errorOf(await h.book({ stayId: null, guestName: 'Walk-in' })).message).toContain(
      'charged to the bill',
    );
    const gym = await h.ok<Service>(
      h.gm.post('/services', {
        ...SPA,
        code: 'GYM',
        name: 'Gym day pass',
        category: 'GYM',
        pricing: 'PER_BOOKING',
        chargeToFolio: false,
        capacity: null,
      }),
    );
    const visitor = await h.ok<Booking>(
      h.book({ serviceId: gym.id, stayId: null, guestName: 'Tunde Bello' }),
    );
    const done = await h.ok<Booking>(h.fd.send(`/service-bookings/${visitor.id}/complete`, {}));
    expect(done.charged).toBe(false);
    expect(await db.folioLine.count({ where: { sourceType: 'SERVICE' } })).toBe(0);
  });

  it('cannot charge a guest who has not checked in yet', async () => {
    const h = await hotel({ checkIn: false });
    const b = await h.ok<Booking>(h.book({}));
    const refused = await h.fd.send(`/service-bookings/${b.id}/complete`, {});
    expect(refused.status).toBe(409);
    expect(errorOf(refused).message).toContain('not checked in');
  });

  it('records a no-show, which charges nothing, and lists the day’s bookings', async () => {
    const h = await hotel();
    const b = await h.ok<Booking>(h.book({}));
    const missed = await h.ok<Booking>(
      h.fd.post(`/service-bookings/${b.id}/cancel`, { noShow: true }),
    );
    expect(missed.status).toBe('NO_SHOW');
    const day = await h.ok<{ data: { id: string; status: string }[] }>(
      h.fd.get('/service-bookings?date=2026-11-11'),
    );
    expect(day.data.map((x) => x.status)).toEqual(['NO_SHOW']);
    expect(
      (await h.ok<{ data: unknown[] }>(h.fd.get('/service-bookings?date=2026-11-12'))).data,
    ).toHaveLength(0);
  });
});
