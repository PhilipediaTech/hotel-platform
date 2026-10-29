import {
  calculateTaxes,
  versionsOn,
  type ChargeBody,
  type DiscountBody,
  type FolioItem,
  type FolioLineItem,
  type FolioQuery,
  type FolioSummary,
  type RoutingBody,
  type WindowBody,
} from '@hotel/shared';
import { z } from 'zod';
import type { Prisma, RevenueCode } from '../../generated/prisma/client.ts';
import {
  performOrRequest,
  type ApprovalActionHandler,
  type ExecuteContext,
} from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import { raisedBy, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Folios (PRD M4-01–M4-05, M4 rules 1–3; tab 4 row "Folios"; T-060). A guest folio opens at
// check-in, one per stay, with window 1 for the guest. Lines are append-only (M4 rule 1; a
// trigger refuses changes): a charge is stored with one tax line per tax rule, from the
// versions in force on the business date, in their configured order and rounded per line
// (rules 2–3); a discount is its own negative line with its share of each tax; a correction
// reverses the charge with its taxes and discounts. Routing rules send new charges of a
// revenue group or code to a window; their taxes go with them.

export interface FolioDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = Tx | TenantDb;
type LineOut = z.input<typeof FolioLineItem>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

/** A closed business day refuses new lines (tab 3 constraint 5). */
async function closedDayGuard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
}

const FOLIO = {
  windows: { orderBy: { number: 'asc' }, include: { payerGuest: true, company: true } },
  routingRules: { include: { window: true, revenueCode: true } },
  lines: {
    orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
    include: {
      revenueCode: true,
      window: true,
      postedBy: { select: { name: true } },
      reversedBy: { select: { id: true } },
      taxRuleVersion: { select: { sequence: true } },
    },
  },
  reservation: { include: { company: true } },
  stays: { include: { room: true } },
} satisfies Prisma.FolioInclude;

type Full = Prisma.FolioGetPayload<{ include: typeof FOLIO }>;
type FullLine = Full['lines'][number];

function lineItem(l: FullLine): LineOut {
  return {
    id: l.id,
    windowNumber: l.window.number,
    businessDate: day(l.businessDate),
    postedAt: iso(l.postedAt),
    kind: l.kind,
    revenueCode: l.revenueCode.code,
    revenueCodeName: l.revenueCode.name,
    description: l.description,
    quantity: l.quantity,
    unitAmountMinor: l.unitAmountMinor.toString(),
    amountMinor: l.amountMinor.toString(),
    parentLineId: l.parentLineId,
    reversesLineId: l.reversesLineId,
    reversedByLineId: l.reversedBy?.id ?? null,
    postedBy: l.postedBy?.name ?? null,
    reason: l.reason,
  };
}

/**
 * Posting order, each line followed by what belongs to it: its taxes in their stacking order
 * (M4 rule 3), then its discounts. A line whose parent is not in the list leads its own group.
 */
function ordered(lines: FullLine[]): FullLine[] {
  const present = new Set(lines.map((l) => l.id));
  const children = new Map<string, FullLine[]>();
  for (const l of lines) {
    if (l.parentLineId && present.has(l.parentLineId)) {
      children.set(l.parentLineId, [...(children.get(l.parentLineId) ?? []), l]);
    }
  }
  const rank = (l: FullLine) => l.taxRuleVersion?.sequence ?? Number.MAX_SAFE_INTEGER;
  const out: FullLine[] = [];
  const add = (l: FullLine) => {
    out.push(l);
    const mine = [...(children.get(l.id) ?? [])].sort(
      (a, b) => rank(a) - rank(b) || a.postedAt.getTime() - b.postedAt.getTime(),
    );
    for (const c of mine) add(c);
  };
  for (const l of lines) if (!l.parentLineId || !present.has(l.parentLineId)) add(l);
  return out;
}

const sum = (lines: { amountMinor: bigint }[]) => lines.reduce((s, l) => s + l.amountMinor, 0n);

async function loadFolio(db: Client, folioId: string): Promise<Full> {
  const folio = await db.folio.findUnique({ where: { id: folioId }, include: FOLIO });
  if (!folio) throw new AppError('NOT_FOUND', 'Folio not found');
  return folio;
}

