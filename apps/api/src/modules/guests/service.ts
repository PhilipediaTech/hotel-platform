import type {
  CompanyBody,
  CompanyItem,
  CompanyPatchBody,
  GuestBody,
  GuestFlagsBody,
  GuestItem,
  GuestPatchBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Company, Guest, Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { TenantContext } from '../../core/tenancy.ts';

// Guest and company profiles (PRD M3-15, M3-18, M3-16 basic; T-043). Guests belong to the
// organisation. Flags are shown only to roles with guest.flag. A merge keeps the older
// profile; tables that point at guests (reservations, stays, folios — T-042 on) must be moved
// in `moveGuestReferences`.

export interface GuestDeps {
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type GuestOut = z.input<typeof GuestItem>;
type CompanyOut = z.input<typeof CompanyItem>;

const FLAG = 'guest.flag';
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

interface Preferences {
  notes: string | null;
  tags: string[];
}

function preferencesOf(g: Guest): Preferences {
  const p = (g.preferences ?? {}) as Partial<Preferences>;
  return { notes: p.notes ?? null, tags: Array.isArray(p.tags) ? p.tags : [] };
}

function guestItem(g: Guest, caller: TenantContext): GuestOut {
  return {
    id: g.id,
    firstName: g.firstName,
    lastName: g.lastName,
    email: g.email,
    phone: g.phone,
    nationality: g.nationality,
    preferences: preferencesOf(g),
    marketingConsent: g.marketingConsent,
    consentAt: g.consentAt ? iso(g.consentAt) : null,
    flags: caller.permissions.has(FLAG)
      ? { vip: g.vip, doNotRent: g.doNotRent, reason: g.flagReason }
      : null,
    mergedIntoId: g.mergedIntoId,
    createdAt: iso(g.createdAt),
    updatedAt: iso(g.updatedAt),
  };
}

/** Fields worth auditing (flags have their own event). */
const auditGuest = (g: Guest) => ({
  firstName: g.firstName,
  lastName: g.lastName,
  email: g.email,
  phone: g.phone,
  nationality: g.nationality,
  preferences: preferencesOf(g),
  marketingConsent: g.marketingConsent,
});

function changedFields<T extends Record<string, unknown>>(before: T, after: T) {
  const keys = (Object.keys(after) as (keyof T)[]).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  return {
    keys,
    before: Object.fromEntries(keys.map((k) => [k, before[k]])),
    after: Object.fromEntries(keys.map((k) => [k, after[k]])),
  };
}

// ── Search ─────────────────────────────────────────────────────────────────────────────

/** Search terms → filter: digits for phones, @ for emails, otherwise name prefixes. */
function searchFilter(q: string | undefined): Prisma.GuestWhereInput {
  const text = (q ?? '').trim();
  if (text === '') return {};
  const digits = text.replace(/[\s()+-]/g, '');
  // Local numbers (0803…) match international ones (+234803…): leading zeros are dropped.
  if (/^\d{4,}$/.test(digits)) return { phone: { contains: digits.replace(/^0+/, '') } };
  if (text.includes('@')) return { email: { startsWith: text.toLowerCase() } };
  const words = text.split(/\s+/).filter(Boolean).slice(0, 4);
  return {
    AND: words.map((w) => ({
      OR: [
        { firstName: { startsWith: w, mode: 'insensitive' as const } },
        { lastName: { startsWith: w, mode: 'insensitive' as const } },
      ],
    })),
  };
}

const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function listGuests(
  deps: GuestDeps,
  caller: TenantContext,
  query: { q?: string | undefined; limit: number; cursor?: string | undefined },
) {
  const offset = decodeCursor(query.cursor);
  const searching = (query.q ?? '').trim() !== '';
  const rows = await deps.tenantDb.guest.findMany({
    where: { mergedIntoId: null, ...searchFilter(query.q) },
    orderBy: searching
      ? [{ lastName: 'asc' }, { firstName: 'asc' }, { createdAt: 'asc' }]
      : [{ createdAt: 'desc' }],
    skip: offset,
    take: query.limit + 1,
  });
  return {
    data: rows.slice(0, query.limit).map((g) => guestItem(g, caller)),
    nextCursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
  };
}

// ── Profiles ───────────────────────────────────────────────────────────────────────────

function consentFields(consent: boolean | undefined, before: Guest | null, now: Date) {
  if (consent === undefined) return {};
  if (!consent) return { marketingConsent: false, consentAt: null };
  // Keep the first time consent was given.
  return { marketingConsent: true, consentAt: before?.marketingConsent ? before.consentAt : now };
}

export async function createGuest(
  deps: GuestDeps,
  caller: TenantContext,
  body: z.output<typeof GuestBody>,
): Promise<GuestOut> {
  return deps.tenantDb.$transaction(async (tx) => {
    const created = await tx.guest.create({
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
        nationality: body.nationality,
        preferences: body.preferences,
        ...consentFields(body.marketingConsent, null, deps.clock()),
      } as unknown as Prisma.GuestUncheckedCreateInput, // organisationId comes from the tenant client
    });
    await recordAudit(tx, {
      action: 'guest.created',
      entityType: 'guest',
      entityId: created.id,
      propertyId: null,
      after: auditGuest(created),
    });
    return guestItem(created, caller);
  });
}

async function findGuest(db: TenantDb | Tx, guestId: string): Promise<Guest> {
  const guest = await db.guest.findUnique({ where: { id: guestId } });
  if (!guest) throw new AppError('NOT_FOUND', 'Guest not found');
  return guest;
}

const notMerged = (g: Guest) => {
  if (g.mergedIntoId) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This profile was merged into another', {
      mergedIntoId: g.mergedIntoId,
    });
  }
};

