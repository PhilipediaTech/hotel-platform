import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { APP_ORIGIN, errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { hashToken } from '../../core/tokens.ts';
import { DEPARTMENT_TEMPLATES } from '../identity/role-templates.ts';
import { requestReviews } from '../reviews/service.ts';

// Requests and feedback from the guest's link (PRD M11-06 "request services and rate my stay";
// S45; T-159). Ada Obi's booking arrives today; the tests open her link, ask for things before
// and after she checks in, follow the staff's progress, then rate the stay after check-out.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

const SETTINGS = {
  slug: 'demo-lagos',
  enabled: true,
  headline: null,
  description: null,
  policies: null,
  photoFileIds: [],
  allowPayFull: true,
  allowDeposit: true,
  depositBps: 3000,
  allowPayAtHotel: true,
};

type Stay = {
  closedReason: string | null;
  roomNumber: string | null;
  requests: { id: string; kind: string; note: string | null; status: string }[];
  feedback: { state: string; path: string | null } | null;
};

async function hotel() {
  const h = await inHouse(db, clock, { checkIn: false });
  await db.department.createMany({
    data: DEPARTMENT_TEMPLATES.map((d) => ({
      organisationId: h.org.id,
      propertyId: h.p1.id,
      ...d,
    })),
  });
  await h.ok(h.gm.put('/booking-engine/settings', SETTINGS));
  const token = 'ada-obi-link-token-0123456789';
  await db.guestLink.create({
    data: {
      id: randomUUID(),
      organisationId: h.org.id,
      propertyId: h.p1.id,
      reservationId: h.reservationId,
      tokenHash: hashToken(TEST_CONFIG.sessionSecret, token),
      createdAt: now,
    },
  });
  const stay = async (t = token) => {
    const res = await request(h.app).get(`/public/v1/bookings/${t}/stay`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Stay;
  };
  const ask = (body: object, t = token) => {
    // A minute apart, so the newest comes first.
    now = new Date(now.getTime() + 60_000);
    return request(h.app)
      .post(`/public/v1/bookings/${t}/requests`)
      .set('Origin', APP_ORIGIN)
      .send({ requestKey: randomUUID(), ...body });
  };
  const feedback = (t = token) =>
    request(h.app).post(`/public/v1/bookings/${t}/feedback`).set('Origin', APP_ORIGIN).send({});
  const task = async (requestId: string) => {
    const row = await db.serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { task: { include: { department: true, room: true } } },
    });
    return row.task;
  };
  const checkOut = async () => {
    await db.stay.update({
      where: { id: h.stayId },
      data: { status: 'CHECKED_OUT', checkedOutAt: now },
    });
    await db.reservation.update({
      where: { id: h.reservationId },
      data: { status: 'CHECKED_OUT' },
    });
  };
  return { ...h, token, stay, ask, feedback, task, checkOut };
}

