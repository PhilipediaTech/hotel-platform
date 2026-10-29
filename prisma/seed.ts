// Demo data for local development: `npm run seed`. Safe to run repeatedly (upserts).
// Grows with each ticket (rates arrive with T-033).
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createDb, type Db } from '../apps/api/src/core/db.ts';
import type { Prisma } from '../apps/api/src/generated/prisma/client.ts';
import { hashPassword } from '../apps/api/src/core/passwords.ts';
import {
  DEPARTMENT_TEMPLATES,
  ROLE_TEMPLATES,
  type DepartmentCode,
} from '../apps/api/src/modules/identity/role-templates.ts';
import { createDefaultApprovalPolicies } from '../apps/api/src/modules/approvals/defaults.ts';
import { createDefaultTaxes } from '../apps/api/src/modules/tax/defaults.ts';
import { rebuildInventory } from '../apps/api/src/modules/availability/inventory.ts';
import { createQuote } from '../apps/api/src/modules/availability/quotes.ts';
import { createReservation } from '../apps/api/src/modules/reservations/service.ts';
import { resolveTenant, runAsTenant } from '../apps/api/src/core/tenancy.ts';
import { createTenantDb } from '../apps/api/src/core/tenant-db.ts';
import { addDays, localDate } from '@hotel/shared';

export const DEMO_ORG_ID = '0d0d0d0d-0000-4000-8000-000000000001';
export const DEMO_PROPERTY_ID = '0d0d0d0d-0000-4000-8000-000000000002';
export const DEMO_EMAIL_DOMAIN = 'demo.hotel.test';

/** Same templates a real sign-up gets; one demo user per role (`<slug>@demo.hotel.test`). */
export const DEMO_DEPARTMENTS = DEPARTMENT_TEMPLATES;
export const DEMO_ROLES = ROLE_TEMPLATES;

/** Runbook: 30 rooms. Three types on three floors (T-031). */
export const DEMO_ROOM_TYPES = [
  { code: 'STD', name: 'Standard', baseOccupancy: 2, maxOccupancy: 2, floor: '1', rooms: 15 },
  { code: 'DLX', name: 'Deluxe', baseOccupancy: 2, maxOccupancy: 3, floor: '2', rooms: 10 },
  { code: 'STE', name: 'Suite', baseOccupancy: 2, maxOccupancy: 4, floor: '3', rooms: 5 },
] as const;

/** Demo BAR per night in kobo (T-033), set for the next DEMO_RATE_DAYS days. */
export const DEMO_BAR = { STD: 4_500_000n, DLX: 6_500_000n, STE: 12_000_000n } as const;
export const DEMO_RATE_DAYS = 90;
/** Day-use price per stay of up to six hours (T-052), every room type. */
export const DEMO_DAY_USE = 2_000_000n;

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

  // Example Lagos taxes (T-032), kept if the property already has revenue codes.
  const property = await db.property.findUniqueOrThrow({ where: { id: DEMO_PROPERTY_ID } });
  await createDefaultTaxes(
    db,
    { id: property.id, country: 'NG', settings: property.settings },
    localDate(new Date(), property.timeZone),
  );

  for (const [sortOrder, t] of DEMO_ROOM_TYPES.entries()) {
    const type = await db.roomType.upsert({
      where: { propertyId_code: { propertyId: DEMO_PROPERTY_ID, code: t.code } },
      update: {},
      create: {
        organisationId: DEMO_ORG_ID,
        propertyId: DEMO_PROPERTY_ID,
        code: t.code,
        name: t.name,
        baseOccupancy: t.baseOccupancy,
        maxOccupancy: t.maxOccupancy,
        sortOrder,
      },
    });
    for (let n = 1; n <= t.rooms; n++) {
      const number = `${t.floor}${String(n).padStart(2, '0')}`;
      await db.room.upsert({
        where: { propertyId_number: { propertyId: DEMO_PROPERTY_ID, number } },
        update: {},
        create: {
          organisationId: DEMO_ORG_ID,
          propertyId: DEMO_PROPERTY_ID,
          roomTypeId: type.id,
          number,
          floor: t.floor,
          qrToken: randomBytes(16).toString('base64url'),
        },
      });
    }
  }

  await seedRates(db, localDate(new Date(), property.timeZone));
  // Rooms left per type and date (T-040).
  await rebuildInventory(db, DEMO_PROPERTY_ID, localDate(new Date(), property.timeZone));
  await seedReservations(db, localDate(new Date(), property.timeZone));
}

