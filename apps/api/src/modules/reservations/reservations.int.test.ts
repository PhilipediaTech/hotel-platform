import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';
import { createDefaultTaxes } from '../tax/defaults.ts';
import { expireHolds } from './service.ts';

// Reservations (PRD M3-01–M3-05, M3 rules 1 and 8, M3 acceptance on double booking and
// holds; tab 4 POST /reservations example; T-042).

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const TODAY = '2026-11-10';
const ARRIVE = '2026-11-12';
const LEAVE = '2026-11-14';

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Stay = {
  id: string;
  status: string;
  guest: { id: string; firstName: string };
  roomTypeId: string;
  arrival: string;
  departure: string;
  adults: number;
  nights: { date: string; amountMinor: string }[];
  totalMinor: string;
};
type Reservation = {
  id: string;
  confirmationNo: string;
  status: string;
  booker: { id: string; firstName: string; lastName: string };
  holdExpiresAt: string | null;
  totalMinor: string;
  depositDueMinor: string;
  stays: Stay[];
  version: number;
  cancelReason: string | null;
};

async function hotel(rooms = 2) {
  const h = await makeHotel(db, now);
  await db.property.update({ where: { id: h.p1.id }, data: { status: 'LIVE' } });
  await createDefaultTaxes(db, { id: h.p1.id, country: 'NG', settings: {} }, TODAY);
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => {
    const client = c.as(await sessionCookie(db, userId, clock));
    const key = () => randomUUID();
    return {
      ...client,
      /** POST with a fresh Idempotency-Key (the ● routes need one). */
      send: (path: string, body?: object) => client.post(path, body).set('Idempotency-Key', key()),
      change: (path: string, version: number, body: object) =>
        client.patch(path, body).set('If-Match', `"${version}"`),
    };
  };
  const gm = await as(h.gm.id);
  const fd = await as(h.fd.id);
  const ok = async <T>(res: Promise<{ status: number; body: unknown }>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body as T;
  };
  const std = await ok<{ id: string }>(gm.post('/room-types', { code: 'STD', name: 'Standard' }));
  const dlx = await ok<{ id: string }>(
    gm.post('/room-types', { code: 'DLX', name: 'Deluxe', maxOccupancy: 3 }),
  );
  for (let i = 1; i <= rooms; i++) {
    await ok(gm.post('/rooms', { number: String(100 + i), roomTypeId: std.id }));
  }
  await ok(gm.post('/rooms', { number: '201', roomTypeId: dlx.id }));
  const policy = await ok<{ id: string }>(
    gm.post('/cancellation-policies', {
      name: 'Two days',
      rules: [{ daysBefore: 2, feeType: 'NIGHTS', value: 1 }],
      noShowFee: { feeType: 'NIGHTS', value: 1 },
    }),
  );
  const bar = await ok<{ id: string }>(
    gm.post('/rate-plans', {
      cancellationPolicyId: policy.id,
      code: 'BAR',
      name: 'Best available',
      kind: 'BAR',
    }),
  );
  await ok(
    gm.put('/rate-calendar', {
      ratePlanId: bar.id,
      roomTypeIds: [std.id],
      from: TODAY,
      to: '2026-12-31',
      set: { amountMinor: '4500000' },
    }),
  );
  await ok(
    gm.put('/rate-calendar', {
      ratePlanId: bar.id,
      roomTypeIds: [dlx.id],
      from: TODAY,
      to: '2026-12-31',
      set: { amountMinor: '6500000' },
    }),
  );
  const quote = async (body: object = {}) =>
    (
      await ok<{ quoteId: string; totalMinor: string }>(
        fd.post('/quotes', {
          roomTypeId: std.id,
          ratePlanId: bar.id,
          arrival: ARRIVE,
          departure: LEAVE,
          adults: 2,
          ...body,
        }),
      )
    ).quoteId;
  const booking = (quoteIds: string[], extra: object = {}) => ({
    source: 'PHONE',
    guarantee: 'DEPOSIT',
    holdUntil: null,
    booker: {
      guestId: null,
      firstName: 'Ada',
      lastName: 'Obi',
      phone: '+2348000000000',
      email: 'ada@example.com',
    },
    companyId: null,
    stays: quoteIds.map((quoteId) => ({ quoteId, guest: { sameAsBooker: true }, roomId: null })),
    notes: 'Late arrival',
    ...extra,
  });
  const book = async (quoteIds: string[], extra: object = {}) =>
    ok<Reservation>(fd.send('/reservations', booking(quoteIds, extra)));
  const inventory = async (roomTypeId: string) =>
    (
      await db.roomTypeInventory.findMany({
        where: { roomTypeId, date: { gte: new Date(ARRIVE), lt: new Date(LEAVE) } },
        orderBy: { date: 'asc' },
      })
    ).map((i) => [i.sold, i.held]);
  return {
    ...h,
    fdId: h.fd.id,
    as,
    gm,
    fd,
    ok,
    std,
    dlx,
    bar,
    policy,
    quote,
    booking,
    book,
    inventory,
  };
}

