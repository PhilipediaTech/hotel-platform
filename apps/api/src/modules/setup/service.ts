import {
  LOCKED_WHEN_LIVE,
  SETUP_STEPS,
  SIGN_UP_COUNTRIES,
  type ManualPayMethod,
  type OrganisationPatchBody,
  type PropertyCreateBody,
  type PropertyDetail,
  type PropertyPatchBody,
  type SetupChecklist,
  type SetupStepId,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma, Property } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db, type DbClient } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';
import { DEPARTMENT_TEMPLATES } from '../identity/role-templates.ts';
import { propertyCodeFor } from '../identity/service.ts';

// Organisation and property setup (PRD M1-02; tab 4 row "Organisation"; S02; T-030):
// details, region, payment methods, the setup checklist and go-live. Properties are tenancy
// roots, not tenant tables, so queries name the caller's organisation and property directly.

export interface SetupDeps {
  db: Db;
  clock: Clock;
}

type Detail = z.input<typeof PropertyDetail>;
type Checklist = z.input<typeof SetupChecklist>;

interface Settings {
  paymentMethods?: ManualPayMethod[];
}

const settingsOf = (p: Property): Settings => (p.settings ?? {}) as Settings;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

function addressOf(p: Property): Detail['address'] {
  const a = record(p.address);
  return {
    line1: str(a['line1']),
    line2: str(a['line2']),
    city: str(a['city']),
    state: str(a['state']),
    postalCode: str(a['postalCode']),
    country: str(a['country']) ?? '',
  };
}

function taxRegistrationOf(p: Property): Detail['taxRegistration'] {
  const t = record(p.taxRegistration);
  return { tin: str(t['tin']), vatNumber: str(t['vatNumber']) };
}

/** Another property path than the one in X-Property-Id reads as missing (no leaks). */
function sameProperty(tenant: TenantContext, propertyId: string): void {
  if (propertyId !== tenant.propertyId) throw new AppError('NOT_FOUND', 'Property not found');
}

async function loadProperty(deps: SetupDeps, tenant: TenantContext): Promise<Property> {
  return deps.db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
}

// ── Checklist ──────────────────────────────────────────────────────────────────────────

/** Someone besides the owner can sign in here, or has been invited. */
async function hasStaff(db: DbClient, p: Property, now: Date): Promise<boolean> {
  const here = {
    organisationId: p.organisationId,
    OR: [{ propertyId: p.id }, { propertyId: null }],
  };
  const [people, invitations] = await Promise.all([
    db.membership.findMany({ where: { ...here, active: true }, select: { userId: true } }),
    db.invitation.count({
      where: { ...here, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    }),
  ]);
  return new Set(people.map((m) => m.userId)).size > 1 || invitations > 0;
}

async function stepDone(
  db: DbClient,
  id: SetupStepId,
  p: Property,
  organisation: { name: string },
  now: Date,
): Promise<boolean> {
  switch (id) {
    case 'organisation':
      return organisation.name.trim() !== '';
    case 'details': {
      const a = addressOf(p);
      return Boolean(p.name && a.line1 && a.city && a.state && (p.phone || p.email));
    }
    case 'region':
      // Sign-up fills these from the country; PATCH validates every change.
      return Boolean(p.timeZone && p.baseCurrency && p.locale);
    case 'payment-methods':
      return (settingsOf(p).paymentMethods ?? []).length > 0;
    case 'staff':
      return hasStaff(db, p, now);
    case 'room-types':
      return (await db.roomType.count({ where: { propertyId: p.id, active: true } })) > 0;
    case 'rooms':
      return (await db.room.count({ where: { propertyId: p.id, active: true } })) > 0;
    case 'tax':
    case 'rates':
      // Not built yet (SETUP_STEPS `later`); their tickets add the check here.
      return false;
  }
}

export async function checklistFor(db: DbClient, p: Property, now: Date): Promise<Checklist> {
  const organisation = await db.organisation.findUniqueOrThrow({
    where: { id: p.organisationId },
  });
  const steps = await Promise.all(
    SETUP_STEPS.map(async (step) => {
      const status: Checklist['steps'][number]['status'] = step.later
        ? 'LATER'
        : (await stepDone(db, step.id, p, organisation, now))
          ? 'DONE'
          : 'TODO';
      return { id: step.id, status, required: step.required, ticket: step.later ?? null };
    }),
  );
  return { steps, ready: steps.every((s) => !s.required || s.status !== 'TODO') };
}

async function toDetail(db: DbClient, p: Property, now: Date): Promise<Detail> {
  return {
    id: p.id,
    organisationId: p.organisationId,
    code: p.code,
    name: p.name,
    status: p.status,
    timeZone: p.timeZone,
    baseCurrency: p.baseCurrency,
    locale: p.locale,
    address: addressOf(p),
    phone: p.phone,
    email: p.email,
    taxRegistration: taxRegistrationOf(p),
    checkInTime: p.checkInTime,
    checkOutTime: p.checkOutTime,
    nightAuditTime: p.nightAuditTime,
    paymentMethods: settingsOf(p).paymentMethods ?? [],
    checklist: await checklistFor(db, p, now),
  };
}

// ── Organisation ───────────────────────────────────────────────────────────────────────

const orgView = (o: { id: string; name: string; legalName: string | null; country: string }) => ({
  id: o.id,
  name: o.name,
  legalName: o.legalName,
  country: o.country,
});

export async function getOrganisation(deps: SetupDeps, tenant: TenantContext) {
  return orgView(
    await deps.db.organisation.findUniqueOrThrow({ where: { id: tenant.organisationId } }),
  );
}

export async function updateOrganisation(
  deps: SetupDeps,
  tenant: TenantContext,
  body: z.output<typeof OrganisationPatchBody>,
) {
  return deps.db.$transaction(async (tx) => {
    const before = await tx.organisation.findUniqueOrThrow({
      where: { id: tenant.organisationId },
    });
    const data: Prisma.OrganisationUpdateInput = {};
    if (body.name !== undefined && body.name !== before.name) data.name = body.name;
    if (body.legalName !== undefined && body.legalName !== before.legalName) {
      data.legalName = body.legalName;
    }
    if (Object.keys(data).length === 0) return orgView(before);
    const after = await tx.organisation.update({ where: { id: before.id }, data });
    await recordAudit(tx, {
      action: 'organisation.updated',
      entityType: 'organisation',
      entityId: before.id,
      propertyId: null,
      before: pick(orgView(before), Object.keys(data)),
      after: pick(orgView(after), Object.keys(data)),
    });
    return orgView(after);
  });
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, value[k]]));
}