/**
 * Demo reservations (T-042), made through the booking service as the front-desk user: a
 * confirmed stay, a tentative hold for two days, and two rooms under one booker. Only once
 * the property is live and has no reservations yet.
 */
async function seedReservations(db: Db, today: string): Promise<void> {
  const property = await db.property.findUniqueOrThrow({ where: { id: DEMO_PROPERTY_ID } });
  if (property.status !== 'LIVE') return;
  if ((await db.reservation.count({ where: { propertyId: DEMO_PROPERTY_ID } })) > 0) return;
  const desk = await db.user.findUnique({
    where: { email: `front-desk@${DEMO_EMAIL_DOMAIN}` },
  });
  const tenant = desk ? await resolveTenant(db, desk.id, DEMO_PROPERTY_ID) : null;
  if (!tenant) return;
  const deps = { db, tenantDb: createTenantDb(db), clock: () => new Date() };
  const plan = async (code: string) =>
    db.ratePlan.findUniqueOrThrow({
      where: { propertyId_code: { propertyId: DEMO_PROPERTY_ID, code } },
    });
  const type = async (code: string) =>
    db.roomType.findUniqueOrThrow({
      where: { propertyId_code: { propertyId: DEMO_PROPERTY_ID, code } },
    });
  const [bar, corp, std, dlx] = [
    await plan('BAR'),
    await plan('CORP'),
    await type('STD'),
    await type('DLX'),
  ];
  await runAsTenant(tenant, async () => {
    const quote = async (
      roomTypeId: string,
      ratePlanId: string,
      from: number,
      nights: number,
      adults: number,
    ) =>
      (
        await createQuote(deps, tenant, {
          roomTypeId,
          ratePlanId,
          arrival: addDays(today, from),
          departure: addDays(today, from + nights),
          adults,
          children: 0,
        })
      ).quoteId;
    const sameAsBooker = { sameAsBooker: true, guestId: null, phone: null, email: null };
    const book = (body: object) =>
      createReservation(deps, tenant, {
        guarantee: 'NONE',
        holdUntil: null,
        companyId: null,
        notes: null,
        ...body,
      } as Parameters<typeof createReservation>[2]);
    await book({
      source: 'PHONE',
      guarantee: 'DEPOSIT',
      booker: {
        guestId: null,
        firstName: 'Ada',
        lastName: 'Obi',
        phone: '+2348031234567',
        email: 'ada.obi@example.com',
      },
      stays: [{ quoteId: await quote(std.id, bar.id, 2, 2, 2), guest: sameAsBooker, roomId: null }],
      notes: 'Late arrival, around 22:00',
    });
    await book({
      source: 'WHATSAPP',
      holdUntil: new Date(Date.now() + 2 * 86_400_000).toISOString().replace(/.d{3}Z$/, 'Z'),
      booker: {
        guestId: null,
        firstName: 'Bola',
        lastName: 'Ade',
        phone: '+2348021112222',
        email: null,
      },
      stays: [{ quoteId: await quote(dlx.id, bar.id, 5, 1, 1), guest: sameAsBooker, roomId: null }],
    });
    await book({
      source: 'EMAIL',
      booker: {
        guestId: null,
        firstName: 'Chidi',
        lastName: 'Eze',
        phone: '+2348035556666',
        email: 'chidi.eze@example.com',
      },
      stays: [
        { quoteId: await quote(std.id, corp.id, 7, 2, 1), guest: sameAsBooker, roomId: null },
        {
          quoteId: await quote(std.id, corp.id, 7, 2, 1),
          guest: {
            sameAsBooker: false,
            guestId: null,
            firstName: 'Ngozi',
            lastName: 'Eze',
            phone: null,
            email: null,
          },
          roomId: null,
        },
      ],
    });
  });
}

