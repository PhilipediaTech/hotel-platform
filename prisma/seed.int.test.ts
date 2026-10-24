import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../apps/api/test/db.ts';
import { DEMO_EMAIL_DOMAIN, DEMO_ORG_ID, DEMO_PROPERTY_ID, DEMO_ROLES, seed } from './seed.ts';

const db = testDb();

async function counts() {
  return {
    organisations: await db.organisation.count(),
    properties: await db.property.count(),
    departments: await db.department.count(),
    roles: await db.role.count(),
    users: await db.user.count(),
    memberships: await db.membership.count(),
  };
}

beforeAll(async () => {
  await resetDb(db);
  await seed(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('seed', () => {
  it('creates one demo organisation and property, five departments, and a user per role', async () => {
    expect(await counts()).toEqual({
      organisations: 1,
      properties: 1,
      departments: 5,
      roles: DEMO_ROLES.length,
      users: DEMO_ROLES.length,
      memberships: DEMO_ROLES.length,
    });
    await expect(
      db.property.findUnique({ where: { id: DEMO_PROPERTY_ID } }),
    ).resolves.toMatchObject({
      organisationId: DEMO_ORG_ID,
      code: 'LAG',
      status: 'SETUP',
    });
  });

  it('is idempotent', async () => {
    const before = await counts();
    await seed(db);
    expect(await counts()).toEqual(before);
  });

  it('requires MFA for owner, GM and finance roles only (M1-06)', async () => {
    const mfa = await db.role.findMany({ where: { requiresMfa: true }, select: { name: true } });
    expect(mfa.map((r) => r.name).sort()).toEqual(['Finance', 'General Manager', 'Owner']);
  });

  it('gives the owner an organisation-wide membership and staff a property membership', async () => {
    const owner = await db.user.findUniqueOrThrow({
      where: { email: `owner@${DEMO_EMAIL_DOMAIN}` },
      include: { memberships: true },
    });
    expect(owner.memberships).toEqual([expect.objectContaining({ propertyId: null })]);

    const desk = await db.user.findUniqueOrThrow({
      where: { email: `front-desk@${DEMO_EMAIL_DOMAIN}` },
      include: { memberships: { include: { department: true } } },
    });
    expect(desk.memberships[0]).toMatchObject({
      propertyId: DEMO_PROPERTY_ID,
      department: { code: 'FO' },
    });
  });
});
