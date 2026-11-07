import {
  MODULES,
  type PlatformInvoiceItem,
  type PlatformTenantItem,
  type SubscriptionBody,
  type SubscriptionItem,
  type SupportSessionItem,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { AuthContext } from '../../core/auth.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { facts, footer, money, render, table, totals } from '../payments/documents.ts';

// Platform administration (PRD M13-01–M13-05, M13 rules and AC; tab 3 subscriptions,
// platform_invoices, feature_flags, support_sessions; tab 4 "Platform"; S30, S31; T-100).
// Platform routes span every tenant by nature, so they use the plain client and name the
// organisation in every query. Every change is audited in that organisation's log as SUPPORT.

export interface PlatformDeps {
  db: Db;
  clock: Clock;
}

type Subscription = z.infer<typeof SubscriptionItem>;
type Invoice = z.infer<typeof PlatformInvoiceItem>;
type SupportSession = z.infer<typeof SupportSessionItem>;
type Tenant = z.infer<typeof PlatformTenantItem>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

// ── Shapes ──────────────────────────────────────────────────────────────────────────────

function subscriptionOf(s: Prisma.SubscriptionGetPayload<object> | null): Subscription | null {
  if (!s) return null;
  return {
    plan: s.plan as Subscription['plan'],
    pricePerRoomMinor: s.pricePerRoomMinor.toString(),
    minimumMinor: s.minimumMinor.toString(),
    currency: s.currency,
    status: s.status as Subscription['status'],
    currentPeriodEnd: day(s.currentPeriodEnd),
  };
}

/** A readable number for an invoice: its month and the start of its ID. */
export function invoiceNumber(i: { id: string; periodStart: Date }): string {
  return `INV-${day(i.periodStart).slice(0, 7).replace('-', '')}-${i.id.slice(0, 8).toUpperCase()}`;
}

function invoiceOf(i: Prisma.PlatformInvoiceGetPayload<object>): Invoice {
  return {
    id: i.id,
    number: invoiceNumber(i),
    organisationId: i.organisationId,
    periodStart: day(i.periodStart),
    periodEnd: day(i.periodEnd),
    activeRooms: i.activeRooms,
    lines: i.lines as Invoice['lines'],
    totalMinor: i.totalMinor.toString(),
    currency: i.currency,
    status: i.status as Invoice['status'],
    issuedAt: iso(i.issuedAt),
  };
}

const SESSION_INCLUDE = {
  admin: { select: { id: true, name: true, email: true } },
} satisfies Prisma.SupportSessionInclude;
type SessionRow = Prisma.SupportSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

async function sessionOf(db: Db, s: SessionRow, now: Date): Promise<SupportSession> {
  const views = await db.auditEvent.count({
    where: {
      organisationId: s.organisationId,
      action: 'support.viewed',
      after: { path: ['sessionId'], equals: s.id },
    },
  });
  return {
    id: s.id,
    organisationId: s.organisationId,
    admin: s.admin,
    reason: s.reason,
    startedAt: iso(s.startedAt),
    expiresAt: iso(s.expiresAt),
    endedAt: s.endedAt ? iso(s.endedAt) : null,
    active: s.endedAt === null && s.expiresAt > now,
    views,
  };
}

const monthOf = (now: Date) => now.toISOString().slice(0, 7);

/** This month's usage (M13-01): active rooms (the billing measure) and WhatsApp messages. */
async function usage(db: Db, organisationId: string, now: Date) {
  const month = monthOf(now);
  const [activeRooms, whatsappMessages] = await Promise.all([
    db.room.count({
      where: { organisationId, active: true, property: { status: { not: 'ARCHIVED' } } },
    }),
    db.notificationDelivery.count({
      where: {
        channel: 'WHATSAPP',
        status: { in: ['SENT', 'DELIVERED', 'READ'] },
        createdAt: { gte: dbDate(`${month}-01`) },
        property: { organisationId },
      },
    }),
  ]);
  return { month, activeRooms, whatsappMessages };
}

/** Active rooms × price, or the monthly minimum if more (ADR-019 as proposed). */
function charge(activeRooms: number, s: { pricePerRoomMinor: bigint; minimumMinor: bigint }) {
  const rooms = BigInt(activeRooms) * s.pricePerRoomMinor;
  return { rooms, total: rooms > s.minimumMinor ? rooms : s.minimumMinor };
}

async function organisation(db: Db, organisationId: string) {
  const org = await db.organisation.findUnique({ where: { id: organisationId } });
  if (!org) throw new AppError('NOT_FOUND', 'Hotel group not found');
  return org;
}

/** Platform changes go in the group's own audit log, as SUPPORT (the owner sees them). */
function audit(
  db: Db,
  auth: AuthContext,
  organisationId: string,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
  },
) {
  return recordAudit(db, {
    ...input,
    organisationId,
    propertyId: null,
    actorUserId: auth.user.id,
    actorType: 'SUPPORT',
  });
}