/**
 * Demo rates (T-033): a flexible policy, BAR with prices for the next 90 days, Corporate at
 * 10% off BAR, and Bed and breakfast (BAR + ₦10,000 with breakfast for two posted to F&B).
 * Plans already there are left alone; missing days are added.
 */
async function seedRates(db: Db, today: string): Promise<void> {
  const existing = await db.cancellationPolicy.findFirst({
    where: { propertyId: DEMO_PROPERTY_ID, name: 'Flexible' },
  });
  const policy =
    existing ??
    (await db.cancellationPolicy.create({
      data: {
        propertyId: DEMO_PROPERTY_ID,
        name: 'Flexible',
        rules: [{ daysBefore: 1, feeType: 'NIGHTS', value: 1 }],
        noShowFee: { feeType: 'NIGHTS', value: 1 },
      },
    }));
  const plan = (
    code: string,
    data: Omit<
      Prisma.RatePlanUncheckedCreateInput,
      'organisationId' | 'propertyId' | 'code' | 'cancellationPolicyId' | 'currency'
    >,
  ) =>
    db.ratePlan.upsert({
      where: { propertyId_code: { propertyId: DEMO_PROPERTY_ID, code } },
      update: {},
      create: {
        organisationId: DEMO_ORG_ID,
        propertyId: DEMO_PROPERTY_ID,
        code,
        cancellationPolicyId: policy.id,
        currency: 'NGN',
        ...data,
      },
    });
  const bar = await plan('BAR', { name: 'Best available', kind: 'BAR', isPublic: true });
  await plan('CORP', {
    name: 'Corporate',
    kind: 'DERIVED',
    parentRatePlanId: bar.id,
    derivationBps: -1000,
  });
  const bb = await plan('BB', {
    name: 'Bed and breakfast',
    kind: 'PACKAGE',
    parentRatePlanId: bar.id,
    derivationAmountMinor: 1_000_000n,
    mealPlan: 'BREAKFAST',
  });
  const dayUse = await plan('DAY', {
    name: 'Day use (up to 6 hours)',
    kind: 'DAY_USE',
    dayUseMaxMinutes: 360,
  });
  const fnb = await db.revenueCode.findUnique({
    where: { propertyId_code: { propertyId: DEMO_PROPERTY_ID, code: 'FNB' } },
  });
  if (fnb && (await db.packageComponent.count({ where: { ratePlanId: bb.id } })) === 0) {
    await db.packageComponent.create({
      data: {
        ratePlanId: bb.id,
        name: 'Breakfast',
        revenueCodeId: fnb.id,
        amountMinor: 500_000n,
        perPerson: true,
      },
    });
  }

  const types = await db.roomType.findMany({ where: { propertyId: DEMO_PROPERTY_ID } });
  const start = new Date(`${today}T00:00:00Z`);
  const days = (ratePlanId: string, price: (code: string) => bigint) =>
    types.flatMap((type) =>
      Array.from({ length: DEMO_RATE_DAYS }, (_, i) => ({
        propertyId: DEMO_PROPERTY_ID,
        ratePlanId,
        roomTypeId: type.id,
        date: new Date(start.getTime() + i * 86_400_000),
        amountMinor: price(type.code),
      })),
    );
  await db.rateDay.createMany({
    data: [
      ...days(bar.id, (code) => DEMO_BAR[code as keyof typeof DEMO_BAR] ?? 5_000_000n),
      ...days(dayUse.id, () => DEMO_DAY_USE),
    ],
    skipDuplicates: true,
  });
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
