import { defineRoute, Uuid } from '@hotel/shared';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { verifiedUser } from '../../test/auth.ts';
import { resetDb, testDb } from '../../test/db.ts';
import { makeProperty, makeTenant } from '../../test/factories.ts';
import { APP_ORIGIN, buildTestApp, errorOf } from '../../test/helpers.ts';
import { sessionCookie } from '../../test/tenancy.ts';
import { AppError } from './errors.ts';
import { IDEMPOTENCY_STALE_MS, requestHash } from './idempotency.ts';
import { mountRoute } from './route.ts';

// Tab 2 "Idempotency" (T-020): a repeat returns the stored response; a different body with
// the same key returns IDEMPOTENCY_KEY_REUSED; keys live 48 hours.

const db = testDb();

const createThing = defineRoute({
  operationId: 'createThing',
  method: 'post',
  path: '/things',
  summary: 'Test route',
  tags: ['Test'],
  idempotent: true,
  body: z.object({ name: z.string(), fail: z.enum(['conflict', 'crash']).optional() }),
  status: 201,
  response: z.object({ id: Uuid, name: z.string(), run: z.number() }),
});
const createScoped = defineRoute({
  operationId: 'createScoped',
  method: 'post',
  path: '/scoped-things',
  summary: 'Test route',
  tags: ['Test'],
  propertyScoped: true,
  idempotent: true,
  body: z.object({ name: z.string() }),
  status: 201,
  response: z.object({ run: z.number() }),
});

let runs = 0;
let gate: Promise<void> | null = null;

function testApp() {
  const router = express.Router();
  mountRoute(router, createThing, async ({ body }) => {
    runs += 1;
    const run = runs;
    if (gate) await gate;
    if (body.fail === 'conflict') throw new AppError('BOOKING_CONFLICT', 'Room taken.', { run });
    if (body.fail === 'crash') throw new Error('database went away');
    return { id: crypto.randomUUID(), name: body.name, run };
  });
  mountRoute(router, createScoped, () => {
    runs += 1;
    return { run: runs };
  });
  return buildTestApp(router, { db }).app;
}

const KEY = '7d4b3f5e-1c2a-4b6d-8e9f-0a1b2c3d4e5f';

async function signedIn() {
  const user = await verifiedUser(db);
  const cookie = await sessionCookie(db, user.id);
  const app = testApp();
  const post = (body: object, key: string = KEY, path = '/things', propertyId?: string) => {
    const req = request(app)
      .post(`/api/v1${path}`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key);
    return (propertyId ? req.set('X-Property-Id', propertyId) : req).send(body);
  };
  return { user, cookie, app, post };
}

beforeEach(async () => {
  await resetDb(db);
  runs = 0;
  gate = null;
});