async function toItem(db: Client, f: Full): Promise<z.input<typeof FolioItem>> {
  const codes = await db.revenueCode.findMany({
    where: { active: true, group: { notIn: ['TAX', 'SERVICE_CHARGE'] } },
    orderBy: { code: 'asc' },
  });
  const stay = f.stays[0] ?? null;
  const lines = ordered(f.lines);
  return {
    id: f.id,
    number: f.number,
    kind: f.kind,
    status: f.status,
    name: f.name,
    currency: f.currency,
    reservationId: f.reservationId,
    confirmationNo: f.reservation?.confirmationNo ?? null,
    stay: stay
      ? {
          id: stay.id,
          status: stay.status,
          roomNumber: stay.room?.number ?? null,
          arrival: day(stay.arrival),
          departure: day(stay.departure),
        }
      : null,
    company: f.reservation?.company
      ? { id: f.reservation.company.id, name: f.reservation.company.name }
      : null,
    windows: f.windows.map((w) => {
      const mine = lines.filter((l) => l.windowId === w.id);
      return {
        number: w.number,
        payerType: w.payerType as 'GUEST' | 'COMPANY',
        payerName: w.company
          ? w.company.name
          : w.payerGuest
            ? `${w.payerGuest.firstName} ${w.payerGuest.lastName}`
            : f.name,
        balanceMinor: sum(mine).toString(),
        lines: mine.map(lineItem),
      };
    }),
    routingRules: f.routingRules.map((r) => ({
      id: r.id,
      revenueGroup: r.revenueGroup,
      revenueCode: r.revenueCode?.code ?? null,
      windowNumber: r.window.number,
    })),
    revenueCodes: codes.map((c) => ({ code: c.code, name: c.name, group: c.group })),
    balanceMinor: sum(f.lines).toString(),
    version: f.version,
  };
}

export async function getFolio(deps: FolioDeps, folioId: string) {
  return toItem(deps.tenantDb, await loadFolio(deps.tenantDb, folioId));
}

