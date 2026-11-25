import type { EinvoiceItem, EinvoiceSettings, EinvoiceStatus } from '@hotel/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import type { Config } from '../../core/config.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import {
  EinvoiceUnavailableError,
  type EinvoiceDocument,
  type EinvoiceProvider,
} from '../../core/einvoice.ts';
import { AppError } from '../../core/errors.ts';
import { defineJob } from '../../core/jobs.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// E-invoicing (PRD M4-24; Strategy §7.6; T-160). An invoice is a folio window once the folio is
// no longer open: the invoice the desk prints. Finance sends it; the request only queues it, with
// the document as it is then, and the worker passes it to the accredited provider. Accepted, it
// keeps the provider's invoice reference number (IRN) and QR data, which the printed invoice and
// the city-ledger invoice of that window then carry. Rejected (the provider's reasons) or failed
// (the provider stayed unreachable), finance fixes what is needed and sends it again.

export interface EinvoiceDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
  config: Pick<Config, 'einvoice'>;
}

type SettingsOut = z.input<typeof EinvoiceSettings>;
type ItemOut = z.input<typeof EinvoiceItem>;

/** Deposits applied and transfers move money between bills: they are not sales. */
const MOVED = new Set(['DEPOSIT_APPLY', 'TRANSFER_IN', 'TRANSFER_OUT']);
/** Minutes before the next try after the provider couldn't be reached; then FAILED. */
const RETRY_MINUTES = [1, 5, 15, 60, 240, 720];
const LIST_LIMIT = 200;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ── Settings ────────────────────────────────────────────────────────────────────────────

interface Stored {
  enabled: boolean;
  enabledAt: string | null;
}

function storedOf(settings: unknown): Stored {
  const raw = ((settings ?? {}) as { einvoicing?: Partial<Stored> }).einvoicing ?? {};
  return { enabled: raw.enabled === true, enabledAt: raw.enabledAt ?? null };
}

const tinOf = (taxRegistration: unknown) => {
  const tin = ((taxRegistration ?? {}) as { tin?: string | null }).tin;
  return tin?.trim() ? tin.trim() : null;
};

const providerReady = (deps: Pick<EinvoiceDeps, 'config'>) =>
  deps.config.einvoice.provider !== 'off';

function settingsOut(
  deps: Pick<EinvoiceDeps, 'config'>,
  p: { settings: unknown; taxRegistration: unknown },
): SettingsOut {
  const s = storedOf(p.settings);
  return {
    enabled: s.enabled,
    providerReady: providerReady(deps),
    sellerTin: tinOf(p.taxRegistration),
    enabledAt: s.enabled && s.enabledAt ? iso(new Date(s.enabledAt)) : null,
  };
}

export async function getSettings(deps: EinvoiceDeps, tenant: TenantContext) {
  const p = await deps.tenantDb.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
  return settingsOut(deps, p);
}