// ── Tenants (M13-01) ─────────────────────────────────────────────────────────────────────

async function tenantOf(deps: PlatformDeps, organisationId: string): Promise<Tenant> {
  const now = deps.clock();
  const org = await organisation(deps.db, organisationId);
  const [properties, subscription, open] = await Promise.all([
    deps.db.property.count({ where: { organisationId, status: { not: 'ARCHIVED' } } }),
    deps.db.subscription.findUnique({ where: { organisationId } }),
    deps.db.supportSession.findFirst({
      where: { organisationId, endedAt: null, expiresAt: { gt: now } },
      include: SESSION_INCLUDE,
      orderBy: { startedAt: 'desc' },
    }),
  ]);
  return {
    id: org.id,
    name: org.name,
    legalName: org.legalName,
    country: org.country,
    createdAt: iso(org.createdAt),
    properties,
    subscription: subscriptionOf(subscription),
    usage: await usage(deps.db, organisationId, now),
    activeSupportSession: open ? await sessionOf(deps.db, open, now) : null,
  };
}

export async function listTenants(deps: PlatformDeps): Promise<{ data: Tenant[] }> {
  const orgs = await deps.db.organisation.findMany({
    orderBy: { name: 'asc' },
    select: { id: true },
  });
  return { data: await Promise.all(orgs.map((o) => tenantOf(deps, o.id))) };
}

async function flagsOf(db: Db, organisationId: string) {
  const rows = await db.featureFlag.findMany({ where: { organisationId } });
  return MODULES.map((m) => ({
    module: m.code,
    label: m.label,
    enabled: rows.find((r) => r.module === m.code)?.enabled ?? true,
  }));
}

export async function getTenant(deps: PlatformDeps, organisationId: string) {
  const now = deps.clock();
  const tenant = await tenantOf(deps, organisationId);
  const [flags, invoices, sessions] = await Promise.all([
    flagsOf(deps.db, organisationId),
    deps.db.platformInvoice.findMany({
      where: { organisationId },
      orderBy: [{ periodStart: 'desc' }, { issuedAt: 'desc' }],
    }),
    deps.db.supportSession.findMany({
      where: { organisationId },
      include: SESSION_INCLUDE,
      orderBy: { startedAt: 'desc' },
      take: 50,
    }),
  ]);
  return {
    ...tenant,
    flags,
    invoices: invoices.map(invoiceOf),
    supportSessions: await Promise.all(sessions.map((s) => sessionOf(deps.db, s, now))),
  };
}

export async function setSubscription(
  deps: PlatformDeps,
  auth: AuthContext,
  organisationId: string,
  body: z.infer<typeof SubscriptionBody>,
): Promise<Subscription> {
  await organisation(deps.db, organisationId);
  const data = {
    plan: body.plan,
    pricePerRoomMinor: BigInt(body.pricePerRoomMinor),
    minimumMinor: BigInt(body.minimumMinor),
    currency: body.currency,
    status: body.status,
    currentPeriodEnd: dbDate(body.currentPeriodEnd),
  };
  return deps.db.$transaction(async (tx) => {
    const before = await tx.subscription.findUnique({ where: { organisationId } });
    const row = await tx.subscription.upsert({
      where: { organisationId },
      create: { organisationId, ...data },
      update: data,
    });
    await audit(tx as unknown as Db, auth, organisationId, {
      action: 'platform.subscription_set',
      entityType: 'subscription',
      entityId: organisationId,
      before: subscriptionOf(before),
      after: subscriptionOf(row),
    });
    return subscriptionOf(row) as Subscription;
  });
}

// ── Feature flags (M13-05) ───────────────────────────────────────────────────────────────

export async function updateFlags(
  deps: PlatformDeps,
  auth: AuthContext,
  organisationId: string,
  flags: { module: string; enabled: boolean }[],
) {
  await organisation(deps.db, organisationId);
  await deps.db.$transaction(async (tx) => {
    const before = await flagsOf(tx as unknown as Db, organisationId);
    for (const f of flags) {
      await tx.featureFlag.upsert({
        where: { organisationId_module: { organisationId, module: f.module } },
        create: { organisationId, module: f.module, enabled: f.enabled },
        update: { enabled: f.enabled },
      });
    }
    await audit(tx as unknown as Db, auth, organisationId, {
      action: 'platform.flags_changed',
      entityType: 'feature_flags',
      entityId: organisationId,
      before,
      after: flags,
    });
  });
  return { flags: await flagsOf(deps.db, organisationId) };
}