describe('requests from the guest’s link (M11-06)', () => {
  it('turns each request into a task for the department that does it, which the guest follows', async () => {
    const h = await hotel();
    expect(await h.stay()).toEqual({
      closedReason: null,
      roomNumber: null,
      requests: [],
      feedback: null,
    });

    // Before arrival: a pickup, for the front office, by name (no room yet).
    const key = randomUUID();
    const pickup = await h.ask({
      requestKey: key,
      kind: 'TRANSPORT',
      note: 'From the airport, 2pm',
    });
    expect(pickup.status, JSON.stringify(pickup.body)).toBe(201);
    const [first] = (pickup.body as Stay).requests;
    expect(first).toMatchObject({
      kind: 'TRANSPORT',
      note: 'From the airport, 2pm',
      status: 'RECEIVED',
    });
    const pickupTask = await h.task(first?.id ?? '');
    expect(pickupTask).toMatchObject({
      type: 'GUEST_REQUEST',
      title: 'Transport: Ada Obi, arriving 2026-11-10',
      description: 'From the guest’s link: From the airport, 2pm',
      status: 'REPORTED',
      roomId: null,
      stayId: h.stayId,
      reportedById: null,
    });
    expect(pickupTask.department.code).toBe('FO');
    expect(pickupTask.dueAt?.toISOString()).toBe('2026-11-10T09:31:00.000Z');
    // The same request again (the answer was lost): still one.
    await h.ask({ requestKey: key, kind: 'TRANSPORT', note: 'From the airport, 2pm' });
    expect(await db.serviceRequest.count()).toBe(1);
    expect(await db.task.count({ where: { type: 'GUEST_REQUEST' } })).toBe(1);

    // In the house: towels go to housekeeping, a fault to maintenance, both with the room.
    await h.checkIn();
    expect((await h.stay()).roomNumber).toBe('101');
    const towels = (await h.ask({ kind: 'HOUSEKEEPING' })).body as Stay;
    const fix = (await h.ask({ kind: 'MAINTENANCE', note: 'The shower drips' })).body as Stay;
    const towelTask = await h.task(towels.requests[0]?.id ?? '');
    expect(towelTask).toMatchObject({ title: 'Cleaning or towels: room 101' });
    expect(towelTask.department.code).toBe('HK');
    expect(towelTask.room?.number).toBe('101');
    const fixTask = await h.task(fix.requests[0]?.id ?? '');
    expect(fixTask.department.code).toBe('MNT');

    // Staff pick them up: the guest sees it.
    await db.task.update({ where: { id: towelTask.id }, data: { status: 'ACKNOWLEDGED' } });
    await db.task.update({ where: { id: pickupTask.id }, data: { status: 'RESOLVED' } });
    const seen = await h.stay();
    expect(seen.requests.map((r) => [r.kind, r.status])).toEqual([
      ['MAINTENANCE', 'RECEIVED'],
      ['HOUSEKEEPING', 'ON_IT'],
      ['TRANSPORT', 'DONE'],
    ]);
    const audit = await db.auditEvent.findMany({ where: { action: 'service_request.created' } });
    expect(audit.map((a) => a.actorType)).toEqual(['SYSTEM', 'SYSTEM', 'SYSTEM']);
    // The staff are told the usual way: a task.created event for each.
    expect(await db.domainEvent.count({ where: { type: 'task.created' } })).toBe(3);
  });

  it('needs a note for “other”, keeps at most 5 waiting, and closes when the stay ends', async () => {
    const h = await hotel();
    const other = await h.ask({ kind: 'OTHER', note: '  ' });
    expect(other.status).toBe(400);

    for (let i = 0; i < 5; i += 1) {
      expect((await h.ask({ kind: 'AMENITIES', note: `Item ${i}` })).status).toBe(201);
    }
    const sixth = await h.ask({ kind: 'AMENITIES' });
    expect(sixth.status).toBe(409);
    expect(errorOf(sixth)).toMatchObject({
      message: 'You have 5 requests waiting already; the hotel will get to them soon',
      details: { reason: 'TOO_MANY_WAITING' },
    });
    // One done: room for another.
    const one = await db.serviceRequest.findFirstOrThrow();
    await db.task.update({ where: { id: one.taskId }, data: { status: 'RESOLVED' } });
    expect((await h.ask({ kind: 'AMENITIES' })).status).toBe(201);

    await h.checkIn();
    await h.checkOut();
    expect((await h.stay()).closedReason).toBe('ENDED');
    const late = await h.ask({ kind: 'HOUSEKEEPING' });
    expect(late.status).toBe(409);
    expect(errorOf(late).message).toBe('Your stay has ended; please call the hotel');
  });

  it('refuses a cancelled booking and an unknown link', async () => {
    const h = await hotel();
    expect((await h.ask({ kind: 'AMENITIES' })).status).toBe(201);
    const unknown = await request(h.app).get('/public/v1/bookings/not-a-real-link-0123456789/stay');
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(404);
    const cancelled = await request(h.app)
      .post(`/public/v1/bookings/${h.token}/cancel`)
      .set('Origin', APP_ORIGIN)
      .send({ acceptedFeeMinor: '100000000' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((await h.stay()).closedReason).toBe('CANCELLED');
    const refused = await h.ask({ kind: 'AMENITIES' });
    expect(refused.status).toBe(409);
    expect(errorOf(refused).message).toBe('Requests open once the booking is confirmed');
  });
});

describe('rating the stay from the link (M11-06)', () => {
  it('opens the review page after check-out while the hotel asks for reviews', async () => {
    const h = await hotel();
    await h.checkIn();
    expect((await h.feedback()).status).toBe(409);
    await h.checkOut();
    // Reviews off: nothing to offer.
    expect((await h.stay()).feedback).toBeNull();
    await h.ok(
      h.gm.put('/review-settings', { enabled: true, delayHours: 3, publicReviewUrl: null }),
    );
    expect((await h.stay()).feedback).toEqual({ state: 'AVAILABLE', path: null });

    const started = await h.feedback();
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const { path } = started.body as { path: string };
    expect(path).toMatch(/^\/r\/[\w-]{20,}$/);
    // Again: the same page, not a second review.
    expect((await h.feedback()).body).toEqual({ path });
    expect(await db.guestReview.count()).toBe(1);
    expect((await db.guestReview.findFirstOrThrow()).channel).toBe('PORTAL');
    expect((await h.stay()).feedback).toEqual({ state: 'OPEN', path });

    // The guest rates it on that page; the link shows it as given.
    const reviewToken = path.slice(3);
    const sent = await request(h.app)
      .post(`/public/v1/reviews/${reviewToken}`)
      .set('Origin', TEST_CONFIG.siteOrigin)
      .send({ rating: 5, comment: 'Lovely' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect((await h.stay()).feedback).toEqual({ state: 'GIVEN', path });
    // The review request later doesn't ask again.
    now = new Date('2026-11-10T15:00:00Z');
    expect(await requestReviews(db, clock, TEST_CONFIG)).toBe(0);
  });

  it('shows the review the hotel already asked for', async () => {
    const h = await hotel();
    await h.checkIn();
    await db.guest.update({
      where: { id: (await db.stay.findUniqueOrThrow({ where: { id: h.stayId } })).guestId },
      data: { email: 'ada@example.test' },
    });
    await h.ok(
      h.gm.put('/review-settings', { enabled: true, delayHours: 3, publicReviewUrl: null }),
    );
    await h.checkOut();
    now = new Date('2026-11-10T13:00:00Z');
    expect(await requestReviews(db, clock, TEST_CONFIG)).toBe(1);
    const asked = await h.stay();
    expect(asked.feedback?.state).toBe('OPEN');
    expect((await h.feedback()).body).toEqual({ path: asked.feedback?.path });
    expect(await db.guestReview.count()).toBe(1);
  });
});