export async function getGuest(deps: GuestDeps, caller: TenantContext, guestId: string) {
  return guestItem(await findGuest(deps.tenantDb, guestId), caller);
}

export async function updateGuest(
  deps: GuestDeps,
  caller: TenantContext,
  guestId: string,
  body: z.output<typeof GuestPatchBody>,
): Promise<GuestOut> {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await findGuest(tx, guestId);
    notMerged(before);
    const { marketingConsent, ...fields } = body;
    const after = await tx.guest.update({
      where: { id: before.id },
      data: { ...fields, ...consentFields(marketingConsent, before, deps.clock()) },
    });
    const diff = changedFields(auditGuest(before), auditGuest(after));
    if (diff.keys.length > 0) {
      await recordAudit(tx, {
        action: 'guest.updated',
        entityType: 'guest',
        entityId: before.id,
        propertyId: null,
        before: diff.before,
        after: diff.after,
      });
    }
    return guestItem(after, caller);
  });
}

export async function flagGuest(
  deps: GuestDeps,
  caller: TenantContext,
  guestId: string,
  body: z.output<typeof GuestFlagsBody>,
): Promise<GuestOut> {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await findGuest(tx, guestId);
    notMerged(before);
    const flagged = body.vip || body.doNotRent;
    const after = await tx.guest.update({
      where: { id: before.id },
      data: { vip: body.vip, doNotRent: body.doNotRent, flagReason: flagged ? body.reason : null },
    });
    await recordAudit(tx, {
      action: 'guest.flagged',
      entityType: 'guest',
      entityId: before.id,
      propertyId: null,
      reason: body.reason ?? undefined,
      before: { vip: before.vip, doNotRent: before.doNotRent },
      after: { vip: after.vip, doNotRent: after.doNotRent },
    });
    return guestItem(after, caller);
  });
}

/**
 * Points everything that refers to `fromId` at `toId`. Nothing refers to guests yet; T-042
 * (reservations, stays) and T-060 (folios) add their updates here.
 */
async function moveGuestReferences(tx: Tx, fromId: string, toId: string): Promise<void> {
  // Guest IDs belong to one organisation, so this reaches every property's bookings of it.
  await tx.$executeRaw`UPDATE reservations SET booker_guest_id = ${toId}::uuid WHERE booker_guest_id = ${fromId}::uuid`;
  await tx.$executeRaw`UPDATE stays SET guest_id = ${toId}::uuid WHERE guest_id = ${fromId}::uuid`;
  // Folios arrive with T-060.
}

