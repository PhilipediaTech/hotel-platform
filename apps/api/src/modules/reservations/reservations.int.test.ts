import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';
import { createDefaultTaxes } from '../tax/defaults.ts';
import { idPurgeJob } from './check-in.ts';
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

describe('Calendar (S07; T-044)', () => {
  type CalendarStay = {
    id: string;
    reservationId: string;
    confirmationNo: string;
    status: string;
    roomTypeId: string;
    roomId: string | null;
    arrival: string;
    departure: string;
    guestName: string;
  };
  const calendar = async (h: Awaited<ReturnType<typeof hotel>>, from: string, to: string) =>
    (await h.ok<{ data: CalendarStay[] }>(h.fd.get(`/calendar?from=${from}&to=${to}`))).data;

  it('lists stays in the window, unassigned, and leaves out cancelled ones', async () => {
    const h = await hotel();
    const a = await h.book([await h.quote()]);
    const b = await h.book([
      await h.quote({ arrival: '2026-11-20', departure: '2026-11-22', adults: 1 }),
    ]);
    const gone = await h.book([
      await h.quote({ arrival: '2026-11-13', departure: '2026-11-14', adults: 1 }),
    ]);
    await h.ok(h.fd.send(`/reservations/${gone.id}/cancel`, { reason: 'DUPLICATE' }));

    const window = await calendar(h, TODAY, '2026-11-24');
    expect(window.map((s) => s.reservationId)).toEqual([a.id, b.id]);
    expect(window[0]).toMatchObject({
      confirmationNo: a.confirmationNo,
      status: 'CONFIRMED',
      roomTypeId: h.std.id,
      roomId: null,
      arrival: ARRIVE,
      departure: LEAVE,
      guestName: 'Ada Obi',
    });
    // A stay is in the window when it has a night in it: departing on `from` is not.
    expect((await calendar(h, LEAVE, '2026-11-20')).map((s) => s.id)).toEqual([]);
    expect((await calendar(h, '2026-11-13', '2026-11-14')).map((s) => s.reservationId)).toEqual([
      a.id,
    ]);
  });

  it('refuses a window over 31 days and needs frontdesk.read', async () => {
    const h = await hotel();
    const long = await h.fd.get(`/calendar?from=${TODAY}&to=2026-12-12`);
    expect(long.status).toBe(400);
    const backwards = await h.fd.get(`/calendar?from=${LEAVE}&to=${ARRIVE}`);
    expect(backwards.status).toBe(400);
    const hk = await h.person('hk-attendant', h.p1.id);
    const attendant = await h.as(hk.id);
    expect((await attendant.get(`/calendar?from=${TODAY}&to=${LEAVE}`)).status).toBe(403);
  });
});

