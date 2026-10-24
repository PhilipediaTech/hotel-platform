import type { RouteContract } from '@hotel/shared';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { expect } from 'vitest';
import { createSession } from '../src/core/auth.ts';
import { systemClock } from '../src/core/clock.ts';
import type { Db } from '../src/core/db.ts';
import { resolveTenant, type TenantContext } from '../src/core/tenancy.ts';
import { makeOrganisation, makeProperty, makeRole, makeUser } from './factories.ts';
import { APP_ORIGIN, TEST_CONFIG } from './helpers.ts';

// Cross-tenant test harness (test plan, suite 1 "Tenancy": for every route, a user of
// property A asking for property B's records gets 404; lists never return B's rows).

/**
 * Two organisations. A has properties A1 and A2, B has B1. Users:
 * - `aStaff`: a role for A1 only, holding `permissions`
 * - `aOwner`: an organisation-wide role in A, holding `permissions`
 * - `bStaff`: a role for B1, holding `permissions`
 */
export async function makeTenantWorld(db: Db, permissions: readonly string[] = []) {
  const orgA = await makeOrganisation(db, { name: 'Org A' });
  const orgB = await makeOrganisation(db, { name: 'Org B' });
  const a1 = await makeProperty(db, orgA.id, { code: 'A1' });
  const a2 = await makeProperty(db, orgA.id, { code: 'A2' });
  const b1 = await makeProperty(db, orgB.id, { code: 'B1' });

  async function member(organisationId: string, propertyId: string | null) {
    const user = await makeUser(db);
    const role = await makeRole(db, organisationId);
    await db.role.update({ where: { id: role.id }, data: { permissions: [...permissions] } });
    await db.membership.create({
      data: { userId: user.id, organisationId, propertyId, roleId: role.id },
    });
    await db.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
    return user;
  }

  return {
    orgA,
    orgB,
    a1,
    a2,
    b1,
    aStaff: await member(orgA.id, a1.id),
    aOwner: await member(orgA.id, null),
    bStaff: await member(orgB.id, b1.id),
  };
}

export type TenantWorld = Awaited<ReturnType<typeof makeTenantWorld>>;

/** The tenant context `userId` gets in `propertyId` (fails if they have none). */
export async function tenantFor(
  db: Db,
  userId: string,
  propertyId: string,
): Promise<TenantContext> {
  const tenant = await resolveTenant(db, userId, propertyId);
  if (!tenant) throw new Error(`User ${userId} has no access to property ${propertyId}`);
  return tenant;
}

/** A signed-in, MFA-passed session for `userId`, as a Cookie header value. */
export async function sessionCookie(db: Db, userId: string): Promise<string> {
  const { token } = await createSession(
    { db, config: TEST_CONFIG, clock: systemClock },
    { userId, sharedDevice: false, mfaPassed: true },
  );
  return `sid=${token}`;
}

/** How to exercise one property-scoped route in the cross-tenant suite. */
export interface CrossTenantCase {
  /**
   * Creates a record of this route's kind in `propertyId` (owned by the world's tenant
   * there) and returns the path params that point at it.
   */
  seed(db: Db, world: TenantWorld, propertyId: string): Promise<Record<string, string>>;
  /** For list routes: the IDs in a response body. */
  listIds?(body: unknown): string[];
  /** Request body for writes. */
  body?(params: Record<string, string>): object;
}

function call(
  app: App,
  route: RouteContract,
  params: Record<string, string>,
  propertyId: string,
  cookie: string,
  body?: object,
) {
  const path = `/api/v1${route.path.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '')}`;
  const req = request(app)
    [route.method](path)
    .set('Cookie', cookie)
    .set('X-Property-Id', propertyId);
  if (route.method !== 'get') req.set('Origin', APP_ORIGIN);
  if (route.idempotent) req.set('Idempotency-Key', crypto.randomUUID());
  if (route.ifMatch) req.set('If-Match', '"0"');
  return body ? req.send(body) : req;
}

/**
 * Asserts the route leaks nothing across tenants:
 * 1. A's user, in A1, naming B1's record → 404 (or, for lists, B's rows absent)
 * 2. A's user, in B1 → 404 (middleware step 7)
 * 3. A's user, in A2 where they have no role → 404
 */
export async function expectCrossTenantSafe(
  app: App,
  db: Db,
  world: TenantWorld,
  route: RouteContract,
  testCase: CrossTenantCase,
): Promise<void> {
  const cookie = await sessionCookie(db, world.aStaff.id);
  const theirs = await testCase.seed(db, world, world.b1.id);
  const body = testCase.body?.(theirs);

  const fromA1 = await call(app, route, theirs, world.a1.id, cookie, body);
  if (testCase.listIds) {
    expect(fromA1.status, `${route.operationId} list from A1`).toBe(200);
    const ids = testCase.listIds(fromA1.body);
    const theirIds = Object.values(theirs);
    expect(
      ids.filter((id) => theirIds.includes(id)),
      `${route.operationId} leaked B's rows`,
    ).toEqual([]);
  } else {
    expect(fromA1.status, `${route.operationId} with B's record from A1`).toBe(404);
  }

  const inB1 = await call(app, route, theirs, world.b1.id, cookie, body);
  expect(inB1.status, `${route.operationId} in B1`).toBe(404);
  const inA2 = await call(app, route, theirs, world.a2.id, cookie, body);
  expect(inA2.status, `${route.operationId} in A2 without a role there`).toBe(404);
}