// ── Invoices (M13-03) ────────────────────────────────────────────────────────────────────

function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export async function issueInvoice(
  deps: PlatformDeps,
  auth: AuthContext,
  body: { organisationId: string; month: string },
): Promise<Invoice> {
  await organisation(deps.db, body.organisationId);
  const s = await deps.db.subscription.findUnique({
    where: { organisationId: body.organisationId },
  });
  if (!s) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Set the hotel group’s plan and prices first');
  }
  const { activeRooms } = await usage(deps.db, body.organisationId, deps.clock());
  const { rooms, total } = charge(activeRooms, s);
  const lines = [
    {
      description: `${s.plan} plan: ${activeRooms} active rooms × ${money(s.pricePerRoomMinor, s.currency)}`,
      quantity: activeRooms,
      amountMinor: rooms.toString(),
    },
    ...(total > rooms
      ? [
          {
            description: `Monthly minimum (${money(s.minimumMinor, s.currency)})`,
            quantity: 1,
            amountMinor: (total - rooms).toString(),
          },
        ]
      : []),
  ];
  try {
    return await deps.db.$transaction(async (tx) => {
      const row = await tx.platformInvoice.create({
        data: {
          organisationId: body.organisationId,
          periodStart: dbDate(`${body.month}-01`),
          periodEnd: dbDate(lastDay(body.month)),
          activeRooms,
          lines,
          totalMinor: total,
          currency: s.currency,
          status: 'ISSUED',
          issuedAt: deps.clock(),
        },
      });
      await audit(tx as unknown as Db, auth, body.organisationId, {
        action: 'platform.invoice_issued',
        entityType: 'platform_invoice',
        entityId: row.id,
        after: { month: body.month, activeRooms, totalMinor: total.toString() },
      });
      return invoiceOf(row);
    });
  } catch (err) {
    // One live invoice per group and month (a partial unique index).
    if ((err as { code?: string }).code === 'P2002') {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `${body.month} is already invoiced: void that invoice to issue it again`,
      );
    }
    throw err;
  }
}

export async function updateInvoice(
  deps: PlatformDeps,
  auth: AuthContext,
  invoiceId: string,
  status: 'PAID' | 'VOID',
): Promise<Invoice> {
  return deps.db.$transaction(async (tx) => {
    const row = await tx.platformInvoice.findUnique({ where: { id: invoiceId } });
    if (!row) throw new AppError('NOT_FOUND', 'Invoice not found');
    if (row.status !== 'ISSUED') {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `This invoice is already ${row.status.toLowerCase()}`,
      );
    }
    const updated = await tx.platformInvoice.update({ where: { id: row.id }, data: { status } });
    await audit(tx as unknown as Db, auth, row.organisationId, {
      action: status === 'PAID' ? 'platform.invoice_paid' : 'platform.invoice_voided',
      entityType: 'platform_invoice',
      entityId: row.id,
      before: { status: row.status },
      after: { status },
    });
    return invoiceOf(updated);
  });
}

// ── Support sessions (M13-02) ────────────────────────────────────────────────────────────

export async function startSupport(
  deps: PlatformDeps,
  auth: AuthContext,
  body: { organisationId: string; reason: string; minutes: number },
): Promise<SupportSession> {
  await organisation(deps.db, body.organisationId);
  const now = deps.clock();
  const open = await deps.db.supportSession.findFirst({
    where: {
      organisationId: body.organisationId,
      adminUserId: auth.user.id,
      endedAt: null,
      expiresAt: { gt: now },
    },
  });
  if (open) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'You already have a session open for this group',
    );
  }
  const row = await deps.db.$transaction(async (tx) => {
    const created = await tx.supportSession.create({
      data: {
        organisationId: body.organisationId,
        adminUserId: auth.user.id,
        reason: body.reason,
        startedAt: now,
        expiresAt: new Date(now.getTime() + body.minutes * 60_000),
      },
      include: SESSION_INCLUDE,
    });
    await audit(tx as unknown as Db, auth, body.organisationId, {
      action: 'support.session_started',
      entityType: 'support_session',
      entityId: created.id,
      reason: body.reason,
      after: { minutes: body.minutes, expiresAt: iso(created.expiresAt) },
    });
    return created;
  });
  return sessionOf(deps.db, row, now);
}