// ── Properties ─────────────────────────────────────────────────────────────────────────

/** Properties of the caller's organisation they can open (all of them with an org-wide role). */
export async function listProperties(deps: SetupDeps, tenant: TenantContext) {
  const memberships = await deps.db.membership.findMany({
    where: { userId: tenant.userId, organisationId: tenant.organisationId, active: true },
    select: { propertyId: true },
  });
  const orgWide = memberships.some((m) => m.propertyId === null);
  const ids = memberships.flatMap((m) => (m.propertyId ? [m.propertyId] : []));
  const rows = await deps.db.property.findMany({
    where: {
      organisationId: tenant.organisationId,
      status: { not: 'ARCHIVED' },
      ...(orgWide ? {} : { id: { in: ids } }),
    },
    orderBy: { name: 'asc' },
  });
  return rows.map((p) => ({ id: p.id, code: p.code, name: p.name, status: p.status }));
}

const codeTaken = (err: unknown) =>
  pgErrorInfo(err)?.sqlState === '23505' &&
  /properties_organisation_id_code/.test(pgErrorInfo(err)?.constraint ?? '');

const codeInUse = () =>
  new AppError('VALIDATION_ERROR', 'Another property already uses this code', {
    issues: [{ path: 'body.code', code: 'custom', message: 'Another property uses this code' }],
  });

/** The name's initials, with a digit added when another property already has them. */
async function freeCode(db: DbClient, organisationId: string, name: string): Promise<string> {
  const base = propertyCodeFor(name).slice(0, 5);
  const taken = new Set(
    (await db.property.findMany({ where: { organisationId }, select: { code: true } })).map(
      (p) => p.code,
    ),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const code = `${base.slice(0, 6 - String(n).length)}${n}`;
    if (!taken.has(code)) return code;
  }
  return base; // 98 look-alike names: let the unique index answer
}

export async function createProperty(
  deps: SetupDeps,
  tenant: TenantContext,
  body: z.output<typeof PropertyCreateBody>,
): Promise<Detail> {
  try {
    return await deps.db.$transaction(async (tx) => {
      const organisation = await tx.organisation.findUniqueOrThrow({
        where: { id: tenant.organisationId },
      });
      const defaults =
        SIGN_UP_COUNTRIES[organisation.country as keyof typeof SIGN_UP_COUNTRIES] ?? null;
      const property = await tx.property.create({
        data: {
          organisationId: organisation.id,
          code: body.code ?? (await freeCode(tx, organisation.id, body.name)),
          name: body.name,
          ...(defaults && {
            timeZone: defaults.timeZone,
            baseCurrency: defaults.currency,
            locale: defaults.locale,
          }),
          address: { country: organisation.country },
        },
      });
      await tx.department.createMany({
        data: DEPARTMENT_TEMPLATES.map((d) => ({
          organisationId: organisation.id,
          propertyId: property.id,
          ...d,
        })),
      });
      await createDefaultApprovalPolicies(tx, organisation.id, property.id);
      await recordAudit(tx, {
        action: 'property.created',
        entityType: 'property',
        entityId: property.id,
        propertyId: property.id,
        // `code` is a secret key name in audit rows (MFA codes), so it is spelled out.
        after: { name: property.name, propertyCode: property.code, status: property.status },
      });
      return toDetail(tx, property, deps.clock());
    });
  } catch (err) {
    if (codeTaken(err)) throw codeInUse();
    throw err;
  }
}

