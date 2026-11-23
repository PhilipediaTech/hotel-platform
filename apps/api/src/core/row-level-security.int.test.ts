import { defineRoute } from '@hotel/shared';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resetDb, TEST_DB_ROLE, testDb } from '../../test/db.ts';
import { buildTestApp } from '../../test/helpers.ts';
import { makeTenantWorld, sessionCookie, tenantFor, type TenantWorld } from '../../test/tenancy.ts';
import { pgErrorInfo } from './db.ts';
import { mountRoute } from './route.ts';
import { currentTenant, runAsTenant, type TenantContext } from './tenancy.ts';

// Row-level security (T-144; spec tab 2 "Tenancy", tab 3 rule 6; ADR-018): the database's
// own tenancy layer, under the application's tenant client. These tests use raw SQL on
// purpose: it is exactly what the tenant Prisma extension does not scope.

const db = testDb();

let world: TenantWorld;
let a1: TenantContext;

beforeEach(async () => {
  await resetDb(db);
  world = await makeTenantWorld(db);
  a1 = await tenantFor(db, world.aStaff.id, world.a1.id);
});

async function department(propertyId: string, organisationId: string, code: string) {
  return db.department.create({ data: { organisationId, propertyId, code, name: `Dept ${code}` } });
}

const settings = () =>
  db.$queryRaw<{ property: string; organisation: string; role: string }[]>`
    SELECT current_setting('app.property_id', true) AS property,
           current_setting('app.organisation_id', true) AS organisation,
           current_user AS role`.then((rows) => rows[0]);

/** Tenant tables that may have no policy, with why. Everything else with a tenant column has one. */
const NOT_TENANT_DATA: Record<string, string> = {
  subscriptions: 'platform billing, read by the platform and before the tenant is known',
  support_sessions: 'platform support, checked before the tenant is known',
  usage_counters: 'platform metering',
  platform_invoices: 'platform billing',
  partner_referrals: 'platform referral programme',
  partner_commissions: 'platform referral programme',
};

