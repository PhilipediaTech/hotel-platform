import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { APP_ORIGIN, errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { settleIntent } from '../payments/intents.ts';
import { expireHolds } from '../reservations/service.ts';

// The booking engine (PRD M11-01–M11-03; M11 rules and AC: "a booking engine reservation appears
// on the PMS calendar with source DIRECT"; "an online payment that succeeds after the hold
// expired either books if inventory remains or auto-refunds with notice"; T-112).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

const ARRIVAL = '2026-11-20';
const DEPARTURE = '2026-11-22';
const SETTINGS = {
  slug: 'demo-lagos',
  enabled: true,
  headline: 'Stay in Lagos',
  description: null,
  policies: 'Check-in from 14:00.',
  photoFileIds: [],
  allowPayFull: true,
  allowDeposit: true,
  depositBps: 3000,
  allowPayAtHotel: true,
};

type Created = {
  token: string;
  confirmationNo: string;
  status: string;
  paymentUrl: string | null;
  amountDueNowMinor: string;
  totalMinor: string;
};
type Availability = {
  promoApplied: boolean;
  roomTypes: {
    roomTypeId: string;
    available: number;
    plans: { ratePlanId: string; name: string; totalMinor: string }[];
  }[];
};
type View = {
  status: string;
  paidMinor: string;
  guestName: string;
  cancellation: { allowed: boolean; feeMinor: string };
};

async function hotel() {
  const h = await inHouse(db, clock);
  const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
  const bar = await db.ratePlan.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'BAR' } });
  await db.ratePlan.update({ where: { id: bar.id }, data: { isPublic: true } });
  await h.ok(h.gm.put('/booking-engine/settings', SETTINGS));
  const pub = () => ({
    get: (path: string) => request(h.app).get(`/public/v1${path}`).set('Origin', APP_ORIGIN),
    post: (path: string, body: object) =>
      request(h.app).post(`/public/v1${path}`).set('Origin', APP_ORIGIN).send(body),
  });
  const availability = (extra = '') =>
    pub().get(
      `/availability?slug=demo-lagos&arrival=${ARRIVAL}&departure=${DEPARTURE}&adults=1${extra}`,
    );
  const book = (over: object = {}) =>
    pub().post('/bookings', {
      slug: 'demo-lagos',
      bookingKey: randomUUID(),
      roomTypeId: type.id,
      ratePlanId: bar.id,
      arrival: ARRIVAL,
      departure: DEPARTURE,
      adults: 1,
      firstName: 'Bisi',
      lastName: 'Adeyemi',
      email: 'bisi@guest.test',
      phone: '+2348031110000',
      payment: 'AT_HOTEL',
      ...over,
    });
  const payments = h.payments;
  const pay = async (reservationConfirmation: string) => {
    const r = await db.reservation.findFirstOrThrow({
      where: { confirmationNo: reservationConfirmation },
    });
    const intent = await db.paymentIntent.findFirstOrThrow({ where: { reservationId: r.id } });
    payments.complete(intent.providerRef, 'SUCCEEDED', now);
    await settleIntent({ db, clock, provider: payments }, intent.id);
    return db.reservation.findUniqueOrThrow({ where: { id: r.id } });
  };
  return { ...h, type, bar, pub, availability, book, pay, payments };
}

describe('settings (M11-03)', () => {
  it('saves the page and gives its address and embed snippet; the address is unique', async () => {
    const h = await hotel();
    const s = await h.ok<{ pageUrl: string; embedSnippet: string }>(
      h.gm.get('/booking-engine/settings'),
    );
    expect(s.pageUrl).toMatch(/\/demo-lagos$/);
    expect(s.embedSnippet).toContain(`<iframe src="${s.pageUrl}"`);
    expect((await h.fd.put('/booking-engine/settings', SETTINGS)).status).toBe(403);

    // Promo codes need the same permission.
    expect((await h.fd.get('/booking-engine/promo-codes')).status).toBe(403);
    const none = await h.gm.put('/booking-engine/settings', {
      ...SETTINGS,
      allowPayFull: false,
      allowDeposit: false,
      allowPayAtHotel: false,
    });
    expect(none.status).toBe(400);
  });

  it('a page that is off, or a hotel not live, is not found', async () => {
    const h = await hotel();
    await h.ok(h.gm.put('/booking-engine/settings', { ...SETTINGS, enabled: false }));
    expect((await h.pub().get('/properties/demo-lagos')).status).toBe(404);
    expect((await h.availability()).status).toBe(404);
  });
});

