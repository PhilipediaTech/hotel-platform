import {
  addDays,
  certState,
  CERT_REMIND_DAYS,
  type CertificationBody,
  type EmploymentType,
  type StaffBody,
  type StaffDetail,
  type StaffItem,
  type StaffPatch,
  type StaffStatus,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { defineJob } from '../../core/jobs.ts';
import { runAsTenant, type TenantContext } from '../../core/tenancy.ts';
import { createTenantDb, type TenantDb } from '../../core/tenant-db.ts';
import { propertyToday } from '../availability/inventory.ts';
import { insertTask } from '../tasks/service.ts';

// Staff profiles and certifications (PRD M7-01, M7-10; T-136). staff_profiles is named in tab
// 3 for V1.1 without columns: they are designed here, with staff_certifications. A profile
// stands alone or is linked to a member's login (one profile per login and property). The
// emergency contact is kept out of the list and the profile; it has its own route, and each
// read is audited. Pay is recorded as a rate per the employment type's period; nothing is
// paid from it here (M7 rule: no pay is computed unless a pay rule is configured). Every day
// the worker opens one task for the manager of anyone with a certification expiring within 30
// days, once per expiry date.

export interface StaffDeps {
  /** For members of the property (read across the organisation). */
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;

const STAFF_INCLUDE = {
  department: { select: { id: true, name: true } },
  manager: { select: { id: true, name: true } },
  user: { select: { id: true, email: true } },
  certifications: { orderBy: [{ expiresOn: 'asc' }, { name: 'asc' }] },
} as const satisfies Prisma.StaffProfileInclude;
type StaffRow = Prisma.StaffProfileGetPayload<{ include: typeof STAFF_INCLUDE }>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dayOrNull = (d: Date | null) => (d ? day(d) : null);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

function staffItem(s: StaffRow, today: string): z.input<typeof StaffItem> {
  return {
    id: s.id,
    number: s.number,
    name: s.name,
    jobTitle: s.jobTitle,
    department: s.department,
    manager: s.manager,
    user: s.user,
    employmentType: s.employmentType as EmploymentType,
    startDate: day(s.startDate),
    endDate: dayOrNull(s.endDate),
    status: s.status as StaffStatus,
    certsDue: s.certifications.filter((c) => {
      const state = certState(dayOrNull(c.expiresOn), today);
      return state === 'EXPIRING' || state === 'EXPIRED';
    }).length,
    hasEmergencyContact: Boolean(s.emergencyName ?? s.emergencyPhone),
  };
}

function staffDetail(s: StaffRow, today: string, currency: string): z.input<typeof StaffDetail> {
  return {
    ...staffItem(s, today),
    phone: s.phone,
    email: s.email,
    payRateMinor: s.payRateMinor === null ? null : s.payRateMinor.toString(),
    currency,
    certifications: s.certifications.map((c) => ({
      id: c.id,
      name: c.name,
      issuer: c.issuer,
      reference: c.reference,
      issuedOn: dayOrNull(c.issuedOn),
      expiresOn: dayOrNull(c.expiresOn),
      state: certState(dayOrNull(c.expiresOn), today),
    })),
    createdAt: iso(s.createdAt),
  };
}

/** What the audit keeps of a profile: never the pay rate or the emergency contact itself. */
function snapshot(s: Prisma.StaffProfileGetPayload<object>) {
  return {
    name: s.name,
    userId: s.userId,
    departmentId: s.departmentId,
    jobTitle: s.jobTitle,
    managerId: s.managerId,
    employmentType: s.employmentType,
    startDate: day(s.startDate),
    endDate: dayOrNull(s.endDate),
    status: s.status,
    phone: s.phone,
    email: s.email,
    payRateRecorded: s.payRateMinor !== null,
    payRateChangedAt: null as string | null,
    emergencyContactRecorded: Boolean(s.emergencyName ?? s.emergencyPhone),
  };
}

async function detailOf(deps: StaffDeps, tx: Client, tenant: TenantContext, staffId: string) {
  const s = await tx.staffProfile.findFirst({ where: { id: staffId }, include: STAFF_INCLUDE });
  if (!s) throw new AppError('NOT_FOUND', 'Staff member not found.');
  const p = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
  return staffDetail(s, await propertyToday(tx, tenant.propertyId, deps.clock), p.baseCurrency);
}

/** Active members of this property (or the whole organisation): logins and managers. */
async function membersOf(db: Db, tenant: TenantContext) {
  const members = await db.membership.findMany({
    where: {
      active: true,
      organisationId: tenant.organisationId,
      OR: [{ propertyId: tenant.propertyId }, { propertyId: null }],
      user: { status: 'ACTIVE' },
    },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  const people = new Map(members.map((m) => [m.user.id, m.user]));
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function checkMember(deps: StaffDeps, tenant: TenantContext, userId: string, path: string) {
  const members = await membersOf(deps.db, tenant);
  if (!members.some((m) => m.id === userId)) {
    throw invalid(path, 'Choose a member of this property');
  }
}

async function checkDepartment(tx: Tx, departmentId: string) {
  const department = await tx.department.findFirst({ where: { id: departmentId } });
  if (!department) throw invalid('departmentId', 'Choose a department of this property');
}

async function checkLogin(tx: Tx, userId: string, staffId: string | null) {
  const taken = await tx.staffProfile.findFirst({
    where: { userId, ...(staffId ? { id: { not: staffId } } : {}) },
    select: { number: true },
  });
  if (taken) throw invalid('userId', `This login already belongs to ST-${taken.number}`);
}

function emergencyData(e: z.output<typeof StaffBody>['emergency']) {
  return {
    emergencyName: e?.name ?? null,
    emergencyPhone: e?.phone ?? null,
    emergencyRelation: e?.relation ?? null,
  };
}

// ── Directory and profiles ─────────────────────────────────────────────────────────────

export async function listStaff(
  deps: StaffDeps,
  tenant: TenantContext,
  query: { status?: StaffStatus | undefined; q?: string | undefined },
) {
  const q = query.q?.trim();
  const number = q && /^(st-?)?\d+$/i.test(q) ? Number(q.replace(/\D/g, '')) : null;
  const [rows, departments, members, today] = await Promise.all([
    deps.tenantDb.staffProfile.findMany({
      where: {
        status: query.status ?? 'ACTIVE',
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { jobTitle: { contains: q, mode: 'insensitive' } },
                ...(number !== null ? [{ number }] : []),
              ],
            }
          : {}),
      },
      include: STAFF_INCLUDE,
      orderBy: { name: 'asc' },
    }),
    deps.tenantDb.department.findMany({ orderBy: { name: 'asc' } }),
    membersOf(deps.db, tenant),
    propertyToday(deps.tenantDb, tenant.propertyId, deps.clock),
  ]);
  const linked = new Set(
    (await deps.tenantDb.staffProfile.findMany({ where: { userId: { not: null } } })).map(
      (s) => s.userId,
    ),
  );
  return {
    data: rows.map((r) => staffItem(r, today)),
    departments: departments.map((d) => ({ id: d.id, name: d.name })),
    people: members.map((m) => ({ ...m, linked: linked.has(m.id) })),
    today,
  };
}

export async function createStaff(
  deps: StaffDeps,
  tenant: TenantContext,
  body: z.output<typeof StaffBody>,
) {
  if (body.userId) await checkMember(deps, tenant, body.userId, 'userId');
  if (body.managerId) await checkMember(deps, tenant, body.managerId, 'managerId');
  return deps.tenantDb.$transaction(async (tx) => {
    if (body.departmentId) await checkDepartment(tx, body.departmentId);
    if (body.userId) await checkLogin(tx, body.userId, null);
    const number = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.STAFF);
    const s = await tx.staffProfile.create({
      data: {
        number,
        userId: body.userId,
        name: body.name,
        phone: body.phone,
        email: body.email,
        departmentId: body.departmentId,
        jobTitle: body.jobTitle,
        managerId: body.managerId,
        employmentType: body.employmentType,
        startDate: dbDate(body.startDate),
        payRateMinor: body.payRateMinor === null ? null : BigInt(body.payRateMinor),
        ...emergencyData(body.emergency),
      } as unknown as Prisma.StaffProfileUncheckedCreateInput, // tenant IDs come from the client
    });
    await recordAudit(tx, {
      action: 'staff.created',
      entityType: 'staff_profile',
      entityId: s.id,
      after: { number, ...snapshot(s) },
    });
    return detailOf(deps, tx, tenant, s.id);
  });
}

export async function getStaff(deps: StaffDeps, tenant: TenantContext, staffId: string) {
  return detailOf(deps, deps.tenantDb, tenant, staffId);
}

export async function updateStaff(
  deps: StaffDeps,
  tenant: TenantContext,
  staffId: string,
  body: z.output<typeof StaffPatch>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM staff_profiles WHERE id = ${staffId}::uuid FOR UPDATE`;
    const before = await tx.staffProfile.findFirst({ where: { id: staffId } });
    if (!before) throw new AppError('NOT_FOUND', 'Staff member not found.');
    if (body.userId) {
      await checkMember(deps, tenant, body.userId, 'userId');
      await checkLogin(tx, body.userId, staffId);
    }
    if (body.managerId) await checkMember(deps, tenant, body.managerId, 'managerId');
    if (body.departmentId) await checkDepartment(tx, body.departmentId);
    const startDate = body.startDate ?? day(before.startDate);
    const endDate = body.endDate === undefined ? dayOrNull(before.endDate) : body.endDate;
    if (endDate && endDate < startDate) throw invalid('endDate', 'Leaves before they started');

    const { emergency, payRateMinor, startDate: _s, endDate: _e, ...rest } = body;
    const data: Prisma.StaffProfileUncheckedUpdateInput = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    data.startDate = dbDate(startDate);
    data.endDate = endDate ? dbDate(endDate) : null;
    data.status = endDate ? 'LEFT' : 'ACTIVE';
    if (payRateMinor !== undefined) {
      data.payRateMinor = payRateMinor === null ? null : BigInt(payRateMinor);
    }
    if (emergency !== undefined) Object.assign(data, emergencyData(emergency));
    const after = await tx.staffProfile.update({ where: { id: staffId }, data });

    const was = snapshot(before);
    const now = snapshot(after);
    if (before.payRateMinor !== after.payRateMinor) now.payRateChangedAt = iso(deps.clock());
    const changed = (Object.keys(now) as (keyof typeof now)[]).filter((k) => was[k] !== now[k]);
    const emergencyChanged =
      before.emergencyName !== after.emergencyName ||
      before.emergencyPhone !== after.emergencyPhone ||
      before.emergencyRelation !== after.emergencyRelation;
    if (changed.length > 0 || emergencyChanged) {
      await recordAudit(tx, {
        action:
          after.status !== before.status && after.status === 'LEFT'
            ? 'staff.left'
            : 'staff.updated',
        entityType: 'staff_profile',
        entityId: staffId,
        before: Object.fromEntries(changed.map((k) => [k, was[k]])),
        after: {
          ...Object.fromEntries(changed.map((k) => [k, now[k]])),
          ...(emergencyChanged ? { emergencyContactChanged: true } : {}),
        },
      });
    }
    return detailOf(deps, tx, tenant, staffId);
  });
}

/** The restricted emergency contact: each read is on the audit log. */
export async function getEmergencyContact(deps: StaffDeps, staffId: string) {
  const s = await deps.tenantDb.staffProfile.findFirst({ where: { id: staffId } });
  if (!s) throw new AppError('NOT_FOUND', 'Staff member not found.');
  await recordAudit(deps.tenantDb, {
    action: 'staff.emergency_contact_viewed',
    entityType: 'staff_profile',
    entityId: staffId,
  });
  return { name: s.emergencyName, phone: s.emergencyPhone, relation: s.emergencyRelation };
}

// ── Certifications ─────────────────────────────────────────────────────────────────────

function certData(body: z.output<typeof CertificationBody>) {
  return {
    name: body.name,
    issuer: body.issuer,
    reference: body.reference,
    issuedOn: body.issuedOn ? dbDate(body.issuedOn) : null,
    expiresOn: body.expiresOn ? dbDate(body.expiresOn) : null,
  };
}

export async function addCertification(
  deps: StaffDeps,
  tenant: TenantContext,
  staffId: string,
  body: z.output<typeof CertificationBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const s = await tx.staffProfile.findFirst({ where: { id: staffId } });
    if (!s) throw new AppError('NOT_FOUND', 'Staff member not found.');
    await tx.staffProfile.update({
      where: { id: staffId },
      data: { certifications: { create: certData(body) } },
    });
    await recordAudit(tx, {
      action: 'staff.certification_added',
      entityType: 'staff_profile',
      entityId: staffId,
      after: { name: body.name, expiresOn: body.expiresOn },
    });
    return detailOf(deps, tx, tenant, staffId);
  });
}

async function certOf(tx: Tx, staffId: string, certificationId: string) {
  const s = await tx.staffProfile.findFirst({
    where: { id: staffId },
    include: { certifications: { where: { id: certificationId } } },
  });
  const cert = s?.certifications[0];
  if (!s || !cert) throw new AppError('NOT_FOUND', 'Certification not found.');
  return cert;
}

export async function updateCertification(
  deps: StaffDeps,
  tenant: TenantContext,
  staffId: string,
  certificationId: string,
  body: z.output<typeof CertificationBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await certOf(tx, staffId, certificationId);
    await tx.staffProfile.update({
      where: { id: staffId },
      data: {
        certifications: { update: { where: { id: certificationId }, data: certData(body) } },
      },
    });
    await recordAudit(tx, {
      action: 'staff.certification_updated',
      entityType: 'staff_profile',
      entityId: staffId,
      before: { name: before.name, expiresOn: dayOrNull(before.expiresOn) },
      after: { name: body.name, expiresOn: body.expiresOn },
    });
    return detailOf(deps, tx, tenant, staffId);
  });
}

export async function removeCertification(
  deps: StaffDeps,
  tenant: TenantContext,
  staffId: string,
  certificationId: string,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await certOf(tx, staffId, certificationId);
    await tx.staffProfile.update({
      where: { id: staffId },
      data: { certifications: { delete: { id: certificationId } } },
    });
    await recordAudit(tx, {
      action: 'staff.certification_removed',
      entityType: 'staff_profile',
      entityId: staffId,
      before: {
        name: before.name,
        reference: before.reference,
        issuedOn: dayOrNull(before.issuedOn),
        expiresOn: dayOrNull(before.expiresOn),
      },
    });
    return detailOf(deps, tx, tenant, staffId);
  });
}

// ── Reminders (M7-10) ──────────────────────────────────────────────────────────────────

/**
 * Opens one task per certification expiring within 30 days (or already expired) that has not
 * been reminded for its current expiry date: given to the person's manager, in their
 * department (or management's). Returns how many were opened.
 */
export async function remindCertifications(
  tenantDb: TenantDb,
  propertyId: string,
  clock: Clock,
): Promise<number> {
  return tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-certs:${propertyId}`}))::text AS locked`;
    const today = await propertyToday(tx, propertyId, clock);
    const limit = dbDate(addDays(today, CERT_REMIND_DAYS));
    const people = await tx.staffProfile.findMany({
      where: {
        status: 'ACTIVE',
        certifications: { some: { expiresOn: { lte: limit } } },
      },
      include: { certifications: { where: { expiresOn: { lte: limit } } } },
    });
    const fallback =
      (await tx.department.findFirst({ where: { code: 'MGT' } })) ??
      (await tx.department.findFirst({ orderBy: { name: 'asc' } }));
    let opened = 0;
    for (const person of people) {
      for (const cert of person.certifications) {
        if (!cert.expiresOn) continue;
        if (cert.remindedFor && cert.remindedFor.getTime() === cert.expiresOn.getTime()) continue;
        const departmentId = person.departmentId ?? fallback?.id;
        if (!departmentId) continue;
        const expires = day(cert.expiresOn);
        const task = await insertTask(tx, propertyId, {
          type: 'GENERAL',
          templateId: null,
          departmentId,
          title:
            `Certification ${expires < today ? 'expired' : 'expiring'}: ${person.name}, ${cert.name}`.slice(
              0,
              200,
            ),
          description: `${cert.name}${cert.reference ? ` (${cert.reference})` : ''} for ST-${person.number} ${person.name} ${expires < today ? 'expired' : 'expires'} on ${expires}. Renew it and update the staff profile.`,
          priority: expires < today ? 'HIGH' : 'NORMAL',
          assigneeId: person.managerId,
          dueAt: dbDate(expires),
          reportedById: null,
        });
        await tx.staffProfile.update({
          where: { id: person.id },
          data: {
            certifications: {
              update: { where: { id: cert.id }, data: { remindedFor: cert.expiresOn } },
            },
          },
        });
        await recordAudit(tx, {
          action: 'staff.certification_reminded',
          entityType: 'staff_profile',
          entityId: person.id,
          after: { certification: cert.name, expiresOn: expires, taskId: task.id },
        });
        opened += 1;
      }
    }
    return opened;
  });
}

function systemTenant(property: { id: string; organisationId: string }): TenantContext {
  return {
    userId: null as unknown as string,
    organisationId: property.organisationId,
    propertyId: property.id,
    roles: [],
    permissions: new Set(),
  };
}

export async function runCertificationReminders(db: Db, clock: Clock): Promise<number> {
  const properties = await db.property.findMany({
    where: { staffProfiles: { some: { status: 'ACTIVE', certifications: { some: {} } } } },
    select: { id: true, organisationId: true },
  });
  const tenantDb = createTenantDb(db);
  let opened = 0;
  for (const property of properties) {
    opened += await runAsTenant(systemTenant(property), () =>
      remindCertifications(tenantDb, property.id, clock),
    );
  }
  return opened;
}

export const certificationRemindersJob = defineJob({
  name: 'certification-reminders',
  // Daily, early morning (UTC); each property's own date decides what is due.
  schedule: { cron: '15 5 * * *' },
  async run(_data, { db, clock, logger }) {
    const opened = await runCertificationReminders(db, clock);
    if (opened > 0) logger.info({ opened }, 'Certification reminders opened as tasks');
  },
});