describe('row-level security policies', () => {
  it('covers every table with a tenant column, forced, with one policy', async () => {
    const tables = await db.$queryRaw<
      { table: string; enabled: boolean; forced: boolean; policies: string[] }[]
    >`
      SELECT c.relname::text AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             coalesce(array_agg(p.policyname::text) FILTER (WHERE p.policyname IS NOT NULL), '{}'::text[]) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = c.relname
      WHERE c.relkind = 'r'
        AND (c.relname = 'organisations' OR EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public' AND col.table_name = c.relname
            AND col.column_name IN ('property_id', 'organisation_id')))
      GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
      ORDER BY 1`;
    const uncovered = tables
      .filter((t) => !(t.table in NOT_TENANT_DATA))
      .filter((t) => !t.enabled || !t.forced || t.policies.join() !== 'tenant_isolation')
      .map((t) => t.table);
    expect(uncovered).toEqual([]);
    // The exception list stays honest: each one exists and really has no policy.
    for (const name of Object.keys(NOT_TENANT_DATA)) {
      expect(tables.find((t) => t.table === name)).toMatchObject({ enabled: false });
    }
    expect(tables.length).toBeGreaterThan(100);
  });

  it('runs the tests as a role that row-level security applies to', async () => {
    expect((await settings())?.role).toBe(TEST_DB_ROLE);
    const [role] = await db.$queryRaw<{ superuser: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles
      WHERE rolname = current_user`;
    expect(role).toEqual({ superuser: false, bypass: false });
  });
});

describe('the connection pool sets the tenant', () => {
  it('sets the current tenant on each query, and clears it outside one', async () => {
    expect(await settings()).toMatchObject({ property: '', organisation: '' });
    expect(await runAsTenant(a1, settings)).toMatchObject({
      property: world.a1.id,
      organisation: world.orgA.id,
    });
    const b1 = await tenantFor(db, world.bStaff.id, world.b1.id);
    expect(await runAsTenant(b1, settings)).toMatchObject({
      property: world.b1.id,
      organisation: world.orgB.id,
    });
    // Back to no tenant: a pooled connection never keeps the last tenant.
    expect(await settings()).toMatchObject({ property: '', organisation: '' });
  });

  it('sets it for a transaction too', async () => {
    const inside = await runAsTenant(a1, () =>
      db.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ property: string }[]>`
          SELECT current_setting('app.property_id', true) AS property`;
        return row?.property;
      }),
    );
    expect(inside).toBe(world.a1.id);
  });

  it('keeps concurrent requests of different tenants apart', async () => {
    const b1 = await tenantFor(db, world.bStaff.id, world.b1.id);
    const runs = Array.from({ length: 20 }, (_, i) => (i % 2 ? a1 : b1));
    const seen = await Promise.all(runs.map((t) => runAsTenant(t, settings)));
    expect(seen.map((s) => s?.property)).toEqual(runs.map((t) => t.propertyId));
  });
});

describe('raw SQL in a tenant context', () => {
  it("never sees another property's rows, even of the same organisation", async () => {
    const mine = await department(world.a1.id, world.orgA.id, 'MINE');
    await department(world.a2.id, world.orgA.id, 'SISTER');
    await department(world.b1.id, world.orgB.id, 'OTHER');
    const seen = await runAsTenant(
      a1,
      () => db.$queryRaw<{ id: string }[]>`SELECT id FROM departments`,
    );
    expect(seen.map((r) => r.id)).toEqual([mine.id]);
  });

  it("can't change or delete another property's rows", async () => {
    const other = await department(world.b1.id, world.orgB.id, 'OTHER');
    const changed = await runAsTenant(a1, async () => [
      await db.$executeRaw`UPDATE departments SET name = 'Taken' WHERE id = ${other.id}::uuid`,
      await db.$executeRaw`DELETE FROM departments WHERE id = ${other.id}::uuid`,
    ]);
    expect(changed).toEqual([0, 0]);
    expect(await db.department.findUnique({ where: { id: other.id } })).toMatchObject({
      name: 'Dept OTHER',
    });
  });

  it("can't write a row into another property, or move one there", async () => {
    const mine = await department(world.a1.id, world.orgA.id, 'MINE');
    const insert = runAsTenant(
      a1,
      () => db.$executeRaw`
        INSERT INTO departments (id, organisation_id, property_id, code, name)
        VALUES (gen_random_uuid(), ${world.orgB.id}::uuid, ${world.b1.id}::uuid, 'X', 'X')`,
    );
    expect(pgErrorInfo(await insert.catch((e: unknown) => e))?.sqlState).toBe('42501');
    const move = runAsTenant(
      a1,
      () => db.$executeRaw`
        UPDATE departments SET property_id = ${world.a2.id}::uuid WHERE id = ${mine.id}::uuid`,
    );
    expect(pgErrorInfo(await move.catch((e: unknown) => e))?.sqlState).toBe('42501');
  });

  it("sees only its own organisation's rows in organisation tables", async () => {
    const seen = await runAsTenant(
      a1,
      () => db.$queryRaw<{ id: string }[]>`SELECT id FROM organisations`,
    );
    expect(seen.map((r) => r.id)).toEqual([world.orgA.id]);
    const properties = await runAsTenant(
      a1,
      () => db.$queryRaw<{ id: string }[]>`SELECT id FROM properties ORDER BY code`,
    );
    // Both of the organisation's properties (the property switcher), none of B's.
    expect(properties.map((r) => r.id)).toEqual([world.a1.id, world.a2.id]);
    const roles = await runAsTenant(
      a1,
      () => db.$queryRaw<{ organisation_id: string }[]>`SELECT organisation_id FROM roles`,
    );
    expect(new Set(roles.map((r) => r.organisation_id))).toEqual(new Set([world.orgA.id]));
  });

  it('leaves code with no tenant (sign-in, platform, worker sweeps) unrestricted', async () => {
    await department(world.a1.id, world.orgA.id, 'A');
    await department(world.b1.id, world.orgB.id, 'B');
    const [row] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM departments`;
    expect(Number(row?.n)).toBe(2);
  });
});

describe('routes and the tenant', () => {
  const Seen = z.object({ property: z.string(), tenant: z.boolean() });
  const route = (propertyScoped: boolean) =>
    defineRoute({
      operationId: propertyScoped ? 'testRlsProperty' : 'testRlsAccount',
      method: 'get',
      path: propertyScoped ? '/test/rls/property' : '/test/rls/account',
      summary: 'Test only',
      tags: ['Test'],
      propertyScoped,
      response: Seen,
    });

  function testApp() {
    const router = express.Router();
    for (const scoped of [true, false]) {
      mountRoute(router, route(scoped), async () => ({
        property: (await settings())?.property ?? '',
        tenant: currentTenant() !== undefined,
      }));
    }
    return buildTestApp(router, { db });
  }

  it('runs a property route as its property, and any other route with no tenant', async () => {
    const { app } = testApp();
    const cookie = await sessionCookie(db, world.aStaff.id);
    const get = (path: string) =>
      request(app)
        .get(`/api/v1/test/rls/${path}`)
        .set('Cookie', cookie)
        .set('X-Property-Id', world.a1.id);
    const property = await get('property');
    expect(property.body).toEqual({ property: world.a1.id, tenant: true });
    // The user's own account, say: the header the web client always sends changes nothing.
    const account = await get('account');
    expect(account.body).toEqual({ property: '', tenant: false });
  });
});