describe('Rooms for stays (M3-07, M3-11; T-050)', () => {
  type Item = Reservation & { stays: (Stay & { roomId: string | null; version: number })[] };
  const roomsOf = async () =>
    Object.fromEntries((await db.room.findMany()).map((r) => [r.number, r.id])) as Record<
      string,
      string
    >;
  const setRoom = (id: string | undefined, hkStatus: 'CLEAN' | 'DIRTY' | 'INSPECTED') =>
    db.room.update({ where: { id: id ?? '' }, data: { hkStatus } });
  const assign = (h: Awaited<ReturnType<typeof hotel>>, stayId: string, body: object, as = h.fd) =>
    as.post(`/stays/${stayId}/assign-room`, body);
  const stayOf = (r: Reservation) => r.stays[0]?.id ?? '';

  it('gives a booking a room, lists only free rooms, and never double-books a room', async () => {
    const h = await hotel(3);
    const room = await roomsOf();
    const a = await h.book([await h.quote()]);
    const b = await h.book([await h.quote()]);
    const c = await h.book([await h.quote()]);

    const free = await h.ok<{ data: { number: string; problems: string[] }[] }>(
      h.fd.get(`/stays/${stayOf(a)}/rooms`),
    );
    // Arriving in two days: housekeeping status does not matter yet.
    expect(free.data).toEqual([
      expect.objectContaining({ number: '101', problems: [] }),
      expect.objectContaining({ number: '102', problems: [] }),
      expect.objectContaining({ number: '103', problems: [] }),
    ]);
    const given = await h.ok<Item>(assign(h, stayOf(a), { roomId: room['101'] }));
    expect(given.stays[0]?.roomId).toBe(room['101']);
    expect(given.version).toBe(a.version + 1);

    // 101 is no longer offered to the others, and can't be given to them.
    const left = await h.ok<{ data: { number: string }[] }>(h.fd.get(`/stays/${stayOf(b)}/rooms`));
    expect(left.data.map((r) => r.number)).toEqual(['102', '103']);
    expect(errorOf(await assign(h, stayOf(b), { roomId: room['101'] }))).toMatchObject({
      code: 'BOOKING_CONFLICT',
    });

    // Two desks give 102 to two stays at the same instant: exactly one wins.
    const race = await Promise.all([
      assign(h, stayOf(b), { roomId: room['102'] }),
      assign(h, stayOf(c), { roomId: room['102'] }),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.roomAllocation.count({ where: { roomId: room['102'], active: true } })).toBe(1);

    const calendar = await h.ok<{
      data: { reservationId: string; rooms: { roomId: string; startDate: string }[] }[];
    }>(h.fd.get(`/calendar?from=${TODAY}&to=2026-11-20`));
    expect(calendar.data.find((s) => s.reservationId === a.id)?.rooms).toEqual([
      { roomId: room['101'], startDate: ARRIVE, endDate: LEAVE },
    ]);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'stay.room_assigned', entityId: stayOf(a) },
    });
    expect(audit.after).toEqual({ roomId: room['101'] });
  });

  it('refuses rooms of another type, blocked rooms, and blocking a room a guest has', async () => {
    const h = await hotel();
    const room = await roomsOf();
    const a = await h.book([await h.quote()]);
    expect(errorOf(await assign(h, stayOf(a), { roomId: room['201'] }))).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await h.ok(
      h.gm.post('/room-blocks', {
        roomId: room['102'],
        kind: 'OUT_OF_SERVICE',
        startDate: '2026-11-13',
        endDate: '2026-11-15',
        reason: 'Painting',
      }),
    );
    expect(errorOf(await assign(h, stayOf(a), { roomId: room['102'] }))).toMatchObject({
      code: 'BOOKING_CONFLICT',
    });
    await h.ok(assign(h, stayOf(a), { roomId: room['101'] }));
    const block = await h.gm.post('/room-blocks', {
      roomId: room['101'],
      kind: 'OUT_OF_ORDER',
      startDate: '2026-11-13',
      endDate: '2026-11-14',
      reason: 'Leak',
    });
    expect(errorOf(block)).toMatchObject({
      code: 'BOOKING_CONFLICT',
      details: { stayId: stayOf(a) },
    });
  });

  it('a guest arriving today gets a clean, empty room unless a manager approves', async () => {
    const h = await hotel();
    const room = await roomsOf();
    const a = await h.book([await h.quote({ arrival: TODAY, departure: ARRIVE })]);
    // New rooms start dirty.
    const free = await h.ok<{ data: { number: string; problems: string[] }[] }>(
      h.fd.get(`/stays/${stayOf(a)}/rooms`),
    );
    expect(free.data.map((r) => [r.number, r.problems])).toEqual([
      ['101', ['NOT_CLEAN']],
      ['102', ['NOT_CLEAN']],
    ]);
    expect(errorOf(await assign(h, stayOf(a), { roomId: room['101'] }))).toMatchObject({
      code: 'ROOM_NOT_READY',
      details: { problems: ['NOT_CLEAN'], hkStatus: 'DIRTY' },
    });
    await setRoom(room['102'], 'INSPECTED');
    await h.ok(assign(h, stayOf(a), { roomId: room['102'] }));

    // Override: the desk asks, a manager approves, the room is given.
    const b = await h.book([await h.quote({ arrival: TODAY, departure: ARRIVE })]);
    const asked = await assign(h, stayOf(b), {
      roomId: room['101'],
      overrideReason: 'Guest will wait in the lounge while it is cleaned',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect((await db.stay.findUniqueOrThrow({ where: { id: stayOf(b) } })).roomId).toBeNull();
    const { approvalRequestId } = asked.body as { approvalRequestId: string };
    await h.gm.post(`/approvals/${approvalRequestId}/approve`, {}).expect(200);
    expect((await db.stay.findUniqueOrThrow({ where: { id: stayOf(b) } })).roomId).toBe(
      room['101'],
    );
    const allocation = await db.roomAllocation.findFirstOrThrow({
      where: { stayId: stayOf(b), active: true },
    });
    expect(allocation.reason).toBe('Guest will wait in the lounge while it is cleaned');
  });

  it('a requote keeps the room when it is free; cancelling and taking it back free it', async () => {
    const h = await hotel();
    const room = await roomsOf();
    const a = await h.book([await h.quote()]);
    const given = await h.ok<Item>(assign(h, stayOf(a), { roomId: room['101'] }));
    // One more night: 101 is free, so it stays.
    const longer = await h.ok<Item>(
      h.fd.change(`/reservations/${a.id}`, given.version, {
        stays: [{ stayId: stayOf(a), quoteId: await h.quote({ departure: '2026-11-15' }) }],
      }),
    );
    expect(longer.stays[0]?.roomId).toBe(room['101']);
    const allocation = await db.roomAllocation.findFirstOrThrow({
      where: { stayId: stayOf(a), active: true },
    });
    expect(allocation.endDate.toISOString().slice(0, 10)).toBe('2026-11-15');

    // Someone else has 101 on the 16th: moving there drops the room.
    const b = await h.book([await h.quote({ arrival: '2026-11-16', departure: '2026-11-17' })]);
    await h.ok(assign(h, stayOf(b), { roomId: room['101'] }));
    const moved = await h.ok<Item>(
      h.fd.change(`/reservations/${a.id}`, longer.version, {
        stays: [
          {
            stayId: stayOf(a),
            quoteId: await h.quote({ arrival: '2026-11-15', departure: '2026-11-17' }),
          },
        ],
      }),
    );
    expect(moved.stays[0]?.roomId).toBeNull();

    // Taking the room back, and cancelling, free it for others.
    const c = await h.book([await h.quote()]);
    await h.ok(assign(h, stayOf(c), { roomId: room['101'] }));
    await h.ok(assign(h, stayOf(c), { roomId: null }));
    expect(await db.roomAllocation.count({ where: { stayId: stayOf(c), active: true } })).toBe(0);
    await h.ok(assign(h, stayOf(c), { roomId: room['102'] }));
    await h.ok(h.fd.send(`/reservations/${c.id}/cancel`, { reason: 'DUPLICATE' }));
    expect(await db.roomAllocation.count({ where: { stayId: stayOf(c), active: true } })).toBe(0);
    const d = await h.book([await h.quote()]);
    await h.ok(assign(h, stayOf(d), { roomId: room['102'] }));
  });

  it('an expired hold gives its room back', async () => {
    const h = await hotel();
    const room = await roomsOf();
    const held = await h.book([await h.quote()], { holdUntil: '2026-11-10T10:00:00Z' });
    await h.ok(assign(h, stayOf(held), { roomId: room['101'] }));
    now = new Date('2026-11-10T10:01:00Z');
    await expireHolds(db, clock);
    expect(await db.roomAllocation.count({ where: { active: true } })).toBe(0);
    expect((await db.stay.findUniqueOrThrow({ where: { id: stayOf(held) } })).roomId).toBeNull();
  });

  /** A stay from today to LEAVE in 101, checked in, two days on (check-in itself is T-051). */
  async function inHouse(h: Awaited<ReturnType<typeof hotel>>) {
    const room = await roomsOf();
    const a = await h.book([await h.quote({ arrival: TODAY })]);
    await setRoom(room['101'], 'CLEAN');
    await h.ok(assign(h, stayOf(a), { roomId: room['101'] }));
    await db.stay.update({
      where: { id: stayOf(a) },
      data: { status: 'CHECKED_IN', checkedInAt: now },
    });
    await db.reservation.update({ where: { id: a.id }, data: { status: 'CHECKED_IN' } });
    now = new Date('2026-11-12T09:00:00Z');
    // Two days on: sign in again (sessions end when idle).
    const gmId = (await db.membership.findFirstOrThrow({ where: { roleId: h.role('gm') } })).userId;
    return { a, room, fd: await h.as(h.fdId), gm: await h.as(gmId) };
  }

  it('moves a checked-in guest from today on; the old room becomes dirty', async () => {
    const h0 = await hotel();
    const { a, room, fd, gm } = await inHouse(h0);
    const h = { ...h0, fd, gm };
    expect(errorOf(await assign(h, stayOf(a), { roomId: room['102'] }))).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
    });
    const dirty = await h.fd.send(`/stays/${stayOf(a)}/move`, {
      roomId: room['102'],
      reason: 'Noisy air conditioner',
    });
    expect(errorOf(dirty)).toMatchObject({ code: 'ROOM_NOT_READY' });

    await setRoom(room['102'], 'CLEAN');
    const moved = await h.ok<Item>(
      h.fd.send(`/stays/${stayOf(a)}/move`, {
        roomId: room['102'],
        reason: 'Noisy air conditioner',
      }),
    );
    expect(moved.stays[0]?.roomId).toBe(room['102']);
    const allocations = await db.roomAllocation.findMany({
      where: { stayId: stayOf(a), active: true },
      orderBy: { startDate: 'asc' },
    });
    expect(
      allocations.map((x) => [
        x.roomId,
        x.startDate.toISOString().slice(0, 10),
        x.endDate.toISOString().slice(0, 10),
      ]),
    ).toEqual([
      [room['101'], TODAY, '2026-11-12'],
      [room['102'], '2026-11-12', LEAVE],
    ]);
    expect((await db.room.findUniqueOrThrow({ where: { id: room['101'] } })).hkStatus).toBe(
      'DIRTY',
    );
    expect(
      await db.auditEvent.count({ where: { action: 'stay.moved', entityId: stayOf(a) } }),
    ).toBe(1);
    // Only checked-in guests are moved.
    const quote = await h.ok<{ quoteId: string }>(
      fd.post('/quotes', {
        roomTypeId: h.std.id,
        ratePlanId: h.bar.id,
        arrival: '2026-11-13',
        departure: LEAVE,
        adults: 1,
      }),
    );
    const b = await h.ok<Reservation>(fd.send('/reservations', h.booking([quote.quoteId])));
    const notIn = await h.fd.send(`/stays/${stayOf(b)}/move`, {
      roomId: room['101'],
      reason: 'Wrong room',
    });
    expect(errorOf(notIn)).toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
  });

  it('a move between midnight and 05:00 needs approval unless the caller is a manager', async () => {
    const h0 = await hotel();
    const { a, room, fd, gm } = await inHouse(h0);
    const h = { ...h0, fd, gm };
    await setRoom(room['102'], 'CLEAN');
    now = new Date('2026-11-12T00:30:00Z'); // 01:30 in Lagos
    const asked = await h.fd.send(`/stays/${stayOf(a)}/move`, {
      roomId: room['102'],
      reason: 'Leaking ceiling',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect((await db.stay.findUniqueOrThrow({ where: { id: stayOf(a) } })).roomId).toBe(
      room['101'],
    );
    const { approvalRequestId } = asked.body as { approvalRequestId: string };
    await h.gm.post(`/approvals/${approvalRequestId}/approve`, {}).expect(200);
    expect((await db.stay.findUniqueOrThrow({ where: { id: stayOf(a) } })).roomId).toBe(
      room['102'],
    );
    await setRoom(room['101'], 'CLEAN');
    const direct = await h.gm.send(`/stays/${stayOf(a)}/move`, {
      roomId: room['101'],
      reason: 'Back after the repair',
    });
    expect(direct.status, JSON.stringify(direct.body)).toBe(200);
  });

  it('sets housekeeping status with hk.work or hk.inspect', async () => {
    const h = await hotel();
    const room = await roomsOf();
    const r101 = await db.room.findUniqueOrThrow({ where: { id: room['101'] } });
    const status = (as: typeof h.fd, hkStatus: string, version: number) =>
      as.patch(`/rooms/${r101.id}/hk-status`, { hkStatus }).set('If-Match', `"${version}"`);
    expect((await status(h.fd, 'CLEAN', r101.version)).status).toBe(403);
    const attendant = await h.as((await h.person('hk-attendant', h.p1.id)).id);
    const clean = await h.ok<{ hkStatus: string; version: number }>(
      status(attendant, 'CLEAN', r101.version),
    );
    expect(clean.hkStatus).toBe('CLEAN');
    expect((await status(attendant, 'INSPECTED', clean.version)).status).toBe(403);
    expect(errorOf(await status(h.gm, 'INSPECTED', r101.version))).toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    const inspected = await h.ok<{ hkStatus: string }>(status(h.gm, 'INSPECTED', clean.version));
    expect(inspected.hkStatus).toBe('INSPECTED');
  });
});