export async function listFolios(deps: FolioDeps, query: z.output<typeof FolioQuery>) {
  const q = query.q?.trim();
  const folios = await deps.tenantDb.folio.findMany({
    where: {
      status: query.status,
      ...(q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
              { stays: { some: { room: { number: q } } } },
            ],
          }
        : {}),
    },
    include: { stays: { include: { room: true } }, reservation: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const totals = await deps.tenantDb.folioLine.groupBy({
    by: ['folioId'],
    where: { folioId: { in: folios.map((f) => f.id) } },
    _sum: { amountMinor: true },
  });
  const balance = new Map(totals.map((t) => [t.folioId, t._sum.amountMinor ?? 0n]));
  const data: z.input<typeof FolioSummary>[] = folios.map((f) => ({
    id: f.id,
    number: f.number,
    name: f.name,
    status: f.status,
    roomNumber: f.stays[0]?.room?.number ?? null,
    confirmationNo: f.reservation?.confirmationNo ?? null,
    balanceMinor: (balance.get(f.id) ?? 0n).toString(),
  }));
  return { data };
}

/** Balance of each folio by ID (the front desk lists, T-053). */
export async function folioBalances(db: Client, folioIds: string[]) {
  if (folioIds.length === 0) return new Map<string, bigint>();
  const totals = await db.folioLine.groupBy({
    by: ['folioId'],
    where: { folioId: { in: folioIds } },
    _sum: { amountMinor: true },
  });
  return new Map(totals.map((t) => [t.folioId, t._sum.amountMinor ?? 0n]));
}

// ── Opening ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens the guest folio of a stay (check-in), window 1 for the guest; answers the folio the
 * stay already has. Leaves the stay's version alone: the folio is not something the desk edits.
 */
export async function openFolio(
  tx: Tx,
  stay: {
    id: string;
    propertyId: string;
    reservationId: string;
    guestId: string;
    folioId: string | null;
  },
): Promise<string> {
  if (stay.folioId) return stay.folioId;
  const [guest, property] = await Promise.all([
    tx.guest.findUniqueOrThrow({ where: { id: stay.guestId } }),
    tx.property.findUniqueOrThrow({ where: { id: stay.propertyId } }),
  ]);
  const n = await nextPropertyCounter(tx, stay.propertyId, COUNTER.FOLIO);
  const folio = await tx.folio.create({
    data: {
      number: `F${String(n).padStart(5, '0')}`,
      kind: 'GUEST',
      reservationId: stay.reservationId,
      name: `${guest.firstName} ${guest.lastName}`.trim(),
      currency: property.baseCurrency,
      windows: { create: { number: 1, payerType: 'GUEST', payerGuestId: guest.id } },
    } as unknown as Prisma.FolioUncheckedCreateInput, // tenant IDs come from the client
  });
  await tx.stay.update({ where: { id: stay.id }, data: { folioId: folio.id } });
  await recordAudit(tx, {
    action: 'folio.opened',
    entityType: 'folio',
    entityId: folio.id,
    after: { number: folio.number, stayId: stay.id },
  });
  return folio.id;
}

export async function openStayFolio(deps: FolioDeps, stayId: string) {
  const id = await deps.tenantDb.$transaction(async (tx) => {
    const stay = await tx.stay.findUnique({ where: { id: stayId } });
    if (!stay) throw new AppError('NOT_FOUND', 'Stay not found');
    if (stay.status !== 'CHECKED_IN' && !stay.folioId) {
      throw new AppError('STATE_TRANSITION_INVALID', 'A folio opens when the guest checks in', {
        status: stay.status,
      });
    }
    return openFolio(tx, stay);
  });
  return getFolio(deps, id);
}

// ── Posting (M4-02, M4 rules 2–3) ───────────────────────────────────────────────────────

async function openFolioFor(tx: Tx, folioId: string) {
  const folio = await tx.folio.findUnique({
    where: { id: folioId },
    include: { windows: true, routingRules: true },
  });
  if (!folio) throw new AppError('NOT_FOUND', 'Folio not found');
  if (folio.status !== 'OPEN') {
    throw new AppError('STATE_TRANSITION_INVALID', 'This folio is not open', {
      status: folio.status,
    });
  }
  return folio;
}

/** Tax versions of a revenue code in force on `date`, with the code each tax posts to. */
async function taxesFor(tx: Tx, code: RevenueCode, date: string) {
  const rules = await tx.taxRule.findMany({
    where: { id: { in: code.taxRuleIds } },
    include: { versions: true },
  });
  const versions = rules.flatMap((r) =>
    versionsOn(
      r.versions.map((v) => ({
        id: v.id,
        taxRuleId: r.id,
        rateBps: v.rateBps,
        basis: v.basis,
        sequence: v.sequence,
        inclusive: v.inclusive,
        effectiveFrom: day(v.effectiveFrom),
        effectiveTo: v.effectiveTo ? day(v.effectiveTo) : null,
      })),
      date,
    ),
  );
  return { versions, rules: new Map(rules.map((r) => [r.id, r])) };
}

type Ctx = ExecuteContext & { now: Date };

/**
 * Posts one charge and its tax lines to a window (M4 rules 2–3); the charge line holds the
 * amount before tax (an inclusive tax is taken out of it). Night audit and POS reuse this.
 */
export async function postChargeLines(
  ctx: Ctx,
  args: {
    folio: { id: string; propertyId: string; currency: string };
    windowId: string;
    code: RevenueCode;
    description: string;
    quantity: number;
    unitAmountMinor: bigint;
    note: string | null;
    sourceType: string;
    sourceId: string | null;
  },
): Promise<string[]> {
  const { tx } = ctx;
  const date = await businessDate(tx, args.folio.propertyId, () => ctx.now);
  const gross = args.unitAmountMinor * BigInt(args.quantity);
  const { versions, rules } = await taxesFor(tx, args.code, date);
  const result = calculateTaxes(gross, versions);
  const versionOf = new Map(versions.map((v) => [v.taxRuleId, v.id]));
  const common = {
    propertyId: args.folio.propertyId,
    folioId: args.folio.id,
    windowId: args.windowId,
    businessDate: dbDate(date),
    postedAt: ctx.now,
    currency: args.folio.currency,
    postedById: ctx.tenant.userId,
    approvalRequestId: ctx.approvalRequestId,
  };
  return closedDayGuard(async () => {
    const charge = await tx.folioLine.create({
      data: {
        ...common,
        kind: 'CHARGE',
        revenueCodeId: args.code.id,
        description: args.description,
        quantity: args.quantity,
        unitAmountMinor: args.unitAmountMinor,
        amountMinor: result.netMinor,
        sourceType: args.sourceType,
        sourceId: args.sourceId,
        reason: args.note,
      },
    });
    const ids = [charge.id];
    for (const t of result.taxes) {
      const rule = rules.get(t.taxRuleId);
      if (!rule) continue;
      const line = await tx.folioLine.create({
        data: {
          ...common,
          kind: 'TAX',
          revenueCodeId: rule.revenueCodeId,
          description: rule.name,
          unitAmountMinor: t.amountMinor,
          amountMinor: t.amountMinor,
          parentLineId: charge.id,
          taxRuleVersionId: versionOf.get(t.taxRuleId) ?? null,
        },
      });
      ids.push(line.id);
    }
    return ids;
  });
}

/** The window a charge of `code` goes to: a rule for the code, then for its group, else 1. */
function routedWindow(
  folio: {
    windows: { id: string; number: number }[];
    routingRules: { revenueCodeId: string | null; revenueGroup: string | null; windowId: string }[];
  },
  code: RevenueCode,
): string | undefined {
  const rule =
    folio.routingRules.find((r) => r.revenueCodeId === code.id) ??
    folio.routingRules.find((r) => r.revenueGroup === code.group);
  return rule?.windowId ?? folio.windows.find((w) => w.number === 1)?.id;
}

async function postedLines(db: Client, folioId: string, ids: string[]) {
  const folio = await loadFolio(db, folioId);
  return {
    lines: ordered(folio.lines.filter((l) => ids.includes(l.id))).map(lineItem),
    balanceMinor: sum(folio.lines).toString(),
  };
}

export async function postCharge(
  deps: FolioDeps,
  tenant: TenantContext,
  folioId: string,
  body: z.output<typeof ChargeBody>,
) {
  const now = deps.clock();
  const ids = await deps.tenantDb.$transaction(async (tx) => {
    const folio = await openFolioFor(tx, folioId);
    const code = await tx.revenueCode.findFirst({
      where: { code: body.revenueCode, active: true },
    });
    if (!code || code.group === 'TAX' || code.group === 'SERVICE_CHARGE') {
      throw invalid('body.revenueCode', 'Choose an active revenue code that takes charges');
    }
    const windowId =
      body.windowNumber !== undefined
        ? folio.windows.find((w) => w.number === body.windowNumber)?.id
        : routedWindow(folio, code);
    if (!windowId) throw invalid('body.windowNumber', 'This folio has no such window');
    const lineIds = await postChargeLines(
      { tx, tenant, approvalRequestId: null, now },
      {
        folio,
        windowId,
        code,
        description: body.description,
        quantity: body.quantity,
        unitAmountMinor: BigInt(body.unitAmountMinor),
        note: body.note,
        sourceType: 'MANUAL',
        sourceId: null,
      },
    );
    await recordAudit(tx, {
      action: 'folio.charge_posted',
      entityType: 'folio',
      entityId: folio.id,
      after: {
        lineId: lineIds[0],
        revenueCode: code.code,
        quantity: body.quantity,
        unitAmountMinor: body.unitAmountMinor,
      },
    });
    await recordEvent(tx, {
      type: 'folio.charge_posted',
      payload: { folioId: folio.id, lineIds },
    });
    return lineIds;
  });
  return postedLines(deps.tenantDb, folioId, ids);
}

// ── Reversal (M4-03, M4 rule 1) ─────────────────────────────────────────────────────────

const ReverseStored = z.object({
  lineId: z.string(),
  reason: z.string(),
  /** What the reversal takes off, as measured when asked (re-checked when it runs). */
  amountMinor: z.string(),
});
type ReversePayload = z.output<typeof ReverseStored>;

/** The line and everything that hangs off it and is not reversed yet. */
async function tree(tx: Tx | TenantDb, lineId: string) {
  const all: { id: string; amountMinor: bigint; kind: string }[] = [];
  let frontier = [lineId];
  const root = await tx.folioLine.findUnique({
    where: { id: lineId },
    include: { reversedBy: { select: { id: true } } },
  });
  if (!root) throw new AppError('NOT_FOUND', 'Folio line not found');
  all.push(root);
  while (frontier.length > 0) {
    const next = await tx.folioLine.findMany({
      where: {
        parentLineId: { in: frontier },
        kind: { not: 'REVERSAL' },
        reversedBy: { is: null },
      },
    });
    all.push(...next);
    frontier = next.map((l) => l.id);
  }
  return { root, lines: all };
}

async function measureReversal(db: Tx | TenantDb, lineId: string) {
  const { root, lines } = await tree(db, lineId);
  if (root.kind !== 'CHARGE' && root.kind !== 'DISCOUNT') {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      root.kind === 'TAX'
        ? 'A tax line is reversed with its charge'
        : 'Only a charge or a discount is reversed',
      { kind: root.kind },
    );
  }
  if (root.reversedBy) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This line is already reversed', {
      reversedByLineId: root.reversedBy.id,
    });
  }
  const total = sum(lines);
  return { root, lines, amount: total < 0n ? -total : total };
}