/** M3 rule: keep the oldest profile, move everything onto it, audit both IDs. */
export async function mergeGuests(
  deps: GuestDeps,
  caller: TenantContext,
  guestId: string,
  otherGuestId: string,
): Promise<GuestOut> {
  return deps.tenantDb.$transaction(async (tx) => {
    // Lock both rows in a fixed order so two merges can't cross.
    await tx.$queryRaw`SELECT id FROM guests WHERE id IN (${guestId}::uuid, ${otherGuestId}::uuid)
      AND organisation_id = ${caller.organisationId}::uuid ORDER BY id FOR UPDATE`;
    const a = await findGuest(tx, guestId);
    if (guestId === otherGuestId) {
      throw new AppError('VALIDATION_ERROR', 'Choose another guest to merge', {
        issues: [{ path: 'body.otherGuestId', code: 'custom', message: 'Choose another guest' }],
      });
    }
    const b = await findGuest(tx, otherGuestId);
    notMerged(a);
    notMerged(b);
    const [keep, drop] =
      a.createdAt.getTime() <= b.createdAt.getTime() ? ([a, b] as const) : ([b, a] as const);
    const keepPrefs = preferencesOf(keep);
    const dropPrefs = preferencesOf(drop);
    const vip = keep.vip || drop.vip;
    const doNotRent = keep.doNotRent || drop.doNotRent;
    const reasons = [keep.flagReason, drop.flagReason].filter((r): r is string => !!r);
    const consent = keep.marketingConsent || drop.marketingConsent;
    const kept = await tx.guest.update({
      where: { id: keep.id },
      data: {
        email: keep.email ?? drop.email,
        phone: keep.phone ?? drop.phone,
        nationality: keep.nationality ?? drop.nationality,
        preferences: {
          notes: [keepPrefs.notes, dropPrefs.notes].filter(Boolean).join('\n') || null,
          tags: [...new Set([...keepPrefs.tags, ...dropPrefs.tags])].slice(0, 20),
        },
        marketingConsent: consent,
        consentAt: keep.marketingConsent ? keep.consentAt : drop.consentAt,
        vip,
        doNotRent,
        flagReason: vip || doNotRent ? [...new Set(reasons)].join('; ') || 'Merged' : null,
      },
    });
    await moveGuestReferences(tx, drop.id, keep.id);
    await tx.guest.update({ where: { id: drop.id }, data: { mergedIntoId: keep.id } });
    await recordAudit(tx, {
      action: 'guest.merged',
      entityType: 'guest',
      entityId: keep.id,
      propertyId: null,
      before: { kept: auditGuest(keep), merged: { id: drop.id, ...auditGuest(drop) } },
      after: { keptId: keep.id, mergedId: drop.id, ...auditGuest(kept) },
    });
    return guestItem(kept, caller);
  });
}

// ── Companies ──────────────────────────────────────────────────────────────────────────

function companyItem(c: Company): CompanyOut {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    contacts: (c.contacts ?? []) as CompanyOut['contacts'],
    taxId: c.taxId,
    active: c.active,
  };
}

const auditCompany = (c: Company) => ({
  kind: c.kind,
  name: c.name,
  contacts: c.contacts,
  taxId: c.taxId,
  active: c.active,
});

export async function listCompanies(
  deps: GuestDeps,
  query: { q?: string | undefined; kind?: Company['kind'] | undefined },
) {
  const q = (query.q ?? '').trim();
  const rows = await deps.tenantDb.company.findMany({
    where: {
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    },
    orderBy: { name: 'asc' },
    take: 200,
  });
  return rows.map(companyItem);
}

export async function createCompany(deps: GuestDeps, body: z.output<typeof CompanyBody>) {
  return deps.tenantDb.$transaction(async (tx) => {
    const created = await tx.company.create({
      data: body as unknown as Prisma.CompanyUncheckedCreateInput,
    });
    await recordAudit(tx, {
      action: 'company.created',
      entityType: 'company',
      entityId: created.id,
      propertyId: null,
      after: auditCompany(created),
    });
    return companyItem(created);
  });
}

export async function getCompany(deps: GuestDeps, companyId: string) {
  const company = await deps.tenantDb.company.findUnique({ where: { id: companyId } });
  if (!company) throw new AppError('NOT_FOUND', 'Company not found');
  return companyItem(company);
}

export async function updateCompany(
  deps: GuestDeps,
  companyId: string,
  body: z.output<typeof CompanyPatchBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.company.findUnique({ where: { id: companyId } });
    if (!before) throw new AppError('NOT_FOUND', 'Company not found');
    const after = await tx.company.update({
      where: { id: before.id },
      data: body,
    });
    const diff = changedFields(auditCompany(before), auditCompany(after));
    if (diff.keys.length > 0) {
      await recordAudit(tx, {
        action: 'company.updated',
        entityType: 'company',
        entityId: before.id,
        propertyId: null,
        before: diff.before,
        after: diff.after,
      });
    }
    return companyItem(after);
  });
}