describe('Check-in (M3-08, M3-19, M3 rules 2 and 6; T-051)', () => {
  type Card = {
    idNumberMasked: string | null;
    idType: string | null;
    nationality: string | null;
    purpose: string | null;
    address: string | null;
    roomNumber: string;
    signature: string;
    checkedInBy: string | null;
  };
  const registration = {
    nationality: 'ng',
    purpose: 'BUSINESS',
    idType: 'PASSPORT',
    idNumber: 'A12345678',
    address: '12 Marina Road, Lagos',
  };

  /** Booked for today in 101 (clean); returns what check-in needs. */
  async function arriving(h: Awaited<ReturnType<typeof hotel>>, clean = true) {
    const room = Object.fromEntries((await db.room.findMany()).map((r) => [r.number, r.id]));
    const r = await h.book([await h.quote({ arrival: TODAY })]);
    const stayId = r.stays[0]?.id ?? '';
    if (clean) await db.room.update({ where: { id: room['101'] }, data: { hkStatus: 'CLEAN' } });
    await h.ok(h.fd.post(`/stays/${stayId}/assign-room`, { roomId: room['101'] }));
    const version = (await db.stay.findUniqueOrThrow({ where: { id: stayId } })).version;
    const checkIn = (body: object, v = version, key = randomUUID()) =>
      h.fd
        .post(`/stays/${stayId}/check-in`, body)
        .set('Idempotency-Key', key)
        .set('If-Match', `"${v}"`);
    return { r, stayId, room, version, checkIn };
  }

  it('checks a guest in: room, registration, encrypted ID, card, keys and history', async () => {
    const h = await hotel();
    const a = await arriving(h);
    const res = await a.checkIn({ registration, keysIssued: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The tab 4 example's answer.
    expect(res.body).toEqual({
      stayId: a.stayId,
      status: 'CHECKED_IN',
      folioId: null,
      roomId: a.room['101'],
      version: a.version + 1,
    });
    const reservation = await h.ok<Reservation>(h.fd.get(`/reservations/${a.r.id}`));
    expect(reservation.status).toBe('CHECKED_IN');
    expect(reservation.stays[0]?.status).toBe('CHECKED_IN');
    const history = await h.ok<{ data: { toStatus: string; stayId: string | null }[] }>(
      h.fd.get(`/reservations/${a.r.id}/history`),
    );
    expect(history.data.at(-1)).toMatchObject({ toStatus: 'CHECKED_IN', stayId: a.stayId });

    // The ID number is stored encrypted only; the card shows its last four characters.
    const doc = await db.idDocument.findFirstOrThrow();
    expect(doc.docType).toBe('PASSPORT');
    expect(Buffer.from(doc.numberEnc ?? []).toString('latin1')).not.toContain('A12345678');
    expect(doc.purgeAfter.toISOString().slice(0, 10)).toBe('2027-11-10');
    const card = await h.ok<Card>(h.fd.get(`/stays/${a.stayId}/registration-card`));
    expect(card).toMatchObject({
      idNumberMasked: '•••• 5678',
      idType: 'PASSPORT',
      nationality: 'NG',
      purpose: 'BUSINESS',
      // Not required by default, so not kept.
      address: null,
      roomNumber: '101',
      signature: 'PAPER',
    });
    expect((await db.guest.findFirstOrThrow({ where: { firstName: 'Ada' } })).nationality).toBe(
      'NG',
    );
    const keys = await h.ok<{ data: { count: number; roomNumber: string }[] }>(
      h.fd.get(`/stays/${a.stayId}/keys`),
    );
    expect(keys.data).toEqual([expect.objectContaining({ count: 2, roomNumber: '101' })]);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'stay.checked_in' } });
    expect(JSON.stringify(audit.after)).not.toContain('A12345678');
  });

  it('needs every required field and keeps only those the property requires', async () => {
    const h = await hotel();
    const a = await arriving(h);
    const missing = await a.checkIn({ registration: { nationality: 'NG' } });
    expect(errorOf(missing)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(
      (errorOf(missing).details as { issues: { path: string }[] }).issues.map((i) => i.path),
    ).toEqual([
      'body.registration.purpose',
      'body.registration.idType',
      'body.registration.idNumber',
    ]);

    // The property only asks for the address now, and keeps ID details 6 months.
    await h.ok(
      h.gm.patch(`/properties/${h.p1.id}`, {
        registration: { requiredFields: ['address'], idRetentionMonths: 6 },
      }),
    );
    const done = await a.checkIn({ registration });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await db.idDocument.count()).toBe(0);
    const card = await h.ok<Card>(h.fd.get(`/stays/${a.stayId}/registration-card`));
    expect(card).toMatchObject({
      address: '12 Marina Road, Lagos',
      nationality: null,
      purpose: null,
      idNumberMasked: null,
    });
  });

  it('refuses a room that is not ready, unless a manager approved it', async () => {
    const h = await hotel();
    const a = await arriving(h);
    await db.room.update({ where: { id: a.room['101'] }, data: { hkStatus: 'DIRTY' } });
    expect(errorOf(await a.checkIn({ registration }))).toMatchObject({
      code: 'ROOM_NOT_READY',
      details: { problems: ['NOT_CLEAN'] },
    });
    // Another, clean room in the same request.
    await db.room.update({ where: { id: a.room['102'] }, data: { hkStatus: 'INSPECTED' } });
    const moved = await a.checkIn({ registration, roomId: a.room['102'] });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((moved.body as { roomId: string }).roomId).toBe(a.room['102']);

    // A dirty room a manager approved giving: the guest checks in.
    const b = await h.book([await h.quote({ arrival: TODAY })]);
    const stayId = b.stays[0]?.id ?? '';
    await h.ok(
      h.gm.post(`/stays/${stayId}/assign-room`, {
        roomId: a.room['101'],
        overrideReason: 'Guest accepts, cleaning now',
      }),
    );
    const v = (await db.stay.findUniqueOrThrow({ where: { id: stayId } })).version;
    const res = await h.fd
      .post(`/stays/${stayId}/check-in`, { registration })
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${v}"`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('only confirmed guests on their arrival day, at the current version, once', async () => {
    const h = await hotel(3);
    const a = await arriving(h);
    expect(errorOf(await a.checkIn({ registration }, a.version - 1))).toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    const key = randomUUID();
    const first = await a.checkIn({ registration }, a.version, key);
    expect(first.status).toBe(200);
    // The same request again answers the same (idempotency), and nothing is done twice.
    const again = await a.checkIn({ registration }, a.version, key);
    expect(again.body).toEqual(first.body);
    expect(await db.registrationCard.count()).toBe(1);
    expect(errorOf(await a.checkIn({ registration }, a.version + 1))).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
    });

    const later = await h.book([await h.quote()]);
    const stayId = later.stays[0]?.id ?? '';
    const early = await h.fd
      .post(`/stays/${stayId}/check-in`, { registration, roomId: a.room['102'] })
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"0"');
    expect(errorOf(early)).toMatchObject({ code: 'STATE_TRANSITION_INVALID' });

    const held = await h.book([await h.quote({ arrival: TODAY })], {
      holdUntil: '2026-11-10T18:00:00Z',
    });
    const hold = await h.fd
      .post(`/stays/${held.stays[0]?.id ?? ''}/check-in`, { registration })
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"0"');
    expect(errorOf(hold)).toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
  });

  it('logs more keys for a checked-in guest only', async () => {
    const h = await hotel();
    const a = await arriving(h);
    expect(errorOf(await h.fd.post(`/stays/${a.stayId}/keys`, { count: 1 }))).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
    });
    await h.ok(a.checkIn({ registration, keysIssued: 1 }));
    // Front desk holds key.issue.
    await h.ok(h.fd.post(`/stays/${a.stayId}/keys`, { count: 1 }));
    const keys = await h.ok<{ data: { count: number }[] }>(h.fd.get(`/stays/${a.stayId}/keys`));
    expect(keys.data.map((k) => k.count)).toEqual([1, 1]);
    expect(await db.auditEvent.count({ where: { action: 'stay.keys_issued' } })).toBe(1);
  });

  it('keeps an on-screen signature and an ID scan, and purges ID details after retention', async () => {
    const h = await hotel();
    const a = await arriving(h);
    const file = (entityType: string, contentType: string) =>
      db.fileObject.create({
        data: {
          organisationId: h.org.id,
          propertyId: h.p1.id,
          storageKey: `org/${h.org.id}/property/${h.p1.id}/${randomUUID()}`,
          contentType,
          sizeBytes: 100,
          scan: 'CLEAN',
          entityType,
          uploadedById: h.fdId,
        },
      });
    const signature = await file('RegistrationCard', 'image/png');
    const scan = await file('IdDocument', 'image/jpeg');
    // A file of another kind is refused.
    const wrong = await a.checkIn({ registration, signatureFileId: scan.id });
    expect(errorOf(wrong)).toMatchObject({ code: 'VALIDATION_ERROR' });
    await h.ok(
      a.checkIn({
        registration: { ...registration, idFileId: scan.id },
        signatureFileId: signature.id,
      }),
    );
    const card = await h.ok<Card & { signatureFileId: string }>(
      h.fd.get(`/stays/${a.stayId}/registration-card`),
    );
    expect(card).toMatchObject({ signature: 'SCREEN', signatureFileId: signature.id });
    const doc = await db.idDocument.findFirstOrThrow();
    expect(doc.fileId).toBe(scan.id);

    const deleted: string[] = [];
    const job = idPurgeJob({
      store: { delete: (key: string) => Promise.resolve(void deleted.push(key)) } as never,
    });
    const logger = { info: () => undefined } as never;
    await job.run({}, { db, clock: () => new Date('2027-11-09T12:00:00Z'), logger });
    expect(await db.idDocument.count()).toBe(1);
    await job.run({}, { db, clock: () => new Date('2027-11-10T12:00:00Z'), logger });
    expect(await db.idDocument.count()).toBe(0);
    expect(await db.fileObject.count({ where: { id: scan.id } })).toBe(0);
    expect(deleted).toEqual([scan.storageKey]);
    // The card stays, without the ID details.
    now = new Date('2027-11-10T12:00:00Z');
    const fd = await h.as(h.fdId);
    const after = await h.ok<Card>(fd.get(`/stays/${a.stayId}/registration-card`));
    expect(after).toMatchObject({ idNumberMasked: null, idType: null, nationality: 'NG' });
  });
});

