import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { APP_ORIGIN, errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { newApiKey } from '../../core/api-keys.ts';
import type { DomainEventRecord } from '../../core/outbox.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { webhookSignature } from '../../core/webhook-sender.ts';
import { partnerWebhookHandler, RETRY_MINUTES, sendDue } from './service.ts';

// Partner API keys and webhooks (Versions V2; T-166). Ada Obi is booked into room 101 of P1;
// the GM makes a key for an outside system and a webhook endpoint for the hotel's events.

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const silent = { warn: () => undefined };

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type KeyItem = { id: string; prefix: string; scopes: string[]; revokedAt: string | null };
type Reservation = {
  id: string;
  confirmationNo: string;
  booker: { firstName: string; email: string | null };
  stays: { roomTypeCode: string; arrival: string }[];
};
type Delivery = {
  id: string;
  status: string;
  attempts: number;
  eventType: string;
  lastStatusCode: number | null;
  lastError: string | null;
};

async function hotel() {
  const h = await inHouse(db, clock, { checkIn: false });
  await db.guest.updateMany({ data: { email: 'ada@example.test' } });
  const partner = (token: string | null) => ({
    get: (path: string) => {
      const req = request(h.app).get(`/api/v1/partner${path}`);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    },
  });
  const makeKey = async (scopes: string[], name = 'Accounting sync') => {
    const res = await h.gm.post('/api-keys', { name, scopes });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { key: KeyItem; token: string };
  };
  const handler = partnerWebhookHandler({
    db,
    clock,
    sender: h.webhooks,
    config: TEST_CONFIG,
    logger: silent,
  });
  const publish = async (type: string) => {
    const event = await db.domainEvent.findFirstOrThrow({
      where: { type },
      orderBy: { id: 'desc' },
    });
    const record: DomainEventRecord = {
      id: event.id.toString(),
      organisationId: event.organisationId,
      propertyId: event.propertyId,
      type: event.type,
      payload: event.payload as Record<string, unknown>,
      occurredAt: event.occurredAt,
    };
    await handler.handle(record);
    return record;
  };
  const makeEndpoint = async (events: string[], url = 'https://hooks.example.test/hotel') => {
    const res = await h.gm.post('/webhook-endpoints', { url, events });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { endpoint: { id: string }; secret: string };
  };
  const deliveries = async () =>
    (await h.ok<{ data: Delivery[] }>(h.gm.get('/webhook-deliveries'))).data;
  return { ...h, partner, makeKey, publish, makeEndpoint, deliveries };
}

describe('partner API keys', () => {
  it('reads the property with a key shown once, and stops when it is revoked', async () => {
    const h = await hotel();
    const { key, token } = await h.makeKey(['reservations:read', 'availability:read']);
    expect(token).toMatch(/^hk_[\w-]{43}$/);
    expect(key.prefix).toBe(token.slice(0, 11));
    const listed = await h.ok<{ data: (KeyItem & { token?: string })[] }>(h.gm.get('/api-keys'));
    expect(listed.data).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token);
    // Only the HMAC is stored.
    const row = await db.apiKey.findFirstOrThrow();
    expect(row.tokenHash).not.toContain(token.slice(3));

    const property = await h.partner(token).get('/property');
    expect(property.status, JSON.stringify(property.body)).toBe(200);
    expect(property.headers['cache-control']).toBe('no-store');
    expect(property.body).toMatchObject({
      id: h.p1.id,
      currency: 'NGN',
      roomTypes: [{ code: 'STD', name: 'Standard' }],
      scopes: ['reservations:read', 'availability:read'],
    });
    expect((await db.apiKey.findFirstOrThrow()).lastUsedAt).toEqual(now);

    const revoked = await h.ok<KeyItem>(h.gm.post(`/api-keys/${key.id}/revoke`));
    expect(revoked.revokedAt).not.toBeNull();
    const after = await h.partner(token).get('/property');
    expect(after.status).toBe(401);
    expect(errorOf(after).code).toBe('UNAUTHENTICATED');
    const audit = await db.auditEvent.findMany({
      where: { entityType: 'api_key' },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['api_key.created', 'api_key.revoked']);
  });

  it('accepts nothing but a live key, and only for its scopes', async () => {
    const h = await hotel();
    const { token } = await h.makeKey(['availability:read']);
    expect((await h.partner(null).get('/property')).status).toBe(401);
    expect((await h.partner('hk_not-a-real-key').get('/property')).status).toBe(401);
    expect((await h.partner('Basic abc').get('/property')).status).toBe(401);
    // A staff session is not a key.
    const cookie = await sessionCookie(db, h.gmId, clock);
    const withCookie = await request(h.app)
      .get('/api/v1/partner/property')
      .set('Cookie', cookie)
      .set('X-Property-Id', h.p1.id);
    expect(withCookie.status).toBe(401);
    // …and a key is not a session.
    const staffRoute = await request(h.app)
      .get('/api/v1/reservations')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Property-Id', h.p1.id);
    expect(staffRoute.status).toBe(401);

    const res = await h.partner(token).get(`/reservations/${h.reservationId}`);
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ scope: 'reservations:read' });
    const days = await h.partner(token).get(`/availability?from=${TODAY}&to=2026-11-11`);
    expect(days.status, JSON.stringify(days.body)).toBe(200);
    expect((days.body as { days: unknown[] }).days).toEqual([
      expect.objectContaining({ date: TODAY, roomTypeCode: 'STD', capacity: 1, sold: 1 }),
      expect.objectContaining({ date: '2026-11-11', roomTypeCode: 'STD', sold: 1 }),
    ]);
    const tooLong = await h.partner(token).get(`/availability?from=${TODAY}&to=2027-03-01`);
    expect(tooLong.status).toBe(400);
  });

  it('only the GM’s side makes keys: the front desk can’t', async () => {
    const h = await hotel();
    const res = await h.fd.post('/api-keys', { name: 'Mine', scopes: ['folios:read'] });
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ permission: 'integration.manage' });
    expect(await db.apiKey.count()).toBe(0);
  });

  it('reads reservations page by page, guest contact only with guests:read', async () => {
    const h = await hotel();
    // A second booking, a minute later.
    later(1);
    const type = await db.roomType.findFirstOrThrow();
    const plan = await db.ratePlan.findFirstOrThrow();
    const quote = await h.ok<{ quoteId: string }>(
      h.fd.post('/quotes', {
        roomTypeId: type.id,
        ratePlanId: plan.id,
        arrival: '2026-11-20',
        departure: '2026-11-21',
        adults: 2,
      }),
    );
    const second = await h.ok<{ id: string }>(
      h.fd.send('/reservations', {
        source: 'PHONE',
        booker: { firstName: 'Bayo', lastName: 'Ade' },
        stays: [{ quoteId: quote.quoteId }],
      }),
    );
    const { token } = await h.makeKey(['reservations:read']);
    const first = await h.partner(token).get('/reservations?limit=1');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const page1 = first.body as { data: Reservation[]; nextCursor: string | null };
    expect(page1.data.map((r) => r.id)).toEqual([h.reservationId]);
    expect(page1.data[0]?.booker).toMatchObject({ firstName: 'Ada', email: null });
    expect(page1.data[0]?.stays).toEqual([
      expect.objectContaining({ roomTypeCode: 'STD', arrival: TODAY }),
    ]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await h.partner(token).get(`/reservations?limit=1&cursor=${page1.nextCursor}`);
    expect((page2.body as { data: Reservation[] }).data.map((r) => r.id)).toEqual([second.id]);
    expect((page2.body as { nextCursor: string | null }).nextCursor).toBeNull();

    const arriving = await h.partner(token).get('/reservations?arrivalFrom=2026-11-15');
    expect((arriving.body as { data: Reservation[] }).data.map((r) => r.id)).toEqual([second.id]);
    // updatedAt is the database's own time of the change.
    const { updatedAt } = await db.reservation.findUniqueOrThrow({ where: { id: second.id } });
    const since = await h
      .partner(token)
      .get(`/reservations?updatedSince=${encodeURIComponent(updatedAt.toISOString())}`);
    expect((since.body as { data: Reservation[] }).data.map((r) => r.id)).toEqual([second.id]);
    expect((await h.partner(token).get('/reservations?cursor=bad')).status).toBe(400);

    const contact = await h.makeKey(['reservations:read', 'guests:read']);
    const one = await h.partner(contact.token).get(`/reservations/${h.reservationId}`);
    expect((one.body as Reservation).booker.email).toBe('ada@example.test');
  });

  it('reads a reservation’s bills with folios:read, and nothing of another property', async () => {
    const h = await hotel();
    await h.checkIn();
    await h.ok(
      h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
    );
    const { token } = await h.makeKey(['folios:read', 'reservations:read']);
    const res = await h.partner(token).get(`/reservations/${h.reservationId}/folios`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [folio] = (res.body as { data: { chargesMinor: string; balanceMinor: string }[] }).data;
    expect(folio?.chargesMinor).not.toBe('0');
    expect(folio?.balanceMinor).toBe(folio?.chargesMinor);

    // A key of P2 (same group) sees none of P1's records.
    const other = newApiKey(TEST_CONFIG);
    await db.apiKey.create({
      data: {
        propertyId: h.p2.id,
        name: 'P2 key',
        prefix: other.prefix,
        tokenHash: other.tokenHash,
        scopes: ['reservations:read', 'folios:read'],
        createdById: h.owner.id,
      },
    });
    expect((await h.partner(other.token).get(`/reservations/${h.reservationId}`)).status).toBe(404);
    expect(
      (await h.partner(other.token).get(`/reservations/${h.reservationId}/folios`)).status,
    ).toBe(404);
    const list = await h.partner(other.token).get('/reservations');
    expect((list.body as { data: unknown[] }).data).toEqual([]);
  });
});