async function reverse(ctx: Ctx, p: ReversePayload): Promise<string> {
  const { tx } = ctx;
  const { root, lines } = await measureReversal(tx, p.lineId);
  const folio = await openFolioFor(tx, root.folioId);
  const date = await businessDate(tx, folio.propertyId, () => ctx.now);
  const originals = await tx.folioLine.findMany({ where: { id: { in: lines.map((l) => l.id) } } });
  const byId = new Map(originals.map((l) => [l.id, l]));
  const made = new Map<string, string>();
  await closedDayGuard(async () => {
    // Parents first, so each reversal of a tax line can point at its charge's reversal.
    for (const l of lines) {
      const o = byId.get(l.id);
      if (!o) continue;
      const reversal = await tx.folioLine.create({
        data: {
          propertyId: o.propertyId,
          folioId: o.folioId,
          windowId: o.windowId,
          businessDate: dbDate(date),
          postedAt: ctx.now,
          kind: 'REVERSAL',
          revenueCodeId: o.revenueCodeId,
          description: `Reversal: ${o.description}`,
          quantity: o.quantity,
          unitAmountMinor: -o.unitAmountMinor,
          amountMinor: -o.amountMinor,
          currency: o.currency,
          parentLineId: o.parentLineId ? (made.get(o.parentLineId) ?? null) : null,
          reversesLineId: o.id,
          taxRuleVersionId: o.taxRuleVersionId,
          postedById: ctx.tenant.userId,
          approvalRequestId: ctx.approvalRequestId,
          reason: p.reason,
        },
      });
      made.set(o.id, reversal.id);
    }
  });
  await recordAudit(tx, {
    action: 'folio.line_reversed',
    entityType: 'folio',
    entityId: folio.id,
    reason: p.reason,
    approvalRequestId: ctx.approvalRequestId ?? undefined,
    before: { lineId: root.id, amountMinor: sum(lines).toString() },
    after: { reversalLineIds: [...made.values()] },
  });
  await recordEvent(tx, {
    type: 'folio.line_reversed',
    payload: { folioId: folio.id, lineId: root.id, reversalLineIds: [...made.values()] },
  });
  return root.id;
}