describe('Day-use (M3-10, M2-08; T-052)', () => {
  type DayUseStay = Stay & {
    roomId: string | null;
    roomNumber: string | null;
    version: number;
    dayUse: { startsAt: string; endsAt: string } | null;
  };
  type DayUseReservation = Omit<Reservation, 'stays'> & { stays: DayUseStay[] };
  type Offer = {
    roomTypeId: string;
    plans: { code: string; totalMinor: string | null; sellable: boolean; maxMinutes: number }[];
    rooms: { number: string }[];
  };
  const registration = {
    nationality: 'NG',
    purpose: 'LEISURE',
    idType: 'PASSPORT',
    idNumber: 'B7654321',
  };

  /** A 6-hour day-use plan at ₦15,000 on Standard rooms; every room clean. */
  async function dayUseHotel() {
    const h = await hotel();
    const plan = await h.ok<{ id: string }>(
      h.gm.post('/rate-plans', {
        cancellationPolicyId: h.policy.id,
        code: 'DAY',
        name: 'Day use',
        kind: 'DAY_USE',
        dayUseMaxMinutes: 360,
      }),
    );
    await h.ok(
      h.gm.put('/rate-calendar', {
        ratePlanId: plan.id,
        roomTypeIds: [h.std.id],
        from: TODAY,
        to: '2026-12-31',
        set: { amountMinor: '1500000' },
      }),
    );
    const room = Object.fromEntries((await db.room.findMany()).map((r) => [r.number, r.id]));
    await db.room.updateMany({ data: { hkStatus: 'CLEAN' } });
    const body = (extra: object = {}) => ({
      date: TODAY,
      start: '10:00',
      minutes: 240,
      roomTypeId: h.std.id,
      ratePlanId: plan.id,
      roomId: room['101'],
      adults: 1,
      booker: { firstName: 'Kemi', lastName: 'Ade', phone: '+2348011111111' },
      ...extra,
    });
    const sell = (extra: object = {}) => h.fd.send('/day-use', body(extra));
    const sold = async (extra: object = {}) =>
      (await h.ok<DayUseReservation>(sell(extra))).stays[0] as DayUseStay;
    const offers = async (q: string) =>
      (await h.ok<{ roomTypes: Offer[] }>(h.fd.get(`/day-use/availability?${q}`))).roomTypes;
    return { ...h, plan, room, body, sell, sold, offers };
  }

  it('sells a room for a start time and duration, priced once, and takes no room night', async () => {
    const h = await dayUseHotel();
    const types = await h.offers(`date=${TODAY}&start=10:00&minutes=240&adults=1`);
    // Overnight plans are not offered; Deluxe has no day-use price.
    expect(types.find((t) => t.roomTypeId === h.dlx.id)?.plans).toMatchObject([
      { code: 'DAY', sellable: false, totalMinor: null },
    ]);
    expect(types.find((t) => t.roomTypeId === h.std.id)).toMatchObject({
      roomTypeId: h.std.id,
      plans: [{ code: 'DAY', sellable: true, maxMinutes: 360, totalMinor: '1848750' }],
      rooms: [{ number: '101' }, { number: '102' }],
    });

    const res = await h.sell();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const r = res.body as DayUseReservation & { source: string };
    expect(r).toMatchObject({ status: 'CONFIRMED', source: 'WALK_IN', totalMinor: '1848750' });
    expect(r.stays[0]).toMatchObject({
      status: 'CONFIRMED',
      arrival: TODAY,
      departure: TODAY,
      roomNumber: '101',
      // 10:00 in Lagos is 09:00 UTC; four hours.
      dayUse: { startsAt: '2026-11-10T09:00:00Z', endsAt: '2026-11-10T13:00:00Z' },
      nights: [{ date: TODAY, amountMinor: '1500000' }],
    });
    // Not a room night (M3 acceptance): today's inventory is untouched.
    const today = await db.roomTypeInventory.findFirstOrThrow({
      where: { roomTypeId: h.std.id, date: new Date(TODAY) },
    });
    expect([today.sold, today.held]).toEqual([0, 0]);
    // The calendar shows it on its date with its hours.
    const cal = await h.ok<{ data: { id: string; dayUse: unknown; rooms: unknown[] }[] }>(
      h.fd.get(`/calendar?from=${TODAY}&to=${ARRIVE}`),
    );
    expect(cal.data).toEqual([
      expect.objectContaining({
        id: r.stays[0]?.id,
        dayUse: r.stays[0]?.dayUse,
        rooms: [{ roomId: h.room['101'], startDate: TODAY, endDate: '2026-11-11' }],
      }),
    ]);
  });

  it('holds the room by the hour: day-use never overlaps, the night is still sold', async () => {
    const h = await dayUseHotel();
    await h.sold();
    // 12:00–14:00 overlaps 10:00–14:00 in 101; 14:00–16:00 follows it.
    expect(errorOf(await h.sell({ start: '12:00', minutes: 120 }))).toMatchObject({
      code: 'BOOKING_CONFLICT',
    });
    await h.sold({ start: '14:00', minutes: 120 });
    const at = await h.offers(`date=${TODAY}&start=11:00&minutes=60&adults=1`);
    const std = at.find((t) => t.roomTypeId === h.std.id);
    expect(std?.rooms.map((r) => r.number)).toEqual(['102']);

    // Tonight's guest gets 101 too: arriving that day does not collide.
    const tonight = await h.book([await h.quote({ arrival: TODAY, departure: ARRIVE })]);
    await h.ok(
      h.fd.post(`/stays/${tonight.stays[0]?.id ?? ''}/assign-room`, { roomId: h.room['101'] }),
    );

    // The database refuses two day-use holds of one room at once, whatever the app does.
    const stay = await db.stay.findFirstOrThrow({ where: { isDayUse: true } });
    await expect(
      db.roomAllocation.create({
        data: {
          propertyId: h.p1.id,
          stayId: stay.id,
          roomId: h.room['101'] ?? '',
          startDate: new Date(TODAY),
          endDate: new Date('2026-11-11'),
          startsAt: new Date('2026-11-10T12:30:00Z'),
          endsAt: new Date('2026-11-10T13:30:00Z'),
        },
      }),
    ).rejects.toThrow(/room_allocations_day_use_no_overlap/);
  });

  it('refuses a day-use on a day a guest stays through, and the other way round', async () => {
    const h = await dayUseHotel();
    // In 102 from 12 to 14 November: the 13th is theirs all day.
    const stay = (await h.book([await h.quote({ adults: 1 })])).stays[0]?.id ?? '';
    await h.ok(h.fd.post(`/stays/${stay}/assign-room`, { roomId: h.room['102'] }));
    const through = await h.sell({ date: '2026-11-13', roomId: h.room['102'] });
    expect(errorOf(through)).toMatchObject({ code: 'BOOKING_CONFLICT' });
    // Their arrival and departure days are free for day-use.
    await h.sold({ date: ARRIVE, roomId: h.room['102'] });
    await h.sold({ date: LEAVE, roomId: h.room['102'] });

    // A day-use on the 13th in 101 keeps an overnight 12–14 out of 101.
    await h.sold({ date: '2026-11-13' });
    const other = (await h.book([await h.quote({ adults: 1 })])).stays[0]?.id ?? '';
    const taken = await h.fd.post(`/stays/${other}/assign-room`, { roomId: h.room['101'] });
    expect(errorOf(taken)).toMatchObject({ code: 'BOOKING_CONFLICT' });
  });

  it('keeps to the plan: longest stay, restrictions, time, plan kind and permission', async () => {
    const h = await dayUseHotel();
    const long = await h.sell({ minutes: 420 });
    expect(errorOf(long).details).toMatchObject({ issues: [{ path: 'body.minutes' }] });
    const offered = await h.offers(`date=${TODAY}&start=10:00&minutes=420&adults=1`);
    expect(offered.find((t) => t.roomTypeId === h.std.id)?.plans[0]?.sellable).toBe(false);

    await h.ok(
      h.gm.put('/rate-calendar', {
        ratePlanId: h.plan.id,
        roomTypeIds: [h.std.id],
        from: ARRIVE,
        to: ARRIVE,
        set: { stopSell: true },
      }),
    );
    expect(errorOf(await h.sell({ date: ARRIVE }))).toMatchObject({
      code: 'RESTRICTION_VIOLATED',
    });
    // 08:00 for an hour was over at 09:00 local; it is 10:00.
    const past = await h.sell({ start: '08:00', minutes: 60 });
    expect(errorOf(past).details).toMatchObject({ issues: [{ path: 'body.start' }] });
    // An overnight plan is not a day-use plan.
    expect((await h.sell({ ratePlanId: h.bar.id })).status).toBe(400);

    const hk = await h.person('hk-attendant', h.p1.id);
    const attendant = await h.as(hk.id);
    expect((await attendant.send('/day-use', h.body())).status).toBe(403);
    expect(await db.stay.count()).toBe(0);
  });

  it('checks in, ends at the desk, sets the room dirty and frees it from then', async () => {
    const h = await dayUseHotel();
    const stay = await h.sold();
    const checkIn = await h.fd
      .post(`/stays/${stay.id}/check-in`, { registration, keysIssued: 1 })
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${stay.version}"`);
    expect(checkIn.status, JSON.stringify(checkIn.body)).toBe(200);

    // Ended early, at 12:00 local.
    now = new Date('2026-11-10T11:00:00Z');
    const fd = await h.as(h.fdId);
    const version = (await db.stay.findUniqueOrThrow({ where: { id: stay.id } })).version;
    const checkOut = (v: number) =>
      fd
        .post(`/stays/${stay.id}/check-out`, {})
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', `"${v}"`);
    expect(errorOf(await checkOut(version - 1))).toMatchObject({ code: 'VERSION_CONFLICT' });
    const out = await checkOut(version);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body).toMatchObject({ status: 'CHECKED_OUT', stays: [{ status: 'CHECKED_OUT' }] });
    // Housekeeping rule 2: a day-use end sets the room to dirty.
    const room = await db.room.findUniqueOrThrow({ where: { id: h.room['101'] } });
    expect(room.hkStatus).toBe('DIRTY');
    expect((await db.keyIssue.findFirstOrThrow()).returnedAt).toEqual(now);
    const held = await db.roomAllocation.findFirstOrThrow({ where: { stayId: stay.id } });
    expect(held.endsAt).toEqual(now);
    const history = await h.ok<{ data: { toStatus: string }[] }>(
      fd.get(`/reservations/${(out.body as { id: string }).id}/history`),
    );
    expect(history.data.at(-1)?.toStatus).toBe('CHECKED_OUT');
    expect(await db.auditEvent.count({ where: { action: 'stay.checked_out' } })).toBe(1);
    // 101 can be sold again from 12:00 (it needs cleaning before the next check-in).
    await h.ok(fd.send('/day-use', h.body({ start: '12:00', minutes: 60 })));
  });

  it('closes check-in after the time, and leaves overnight check-out for folios', async () => {
    const h = await dayUseHotel();
    const stay = await h.sold({ minutes: 60 });
    now = new Date('2026-11-10T10:30:00Z'); // 11:30 local; it ended at 11:00
    const fd = await h.as(h.fdId);
    const late = await fd
      .post(`/stays/${stay.id}/check-in`, { registration })
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${stay.version}"`);
    expect(errorOf(late)).toMatchObject({ code: 'STATE_TRANSITION_INVALID' });

    const overnight = await h.book([await h.quote({ arrival: TODAY, adults: 1 })]);
    const o = overnight.stays[0];
    await h.ok(fd.post(`/stays/${o?.id ?? ''}/assign-room`, { roomId: h.room['102'] }));
    const v = (await db.stay.findUniqueOrThrow({ where: { id: o?.id ?? '' } })).version;
    await h.ok(
      fd
        .post(`/stays/${o?.id ?? ''}/check-in`, { registration })
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', `"${v}"`),
    );
    const refused = await fd
      .post(`/stays/${o?.id ?? ''}/check-out`, {})
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${v + 1}"`);
    expect(errorOf(refused).details).toMatchObject({ reason: 'NEEDS_FOLIO' });
  });

  it('keeps its room and time: no assign or re-quote; cancel frees it, no reinstate', async () => {
    const h = await dayUseHotel();
    const r = await h.ok<DayUseReservation>(h.sell());
    const stay = r.stays[0] as DayUseStay;
    const assign = await h.fd.post(`/stays/${stay.id}/assign-room`, { roomId: h.room['102'] });
    expect(errorOf(assign).details).toMatchObject({ reason: 'DAY_USE' });
    const requote = await h.fd.change(`/reservations/${r.id}`, r.version, {
      stays: [{ stayId: stay.id, quoteId: await h.quote({ arrival: TODAY, adults: 1 }) }],
    });
    expect(errorOf(requote).details).toMatchObject({ reason: 'DAY_USE' });
    expect((await h.ok<{ data: unknown[] }>(h.fd.get(`/stays/${stay.id}/rooms`))).data).toEqual([]);

    await h.ok(h.fd.send(`/reservations/${r.id}/cancel`, { reason: 'GUEST_REQUEST' }));
    await h.sold();
    const back = await h.fd.send(`/reservations/${r.id}/reinstate`);
    expect(errorOf(back).details).toMatchObject({ reason: 'DAY_USE' });
  });
});

