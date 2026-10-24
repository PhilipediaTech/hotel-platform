// Demo data for local development: `npm run seed`. Safe to run repeatedly (upserts).
// Grows with each ticket (rooms and rates arrive with T-031/T-033; permissions with T-013).
import { pathToFileURL } from 'node:url';
import { createDb, type Db } from '../apps/api/src/core/db.ts';

export const DEMO_ORG_ID = '0d0d0d0d-0000-4000-8000-000000000001';
export const DEMO_PROPERTY_ID = '0d0d0d0d-0000-4000-8000-000000000002';
export const DEMO_EMAIL_DOMAIN = 'demo.hotel.test';

export const DEMO_DEPARTMENTS = [
  { code: 'MGT', name: 'Management' },
  { code: 'FO', name: 'Front office' },
  { code: 'HK', name: 'Housekeeping' },
  { code: 'MNT', name: 'Maintenance' },
  { code: 'FIN', name: 'Finance' },
] as const;

type DepartmentCode = (typeof DEMO_DEPARTMENTS)[number]['code'];

/** System roles from Strategy §5 that V1 uses. MFA is mandatory for owner, GM and finance (M1-06). */
export const DEMO_ROLES: {
  name: string;
  slug: string;
  requiresMfa: boolean;
  orgWide: boolean;
  department: DepartmentCode | null;
}[] = [
  { name: 'Owner', slug: 'owner', requiresMfa: true, orgWide: true, department: null },
  { name: 'General Manager', slug: 'gm', requiresMfa: true, orgWide: false, department: 'MGT' },
  {
    name: 'Night Auditor',
    slug: 'night-auditor',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
  },
  {
    name: 'Front Desk / Cashier',
    slug: 'front-desk',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
  },
  {
    name: 'Reservations Agent',
    slug: 'reservations',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
  },
  { name: 'Finance', slug: 'finance', requiresMfa: true, orgWide: false, department: 'FIN' },
  {
    name: 'Housekeeping Supervisor',
    slug: 'hk-supervisor',
    requiresMfa: false,
    orgWide: false,
    department: 'HK',
  },
  {
    name: 'Housekeeping Attendant',
    slug: 'hk-attendant',
    requiresMfa: false,
    orgWide: false,
    department: 'HK',
  },
  {
    name: 'Maintenance',
    slug: 'maintenance',
    requiresMfa: false,
    orgWide: false,
    department: 'MNT',
  },
  {
    name: 'Department Manager',
    slug: 'dept-manager',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
  },
  { name: 'Staff Member', slug: 'staff', requiresMfa: false, orgWide: false, department: 'FO' },
  {
    name: 'Auditor (read-only)',
    slug: 'auditor',
    requiresMfa: false,
    orgWide: true,
    department: null,
  },
];

export async function seed(db: Db): Promise<void> {
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
    const role = await db.role.upsert({
      where: { organisationId_name: { organisationId: DEMO_ORG_ID, name: r.name } },
      update: { requiresMfa: r.requiresMfa },
      create: {
        organisationId: DEMO_ORG_ID,
        name: r.name,
        isSystem: true,
        requiresMfa: r.requiresMfa,
      },
    });

    const email = `${r.slug}@${DEMO_EMAIL_DOMAIN}`;
    const user = await db.user.upsert({
      where: { email },
      update: {},
      // No password yet: sign-in arrives with T-010, which sets a dev password here.
      create: { email, name: `Demo ${r.name}`, status: 'ACTIVE' },
    });

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
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Run via `npm run seed`, which loads .env.');
    process.exit(1);
  }
  const db = createDb(url);
  try {
    await seed(db);
    console.error(`Seeded demo organisation ${DEMO_ORG_ID} with ${DEMO_ROLES.length} users.`);
  } finally {
    await db.$disconnect();
  }
}