describe('webhooks', () => {
  it('sends each event an endpoint takes once, signed, with IDs and no guest details', async () => {
    const h = await hotel();
    const { endpoint, secret } = await h.makeEndpoint(['reservation.created', 'stay.checked_in']);
    expect(secret).toMatch(/^whsec_/);
    const listed = await h.ok<{ data: { id: string }[] }>(h.gm.get('/webhook-endpoints'));
    expect(JSON.stringify(listed)).not.toContain(secret);

    const event = await h.publish('reservation.created');
    // The outbox is at least once: a repeat adds nothing.
    await h.publish('reservation.created');
    expect(h.webhooks.sent).toHaveLength(1);
    const [sent] = h.webhooks.sent;
    expect(sent?.url).toBe('https://hooks.example.test/hotel');
    const body = JSON.parse(sent?.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      id: `evt_${event.id}`,
      type: 'reservation.created',
      createdAt: expect.any(String) as unknown,
      propertyId: h.p1.id,
      data: {
        reservationId: h.reservationId,
        confirmationNo: expect.any(String) as unknown,
        status: 'CONFIRMED',
      },
    });
    expect(sent?.body).not.toContain('Ada');
    const ts = sent?.headers['X-Webhook-Timestamp'] ?? '';
    expect(ts).toBe(String(Math.floor(now.getTime() / 1000)));
    expect(sent?.headers['X-Webhook-Signature']).toBe(
      webhookSignature(secret, ts, sent?.body ?? ''),
    );
    const [delivery] = await h.deliveries();
    expect(delivery).toMatchObject({ status: 'DELIVERED', attempts: 1, lastStatusCode: 200 });
    const stats = await h.ok<{ data: { delivered: number }[] }>(h.gm.get('/webhook-endpoints'));
    expect(stats.data[0]?.delivered).toBe(1);

    // Not an event it takes: nothing.
    await h.checkIn();
    await h.publish('stay.checked_in');
    expect(h.webhooks.sent).toHaveLength(2);
    await h.ok(h.gm.patch(`/webhook-endpoints/${endpoint.id}`, { events: ['stay.checked_out'] }));
    await db.webhookDelivery.deleteMany();
    await h.publish('stay.checked_in');
    expect(h.webhooks.sent).toHaveLength(2);
  });

  it('tries again on the retry plan, then fails; the GM sends it again', async () => {
    const h = await hotel();
    await h.makeEndpoint(['reservation.created']);
    h.webhooks.answers.push(500, 'unreachable', 500, 500, 500, 500, 500);
    await h.publish('reservation.created');
    let [d] = await h.deliveries();
    expect(d).toMatchObject({ status: 'PENDING', attempts: 1, lastStatusCode: 500 });
    expect(d?.lastError).toBe('The endpoint answered 500');
    // Not yet due.
    expect(await sendDue(db, clock, h.webhooks, TEST_CONFIG)).toBe(0);
    for (const minutes of RETRY_MINUTES) {
      later(minutes);
      expect(await sendDue(db, clock, h.webhooks, TEST_CONFIG)).toBe(1);
    }
    // Days later: sign in again.
    const gm = await h.as(h.gmId);
    [d] = (await h.ok<{ data: Delivery[] }>(gm.get('/webhook-deliveries'))).data;
    expect(d).toMatchObject({ status: 'FAILED', attempts: 7 });
    expect(h.webhooks.sent).toHaveLength(7);
    // A different body each time? No: the same bytes, signed afresh.
    expect(new Set(h.webhooks.sent.map((s) => s.body)).size).toBe(1);

    const again = await h.ok<Delivery>(gm.post(`/webhook-deliveries/${d?.id}/retry`));
    expect(again).toMatchObject({ status: 'DELIVERED', attempts: 1 });
    const twice = await gm.post(`/webhook-deliveries/${d?.id}/retry`);
    expect(twice.status).toBe(409);
    expect(errorOf(twice).code).toBe('STATE_TRANSITION_INVALID');
  });

  it('holds deliveries for a paused endpoint until it is switched back on', async () => {
    const h = await hotel();
    const { endpoint } = await h.makeEndpoint(['reservation.created']);
    h.webhooks.answers.push('unreachable');
    await h.publish('reservation.created');
    await h.ok(h.gm.patch(`/webhook-endpoints/${endpoint.id}`, { active: false }));
    later(2);
    expect(await sendDue(db, clock, h.webhooks, TEST_CONFIG)).toBe(0);
    await h.ok(h.gm.patch(`/webhook-endpoints/${endpoint.id}`, { active: true }));
    expect(await sendDue(db, clock, h.webhooks, TEST_CONFIG)).toBe(1);
    expect((await h.deliveries())[0]?.status).toBe('DELIVERED');
  });

  it('sends a test at once, and refuses URLs it must not send to', async () => {
    const h = await hotel();
    const { endpoint } = await h.makeEndpoint(['business_day.closed']);
    const test = await h.ok<Delivery>(h.gm.post(`/webhook-endpoints/${endpoint.id}/test`));
    expect(test).toMatchObject({ eventType: 'webhook.test', status: 'DELIVERED' });
    expect(JSON.parse(h.webhooks.sent[0]?.body ?? '{}')).toMatchObject({ type: 'webhook.test' });

    const bad = await h.gm.post('/webhook-endpoints', {
      url: 'https://user:pw@hooks.example.test/x',
      events: ['reservation.created'],
    });
    expect(bad.status).toBe(400);
    const ftp = await h.gm.post('/webhook-endpoints', {
      url: 'ftp://hooks.example.test/x',
      events: ['reservation.created'],
    });
    expect(ftp.status).toBe(400);
    const unknown = await h.gm.post('/webhook-endpoints', {
      url: 'https://hooks.example.test/x',
      events: ['guest.created'],
    });
    expect(unknown.status).toBe(400);
    expect(await db.webhookEndpoint.count()).toBe(1);
  });

  it('needs the Origin of the app to change settings', async () => {
    const h = await hotel();
    const cookie = await sessionCookie(db, h.gmId, clock);
    const res = await request(h.app)
      .post('/api/v1/webhook-endpoints')
      .set('Cookie', cookie)
      .set('X-Property-Id', h.p1.id)
      .send({ url: 'https://hooks.example.test/x', events: ['reservation.created'] });
    expect(res.status).toBe(403);
    const ok = await request(h.app)
      .post('/api/v1/webhook-endpoints')
      .set('Cookie', cookie)
      .set('X-Property-Id', h.p1.id)
      .set('Origin', APP_ORIGIN)
      .send({ url: 'https://hooks.example.test/x', events: ['reservation.created'] });
    expect(ok.status).toBe(201);
  });
});