describe('Front desk lists (M3-06; T-053)', () => {
  type Row = {
    stayId: string;
    status: string;
    guest: { firstName: string; lastName: string };
    roomNumber: string | null;
    hkStatus: string | null;
    nights: number;
    flags: string[];
    balanceMinor: string | null;
    depositDueMinor: string;
    totalMinor: string;
    dayUse: { startsAt: string; endsAt: string } | null;
    version: number;
  };
  type List = { date: string; data: Row[] };
  const registration = {
    nationality: 'NG',
    purpose: 'BUSINESS',
    idType: 'PASSPORT',
    idNumber: 'A12345678',
  };
  type H = Awaited<ReturnType<typeof hotel>>;
  type Client = H['fd'];

  const rooms = async () =>
    Object.fromEntries((await db.room.findMany()).map((r) => [r.number, r.id]));
  const named = (list: List) => list.data.map((r) => r.guest.firstName);
  const get = (fd: Client, path: string) =>
    fd.get(path) as unknown as Promise<{ status: number; body: List }>;

  /** Books one guest (today for two nights unless told); `first` names them. */
  async function guest(h: H, first: string, quote: object = {}, extra: object = {}) {
    const dates = { arrival: TODAY, departure: ARRIVE };
    const r = await h.book([await h.quote({ adults: 1, ...dates, ...quote })], {
      booker: { guestId: null, firstName: first, lastName: 'Test', phone: null, email: null },
      ...extra,
    });
    return r.stays[0]?.id ?? '';
  }

  async function checkIn(fd: Client, stayId: string, roomId: string) {
    await db.room.update({ where: { id: roomId }, data: { hkStatus: 'CLEAN' } });
    const ok = async (res: Promise<{ status: number; body: unknown }>) => {
      const r = await res;
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    };
    await ok(fd.post(`/stays/${stayId}/assign-room`, { roomId }));
    const version = (await db.stay.findUniqueOrThrow({ where: { id: stayId } })).version;
    await ok(
      fd
        .post(`/stays/${stayId}/check-in`, { registration })
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', `"${version}"`),
    );
  }

  it('lists today’s arrivals with their flags, those still to come first', async () => {
    const h = await hotel(5);
    const room = await rooms();
    const ada = await guest(h, 'Ada');
    const bola = await guest(
      h,
      'Bola',
      {},
      {
        holdUntil: '2026-11-10T15:00:00Z',
        guarantee: 'NONE',
        notes: null,
      },
    );
    const chi = await guest(h, 'Chi', {}, { guarantee: 'NONE', notes: null });
    // Chi's room got dirty again; Dayo is already in; Efe comes tomorrow; Femi cancelled.
    await db.room.update({ where: { id: room['102'] }, data: { hkStatus: 'CLEAN' } });
    await h.ok(h.fd.post(`/stays/${chi}/assign-room`, { roomId: room['102'] }));
    await db.room.update({ where: { id: room['102'] }, data: { hkStatus: 'DIRTY' } });
    const dayo = await guest(h, 'Dayo', {}, { guarantee: 'NONE', notes: null });
    await checkIn(h.fd, dayo, room['103'] ?? '');
    await guest(h, 'Efe', { arrival: ARRIVE, departure: LEAVE });
    const femi = await h.book([await h.quote({ arrival: TODAY, departure: ARRIVE, adults: 1 })]);
    await h.ok(h.fd.send(`/reservations/${femi.id}/cancel`, { reason: 'DUPLICATE' }));
    const adaGuest = await db.stay.findUniqueOrThrow({ where: { id: ada } });
    await db.guest.update({
      where: { id: adaGuest.guestId },
      data: { vip: true, flagReason: 'Regular guest' },
    });

    const res = await get(h.fd, '/front-desk/arrivals');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.date).toBe(TODAY);
    expect(named(res.body)).toEqual(['Ada', 'Bola', 'Chi', 'Dayo']);
    const [a, b, c, d] = res.body.data;
    expect(a).toMatchObject({
      stayId: ada,
      status: 'CONFIRMED',
      nights: 2,
      roomNumber: null,
      // No folios yet (T-060): no balance.
      balanceMinor: null,
      depositDueMinor: '4500000',
      flags: ['VIP', 'NO_ROOM', 'DEPOSIT_DUE', 'NOTES'],
    });
    expect(b).toMatchObject({ stayId: bola, flags: ['TENTATIVE', 'NO_ROOM'] });
    expect(c).toMatchObject({ roomNumber: '102', hkStatus: 'DIRTY', flags: ['ROOM_NOT_READY'] });
    expect(d).toMatchObject({ stayId: dayo, status: 'CHECKED_IN', roomNumber: '103', flags: [] });

    // Another business date: tomorrow's arrivals.
    const tomorrow = await get(h.fd, `/front-desk/arrivals?date=${ARRIVE}`);
    expect(tomorrow.body).toMatchObject({ date: ARRIVE });
    expect(named(tomorrow.body)).toEqual(['Efe']);
  });

  it('keeps a guest who did not arrive on today’s list, flagged overdue', async () => {
    const h = await hotel();
    await guest(h, 'Ada', { departure: LEAVE }, { notes: null });
    now = new Date('2026-11-11T09:00:00Z');
    const fd = await h.as(h.fdId);
    const list = (await get(fd, '/front-desk/arrivals')).body;
    expect(list.date).toBe('2026-11-11');
    expect(list.data).toEqual([
      expect.objectContaining({ flags: ['NO_ROOM', 'DEPOSIT_DUE', 'OVERDUE'] }),
    ]);
    // Not on another date's list.
    expect((await get(fd, `/front-desk/arrivals?date=${ARRIVE}`)).body.data).toEqual([]);
  });

  it('lists departures and in-house guests; past their date they are overdue', async () => {
    const h = await hotel(3);
    const room = await rooms();
    const ada = await guest(h, 'Ada', { departure: '2026-11-11' }, { notes: null });
    const bola = await guest(h, 'Bola', { departure: LEAVE }, { notes: null });
    await checkIn(h.fd, ada, room['101'] ?? '');
    await checkIn(h.fd, bola, room['102'] ?? '');
    await guest(h, 'Chi', { departure: '2026-11-11' });

    const inHouse = (await get(h.fd, '/front-desk/in-house')).body;
    expect(named(inHouse)).toEqual(['Ada', 'Bola']);
    expect(inHouse.data[0]).toMatchObject({ status: 'CHECKED_IN', roomNumber: '101', flags: [] });
    expect((await get(h.fd, '/front-desk/departures')).body.data).toEqual([]);
    expect(named((await get(h.fd, '/front-desk/departures?date=2026-11-11')).body)).toEqual([
      'Ada',
    ]);

    // A day later Ada is due out; two days later she is still in: overdue.
    now = new Date('2026-11-11T09:00:00Z');
    const fd = await h.as(h.fdId);
    expect((await get(fd, '/front-desk/departures')).body.data).toEqual([
      expect.objectContaining({ stayId: ada, flags: [] }),
    ]);
    now = new Date('2026-11-12T09:00:00Z');
    const later = await h.as(h.fdId);
    const due = (await get(later, '/front-desk/departures')).body;
    expect(named(due)).toEqual(['Ada']);
    expect(due.data[0]?.flags).toEqual(['OVERDUE']);
    expect(
      (await get(later, '/front-desk/in-house')).body.data.map((r) => [r.guest.firstName, r.flags]),
    ).toEqual([
      ['Ada', ['OVERDUE']],
      ['Bola', []],
    ]);
  });

  it('shows day-use stays with their hours, due out on their date, gone once ended', async () => {
    const h = await hotel();
    const room = await rooms();
    const plan = await h.ok<{ id: string }>(
      h.gm.post('/rate-plans', {
        cancellationPolicyId: h.policy.id,
        code: 'DAY',
        name: 'Day use',
        kind: 'DAY_USE',
        dayUseMaxMinutes: 360,
      }),
    );
    await h.ok(
      h.gm.put('/rate-calendar', {
        ratePlanId: plan.id,
        roomTypeIds: [h.std.id],
        from: TODAY,
        to: '2026-12-31',
        set: { amountMinor: '1500000' },
      }),
    );
    await db.room.updateMany({ data: { hkStatus: 'CLEAN' } });
    const sold = await h.ok<{ stays: { id: string; version: number }[] }>(
      h.fd.send('/day-use', {
        date: TODAY,
        start: '10:00',
        minutes: 120,
        roomTypeId: h.std.id,
        ratePlanId: plan.id,
        roomId: room['101'],
        adults: 1,
        booker: { firstName: 'Kemi', lastName: 'Ade' },
      }),
    );
    const stay = sold.stays[0] as { id: string; version: number };
    const arrivals = (await get(h.fd, '/front-desk/arrivals')).body;
    expect(arrivals.data).toEqual([
      expect.objectContaining({
        stayId: stay.id,
        nights: 0,
        roomNumber: '101',
        dayUse: { startsAt: '2026-11-10T09:00:00Z', endsAt: '2026-11-10T11:00:00Z' },
        flags: ['DAY_USE'],
      }),
    ]);
    await h.ok(
      h.fd
        .post(`/stays/${stay.id}/check-in`, { registration })
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', `"${stay.version}"`),
    );
    expect((await get(h.fd, '/front-desk/departures')).body.data).toEqual([
      expect.objectContaining({ stayId: stay.id, status: 'CHECKED_IN', flags: ['DAY_USE'] }),
    ]);
    // Past its end time and still in: overdue.
    now = new Date('2026-11-10T11:30:00Z');
    const fd = await h.as(h.fdId);
    expect((await get(fd, '/front-desk/in-house')).body.data[0]?.flags).toEqual([
      'DAY_USE',
      'OVERDUE',
    ]);
    const version = (await db.stay.findUniqueOrThrow({ where: { id: stay.id } })).version;
    await h.ok(
      fd
        .post(`/stays/${stay.id}/check-out`, {})
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', `"${version}"`),
    );
    expect((await get(fd, '/front-desk/departures')).body.data).toEqual([
      expect.objectContaining({ stayId: stay.id, status: 'CHECKED_OUT' }),
    ]);
    expect((await get(fd, '/front-desk/in-house')).body.data).toEqual([]);
  });

  it('needs frontdesk.read', async () => {
    const h = await hotel();
    const hk = await h.person('hk-attendant', h.p1.id);
    const attendant = await h.as(hk.id);
    for (const list of ['arrivals', 'departures', 'in-house']) {
      expect((await attendant.get(`/front-desk/${list}`)).status).toBe(403);
    }
  });
});
