import { API_ROUTES, defineRoute, page, PageQuery, Uuid } from '@hotel/shared';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CROSS_TENANT_CASES } from '../../test/cross-tenant-cases.ts';
import { resetDb, testDb } from '../../test/db.ts';
import { buildTestApp, errorOf } from '../../test/helpers.ts';
import {
  expectCrossTenantSafe,
  makeTenantWorld,
  sessionCookie,
  tenantFor,
  type TenantWorld,
} from '../../test/tenancy.ts';
import { AppError } from './errors.ts';
import { mountRoute } from './route.ts';
import { createTenantDb } from './tenant-db.ts';
import { resolveTenant, runAsTenant, TenancyError } from './tenancy.ts';

const db = testDb();
const tenantDb = createTenantDb(db);
const PERMISSION = 'demo.read';

let world: TenantWorld;

async function department(propertyId: string, organisationId: string, code: string) {
  return db.department.create({ data: { organisationId, propertyId, code, name: `Dept ${code}` } });
}

beforeEach(async () => {
  await resetDb(db);
  world = await makeTenantWorld(db, [PERMISSION]);
});

// ---------------------------------------------------------------------------------------

describe('resolveTenant', () => {
  it('gives a property member their roles and permissions there', async () => {
    const tenant = await tenantFor(db, world.aStaff.id, world.a1.id);
    expect(tenant).toMatchObject({
      userId: world.aStaff.id,
      organisationId: world.orgA.id,
      propertyId: world.a1.id,
    });
    expect(tenant.roles).toHaveLength(1);
    expect([...tenant.permissions]).toEqual([PERMISSION]);
  });

  it('lets an organisation-wide member into every property of the organisation', async () => {
    expect((await tenantFor(db, world.aOwner.id, world.a1.id)).propertyId).toBe(world.a1.id);
    expect((await tenantFor(db, world.aOwner.id, world.a2.id)).propertyId).toBe(world.a2.id);
  });

  it('combines organisation-wide and property roles', async () => {
    const extra = await db.role.create({
      data: { organisationId: world.orgA.id, name: 'Extra', permissions: ['extra.do'] },
    });
    await db.membership.create({
      data: {
        userId: world.aStaff.id,
        organisationId: world.orgA.id,
        propertyId: null,
        roleId: extra.id,
      },
    });
    const tenant = await tenantFor(db, world.aStaff.id, world.a1.id);
    expect([...tenant.permissions].sort()).toEqual(['demo.read', 'extra.do']);
    expect(tenant.roles).toHaveLength(2);
  });

  it.each([
    ['a sibling property without a role there', (w: TenantWorld) => [w.aStaff.id, w.a2.id]],
    ['another organisation’s property', (w: TenantWorld) => [w.aStaff.id, w.b1.id]],
    ['a property that doesn’t exist', (w: TenantWorld) => [w.aStaff.id, crypto.randomUUID()]],
  ])('refuses %s', async (_case, pick) => {
    const [userId, propertyId] = pick(world) as [string, string];
    expect(await resolveTenant(db, userId, propertyId)).toBeNull();
  });

  it('refuses inactive memberships and archived properties', async () => {
    await db.membership.updateMany({ where: { userId: world.aStaff.id }, data: { active: false } });
    expect(await resolveTenant(db, world.aStaff.id, world.a1.id)).toBeNull();
    await db.property.update({ where: { id: world.a2.id }, data: { status: 'ARCHIVED' } });
    expect(await resolveTenant(db, world.aOwner.id, world.a2.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------

describe('tenant Prisma extension', () => {
  const asA1 = () => tenantFor(db, world.aStaff.id, world.a1.id);

  it('throws outside a tenant context, and for models that aren’t tenant models', async () => {
    await expect(tenantDb.department.findMany()).rejects.toThrow(TenancyError);
    const tenant = await asA1();
    await expect(runAsTenant(tenant, () => tenantDb.user.findMany())).rejects.toThrow(
      'User is not a tenant model',
    );
  });

  it('runs a query returned without await inside the tenant context', async () => {
    await department(world.a1.id, world.orgA.id, 'MINE');
    const tenant = await asA1();
    // Prisma queries are lazy; runAsTenant awaits them before leaving the context.
    const rows = await runAsTenant(tenant, () => tenantDb.department.findMany());
    expect(rows.map((d) => d.code)).toEqual(['MINE']);
  });

  it('scopes reads to the current property', async () => {
    const mine = await department(world.a1.id, world.orgA.id, 'MINE');
    await department(world.a2.id, world.orgA.id, 'SIBLING');
    const theirs = await department(world.b1.id, world.orgB.id, 'THEIRS');
    const tenant = await asA1();

    await runAsTenant(tenant, async () => {
      expect((await tenantDb.department.findMany()).map((d) => d.code)).toEqual(['MINE']);
      expect(await tenantDb.department.count()).toBe(1);
      expect(await tenantDb.department.findUnique({ where: { id: mine.id } })).not.toBeNull();
      // Guessed IDs of other tenants simply don't exist here.
      expect(await tenantDb.department.findUnique({ where: { id: theirs.id } })).toBeNull();
      expect(await tenantDb.department.findFirst({ where: { id: theirs.id } })).toBeNull();
      await expect(
        tenantDb.department.findFirstOrThrow({ where: { id: theirs.id } }),
      ).rejects.toThrow();
      // A caller's own propertyId filter can't widen the scope.
      expect(
        await tenantDb.department.findMany({ where: { propertyId: world.b1.id } }),
      ).toHaveLength(1);
    });
  });

  it('never changes or deletes another tenant’s rows', async () => {
    const theirs = await department(world.b1.id, world.orgB.id, 'THEIRS');
    const tenant = await asA1();
    await runAsTenant(tenant, async () => {
      await expect(
        tenantDb.department.update({ where: { id: theirs.id }, data: { name: 'Hijacked' } }),
      ).rejects.toThrow();
      expect(
        (await tenantDb.department.updateMany({ where: { id: theirs.id }, data: { name: 'X' } }))
          .count,
      ).toBe(0);
      await expect(tenantDb.department.delete({ where: { id: theirs.id } })).rejects.toThrow();
      expect((await tenantDb.department.deleteMany({ where: { id: theirs.id } })).count).toBe(0);
    });
    expect(await db.department.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({
      name: 'Dept THEIRS',
    });
  });

  it('stamps new rows with the tenant and refuses rows aimed elsewhere', async () => {
    const tenant = await asA1();
    await runAsTenant(tenant, async () => {
      const created = await tenantDb.department.create({
        data: { code: 'NEW', name: 'New' } as never,
      });
      expect(created).toMatchObject({ propertyId: world.a1.id, organisationId: world.orgA.id });
      await tenantDb.department.createMany({
        data: [
          { code: 'M1', name: 'Many 1' },
          { code: 'M2', name: 'Many 2' },
        ] as never,
      });
      expect(await tenantDb.department.count()).toBe(3);

      await expect(
        tenantDb.department.create({
          data: {
            code: 'BAD',
            name: 'Bad',
            propertyId: world.b1.id,
            organisationId: world.orgB.id,
          },
        }),
      ).rejects.toThrow(TenancyError);
      await expect(
        tenantDb.department.update({
          where: { id: created.id },
          data: { propertyId: world.a2.id },
        }),
      ).rejects.toThrow("can't be changed to another tenant");
    });
  });

  it('scopes organisation-level models to the organisation', async () => {
    const tenant = await asA1();
    await runAsTenant(tenant, async () => {
      const roles = await tenantDb.role.findMany();
      expect(roles.length).toBeGreaterThan(0);
      expect(roles.every((r) => r.organisationId === world.orgA.id)).toBe(true);
      expect((await tenantDb.property.findMany()).map((p) => p.code).sort()).toEqual(['A1', 'A2']);
      expect((await tenantDb.organisation.findMany()).map((o) => o.id)).toEqual([world.orgA.id]);
    });
  });

  it('keeps the scope inside transactions', async () => {
    await department(world.a1.id, world.orgA.id, 'MINE');
    await department(world.b1.id, world.orgB.id, 'THEIRS');
    const tenant = await asA1();
    const codes = await runAsTenant(tenant, () =>
      tenantDb.$transaction(async (tx) => (await tx.department.findMany()).map((d) => d.code)),
    );
    expect(codes).toEqual(['MINE']);
  });

  it('keeps concurrent requests apart', async () => {
    await department(world.a1.id, world.orgA.id, 'A1-DEPT');
    await department(world.b1.id, world.orgB.id, 'B1-DEPT');
    const [a, b] = [await asA1(), await tenantFor(db, world.bStaff.id, world.b1.id)];
    const look = (tenant: typeof a) =>
      runAsTenant(tenant, async () => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
        return (await tenantDb.department.findMany()).map((d) => d.code);
      });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => look(i % 2 ? b : a)));
    results.forEach((codes, i) => expect(codes).toEqual([i % 2 ? 'B1-DEPT' : 'A1-DEPT']));
  });
});

// ---------------------------------------------------------------------------------------
// HTTP: middleware step 7 + routes, with test-only routes on the tenant client

const Department = z.object({ id: Uuid, code: z.string(), name: z.string() });
const listDepartments = defineRoute({
  operationId: 'testListDepartments',
  method: 'get',
  path: '/test/departments',
  summary: 'Test only',
  tags: ['Test'],
  propertyScoped: true,
  permission: PERMISSION,
  query: PageQuery,
  response: page(Department),
});
const getDepartment = defineRoute({
  operationId: 'testGetDepartment',
  method: 'get',
  path: '/test/departments/{departmentId}',
  summary: 'Test only',
  tags: ['Test'],
  propertyScoped: true,
  permission: PERMISSION,
  params: z.object({ departmentId: Uuid }),
  response: Department,
});

function testApp() {
  const router = express.Router();
  mountRoute(router, listDepartments, async () => ({
    data: await tenantDb.department.findMany({ orderBy: { code: 'asc' } }),
    nextCursor: null,
  }));
  mountRoute(router, getDepartment, async ({ params }) => {
    const found = await tenantDb.department.findUnique({ where: { id: params.departmentId } });
    if (!found) throw new AppError('NOT_FOUND', 'Department not found.');
    return found;
  });
  return buildTestApp(router, { db });
}

const seedDepartment = async (_db: unknown, w: TenantWorld, propertyId: string) => {
  const orgId = propertyId === w.b1.id ? w.orgB.id : w.orgA.id;
  const d = await department(propertyId, orgId, `D${Math.random().toString(36).slice(2, 7)}`);
  return { departmentId: d.id };
};

describe('middleware step 7 over HTTP', () => {
  it('lets a member work in their property', async () => {
    await department(world.a1.id, world.orgA.id, 'FO');
    const { app } = testApp();
    const res = await request(app)
      .get('/api/v1/test/departments')
      .set('Cookie', await sessionCookie(db, world.aStaff.id))
      .set('X-Property-Id', world.a1.id);
    expect(res.status).toBe(200);
    expect((res.body as { data: { code: string }[] }).data.map((d) => d.code)).toEqual(['FO']);
  });

  it('answers the same 404 for another tenant’s property and a made-up one', async () => {
    const { app } = testApp();
    const cookie = await sessionCookie(db, world.aStaff.id);
    const get = (propertyId: string) =>
      request(app)
        .get('/api/v1/test/departments')
        .set('Cookie', cookie)
        .set('X-Property-Id', propertyId);
    const [theirs, madeUp] = [await get(world.b1.id), await get(crypto.randomUUID())];
    expect(theirs.status).toBe(404);
    expect(madeUp.status).toBe(404);
    expect(errorOf(theirs).message).toBe(errorOf(madeUp).message);
  });

  it('asks for sign-in before anything about the property', async () => {
    const { app } = testApp();
    const res = await request(app)
      .get('/api/v1/test/departments')
      .set('X-Property-Id', world.b1.id);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });

  it('needs X-Property-Id on property-scoped routes', async () => {
    const { app } = testApp();
    const res = await request(app)
      .get('/api/v1/test/departments')
      .set('Cookie', await sessionCookie(db, world.aStaff.id));
    expect(res.status).toBe(400);
    expect(errorOf(res).details?.['issues']).toEqual([
      expect.objectContaining({ path: 'headers.X-Property-Id' }),
    ]);
  });

  it('adds userId, orgId and propertyId to the request log', async () => {
    const { app, logLines } = testApp();
    await request(app)
      .get('/api/v1/test/departments')
      .set('Cookie', await sessionCookie(db, world.aStaff.id))
      .set('X-Property-Id', world.a1.id)
      .expect(200);
    const line = logLines.find(
      (l) => (l['req'] as { url?: string } | undefined)?.url === '/api/v1/test/departments',
    );
    expect(line).toMatchObject({
      userId: world.aStaff.id,
      orgId: world.orgA.id,
      propertyId: world.a1.id,
    });
  });

  it('the harness catches a route that reads through the plain client', async () => {
    const router = express.Router();
    // Deliberately wrong: the base client ignores the tenant.
    mountRoute(router, getDepartment, async ({ params }) =>
      db.department.findUniqueOrThrow({ where: { id: params.departmentId } }),
    );
    const { app } = buildTestApp(router, { db });
    await expect(
      expectCrossTenantSafe(app, db, world, getDepartment, { seed: seedDepartment }),
    ).rejects.toThrow("testGetDepartment with B's record from A1");
  });

  it('passes the cross-tenant harness for a detail route and a list route', async () => {
    const { app } = testApp();
    await expectCrossTenantSafe(app, db, world, getDepartment, { seed: seedDepartment });
    await expectCrossTenantSafe(app, db, world, listDepartments, {
      seed: seedDepartment,
      listIds: (body) => (body as { data: { id: string }[] }).data.map((d) => d.id),
    });
  });
});

describe('cross-tenant suite (test plan, suite 1)', () => {
  const scoped = Object.values(API_ROUTES).filter((r) => 'propertyScoped' in r && r.propertyScoped);

  it('has a case for every property-scoped route in the API', () => {
    const missing = scoped.map((r) => r.operationId).filter((id) => !(id in CROSS_TENANT_CASES));
    expect(missing, 'add these to apps/api/test/cross-tenant-cases.ts').toEqual([]);
  });

  it('every registered case leaks nothing', async () => {
    const { app } = buildTestApp(undefined, { db });
    for (const route of scoped) {
      const testCase = CROSS_TENANT_CASES[route.operationId as keyof typeof CROSS_TENANT_CASES];
      if (testCase) await expectCrossTenantSafe(app, db, world, route, testCase);
    }
  });
});
