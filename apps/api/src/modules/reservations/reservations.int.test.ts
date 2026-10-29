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