export function reverseHandler(deps: FolioDeps): ApprovalActionHandler<ReversePayload> {
  return {
    action: 'folio.reverse',
    payload: ReverseStored,
    measure: (p) => ({ amountMinor: BigInt(p.amountMinor) }),
    execute: (ctx, p) => reverse({ ...ctx, now: deps.clock() }, p),
  };
}

export async function reverseLine(
  deps: FolioDeps,
  tenant: TenantContext,
  lineId: string,
  reason: string,
) {
  const { root, lines, amount } = await measureReversal(deps.tenantDb, lineId);
  const result = await performOrRequest(
    { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
    tenant,
    reverseHandler(deps),
    { lineId, reason, amountMinor: amount.toString() },
    reason,
  );
  if (!('resultRef' in result)) return result;
  const reversals = await deps.tenantDb.folioLine.findMany({
    where: { reversesLineId: { in: lines.map((l) => l.id) } },
  });
  const { balanceMinor } = await postedLines(deps.tenantDb, root.folioId, []);
  return { reversalLineIds: reversals.map((r) => r.id), balanceMinor };
}

// ── Discounts (M4-04) ───────────────────────────────────────────────────────────────────

const DiscountStored = z.object({
  folioId: z.string(),
  lineId: z.string(),
  /** The discount off the charge with its taxes, minor units (worked out when asked). */
  amountMinor: z.string(),
  /** Its share of the charge with its taxes, basis points (for the approval threshold). */
  bps: z.number(),
  reason: z.string(),
});
type DiscountPayload = z.output<typeof DiscountStored>;

/** Half-up rounding of a × b ÷ c for non-negative a, b and positive c. */
const share = (a: bigint, b: bigint, c: bigint) => (a * b * 2n + c) / (2n * c);

async function measureDiscount(
  db: Tx | TenantDb,
  folioId: string,
  body: { lineId: string; percent?: number | undefined; amountMinor?: string | undefined },
) {
  const charge = await db.folioLine.findUnique({
    where: { id: body.lineId },
    include: { reversedBy: { select: { id: true } } },
  });
  if (!charge || charge.folioId !== folioId) {
    throw invalid('body.lineId', 'Choose a charge on this folio');
  }
  if (charge.kind !== 'CHARGE' || charge.reversedBy) {
    throw invalid('body.lineId', 'Only a charge that is not reversed takes a discount');
  }
  const children = await db.folioLine.findMany({
    where: { parentLineId: charge.id, reversedBy: { is: null } },
  });
  const taxes = children.filter((c) => c.kind === 'TAX');
  const gross = charge.amountMinor + sum(taxes);
  // Earlier discounts on it (with their taxes) still in place.
  const discounts = children.filter((c) => c.kind === 'DISCOUNT');
  const discountTaxes = await db.folioLine.findMany({
    where: { parentLineId: { in: discounts.map((d) => d.id) }, reversedBy: { is: null } },
  });
  const left = gross + sum(discounts) + sum(discountTaxes);
  const amount =
    body.percent !== undefined
      ? share(gross, BigInt(Math.round(body.percent * 100)), 10_000n)
      : BigInt(body.amountMinor ?? '0');
  if (amount <= 0n) throw invalid('body.amountMinor', 'The discount is more than nothing');
  if (amount > left) {
    throw invalid('body.amountMinor', 'The discount is more than what is left of the charge');
  }
  const bps = Number((amount * 10_000n + gross - 1n) / gross);
  return { charge, taxes, gross, amount, bps };
}

async function discount(ctx: Ctx, p: DiscountPayload): Promise<string> {
  const { tx } = ctx;
  const folio = await openFolioFor(tx, p.folioId);
  const { charge, taxes, gross, amount } = await measureDiscount(tx, p.folioId, {
    lineId: p.lineId,
    amountMinor: p.amountMinor,
  });
  const date = await businessDate(tx, folio.propertyId, () => ctx.now);
  // Each tax gives up its share; the charge part takes what is left, so the parts add up.
  const taxParts = taxes.map((t) => ({ t, part: share(t.amountMinor, amount, gross) }));
  const chargePart = amount - taxParts.reduce((s, x) => s + x.part, 0n);
  const common = {
    propertyId: charge.propertyId,
    folioId: charge.folioId,
    windowId: charge.windowId,
    businessDate: dbDate(date),
    postedAt: ctx.now,
    currency: charge.currency,
    postedById: ctx.tenant.userId,
    approvalRequestId: ctx.approvalRequestId,
  };
  const id = await closedDayGuard(async () => {
    const line = await tx.folioLine.create({
      data: {
        ...common,
        kind: 'DISCOUNT',
        revenueCodeId: charge.revenueCodeId,
        description: `Discount: ${charge.description}`,
        unitAmountMinor: -chargePart,
        amountMinor: -chargePart,
        parentLineId: charge.id,
        reason: p.reason,
      },
    });
    for (const { t, part } of taxParts) {
      if (part === 0n) continue;
      await tx.folioLine.create({
        data: {
          ...common,
          kind: 'TAX',
          revenueCodeId: t.revenueCodeId,
          description: t.description,
          unitAmountMinor: -part,
          amountMinor: -part,
          parentLineId: line.id,
          taxRuleVersionId: t.taxRuleVersionId,
        },
      });
    }
    return line.id;
  });
  await recordAudit(tx, {
    action: 'folio.discount_given',
    entityType: 'folio',
    entityId: folio.id,
    reason: p.reason,
    approvalRequestId: ctx.approvalRequestId ?? undefined,
    after: { lineId: id, chargeLineId: charge.id, amountMinor: amount.toString(), bps: p.bps },
  });
  await recordEvent(tx, {
    type: 'folio.discount_given',
    payload: { folioId: folio.id, lineId: id, amountMinor: amount.toString() },
  });
  return id;
}

export function discountHandler(deps: FolioDeps): ApprovalActionHandler<DiscountPayload> {
  return {
    action: 'folio.discount',
    payload: DiscountStored,
    measure: (p) => ({ bps: p.bps }),
    execute: (ctx, p) => discount({ ...ctx, now: deps.clock() }, p),
  };
}

export async function addDiscount(
  deps: FolioDeps,
  tenant: TenantContext,
  folioId: string,
  body: z.output<typeof DiscountBody>,
) {
  await loadFolio(deps.tenantDb, folioId);
  const { amount, bps } = await measureDiscount(deps.tenantDb, folioId, body);
  const result = await performOrRequest(
    { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
    tenant,
    discountHandler(deps),
    { folioId, lineId: body.lineId, amountMinor: amount.toString(), bps, reason: body.reason },
    body.reason,
  );
  if (!('resultRef' in result)) return result;
  const taxLines = await deps.tenantDb.folioLine.findMany({
    where: { parentLineId: result.resultRef },
  });
  return postedLines(deps.tenantDb, folioId, [result.resultRef, ...taxLines.map((l) => l.id)]);
}

// ── Windows and routing (M4-05) ─────────────────────────────────────────────────────────

export async function addWindow(
  deps: FolioDeps,
  folioId: string,
  body: z.output<typeof WindowBody>,
) {
  await deps.tenantDb.$transaction(async (tx) => {
    const folio = await openFolioFor(tx, folioId);
    const next = Math.max(0, ...folio.windows.map((w) => w.number)) + 1;
    if (next > 8) throw invalid('body.payerType', 'A folio has at most 8 windows');
    let companyId: string | null = null;
    if (body.payerType === 'COMPANY') {
      const company = body.companyId
        ? await tx.company.findUnique({ where: { id: body.companyId } })
        : null;
      if (!company?.active) throw invalid('body.companyId', 'Choose an active company');
      companyId = company.id;
    }
    await tx.folio.update({
      where: { id: folio.id },
      data: {
        version: { increment: 1 },
        windows: { create: { number: next, payerType: body.payerType, companyId } },
      },
    });
    await recordAudit(tx, {
      action: 'folio.window_added',
      entityType: 'folio',
      entityId: folio.id,
      after: { number: next, payerType: body.payerType, companyId },
    });
  });
  return getFolio(deps, folioId);
}

export async function addRoutingRule(
  deps: FolioDeps,
  folioId: string,
  body: z.output<typeof RoutingBody>,
) {
  await deps.tenantDb.$transaction(async (tx) => {
    const folio = await openFolioFor(tx, folioId);
    const window = folio.windows.find((w) => w.number === body.windowNumber);
    if (!window) throw invalid('body.windowNumber', 'This folio has no such window');
    let revenueCodeId: string | null = null;
    if (body.revenueCode) {
      const code = await tx.revenueCode.findFirst({ where: { code: body.revenueCode } });
      if (!code) throw invalid('body.revenueCode', 'No such revenue code');
      revenueCodeId = code.id;
    }
    const revenueGroup = body.revenueGroup ?? null;
    // A rule for the same group or code replaces the earlier one.
    const replaced = folio.routingRules.filter((r) =>
      revenueCodeId ? r.revenueCodeId === revenueCodeId : r.revenueGroup === revenueGroup,
    );
    await tx.folio.update({
      where: { id: folio.id },
      data: {
        version: { increment: 1 },
        routingRules: {
          deleteMany: { id: { in: replaced.map((r) => r.id) } },
          create: { revenueGroup, revenueCodeId, windowId: window.id },
        },
      },
    });
    await recordAudit(tx, {
      action: 'folio.routing_set',
      entityType: 'folio',
      entityId: folio.id,
      after: { revenueGroup, revenueCode: body.revenueCode ?? null, window: body.windowNumber },
    });
  });
  return getFolio(deps, folioId);
}