describe('Booking from quotes (M3-01, M3-05)', () => {
  it('books the tab 4 example: confirmation number, stays, nights, deposit, inventory', async () => {
    const h = await hotel();
    const quoteId = await h.quote();
    const res = await h.fd.send('/reservations', h.booking([quoteId]));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers['etag']).toBe('"0"');
    const r = res.body as Reservation;
    expect(r).toMatchObject({
      confirmationNo: 'P1-00001',
      status: 'CONFIRMED',
      depositDueMinor: '4500000',
      version: 0,
      booker: { firstName: 'Ada', lastName: 'Obi' },
    });
    expect(r.stays).toHaveLength(1);
    expect(r.stays[0]).toMatchObject({
      arrival: ARRIVE,
      departure: LEAVE,
      status: 'CONFIRMED',
      adults: 2,
      nights: [
        { date: '2026-11-12', amountMinor: '4500000' },
        { date: '2026-11-13', amountMinor: '4500000' },
      ],
      totalMinor: '11092500',
    });
    // The new booker became a guest profile, and the stay is theirs.
    const guest = await db.guest.findFirstOrThrow({ where: { lastName: 'Obi' } });
    expect(r.stays[0]?.guest.id).toBe(guest.id);
    expect(await h.inventory(h.std.id)).toEqual([
      [1, 0],
      [1, 0],
    ]);
    const stored = await db.reservation.findUniqueOrThrow({
      where: { id: r.id },
      include: { history: true, stays: { include: { nights: true } } },
    });
    expect(stored.history.map((x) => [x.fromStatus, x.toStatus, x.byUserId])).toEqual([
      [null, 'CONFIRMED', h.fdId],
    ]);
    expect(stored.stays[0]?.nights.map((n) => n.ruleVersion)).toEqual([1, 1]);
    expect(await db.auditEvent.count({ where: { action: 'reservation.created' } })).toBe(1);
    expect(await db.domainEvent.count({ where: { type: 'reservation.created' } })).toBe(1);

    const second = await h.book([await h.quote()], { guarantee: 'NONE' });
    expect(second.confirmationNo).toBe('P1-00002');
    expect(second.depositDueMinor).toBe('0');
  });

  it('books several rooms under one booker with a guest per room (M3-05)', async () => {
    const h = await hotel();
    const kept = await db.guest.create({
      data: { organisationId: h.org.id, firstName: 'Bola', lastName: 'Ade' },
    });
    const r = await h.ok<Reservation>(
      h.fd.send('/reservations', {
        ...h.booking([]),
        stays: [
          { quoteId: await h.quote(), guest: { sameAsBooker: true } },
          { quoteId: await h.quote({ adults: 1 }), guest: { guestId: kept.id }, adults: 1 },
          {
            quoteId: await h.quote({ roomTypeId: h.dlx.id, adults: 3 }),
            guest: { firstName: 'Chidi', lastName: 'Eze' },
            adults: 2,
            children: 1,
          },
        ],
      }),
    );
    expect(r.stays.map((s) => s.guest.firstName).sort()).toEqual(['Ada', 'Bola', 'Chidi']);
    expect(r.depositDueMinor).toBe(String(4500000 * 2 + 6500000));
    expect(await h.inventory(h.std.id)).toEqual([
      [2, 0],
      [2, 0],
    ]);
    expect(await h.inventory(h.dlx.id)).toEqual([
      [1, 0],
      [1, 0],
    ]);
  });

  it('two agents booking the last room at the same instant: exactly one succeeds', async () => {
    const h = await hotel(1);
    const [q1, q2] = [await h.quote(), await h.quote()];
    const results = await Promise.all([
      h.fd.send('/reservations', h.booking([q1])),
      h.gm.send('/reservations', h.booking([q2])),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(errorOf(loser!).code).toBe('BOOKING_CONFLICT');
    expect(await db.reservation.count()).toBe(1);
    expect(await h.inventory(h.std.id)).toEqual([
      [1, 0],
      [1, 0],
    ]);
  });

  it('refuses until the property is live (403 PROPERTY_NOT_LIVE)', async () => {
    const h = await hotel();
    const quoteId = await h.quote();
    await db.property.update({ where: { id: h.p1.id }, data: { status: 'SETUP' } });
    const res = await h.fd.send('/reservations', h.booking([quoteId]));
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('PROPERTY_NOT_LIVE');
    expect(await db.reservation.count()).toBe(0);
  });

  it('keeps to the quote: not expired, booked once, for the guests it priced', async () => {
    const h = await hotel();
    const quoteId = await h.quote();
    const tooMany = await h.fd.send('/reservations', {
      ...h.booking([]),
      stays: [{ quoteId, adults: 1 }],
    });
    expect(errorOf(tooMany).code).toBe('VALIDATION_ERROR');
    expect(errorOf(tooMany).details?.['issues']).toEqual([
      expect.objectContaining({ path: 'body.stays.0.adults' }),
    ]);
    const roomGiven = await h.fd.send('/reservations', {
      ...h.booking([]),
      stays: [{ quoteId, roomId: randomUUID() }],
    });
    expect(errorOf(roomGiven).code).toBe('VALIDATION_ERROR');

    await h.book([quoteId]);
    const again = await h.fd.send('/reservations', h.booking([quoteId]));
    expect(errorOf(again)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { reason: 'QUOTE_USED' },
    });

    const late = await h.quote();
    now = new Date(now.getTime() + 31 * 60_000);
    const expired = await h.fd.send('/reservations', h.booking([late]));
    expect(errorOf(expired)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { reason: 'QUOTE_EXPIRED' },
    });
    expect(await db.reservation.count()).toBe(1);
  });

  it('replays the same Idempotency-Key without booking twice', async () => {
    const h = await hotel();
    const body = h.booking([await h.quote()]);
    const key = randomUUID();
    const first = await h.fd.post('/reservations', body).set('Idempotency-Key', key);
    const second = await h.fd.post('/reservations', body).set('Idempotency-Key', key);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect((second.body as Reservation).id).toBe((first.body as Reservation).id);
    expect(await db.reservation.count()).toBe(1);
  });
});