export async function getProperty(
  deps: SetupDeps,
  tenant: TenantContext,
  propertyId: string,
): Promise<Detail> {
  sameProperty(tenant, propertyId);
  return toDetail(deps.db, await loadProperty(deps, tenant), deps.clock());
}

/** Audit-friendly view of the editable fields. */
function editable(p: Property): Record<string, unknown> {
  return {
    name: p.name,
    propertyCode: p.code,
    address: addressOf(p),
    phone: p.phone,
    email: p.email,
    taxRegistration: taxRegistrationOf(p),
    timeZone: p.timeZone,
    baseCurrency: p.baseCurrency,
    locale: p.locale,
    checkInTime: p.checkInTime,
    checkOutTime: p.checkOutTime,
    nightAuditTime: p.nightAuditTime,
    paymentMethods: settingsOf(p).paymentMethods ?? [],
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function updateProperty(
  deps: SetupDeps,
  tenant: TenantContext,
  propertyId: string,
  body: z.output<typeof PropertyPatchBody>,
): Promise<Detail> {
  sameProperty(tenant, propertyId);
  try {
    return await deps.db.$transaction(async (tx) => {
      // Serialises edits with go-live, so a live property's currency can't slip through.
      await tx.$queryRaw`SELECT id FROM properties WHERE id = ${tenant.propertyId}::uuid FOR UPDATE`;
      const current = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });

      const locked = LOCKED_WHEN_LIVE.filter(
        (field) => body[field] !== undefined && body[field] !== current[field],
      );
      if (locked.length > 0 && current.status !== 'SETUP') {
        throw new AppError(
          'STATE_TRANSITION_INVALID',
          'Time zone and base currency are fixed once the property is live',
          { fields: locked, status: current.status },
        );
      }

      const { paymentMethods, address, taxRegistration, ...columns } = body;
      const data: Prisma.PropertyUpdateInput = {};
      for (const [key, value] of Object.entries(columns)) {
        if (value !== undefined) (data as Record<string, unknown>)[key] = value;
      }
      if (address) data.address = address;
      if (taxRegistration) data.taxRegistration = taxRegistration;
      if (paymentMethods) {
        data.settings = { ...settingsOf(current), paymentMethods };
      }
      const after = await tx.property.update({ where: { id: current.id }, data });

      const was = editable(current);
      const now = editable(after);
      const changed = Object.keys(now).filter((k) => !same(was[k], now[k]));
      if (changed.length > 0) {
        await recordAudit(tx, {
          action: 'property.updated',
          entityType: 'property',
          entityId: current.id,
          before: pick(was, changed),
          after: pick(now, changed),
        });
      }
      return toDetail(tx, after, deps.clock());
    });
  } catch (err) {
    if (codeTaken(err)) throw codeInUse();
    throw err;
  }
}

export async function goLive(
  deps: SetupDeps,
  tenant: TenantContext,
  propertyId: string,
): Promise<Detail> {
  sameProperty(tenant, propertyId);
  return deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM properties WHERE id = ${tenant.propertyId}::uuid FOR UPDATE`;
    const property = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
    if (property.status !== 'SETUP') {
      throw new AppError('STATE_TRANSITION_INVALID', 'Only a property in setup can go live', {
        status: property.status,
      });
    }
    const now = deps.clock();
    const checklist = await checklistFor(tx, property, now);
    if (!checklist.ready) {
      const steps = checklist.steps
        .filter((s) => s.required && s.status === 'TODO')
        .map((s) => s.id);
      throw new AppError('STATE_TRANSITION_INVALID', 'Finish the setup checklist first', {
        steps,
      });
    }
    const live = await tx.property.update({
      where: { id: property.id },
      data: { status: 'LIVE' },
    });
    await recordAudit(tx, {
      action: 'property.went_live',
      entityType: 'property',
      entityId: property.id,
      before: { status: property.status },
      after: {
        status: live.status,
        // Steps that were not built yet when the property went live.
        later: checklist.steps.filter((s) => s.status === 'LATER').map((s) => s.id),
      },
    });
    return toDetail(tx, live, now);
  });
}