export async function updateSettings(
  deps: EinvoiceDeps,
  tenant: TenantContext,
  body: { enabled: boolean },
): Promise<SettingsOut> {
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM properties WHERE id = ${tenant.propertyId}::uuid FOR UPDATE`;
    const p = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
    const before = storedOf(p.settings);
    if (body.enabled && !before.enabled) {
      if (!providerReady(deps)) {
        throw new AppError(
          'STATE_TRANSITION_INVALID',
          'No e-invoicing provider is set up on the platform yet',
          { reason: 'NO_PROVIDER' },
        );
      }
      if (!tinOf(p.taxRegistration)) {
        throw new AppError(
          'STATE_TRANSITION_INVALID',
          'Add the hotel’s TIN to its tax registration first',
          { reason: 'NO_TIN' },
        );
      }
    }
    const enabledAt = body.enabled
      ? before.enabled && before.enabledAt
        ? before.enabledAt
        : deps.clock().toISOString()
      : null;
    const settings = (p.settings ?? {}) as Record<string, unknown>;
    const updated = await tx.property.update({
      where: { id: tenant.propertyId },
      data: {
        settings: { ...settings, einvoicing: { enabled: body.enabled, enabledAt } } as never,
      },
    });
    await recordAudit(tx, {
      action: 'einvoice.settings_updated',
      entityType: 'property',
      entityId: tenant.propertyId,
      before: { enabled: before.enabled },
      after: { enabled: body.enabled },
    });
    return settingsOut(deps, updated);
  });
}

// ── The invoice ─────────────────────────────────────────────────────────────────────────

const FOLIO_INCLUDE = {
  property: true,
  windows: {
    include: {
      company: true,
      payerGuest: true,
      einvoice: { include: { submittedBy: { select: { name: true } } } },
    },
    orderBy: { number: 'asc' },
  },
  lines: { include: { taxRuleVersion: { select: { rateBps: true } } } },
} satisfies Prisma.FolioInclude;

type LoadedFolio = Prisma.FolioGetPayload<{ include: typeof FOLIO_INCLUDE }>;
type LoadedWindow = LoadedFolio['windows'][number];

const invoiceNumberOf = (folio: { number: string }, n: number) =>
  n > 1 ? `${folio.number}-${n}` : folio.number;

function buyerOf(folio: LoadedFolio, w: LoadedWindow): EinvoiceDocument['buyer'] {
  if (w.company) {
    return { kind: 'COMPANY', name: w.company.name, tin: w.company.taxId?.trim() || null };
  }
  const guest = w.payerGuest
    ? `${w.payerGuest.firstName} ${w.payerGuest.lastName}`.trim()
    : folio.name;
  return { kind: 'INDIVIDUAL', name: guest || folio.name, tin: null };
}

/** The window's invoice as the provider gets it, in the order the lines were posted. */
function documentOf(folio: LoadedFolio, w: LoadedWindow, issueDate: string): EinvoiceDocument {
  const lines = folio.lines
    .filter((l) => l.windowId === w.id && !MOVED.has(l.kind))
    .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime() || a.id.localeCompare(b.id));
  const isTax = (l: (typeof lines)[number]) =>
    l.kind === 'TAX' || (l.kind === 'REVERSAL' && l.taxRuleVersionId !== null);
  const taxes = new Map<string, { rateBps: number | null; amount: bigint }>();
  for (const l of lines.filter(isTax)) {
    const name = l.description.replace(/^Reversal: /, '');
    const was = taxes.get(name);
    taxes.set(name, {
      rateBps: was?.rateBps ?? l.taxRuleVersion?.rateBps ?? null,
      amount: (was?.amount ?? 0n) + l.amountMinor,
    });
  }
  const sales = lines.filter((l) => !isTax(l));
  const net = sales.reduce((s, l) => s + l.amountMinor, 0n);
  const tax = [...taxes.values()].reduce((s, t) => s + t.amount, 0n);
  const address = Object.values((folio.property.address ?? {}) as Record<string, unknown>)
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(', ');
  const registration = (folio.property.taxRegistration ?? {}) as Record<string, string | null>;
  return {
    invoiceNumber: invoiceNumberOf(folio, w.number),
    issueDate,
    currency: folio.currency,
    seller: {
      name: folio.property.name,
      tin: tinOf(folio.property.taxRegistration) ?? '',
      vatNumber: registration.vatNumber?.trim() || null,
      address: address || null,
    },
    buyer: buyerOf(folio, w),
    lines: sales.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitAmountMinor: l.unitAmountMinor.toString(),
      netMinor: l.amountMinor.toString(),
    })),
    taxes: [...taxes.entries()].map(([name, t]) => ({
      name,
      rateBps: t.rateBps,
      amountMinor: t.amount.toString(),
    })),
    totals: {
      netMinor: net.toString(),
      taxMinor: tax.toString(),
      totalMinor: (net + tax).toString(),
    },
  };
}

function itemOf(folio: LoadedFolio, w: LoadedWindow, issueDate: string): ItemOut {
  const sub = w.einvoice;
  const buyer = buyerOf(folio, w);
  return {
    folioId: folio.id,
    folioNumber: folio.number,
    windowNumber: w.number,
    invoiceNumber: invoiceNumberOf(folio, w.number),
    billTo: buyer.name,
    buyerTin: buyer.tin,
    totalMinor: sub ? sub.totalMinor.toString() : documentOf(folio, w, issueDate).totals.totalMinor,
    currency: folio.currency,
    status: (sub?.status ?? 'NOT_SENT') as EinvoiceStatus,
    irn: sub?.irn ?? null,
    reasons: sub?.reasons ?? [],
    attempts: sub?.attempts ?? 0,
    submittedAt: sub ? iso(sub.submittedAt) : null,
    submittedBy: sub?.submittedBy?.name ?? null,
    acceptedAt: sub?.acceptedAt ? iso(sub.acceptedAt) : null,
  };
}

/** A window that can be sent: the folio is no longer open and the window sold something. */
const sold = (folio: LoadedFolio, w: LoadedWindow) =>
  folio.lines.some((l) => l.windowId === w.id && !MOVED.has(l.kind));

// ── Finance's list ──────────────────────────────────────────────────────────────────────

export async function listEinvoices(
  deps: EinvoiceDeps,
  tenant: TenantContext,
  status: EinvoiceStatus | undefined,
) {
  const db = deps.tenantDb;
  const p = await db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
  const s = storedOf(p.settings);
  const today = await businessDate(db, tenant.propertyId, deps.clock);
  const counts = Object.fromEntries(
    (['NOT_SENT', 'QUEUED', 'ACCEPTED', 'REJECTED', 'FAILED'] as const).map((k) => [k, 0]),
  ) as Record<EinvoiceStatus, number>;
  for (const g of await db.einvoiceSubmission.groupBy({ by: ['status'], _count: true })) {
    counts[g.status as EinvoiceStatus] = g._count;
  }

  // Not sent yet: closed folios with charges since e-invoicing was switched on.
  let notSent: ItemOut[] = [];
  if (s.enabled && s.enabledAt && (status === undefined || status === 'NOT_SENT')) {
    const folios = await db.folio.findMany({
      where: {
        status: { not: 'OPEN' },
        lines: { some: { postedAt: { gte: new Date(s.enabledAt) } } },
        windows: { some: { einvoice: null } },
      },
      include: FOLIO_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
    });
    notSent = folios.flatMap((f) =>
      f.windows.filter((w) => !w.einvoice && sold(f, w)).map((w) => itemOf(f, w, today)),
    );
    counts.NOT_SENT = notSent.length;
  }
  if (status === 'NOT_SENT') return { data: notSent.slice(0, LIST_LIMIT), counts };

  const rows = await db.einvoiceSubmission.findMany({
    where: status ? { status } : {},
    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    take: LIST_LIMIT,
    select: { folioId: true, windowId: true },
  });
  const folios = await db.folio.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.folioId))] } },
    include: FOLIO_INCLUDE,
  });
  const byId = new Map(folios.map((f) => [f.id, f]));
  const sent = rows.flatMap((r) => {
    const f = byId.get(r.folioId);
    const w = f?.windows.find((x) => x.id === r.windowId);
    return f && w ? [itemOf(f, w, today)] : [];
  });
  return { data: [...(status ? [] : notSent), ...sent].slice(0, LIST_LIMIT), counts };
}

// ── Sending ─────────────────────────────────────────────────────────────────────────────

const refuse = (message: string, reason: string) =>
  new AppError('STATE_TRANSITION_INVALID', message, { reason });

export async function submitEinvoice(
  deps: EinvoiceDeps,
  tenant: TenantContext,
  folioId: string,
  windowNumber: number,
): Promise<ItemOut> {
  const db = deps.tenantDb;
  const today = await businessDate(db, tenant.propertyId, deps.clock);
  const now = deps.clock();
  await db.$transaction(async (tx) => {
    // One request at a time per folio, so the same invoice can't be queued twice.
    await tx.$queryRaw`SELECT id FROM folios WHERE id = ${folioId}::uuid FOR UPDATE`;
    const folio = await tx.folio.findUnique({ where: { id: folioId }, include: FOLIO_INCLUDE });
    if (!folio) throw new AppError('NOT_FOUND', 'Folio not found');
    const s = storedOf(folio.property.settings);
    if (!s.enabled) throw refuse('E-invoicing is off for this property', 'OFF');
    const w = folio.windows.find((x) => x.number === windowNumber);
    if (!w) throw new AppError('NOT_FOUND', 'This folio has no such window');
    if (folio.status === 'OPEN') {
      throw refuse('The folio is still open: send its invoice once it is settled', 'OPEN');
    }
    if (!sold(folio, w)) throw refuse('This invoice has no charges', 'EMPTY');
    const sub = w.einvoice;
    if (sub?.status === 'ACCEPTED') {
      throw refuse('The tax authority has this invoice already', 'ACCEPTED');
    }
    if (sub?.status === 'QUEUED') throw refuse('This invoice is being sent', 'QUEUED');
    const doc = documentOf(folio, w, today);
    if (!doc.seller.tin)
      throw refuse('Add the hotel’s TIN to its tax registration first', 'NO_TIN');
    const data = {
      status: 'QUEUED',
      provider: deps.config.einvoice.provider.toUpperCase(),
      document: doc as unknown as Prisma.InputJsonValue,
      totalMinor: BigInt(doc.totals.totalMinor),
      currency: doc.currency,
      irn: null,
      qrData: null,
      reasons: [],
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      submittedById: tenant.userId,
      submittedAt: now,
      acceptedAt: null,
    };
    const id = sub?.id ?? randomUUID();
    if (sub) {
      await tx.einvoiceSubmission.update({ where: { id }, data });
    } else {
      await tx.einvoiceSubmission.create({
        data: {
          id,
          folioId: folio.id,
          windowId: w.id,
          invoiceNumber: doc.invoiceNumber,
          ...data,
        } as unknown as Prisma.EinvoiceSubmissionUncheckedCreateInput, // the tenant client sets the property
      });
    }
    await recordAudit(tx, {
      action: sub ? 'einvoice.resubmitted' : 'einvoice.submitted',
      entityType: 'einvoice_submission',
      entityId: id,
      after: {
        invoiceNumber: doc.invoiceNumber,
        totalMinor: doc.totals.totalMinor,
        buyerTin: doc.buyer.tin,
      },
    });
  });
  const folio = await db.folio.findUniqueOrThrow({
    where: { id: folioId },
    include: FOLIO_INCLUDE,
  });
  const w = folio.windows.find((x) => x.number === windowNumber) as LoadedWindow;
  return itemOf(folio, w, today);
}

// ── The worker ──────────────────────────────────────────────────────────────────────────

/** Sends what is queued and due; answers how many it handled. */
export async function sendQueued(
  db: Db,
  clock: Clock,
  provider: EinvoiceProvider,
  logger?: { warn: (o: object, m: string) => void },
  batch = 50,
): Promise<number> {
  const now = clock();
  const due = await db.einvoiceSubmission.findMany({
    where: { status: 'QUEUED', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: batch,
    include: { property: { select: { organisationId: true } } },
  });
  for (const row of due) {
    // The same key on every try of this sending; a new one when it is sent again later.
    const key = `${row.id}:${row.submittedAt.getTime()}`;
    let outcome:
      | { kind: 'ACCEPTED'; irn: string; qrData: string }
      | { kind: 'REJECTED'; reasons: string[] }
      | { kind: 'RETRY'; error: string };
    try {
      const r = await provider.submit(row.document as unknown as EinvoiceDocument, key);
      outcome =
        r.outcome === 'ACCEPTED'
          ? { kind: 'ACCEPTED', irn: r.irn, qrData: r.qrData }
          : { kind: 'REJECTED', reasons: r.reasons.length ? r.reasons : ['Refused'] };
    } catch (err) {
      if (!(err instanceof EinvoiceUnavailableError)) {
        logger?.warn({ err: pgErrorInfo(err), id: row.id }, 'E-invoice send failed');
      }
      outcome = { kind: 'RETRY', error: err instanceof Error ? err.message : 'Failed' };
    }
    const at = clock();
    await db.$transaction(async (tx) => {
      // Sent again meanwhile, or handled by another worker: leave it.
      const still = await tx.einvoiceSubmission.updateMany({
        where: { id: row.id, status: 'QUEUED', submittedAt: row.submittedAt },
        data:
          outcome.kind === 'ACCEPTED'
            ? {
                status: 'ACCEPTED',
                irn: outcome.irn,
                qrData: outcome.qrData,
                acceptedAt: at,
                nextAttemptAt: null,
                attempts: { increment: 1 },
                lastError: null,
              }
            : outcome.kind === 'REJECTED'
              ? {
                  status: 'REJECTED',
                  reasons: outcome.reasons,
                  nextAttemptAt: null,
                  attempts: { increment: 1 },
                }
              : row.attempts + 1 >= RETRY_MINUTES.length
                ? {
                    status: 'FAILED',
                    nextAttemptAt: null,
                    attempts: { increment: 1 },
                    lastError: outcome.error,
                  }
                : {
                    nextAttemptAt: new Date(
                      at.getTime() + (RETRY_MINUTES[row.attempts] ?? 60) * 60_000,
                    ),
                    attempts: { increment: 1 },
                    lastError: outcome.error,
                  },
      });
      if (still.count !== 1 || outcome.kind === 'RETRY') return;
      if (outcome.kind === 'ACCEPTED') {
        // The city-ledger invoice of this window carries the reference too.
        await tx.arInvoice.updateMany({
          where: { propertyId: row.propertyId, payment: { windowId: row.windowId } },
          data: { einvoiceIrn: outcome.irn },
        });
      }
      await recordAudit(tx, {
        organisationId: row.property.organisationId,
        propertyId: row.propertyId,
        actorType: 'SYSTEM',
        actorUserId: null,
        action: outcome.kind === 'ACCEPTED' ? 'einvoice.accepted' : 'einvoice.rejected',
        entityType: 'einvoice_submission',
        entityId: row.id,
        after:
          outcome.kind === 'ACCEPTED'
            ? { invoiceNumber: row.invoiceNumber, irn: outcome.irn }
            : { invoiceNumber: row.invoiceNumber, reasons: outcome.reasons },
      });
    });
  }
  return due.length;
}

export const einvoiceSendJob = (deps: { provider: EinvoiceProvider }) =>
  defineJob({
    name: 'einvoice-send',
    schedule: { cron: '* * * * *' },
    options: { expireInSeconds: 5 * 60, retryLimit: 0 },
    run: async (_data, ctx) => {
      const n = await sendQueued(ctx.db, ctx.clock, deps.provider, ctx.logger);
      if (n > 0) ctx.logger.info({ count: n }, 'E-invoices sent');
    },
  });
