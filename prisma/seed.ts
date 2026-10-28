// Demo data for local development: `npm run seed`. Safe to run repeatedly (upserts).
// Grows with each ticket (rooms and rates arrive with T-031/T-033).
import { pathToFileURL } from 'node:url';
import { createDb, type Db } from '../apps/api/src/core/db.ts';
import { hashPassword } from '../apps/api/src/core/passwords.ts';
import {
  DEPARTMENT_TEMPLATES,
  ROLE_TEMPLATES,
  type DepartmentCode,
} from '../apps/api/src/modules/identity/role-templates.ts';
import { createDefaultApprovalPolicies } from '../apps/api/src/modules/approvals/defaults.ts';

export const DEMO_ORG_ID = '0d0d0d0d-0000-4000-8000-000000000001';
export const DEMO_PROPERTY_ID = '0d0d0d0d-0000-4000-8000-000000000002';
export const DEMO_EMAIL_DOMAIN = 'demo.hotel.test';

/** Same templates a real sign-up gets; one demo user per role (`<slug>@demo.hotel.test`). */
export const DEMO_DEPARTMENTS = DEPARTMENT_TEMPLATES;
export const DEMO_ROLES = ROLE_TEMPLATES;

export interface SeedOptions {
  /** Password for demo users that have none yet (local sign-in). Omit to leave them without. */
  password?: string | undefined;
}

export async function seed(db: Db, options: SeedOptions = {}): Promise<void> {
  // Hash once: every demo user shares the local-only password.
  const passwordHash = options.password ? await hashPassword(options.password) : undefined;

  await db.organisation.upsert({
    where: { id: DEMO_ORG_ID },
    update: {},
    create: {
      id: DEMO_ORG_ID,
      name: 'Demo Hotels Ltd',
      legalName: 'Demo Hotels Limited',
      country: 'NG',
    },
  });

  await db.property.upsert({
    where: { id: DEMO_PROPERTY_ID },
    update: {},
    create: {
      id: DEMO_PROPERTY_ID,
      organisationId: DEMO_ORG_ID,
      code: 'LAG',
      name: 'Demo Lagos Hotel',
      address: { line1: '1 Demo Street', city: 'Lagos', state: 'Lagos', country: 'NG' },
      phone: '+2348000000001',
      email: `frontdesk@${DEMO_EMAIL_DOMAIN}`,
    },
  });

  const departmentIds = new Map<DepartmentCode, string>();
  for (const d of DEMO_DEPARTMENTS) {
    const row = await db.department.upsert({
      where: { propertyId_code: { propertyId: DEMO_PROPERTY_ID, code: d.code } },
      update: { name: d.name },
      create: { organisationId: DEMO_ORG_ID, propertyId: DEMO_PROPERTY_ID, ...d },
    });
    departmentIds.set(d.code, row.id);
  }

  for (const r of DEMO_ROLES) {
    const permissions = [...r.permissions];
    const role = await db.role.upsert({
      where: { organisationId_name: { organisationId: DEMO_ORG_ID, name: r.name } },
      update: { requiresMfa: r.requiresMfa, permissions },
      create: {
        organisationId: DEMO_ORG_ID,
        name: r.name,
        isSystem: true,
        requiresMfa: r.requiresMfa,
        permissions,
      },
    });

    const email = `${r.slug}@${DEMO_EMAIL_DOMAIN}`;
    const user = await db.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        name: `Demo ${r.name}`,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        ...(passwordHash ? { passwordHash } : {}),
      },
    });
    if (passwordHash && !user.passwordHash) {
      await db.user.update({ where: { id: user.id }, data: { passwordHash } });
    }

    const propertyId = r.orgWide ? null : DEMO_PROPERTY_ID;
    const existing = await db.membership.findFirst({
      where: { userId: user.id, organisationId: DEMO_ORG_ID, propertyId, roleId: role.id },
    });
    if (!existing) {
      await db.membership.create({
        data: {
          userId: user.id,
          organisationId: DEMO_ORG_ID,
          propertyId,
          roleId: role.id,
          departmentId: r.department ? (departmentIds.get(r.department) ?? null) : null,
        },
      });
    }
  }

  // PRD M1 rule 2 defaults (T-022); policies already there are kept.
  await createDefaultApprovalPolicies(db, DEMO_ORG_ID, DEMO_PROPERTY_ID);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Run via `npm run seed`, which loads .env.');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo users with a shared password in production.');
    process.exit(1);
  }
  const db = createDb(url);
  try {
    await seed(db, { password: process.env.SEED_USER_PASSWORD });
    const how = process.env.SEED_USER_PASSWORD
      ? 'sign in with SEED_USER_PASSWORD from .env'
      : 'SEED_USER_PASSWORD is not set, so demo users have no password';
    console.error(
      `Seeded demo organisation ${DEMO_ORG_ID} with ${DEMO_ROLES.length} users (${how}).`,
    );
  } finally {
    await db.$disconnect();
  }
}