describe('Tentative holds (M3-02)', () => {
  it('holds rooms until the time set, then releases them within a minute', async () => {
    const h = await hotel(1);
    const holdUntil = '2026-11-10T12:00:00Z';
    const r = await h.book([await h.quote()], { holdUntil });
    expect(r).toMatchObject({ status: 'TENTATIVE', holdExpiresAt: holdUntil });
    expect(await h.inventory(h.std.id)).toEqual([
      [0, 1],
      [0, 1],
    ]);
    // A live hold takes the room (M2 acceptance: held rooms are not sellable).
    const full = await h.fd.post('/quotes', {
      roomTypeId: h.std.id,
      ratePlanId: h.bar.id,
      arrival: ARRIVE,
      departure: LEAVE,
      adults: 1,
    });
    expect(errorOf(full).code).toBe('BOOKING_CONFLICT');

    now = new Date('2026-11-10T11:59:59Z');
    expect(await expireHolds(db, clock)).toBe(0);
    now = new Date('2026-11-10T12:00:30Z');
    expect(await expireHolds(db, clock)).toBe(1);
    expect(await h.inventory(h.std.id)).toEqual([
      [0, 0],
      [0, 0],
    ]);
    const after = await h.ok<Reservation>(h.fd.get(`/reservations/${r.id}`));
    expect(after).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'HOLD_EXPIRED',
      holdExpiresAt: null,
    });
    expect(after.stays.map((s) => s.status)).toEqual(['CANCELLED']);
    expect(await db.auditEvent.count({ where: { action: 'reservation.hold_expired' } })).toBe(1);
    expect(await expireHolds(db, clock)).toBe(0);
  });

  it('a hold is moved or confirmed; confirming turns held rooms into sold ones', async () => {
    const h = await hotel();
    const r = await h.book([await h.quote()], { holdUntil: '2026-11-10T12:00:00Z' });
    const moved = await h.ok<Reservation>(
      h.fd.change(`/reservations/${r.id}`, 0, { holdUntil: '2026-11-10T18:00:00Z' }),
    );
    expect(moved.holdExpiresAt).toBe('2026-11-10T18:00:00Z');
    const confirmed = await h.ok<Reservation>(
      h.fd.change(`/reservations/${r.id}`, 1, { confirm: true }),
    );
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', holdExpiresAt: null, version: 2 });
    expect(await h.inventory(h.std.id)).toEqual([
      [1, 0],
      [1, 0],
    ]);
    // Confirmed: no longer a hold, and confirming again is not a transition.
    const twice = await h.fd.change(`/reservations/${r.id}`, 2, { confirm: true });
    expect(errorOf(twice).code).toBe('STATE_TRANSITION_INVALID');
    const holdAgain = await h.fd.change(`/reservations/${r.id}`, 2, {
      holdUntil: '2026-11-10T20:00:00Z',
    });
    expect(errorOf(holdAgain).code).toBe('VALIDATION_ERROR');
  });
});