export async function endSupport(
  deps: PlatformDeps,
  auth: AuthContext,
  sessionId: string,
): Promise<SupportSession> {
  const now = deps.clock();
  const row = await deps.db.supportSession.findUnique({
    where: { id: sessionId },
    include: SESSION_INCLUDE,
  });
  if (!row) throw new AppError('NOT_FOUND', 'Support session not found');
  if (row.endedAt || row.expiresAt <= now) return sessionOf(deps.db, row, now);
  const ended = await deps.db.$transaction(async (tx) => {
    const updated = await tx.supportSession.update({
      where: { id: row.id },
      data: { endedAt: now },
      include: SESSION_INCLUDE,
    });
    await audit(tx as unknown as Db, auth, row.organisationId, {
      action: 'support.session_ended',
      entityType: 'support_session',
      entityId: row.id,
    });
    return updated;
  });
  return sessionOf(deps.db, ended, now);
}

// ── The owner's billing page (M13-04) ────────────────────────────────────────────────────

export async function ownerSubscription(deps: PlatformDeps, tenant: TenantContext) {
  const now = deps.clock();
  const org = await organisation(deps.db, tenant.organisationId);
  const [s, invoices, sessions, use] = await Promise.all([
    deps.db.subscription.findUnique({ where: { organisationId: org.id } }),
    deps.db.platformInvoice.findMany({
      where: { organisationId: org.id },
      orderBy: [{ periodStart: 'desc' }, { issuedAt: 'desc' }],
      take: 24,
    }),
    deps.db.supportSession.findMany({
      where: { organisationId: org.id },
      include: SESSION_INCLUDE,
      orderBy: { startedAt: 'desc' },
      take: 20,
    }),
    usage(deps.db, org.id, now),
  ]);
  return {
    organisation: { id: org.id, name: org.name, legalName: org.legalName },
    subscription: subscriptionOf(s),
    usage: { ...use, estimateMinor: s ? charge(use.activeRooms, s).total.toString() : null },
    invoices: invoices.map(invoiceOf),
    supportSessions: await Promise.all(sessions.map((x) => sessionOf(deps.db, x, now))),
  };
}

export async function updateBilling(
  deps: PlatformDeps,
  tenant: TenantContext,
  legalName: string,
): Promise<{ legalName: string }> {
  return deps.db.$transaction(async (tx) => {
    const before = await tx.organisation.findUniqueOrThrow({
      where: { id: tenant.organisationId },
    });
    await tx.organisation.update({ where: { id: tenant.organisationId }, data: { legalName } });
    await recordAudit(tx, {
      action: 'organisation.billing_updated',
      entityType: 'organisation',
      entityId: tenant.organisationId,
      propertyId: null,
      before: { legalName: before.legalName },
      after: { legalName },
    });
    return { legalName };
  });
}

/** An invoice to the owner's group as PDF; another group's is not found. */
export async function invoicePdf(deps: PlatformDeps, tenant: TenantContext, invoiceId: string) {
  const row = await deps.db.platformInvoice.findFirst({
    where: { id: invoiceId, organisationId: tenant.organisationId },
  });
  if (!row) throw new AppError('NOT_FOUND', 'Invoice not found');
  const org = await organisation(deps.db, tenant.organisationId);
  const inv = invoiceOf(row);
  const m = (minor: string) => money(BigInt(minor), inv.currency);
  const content = await render((doc) => {
    doc.font('Helvetica-Bold').fontSize(16).text('Hotel Platform', 50, 50);
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .text(`Invoice ${inv.number}`, 50, 50, { align: 'right' });
    doc.moveDown(2).font('Helvetica').fontSize(9);
    facts(doc, [
      ['Bill to', org.legalName ?? org.name],
      ['Period', `${inv.periodStart} to ${inv.periodEnd}`],
      ['Issued', inv.issuedAt.slice(0, 10)],
      ['Status', inv.status],
    ]);
    table(
      doc,
      [
        { title: 'Description', width: 330 },
        { title: 'Qty', width: 50, align: 'right' },
        { title: 'Amount', width: 115, align: 'right' },
      ],
      inv.lines.map((l) => [l.description, String(l.quantity), m(l.amountMinor)]),
    );
    totals(doc, [['Total', m(inv.totalMinor)]], true);
    footer(
      doc,
      'Price per active room per month, with a monthly minimum. No tax is charged on this invoice yet: the tax treatment is being confirmed.',
    );
  });
  return { filename: `${inv.number}.pdf`, content };
}