describe('the public page (M11-01)', () => {
  it('shows the hotel and only public plans, at the front desk’s prices', async () => {
    const h = await hotel();
    const page = await h.pub().get('/properties/demo-lagos');
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body).toMatchObject({ name: h.p1.name, headline: 'Stay in Lagos' });

    const staff = await h.ok<{
      roomTypes: { plans: { ratePlanId: string; totalMinor: string }[] }[];
    }>(h.fd.get(`/availability?arrival=${ARRIVAL}&departure=${DEPARTURE}&adults=1`));
    const res = await h.availability();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as Availability;
    expect(body.roomTypes[0]?.plans[0]?.totalMinor).toBe(staff.roomTypes[0]?.plans[0]?.totalMinor);

    await db.ratePlan.update({ where: { id: h.bar.id }, data: { isPublic: false } });
    expect(((await h.availability()).body as Availability).roomTypes).toEqual([]);
    const refused = await h.book();
    expect(refused.status).toBe(400);
  });
});

describe('booking (M11-01)', () => {
  it('paying at the hotel confirms at once, source DIRECT, and tells the guest', async () => {
    const h = await hotel();
    const res = await h.book({ marketingConsent: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const b = res.body as Created;
    expect(b).toMatchObject({ status: 'CONFIRMED', paymentUrl: null, amountDueNowMinor: '0' });
    const r = await db.reservation.findFirstOrThrow({
      where: { confirmationNo: b.confirmationNo },
      include: { booker: true },
    });
    expect(r).toMatchObject({ source: 'DIRECT', status: 'CONFIRMED', guarantee: 'NONE' });
    expect(r.booker.marketingConsent).toBe(true);

    const calendar = await h.ok<{ reservations?: unknown }>(
      h.fd.get(`/reservations?search=${b.confirmationNo}`),
    );
    expect(JSON.stringify(calendar)).toContain(b.confirmationNo);

    expect(
      (
        await db.notificationDelivery.findMany({ where: { templateCode: 'BOOKING_CONFIRMED' } })
      ).map((d) => d.channel),
    ).toEqual(expect.arrayContaining(['EMAIL', 'WHATSAPP']));
    expect(h.email.lastTo('bisi@guest.test')?.text).toContain(`/manage?token=${b.token}`);
  });

  it('the same key books once', async () => {
    const h = await hotel();
    const bookingKey = randomUUID();
    const first = (await h.book({ bookingKey })).body as Created;
    const again = await h.book({ bookingKey });
    expect(again.status).toBe(201);
    expect((again.body as Created).confirmationNo).toBe(first.confirmationNo);
    expect((again.body as Created).token).toBe(first.token);
    expect(await db.guestLink.count()).toBe(1);
  });

  it('never sells a room the desk could not: the one room left goes once', async () => {
    const h = await hotel();
    expect((await h.book()).status).toBe(201);
    const second = await h.book({ email: 'other@guest.test' });
    expect(second.status).toBe(409);
    expect(errorOf(second).code).toBe('BOOKING_CONFLICT');
  });

  it('one visitor can make only so many bookings a minute; payment returns only to our site', async () => {
    const h = await hotel();
    const away = await h.book({ payment: 'FULL', returnUrl: 'https://evil.example/pay' });
    expect(away.status).toBe(400);
    expect(errorOf(away).details).toMatchObject({
      issues: [expect.objectContaining({ path: 'body.returnUrl' })],
    });
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await h.book({ slug: 'no-such-page' })).status;
    expect(last).toBe(429);
  });

  it('a guest flagged do-not-rent is sent to the hotel', async () => {
    const h = await hotel();
    await db.guest.create({
      data: {
        organisationId: h.org.id,
        firstName: 'Bad',
        lastName: 'Guest',
        phone: '+2348031110000',
        doNotRent: true,
        flagReason: 'Unpaid bill',
      },
    });
    const res = await h.book();
    expect(res.status).toBe(409);
    expect(await db.guestLink.count()).toBe(0);
  });

  it('paying a deposit holds the room, and the payment confirms it', async () => {
    const h = await hotel();
    const res = await h.book({ payment: 'DEPOSIT' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const b = res.body as Created;
    expect(b.status).toBe('TENTATIVE');
    expect(b.paymentUrl).toBeTruthy();
    expect(b.amountDueNowMinor).toBe(((BigInt(b.totalMinor) * 3000n) / 10_000n).toString());

    const inv = await db.roomTypeInventory.findFirstOrThrow({
      where: { roomTypeId: h.type.id, date: new Date(`${ARRIVAL}T00:00:00Z`) },
    });
    expect(inv.held).toBe(1);

    const r = await h.pay(b.confirmationNo);
    expect(r.status).toBe('CONFIRMED');
    const after = await db.roomTypeInventory.findFirstOrThrow({
      where: { roomTypeId: h.type.id, date: new Date(`${ARRIVAL}T00:00:00Z`) },
    });
    expect(after).toMatchObject({ held: 0, sold: 1 });
    const view = (await h.pub().get(`/bookings/${b.token}`)).body as View;
    expect(view).toMatchObject({ status: 'CONFIRMED', paidMinor: b.amountDueNowMinor });
  });
});

describe('a payment after the hold ran out (M11 rule)', () => {
  it('books if a room is left', async () => {
    const h = await hotel();
    const b = (await h.book({ payment: 'FULL' })).body as Created;
    now = new Date(now.getTime() + 31 * 60_000);
    expect(await expireHolds(db, clock)).toBe(1);
    expect((await h.pay(b.confirmationNo)).status).toBe('CONFIRMED');
    expect(h.payments.refunds).toEqual([]);
  });

  it('refunds with notice if the room has gone', async () => {
    const h = await hotel();
    const b = (await h.book({ payment: 'FULL' })).body as Created;
    now = new Date(now.getTime() + 31 * 60_000);
    await expireHolds(db, clock);
    expect((await h.book({ email: 'second@guest.test' })).status).toBe(201);

    const r = await h.pay(b.confirmationNo);
    expect(r.status).toBe('CANCELLED');
    expect(h.payments.refunds).toEqual([
      expect.objectContaining({ amountMinor: BigInt(b.totalMinor) }),
    ]);
    const view = (await h.pub().get(`/bookings/${b.token}`)).body as View;
    expect(view.paidMinor).toBe('0');
    const notice = await db.notificationDelivery.findFirstOrThrow({
      where: { templateCode: 'BOOKING_REFUNDED' },
    });
    expect(notice.recipient).toBe('bisi@guest.test');
  });
});

describe('promo codes (M11-03)', () => {
  it('takes the discount off before tax, and stops at the limit', async () => {
    const h = await hotel();
    await h.ok(
      h.gm.send('/booking-engine/promo-codes', { code: 'WELCOME', discountBps: 1000, maxUses: 1 }),
    );
    const plain = ((await h.availability()).body as Availability).roomTypes[0]?.plans[0];
    const res = (await h.availability('&promo=welcome')).body as Availability;
    expect(res.promoApplied).toBe(true);
    const discounted = BigInt(res.roomTypes[0]?.plans[0]?.totalMinor ?? '0');
    expect(discounted).toBeLessThan(BigInt(plain?.totalMinor ?? '0'));

    const b = (await h.book({ promo: 'WELCOME' })).body as Created;
    expect(BigInt(b.totalMinor)).toBe(discounted);
    expect(await db.promoCode.findFirstOrThrow()).toMatchObject({ usedCount: 1 });

    const used = await h.book({ promo: 'WELCOME', email: 'o@guest.test' });
    expect(used.status).toBe(400);
    expect(errorOf(used).details).toMatchObject({
      issues: [expect.objectContaining({ path: 'body.promo' })],
    });
  });
});

describe('the guest’s link (M11-02)', () => {
  it('shows the booking; a wrong link is not found; the database keeps only a hash', async () => {
    const h = await hotel();
    const b = (await h.book()).body as Created;
    const view = await h.pub().get(`/bookings/${b.token}`);
    expect(view.status).toBe(200);
    expect((view.body as View).guestName).toBe('Bisi Adeyemi');
    expect((await h.pub().get(`/bookings/${'x'.repeat(43)}`)).status).toBe(404);
    expect((await db.guestLink.findFirstOrThrow()).tokenHash).not.toBe(b.token);
  });

  it('cancels free of charge while the policy allows', async () => {
    const h = await hotel();
    const b = (await h.book()).body as Created;
    const res = await h.pub().post(`/bookings/${b.token}/cancel`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as View).status).toBe('CANCELLED');
    const inv = await db.roomTypeInventory.findFirstOrThrow({
      where: { roomTypeId: h.type.id, date: new Date(`${ARRIVAL}T00:00:00Z`) },
    });
    expect(inv.sold).toBe(0);
    expect((await h.pub().post(`/bookings/${b.token}/cancel`, {})).status).toBe(409);
  });

  it('inside the fee window the guest must accept the fee they were shown', async () => {
    const h = await hotel();
    await db.cancellationPolicy.updateMany({
      data: { rules: [{ daysBefore: 30, feeType: 'NIGHTS', value: 1 }] },
    });
    const b = (await h.book()).body as Created;
    const shown = (await h.pub().get(`/bookings/${b.token}`)).body as View;
    expect(BigInt(shown.cancellation.feeMinor)).toBeGreaterThan(0n);

    const refused = await h.pub().post(`/bookings/${b.token}/cancel`, {});
    expect(refused.status).toBe(409);
    expect(errorOf(refused).details).toMatchObject({ reason: 'FEE_CHANGED' });
    const done = await h.pub().post(`/bookings/${b.token}/cancel`, {
      acceptedFeeMinor: shown.cancellation.feeMinor,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((done.body as View).status).toBe('CANCELLED');
  });
});