describe('Changes (M3-03)', () => {
  it('requotes a stay: moves its nights and answers the difference', async () => {
    const h = await hotel();
    const r = await h.book([await h.quote()]);
    const longer = await h.quote({ departure: '2026-11-15' });
    const res = await h.fd.change(`/reservations/${r.id}`, 0, {
      stays: [{ stayId: r.stays[0]?.id, quoteId: longer }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['etag']).toBe('"1"');
    const changed = res.body as Reservation & { differenceMinor: string };
    expect(changed.stays[0]).toMatchObject({ departure: '2026-11-15', totalMinor: '16638750' });
    expect(changed.stays[0]?.nights).toHaveLength(3);
    expect(changed.differenceMinor).toBe(String(16638750 - 11092500));
    const nights = await db.roomTypeInventory.findMany({
      where: { roomTypeId: h.std.id, date: { gte: new Date(ARRIVE), lt: new Date('2026-11-16') } },
      orderBy: { date: 'asc' },
    });
    expect(nights.map((n) => n.sold)).toEqual([1, 1, 1, 0]);

    // Moving to another room type takes that type's rooms instead.
    const deluxe = await h.quote({ roomTypeId: h.dlx.id });
    await h.ok(
      h.fd.change(`/reservations/${r.id}`, 1, {
        stays: [{ stayId: r.stays[0]?.id, quoteId: deluxe }],
      }),
    );
    expect(await h.inventory(h.std.id)).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(await h.inventory(h.dlx.id)).toEqual([
      [1, 0],
      [1, 0],
    ]);
    expect(await db.auditEvent.count({ where: { action: 'reservation.modified' } })).toBe(2);
  });

  it('refuses a stale version, a full night, and changes to a cancelled booking', async () => {
    const h = await hotel(1);
    const r = await h.book([await h.quote()]);
    const stale = await h.fd.change(`/reservations/${r.id}`, 5, { notes: 'x' });
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');

    // Another booking fills the night after; extending into it is a conflict, nothing moves.
    const next = await h.quote({ arrival: LEAVE, departure: '2026-11-15' });
    await h.book([next]);
    await db.quote.updateMany({ data: { expiresAt: new Date('2026-11-11T00:00:00Z') } });
    const overlap = await db.quote.create({
      data: {
        ...(await db.quote.findUniqueOrThrow({ where: { id: next } })),
        id: randomUUID(),
        arrival: new Date(ARRIVE),
        departure: new Date('2026-11-15'),
      } as never,
    });
    const full = await h.fd.change(`/reservations/${r.id}`, 0, {
      stays: [{ stayId: r.stays[0]?.id, quoteId: overlap.id }],
    });
    expect(errorOf(full).code).toBe('BOOKING_CONFLICT');
    expect(await h.inventory(h.std.id)).toEqual([
      [1, 0],
      [1, 0],
    ]);

    const notes = await h.ok<Reservation>(
      h.fd.change(`/reservations/${r.id}`, 0, { notes: 'Airport pickup' }),
    );
    expect(notes.version).toBe(1);
    await h.ok(h.fd.send(`/reservations/${r.id}/cancel`, { reason: 'GUEST_REQUEST' }));
    const late = await h.fd.change(`/reservations/${r.id}`, 2, {
      stays: [{ stayId: r.stays[0]?.id, adults: 1 }],
    });
    expect(errorOf(late).code).toBe('STATE_TRANSITION_INVALID');
  });
});

describe('Cancel and reinstate (M3-04)', () => {
  it('cancels with a reason, charges the policy fee and gives back the rooms', async () => {
    const h = await hotel();
    // Arrival in two days: the "2 days or fewer → 1 night" rule applies.
    const r = await h.book([await h.quote()]);
    const res = await h.fd.send(`/reservations/${r.id}/cancel`, {
      reason: 'GUEST_REQUEST',
      note: 'Flight cancelled',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'GUEST_REQUEST',
      feeMinor: '4500000',
    });
    expect(await h.inventory(h.std.id)).toEqual([
      [0, 0],
      [0, 0],
    ]);
    const event = await db.domainEvent.findFirstOrThrow({
      where: { type: 'reservation.cancelled' },
    });
    expect(event.payload).toMatchObject({ reason: 'GUEST_REQUEST', feeMinor: '4500000' });

    const twice = await h.fd.send(`/reservations/${r.id}/cancel`, { reason: 'GUEST_REQUEST' });
    expect(errorOf(twice).code).toBe('STATE_TRANSITION_INVALID');

    // Earlier than the policy's window, or the hotel's own reason: no fee.
    const early = await h.book([await h.quote({ arrival: '2026-11-20', departure: '2026-11-21' })]);
    expect(
      await h.ok(h.fd.send(`/reservations/${early.id}/cancel`, { reason: 'CHANGE_OF_PLANS' })),
    ).toMatchObject({ feeMinor: '0' });
    const duplicate = await h.book([await h.quote()]);
    expect(
      await h.ok(h.fd.send(`/reservations/${duplicate.id}/cancel`, { reason: 'DUPLICATE' })),
    ).toMatchObject({ feeMinor: '0' });
  });

  it('reinstates while rooms are free, and refuses when they are gone', async () => {
    const h = await hotel(1);
    const r = await h.book([await h.quote()]);
    await h.ok(h.fd.send(`/reservations/${r.id}/cancel`, { reason: 'GUEST_REQUEST' }));
    const back = await h.ok<Reservation>(h.fd.send(`/reservations/${r.id}/reinstate`));
    expect(back).toMatchObject({ status: 'CONFIRMED', cancelReason: null });
    expect(back.stays.map((s) => s.status)).toEqual(['CONFIRMED']);
    expect(await h.inventory(h.std.id)).toEqual([
      [1, 0],
      [1, 0],
    ]);
    const notCancelled = await h.fd.send(`/reservations/${r.id}/reinstate`);
    expect(errorOf(notCancelled).code).toBe('STATE_TRANSITION_INVALID');

    await h.ok(h.fd.send(`/reservations/${r.id}/cancel`, { reason: 'GUEST_REQUEST' }));
    await h.book([await h.quote()]);
    const gone = await h.fd.send(`/reservations/${r.id}/reinstate`);
    expect(errorOf(gone).code).toBe('BOOKING_CONFLICT');
    expect((await db.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      'CANCELLED',
    );

    const history = await h.ok<{
      data: {
        fromStatus: string | null;
        toStatus: string;
        reason: string | null;
        byName: string | null;
      }[];
    }>(h.fd.get(`/reservations/${r.id}/history`));
    expect(history.data.map((x) => [x.fromStatus, x.toStatus, x.reason])).toEqual([
      [null, 'CONFIRMED', null],
      ['CONFIRMED', 'CANCELLED', 'GUEST_REQUEST'],
      ['CANCELLED', 'CONFIRMED', 'REINSTATED'],
      ['CONFIRMED', 'CANCELLED', 'GUEST_REQUEST'],
    ]);
    expect(history.data[0]?.byName).toBeTruthy();
  });
});

describe('Do-not-rent guests (M3 rule 8)', () => {
  it('warns the desk, waits for a manager, and books once approved', async () => {
    const h = await hotel();
    const flagged = await db.guest.create({
      data: {
        organisationId: h.org.id,
        firstName: 'Kunle',
        lastName: 'Bad',
        doNotRent: true,
        flagReason: 'Damaged room 2025',
      },
    });
    const body = { ...h.booking([await h.quote()]), booker: { guestId: flagged.id } };
    const warned = await h.fd.send('/reservations', body);
    expect(errorOf(warned)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { doNotRent: true },
    });

    const pending = await h.fd.send('/reservations', {
      ...body,
      approvalReason: 'Paid the damage in full',
    });
    expect(pending.status, JSON.stringify(pending.body)).toBe(202);
    expect(await db.reservation.count()).toBe(0);
    const { approvalRequestId } = pending.body as { approvalRequestId: string };

    now = new Date(now.getTime() + 10 * 60_000);
    await h.gm.post(`/approvals/${approvalRequestId}/approve`, {}).expect(200);
    const booked = await db.reservation.findFirstOrThrow({ include: { stays: true } });
    expect(booked).toMatchObject({ bookerGuestId: flagged.id, status: 'CONFIRMED' });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'reservation.created' },
    });
    expect(audit).toMatchObject({ approvalRequestId, actorUserId: h.fdId });
  });

  it('a manager books a do-not-rent guest directly', async () => {
    const h = await hotel();
    const flagged = await db.guest.create({
      data: {
        organisationId: h.org.id,
        firstName: 'Kunle',
        lastName: 'Bad',
        doNotRent: true,
        flagReason: 'Damaged room 2025',
      },
    });
    const res = await h.gm.send('/reservations', {
      ...h.booking([await h.quote()]),
      booker: { guestId: flagged.id },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('Finding and merging', () => {
  it('lists by name, confirmation number, status and arrival', async () => {
    const h = await hotel();
    const a = await h.book([await h.quote()]);
    now = new Date(now.getTime() + 60_000);
    const b = await h.book([await h.quote({ arrival: '2026-11-20', departure: '2026-11-21' })], {
      booker: { firstName: 'Bola', lastName: 'Ade', phone: '+2348031112222' },
      holdUntil: '2026-11-10T12:00:00Z',
    });
    const list = async (q: string) =>
      (
        await h.ok<{ data: { id: string; bookerName: string; rooms: number }[] }>(
          h.fd.get(`/reservations?${q}`),
        )
      ).data.map((x) => x.id);
    expect(await list('')).toEqual([b.id, a.id]);
    expect(await list('q=obi')).toEqual([a.id]);
    expect(await list(`q=${b.confirmationNo}`)).toEqual([b.id]);
    expect(await list('q=08031112222')).toEqual([b.id]);
    expect(await list('status=TENTATIVE')).toEqual([b.id]);
    expect(await list('arrivalFrom=2026-11-15')).toEqual([b.id]);
    expect(await list('arrivalTo=2026-11-12')).toEqual([a.id]);
  });

  it('a guest merge moves their reservations and stays to the kept profile', async () => {
    const h = await hotel();
    const kept = await db.guest.create({
      data: {
        organisationId: h.org.id,
        firstName: 'Ada',
        lastName: 'Obi',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const r = await h.book([await h.quote()]);
    await h.ok(h.gm.post(`/guests/${r.booker.id}/merge`, { otherGuestId: kept.id }));
    const moved = await h.ok<Reservation>(h.fd.get(`/reservations/${r.id}`));
    expect(moved.booker.id).toBe(kept.id);
    expect(moved.stays[0]?.guest.id).toBe(kept.id);
  });
});