describe('Idempotency-Key', () => {
  it('runs once and replays the stored response for a repeat', async () => {
    const { post } = await signedIn();
    const first = await post({ name: 'Ada' });
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const again = await post({ name: 'Ada' });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(runs).toBe(1);
  });

  it('treats the same data in another key order as the same request', async () => {
    const { post } = await signedIn();
    await post({ name: 'Ada', fail: undefined }).expect(201);
    await post({ name: 'Ada' }).expect(201);
    expect(runs).toBe(1);
  });

  it('refuses the same key with a different body or path (IDEMPOTENCY_KEY_REUSED)', async () => {
    const { post, user } = await signedIn();
    await post({ name: 'Ada' }).expect(201);
    const otherBody = await post({ name: 'Bisi' });
    expect(otherBody.status).toBe(409);
    expect(errorOf(otherBody).code).toBe('IDEMPOTENCY_KEY_REUSED');
    const { organisation, property, role } = await makeTenant(db);
    await db.membership.create({
      data: {
        userId: user.id,
        organisationId: organisation.id,
        propertyId: property.id,
        roleId: role.id,
      },
    });
    const otherPath = await post({ name: 'Ada' }, KEY, '/scoped-things', property.id);
    expect(errorOf(otherPath).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(runs).toBe(1);
  });

  it('counts the property as part of the request', async () => {
    const { post, user } = await signedIn();
    const { organisation, property, role } = await makeTenant(db);
    const other = await makeProperty(db, organisation.id, { code: 'P2' });
    for (const propertyId of [property.id, other.id]) {
      await db.membership.create({
        data: { userId: user.id, organisationId: organisation.id, propertyId, roleId: role.id },
      });
    }
    await post({ name: 'Ada' }, KEY, '/scoped-things', property.id).expect(201);
    const elsewhere = await post({ name: 'Ada' }, KEY, '/scoped-things', other.id);
    expect(errorOf(elsewhere).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('keeps keys per user', async () => {
    const a = await signedIn();
    const b = await signedIn();
    await a.post({ name: 'Ada' }).expect(201);
    await b.post({ name: 'Bisi' }).expect(201);
    expect(runs).toBe(2);
  });

  it('requires a UUID key', async () => {
    const { post } = await signedIn();
    const res = await post({ name: 'Ada' }, 'not-a-uuid');
    expect(res.status).toBe(400);
    expect((errorOf(res).details?.['issues'] as { path: string }[])[0]?.path).toBe(
      'headers.Idempotency-Key',
    );
    expect(runs).toBe(0);
  });

  it('stores client errors and replays them without running again', async () => {
    const { post } = await signedIn();
    const first = await post({ name: 'Ada', fail: 'conflict' });
    expect(first.status).toBe(409);
    expect(errorOf(first)).toMatchObject({ code: 'BOOKING_CONFLICT', details: { run: 1 } });
    const again = await post({ name: 'Ada', fail: 'conflict' });
    expect(errorOf(again)).toMatchObject({ code: 'BOOKING_CONFLICT', details: { run: 1 } });
    expect(again.headers['idempotent-replayed']).toBe('true');
    // A fresh request ID for the replay, so support can find both.
    expect(errorOf(again).requestId).not.toBe(errorOf(first).requestId);
    expect(runs).toBe(1);
  });

  it('releases the key after a server error, so a retry runs again', async () => {
    const { post } = await signedIn();
    expect((await post({ name: 'Ada', fail: 'crash' })).status).toBe(500);
    expect(await db.idempotencyKey.count()).toBe(0);
    expect((await post({ name: 'Ada', fail: 'crash' })).status).toBe(500);
    expect(runs).toBe(2);
  });

  it('answers a repeat that arrives while the first is still running', async () => {
    const { post } = await signedIn();
    let release = () => {};
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = post({ name: 'Ada' }).then((r) => r);
    await expect.poll(() => runs).toBe(1);
    const during = await post({ name: 'Ada' });
    expect(during.status).toBe(409);
    expect(errorOf(during).details).toEqual({ reason: 'IN_PROGRESS' });
    expect(during.headers['retry-after']).toBe('1');
    release();
    expect((await first).status).toBe(201);
    expect(runs).toBe(1);
  });

  it('lets only one of two simultaneous requests run', async () => {
    const { post } = await signedIn();
    const results = await Promise.all([post({ name: 'Ada' }), post({ name: 'Ada' })]);
    expect(runs).toBe(1);
    // The loser either saw the first still running (409) or got its stored response (201).
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 201)).toBe(true);
  });

  it('forgets a key after 48 hours', async () => {
    const { post } = await signedIn();
    await post({ name: 'Ada' }).expect(201);
    const row = await db.idempotencyKey.findFirstOrThrow();
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(48 * 60 * 60_000);
    await db.idempotencyKey.updateMany({
      data: {
        createdAt: new Date(Date.now() - 49 * 3_600_000),
        expiresAt: new Date(Date.now() - 3_600_000),
      },
    });
    await post({ name: 'Bisi' }).expect(201);
    expect(runs).toBe(2);
  });

  it('takes over a claim abandoned mid-request after 5 minutes', async () => {
    const { post, user } = await signedIn();
    await db.idempotencyKey.create({
      data: {
        userId: user.id,
        key: KEY,
        method: 'POST',
        path: '/api/v1/things',
        requestHash: 'whatever',
        createdAt: new Date(Date.now() - IDEMPOTENCY_STALE_MS - 1000),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await post({ name: 'Ada' }).expect(201);
    expect(runs).toBe(1);
  });

  it('hashes method, path, property and body', () => {
    const req = (body: unknown, propertyId?: string) =>
      ({
        method: 'POST',
        originalUrl: '/api/v1/things',
        body,
        get: (name: string) => (name === 'X-Property-Id' ? propertyId : undefined),
      }) as unknown as Parameters<typeof requestHash>[0];
    expect(requestHash(req({ a: 1, b: [1, { c: 2, d: 3 }] }))).toBe(
      requestHash(req({ b: [1, { d: 3, c: 2 }], a: 1 })),
    );
    expect(requestHash(req({ a: 1 }))).not.toBe(requestHash(req({ a: 2 })));
    expect(requestHash(req({ a: 1 }, 'p1'))).not.toBe(requestHash(req({ a: 1 }, 'p2')));
  });
});
