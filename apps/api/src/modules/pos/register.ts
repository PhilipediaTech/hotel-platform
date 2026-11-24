import {
  calculateTaxes,
  POS_PAY_METHODS,
  posSettingsOf,
  type CloseShiftBody,
  type DiscountPosOrderLineBody,
  type PosOrderItem,
  type PosRegister,
  type PosSettings,
  type SettlePosOrderBody,
} from '@hotel/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import {
  performOrRequest,
  type ApprovalActionHandler,
  type ExecuteContext,
} from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate, postingDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import { pgErrorInfo, raisedBy, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import {
  enabledMethods,
  folioBalances,
  postChargeLines,
  postDiscountLines,
  routedWindow,
  taxesFor,
} from '../folios/service.ts';
import * as shifts from '../shifts/service.ts';

// Lite POS register (PRD M8-02, M8-03, M8-05; tab 3 pos_orders, pos_order_lines; tab 4 row
// POS; S33; T-142). An outlet shift is a cashier shift with its outlet: opening, the blind
// close, tolerance, leakage alert and sign-off are the front desk's (T-061). An order is
// settled once, under a row lock:
// - paid at the outlet: its lines post with their taxes to a POS folio of its own (kind POS),
//   the payments (which must add up to the total) go to the cashier's outlet shift and settle
//   that folio, so the shift close expects exactly the settlements by method;
// - charged to room: only a CHECKED_IN stay, within the folio's credit limit (its own, else the
//   POS setting, unlimited by default); the lines post to the guest folio referencing the order
//   (source POS_ORDER), with the guest's signature drawn on screen.
// Items are priced when added (item + options).
//
// Voids and discounts (M8-04; T-143) need pos.void and go through the approvals engine: within
// the caller's pos.void amount limit at once, above it (or with no limit set) a manager
// approves. Both are measured by what the guest pays less, taxes included. A voided item stays
// on the order with its reason and is not charged; a discount (one per item, at most what the
// item charges) posts at settlement as a DISCOUNT line taking its share off the charge and
// each of its taxes, like a folio discount.

export interface RegisterDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;
type PosMethod = (typeof POS_PAY_METHODS)[number];

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const invalid = (path: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
    ...details,
  });

const METHOD_NAMES: Record<PosMethod, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  POS_TERMINAL: 'POS terminal',
};

const posMethods = (settings: unknown): PosMethod[] =>
  enabledMethods(settings).filter((m): m is PosMethod =>
    (POS_PAY_METHODS as readonly string[]).includes(m),
  );

// ── Outlet shifts (M8-02, M8-05) ─────────────────────────────────────────────────────────

export async function register(
  deps: RegisterDeps,
  tenant: TenantContext,
): Promise<z.input<typeof PosRegister>> {
  const db = deps.tenantDb;
  const [property, outlets, mine] = await Promise.all([
    db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } }),
    db.outlet.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    db.cashierShift.findMany({
      where: {
        userId: tenant.userId,
        outletId: { not: null },
        status: { in: ['OPEN', 'CLOSING'] },
      },
      include: { outlet: true },
      orderBy: { openedAt: 'asc' },
    }),
  ]);
  return {
    currency: property.baseCurrency,
    outlets: outlets.map((o) => ({ id: o.id, code: o.code, name: o.name })),
    shifts: await Promise.all(
      mine.map(async (s) => {
        const [counts, roomCharges, openOrders] = await Promise.all([
          db.payment.groupBy({
            by: ['method'],
            where: { shiftId: s.id },
            _count: { _all: true },
            orderBy: { method: 'asc' },
          }),
          db.posOrder.count({ where: { settledShiftId: s.id, status: 'ROOM_CHARGED' } }),
          db.posOrder.count({ where: { outletId: s.outletId ?? '', status: 'OPEN' } }),
        ]);
        return {
          id: s.id,
          outletId: s.outletId ?? '',
          outlet: s.outlet?.name ?? '',
          status: s.status === 'OPEN' ? ('OPEN' as const) : ('CLOSING' as const),
          openedAt: iso(s.openedAt),
          floatMinor: String(s.floatMinor),
          paymentCounts: counts.map((c) => ({ method: c.method, count: c._count._all })),
          roomCharges,
          openOrders,
        };
      }),
    ),
    methods: posMethods(property.settings),
  };
}

export async function openOutletShift(
  deps: RegisterDeps,
  tenant: TenantContext,
  body: { outletId: string; floatMinor: string },
) {
  const taken = () =>
    new AppError('STATE_TRANSITION_INVALID', 'You already have an open shift at this outlet');
  try {
    await deps.tenantDb.$transaction(async (tx) => {
      const outlet = await tx.outlet.findFirst({ where: { id: body.outletId, active: true } });
      if (!outlet) throw invalid('body.outletId', 'Choose an outlet that is switched on');
      const open = await tx.cashierShift.findFirst({
        where: { userId: tenant.userId, outletId: outlet.id, status: 'OPEN' },
      });
      if (open) throw taken();
      const shift = await tx.cashierShift.create({
        data: {
          userId: tenant.userId,
          outletId: outlet.id,
          floatMinor: BigInt(body.floatMinor),
          openedAt: deps.clock(),
        } as unknown as Prisma.CashierShiftUncheckedCreateInput, // tenant IDs come from the client
      });
      await recordAudit(tx, {
        action: 'shift.opened',
        entityType: 'cashier_shift',
        entityId: shift.id,
        after: { floatMinor: body.floatMinor, outletId: outlet.id },
      });
    });
  } catch (err) {
    // Two opens at once: the partial unique index lets one through.
    if (pgErrorInfo(err)?.constraint === 'cashier_shifts_one_open_outlet') throw taken();
    throw err;
  }
  return register(deps, tenant);
}

async function outletShift(deps: RegisterDeps, shiftId: string) {
  const shift = await deps.tenantDb.cashierShift.findUnique({ where: { id: shiftId } });
  if (!shift?.outletId) throw new AppError('NOT_FOUND', 'Outlet shift not found');
}

/** M8-05: the front desk's blind close, for an outlet shift. */
export async function closeOutletShift(
  deps: RegisterDeps,
  tenant: TenantContext,
  shiftId: string,
  body: z.output<typeof CloseShiftBody>,
) {
  await outletShift(deps, shiftId);
  return shifts.closeShift(deps, tenant, shiftId, body);
}

export async function addOutletVarianceNote(
  deps: RegisterDeps,
  tenant: TenantContext,
  shiftId: string,
  note: string,
) {
  await outletShift(deps, shiftId);
  return shifts.addVarianceNote(deps, tenant, shiftId, note);
}

/** The cashier's open shift at the outlet, locked so a close cannot slip in between. */
async function myShiftAt(tx: Tx, tenant: TenantContext, outletId: string) {
  const open = await tx.cashierShift.findFirst({
    where: { userId: tenant.userId, outletId, status: 'OPEN' },
  });
  if (open)
    await tx.$queryRaw`SELECT id FROM cashier_shifts WHERE id = ${open.id}::uuid FOR UPDATE`;
  const shift = open ? await tx.cashierShift.findUnique({ where: { id: open.id } }) : null;
  if (shift?.status !== 'OPEN') {
    throw new AppError('SHIFT_NOT_OPEN', 'Open your shift at this outlet first');
  }
  return shift;
}

// ── The menu (M8-03) ────────────────────────────────────────────────────────────────────

export async function outletMenu(deps: RegisterDeps, tenant: TenantContext, outletId: string) {
  const db = deps.tenantDb;
  const [outlet, property] = await Promise.all([
    db.outlet.findFirst({
      where: { id: outletId },
      include: {
        categories: {
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            items: {
              where: { active: true },
              orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
              include: {
                revenueCode: { select: { id: true, code: true, name: true } },
                modifiers: { where: { active: true }, orderBy: { name: 'asc' } },
              },
            },
          },
        },
      },
    }),
    db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } }),
  ]);
  if (!outlet) throw new AppError('NOT_FOUND', 'Outlet not found');
  return {
    outletId: outlet.id,
    outlet: outlet.name,
    currency: property.baseCurrency,
    categories: (outlet.active ? outlet.categories : [])
      .filter((c) => c.items.length > 0)
      .map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sortOrder,
        active: c.active,
        kitchenStation: c.kitchenStation,
        items: c.items.map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          priceMinor: i.priceMinor.toString(),
          revenueCode: i.revenueCode,
          sortOrder: i.sortOrder,
          active: i.active,
          modifiers: i.modifiers.map((m) => ({
            id: m.id,
            name: m.name,
            priceMinor: m.priceMinor.toString(),
            active: m.active,
          })),
        })),
      })),
  };
}

// ── Orders (M8-03) ──────────────────────────────────────────────────────────────────────

const ORDER = {
  outlet: { select: { name: true } },
  openedBy: { select: { name: true } },
  settledBy: { select: { name: true } },
  stay: { select: { id: true, room: { select: { number: true } } } },
  lines: {
    orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    include: {
      addedBy: { select: { name: true } },
      voidedBy: { select: { name: true } },
      discountedBy: { select: { name: true } },
      kitchenTicket: { select: { sentAt: true } },
    },
  },
} satisfies Prisma.PosOrderInclude;
type OrderRow = Prisma.PosOrderGetPayload<{ include: typeof ORDER }>;
type LineRow = Prisma.PosOrderLineGetPayload<object>;

/** Half-up rounding of a × b ÷ c for non-negative a, b and positive c (as folio discounts). */
const share = (a: bigint, b: bigint, c: bigint) => (a * b * 2n + c) / (2n * c);

interface LineMath {
  /** Before tax, after the discount's share off the charge. */
  net: bigint;
  /** With taxes, after the discount; 0 when voided. */
  total: bigint;
  /** With taxes, before the discount. */
  gross: bigint;
}

/**
 * Each line's amounts on `date`, as settlement would post them: the charge with its taxes,
 * less the discount split over the charge and each tax the way postDiscountLines splits it.
 */
async function lineMath(db: Client, lines: LineRow[], date: string) {
  const codes = new Map<string, Awaited<ReturnType<typeof taxesFor>>['versions']>();
  const out = new Map<string, LineMath>();
  for (const l of lines) {
    let versions = codes.get(l.revenueCodeId);
    if (!versions) {
      const code = await db.revenueCode.findUniqueOrThrow({ where: { id: l.revenueCodeId } });
      versions = (await taxesFor(db, code, date)).versions;
      codes.set(l.revenueCodeId, versions);
    }
    const r = calculateTaxes(l.unitPriceMinor * BigInt(l.quantity), versions);
    const gross = r.totalMinor;
    if (l.voidedAt) {
      out.set(l.id, { net: 0n, total: 0n, gross });
      continue;
    }
    const off = l.discountMinor !== null && gross > 0n ? l.discountMinor : 0n;
    const taxOff =
      off === 0n ? 0n : r.taxes.reduce((s, t) => s + share(t.amountMinor, off, gross), 0n);
    out.set(l.id, { net: r.netMinor - (off - taxOff), total: gross - off, gross });
  }
  return out;
}

/** The business date an order's lines are worked out on: posted, else the open day. */
async function dateOf(db: Client, o: OrderRow, clock: Clock) {
  if (o.folioId && o.totalMinor !== null) {
    const posted = await db.folioLine.findFirst({
      where: { folioId: o.folioId, kind: 'CHARGE', sourceType: 'POS_ORDER', sourceId: o.id },
      select: { businessDate: true },
    });
    if (posted) return posted.businessDate.toISOString().slice(0, 10);
  }
  return businessDate(db, o.propertyId, clock);
}

/** Lines' totals: as posted once settled; worked out for the open day while open. */
async function totalsOf(db: Client, o: OrderRow, math: Map<string, LineMath>) {
  const discount = o.lines.reduce(
    (s, l) => s + (l.voidedAt || l.discountMinor === null ? 0n : l.discountMinor),
    0n,
  );
  if (o.status === 'CANCELLED') return { subtotal: 0n, tax: 0n, total: 0n, discount: 0n };
  if (o.folioId && o.totalMinor !== null) {
    const posted = await db.folioLine.findMany({
      where: {
        folioId: o.folioId,
        kind: { in: ['CHARGE', 'DISCOUNT'] },
        sourceType: 'POS_ORDER',
        sourceId: o.id,
      },
      select: { amountMinor: true },
    });
    const subtotal = posted.reduce((s, l) => s + l.amountMinor, 0n);
    return { subtotal, tax: o.totalMinor - subtotal, total: o.totalMinor, discount };
  }
  let subtotal = 0n;
  let total = 0n;
  for (const m of math.values()) {
    subtotal += m.net;
    total += m.total;
  }
  return { subtotal, tax: total - subtotal, total, discount };
}

async function orderItem(
  db: Client,
  o: OrderRow,
  currency: string,
  clock: Clock,
): Promise<z.input<typeof PosOrderItem>> {
  const math =
    o.lines.length === 0 || o.status === 'CANCELLED'
      ? new Map<string, LineMath>()
      : await lineMath(db, o.lines, await dateOf(db, o, clock));
  const [totals, payments] = await Promise.all([
    totalsOf(db, o, math),
    o.status === 'PAID' && o.folioId
      ? db.payment.findMany({
          where: { folioId: o.folioId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : Promise.resolve([]),
  ]);
  return {
    id: o.id,
    number: o.number,
    label: o.label,
    status: o.status as z.input<typeof PosOrderItem>['status'],
    outletId: o.outletId,
    outlet: o.outlet.name,
    openedBy: o.openedBy.name,
    openedAt: iso(o.openedAt),
    currency,
    lines: o.lines.map((l) => ({
      id: l.id,
      name: l.name,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor.toString(),
      amountMinor: (l.unitPriceMinor * BigInt(l.quantity)).toString(),
      note: l.note,
      addedBy: l.addedBy.name,
      addedAt: iso(l.addedAt),
      voided:
        l.voidedAt && l.voidReason
          ? { at: iso(l.voidedAt), by: l.voidedBy?.name ?? '', reason: l.voidReason }
          : null,
      discount:
        l.discountMinor !== null && l.discountedAt && l.discountReason
          ? {
              amountMinor: l.discountMinor.toString(),
              at: iso(l.discountedAt),
              by: l.discountedBy?.name ?? '',
              reason: l.discountReason,
            }
          : null,
      totalMinor: (math.get(l.id)?.total ?? 0n).toString(),
      kitchen: l.kitchenStation
        ? {
            station: l.kitchenStation,
            sentAt: l.kitchenTicket ? iso(l.kitchenTicket.sentAt) : null,
          }
        : null,
    })),
    subtotalMinor: totals.subtotal.toString(),
    taxMinor: totals.tax.toString(),
    discountMinor: totals.discount.toString(),
    totalMinor: totals.total.toString(),
    settledAt: o.settledAt ? iso(o.settledAt) : null,
    settledBy: o.settledBy?.name ?? null,
    payments: payments.map((p) => ({
      method: p.method,
      amountMinor: p.amountMinor.toString(),
      externalRef: p.externalRef,
    })),
    room:
      o.status === 'ROOM_CHARGED' && o.stay && o.folioId
        ? { stayId: o.stay.id, roomNumber: o.stay.room?.number ?? null, folioId: o.folioId }
        : null,
    unsentKitchenLines: o.lines.filter(unsent).length,
    version: o.version,
  };
}

// ── Kitchen (M8-06; T-156) ──────────────────────────────────────────────────────────────

/** A kitchen item not sent yet (and not voided: nothing to make). */
const unsent = (l: Pick<LineRow, 'kitchenStation' | 'kitchenTicketId' | 'voidedAt'>) =>
  l.kitchenStation !== null && l.kitchenTicketId === null && l.voidedAt === null;

/** Sends the order's unsent kitchen items, one ticket per station; answers how many tickets. */
async function sendKitchenLines(
  tx: Tx,
  tenant: TenantContext,
  order: { id: string; outletId: string; lines: LineRow[] },
  now: Date,
): Promise<number> {
  const waiting = order.lines.filter(unsent);
  if (waiting.length === 0) return 0;
  const byStation = new Map<string, string[]>();
  for (const l of waiting) {
    const station = l.kitchenStation ?? '';
    byStation.set(station, [...(byStation.get(station) ?? []), l.id]);
  }
  const last = await tx.kitchenTicket.aggregate({
    where: { orderId: order.id },
    _max: { number: true },
  });
  let number = last._max.number ?? 0;
  for (const [station, lineIds] of [...byStation].sort(([a], [b]) => a.localeCompare(b))) {
    number += 1;
    const ticket = await tx.kitchenTicket.create({
      data: {
        outletId: order.outletId,
        orderId: order.id,
        station,
        number,
        sentAt: now,
        sentById: tenant.userId,
      } as unknown as Prisma.KitchenTicketUncheckedCreateInput, // tenant IDs come from the client
    });
    await tx.posOrderLine.updateMany({
      where: { id: { in: lineIds }, kitchenTicketId: null },
      data: { kitchenTicketId: ticket.id },
    });
  }
  return byStation.size;
}

/** The cashier sends what is waiting to the kitchen displays (M8-06). */
export async function sendToKitchen(deps: RegisterDeps, tenant: TenantContext, orderId: string) {
  await deps.tenantDb.$transaction(async (tx) => {
    const order = await lockOpenOrder(tx, orderId);
    await myShiftAt(tx, tenant, order.outletId);
    const tickets = await sendKitchenLines(tx, tenant, order, deps.clock());
    if (tickets > 0) {
      await tx.posOrder.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
      await recordAudit(tx, {
        action: 'pos.sent_to_kitchen',
        entityType: 'pos_order',
        entityId: order.id,
        after: { tickets },
      });
    }
  });
  return orderView(deps.tenantDb, orderId, deps.clock);
}

async function baseCurrency(db: Client, propertyId: string) {
  return (await db.property.findUniqueOrThrow({ where: { id: propertyId } })).baseCurrency;
}

async function orderView(db: Client, orderId: string, clock: Clock) {
  const o = await db.posOrder.findUnique({ where: { id: orderId }, include: ORDER });
  if (!o) throw new AppError('NOT_FOUND', 'Order not found');
  return orderItem(db, o, await baseCurrency(db, o.propertyId), clock);
}

export async function listOrders(
  deps: RegisterDeps,
  tenant: TenantContext,
  query: { outletId: string; status: 'OPEN' | 'CLOSED' },
) {
  const db = deps.tenantDb;
  const rows = await db.posOrder.findMany({
    where: {
      outletId: query.outletId,
      status: query.status === 'OPEN' ? 'OPEN' : { not: 'OPEN' },
    },
    include: ORDER,
    orderBy: query.status === 'OPEN' ? { openedAt: 'asc' } : { settledAt: 'desc' },
    take: query.status === 'OPEN' ? 200 : 50,
  });
  const currency = await baseCurrency(db, tenant.propertyId);
  return { data: await Promise.all(rows.map((o) => orderItem(db, o, currency, deps.clock))) };
}

export const getOrder = (deps: RegisterDeps, orderId: string) =>
  orderView(deps.tenantDb, orderId, deps.clock);

export async function openOrder(
  deps: RegisterDeps,
  tenant: TenantContext,
  body: { outletId: string; label: string },
) {
  const id = await deps.tenantDb.$transaction(async (tx) => {
    const outlet = await tx.outlet.findFirst({ where: { id: body.outletId } });
    if (!outlet) throw invalid('body.outletId', 'Choose an outlet');
    const shift = await myShiftAt(tx, tenant, outlet.id);
    if (!outlet.active) throw invalid('body.outletId', 'This outlet is switched off');
    const n = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.POS_ORDER);
    const order = await tx.posOrder.create({
      data: {
        outletId: outlet.id,
        shiftId: shift.id,
        number: `P${String(n).padStart(5, '0')}`,
        label: body.label,
        openedById: tenant.userId,
        openedAt: deps.clock(),
      } as unknown as Prisma.PosOrderUncheckedCreateInput, // tenant IDs come from the client
    });
    await recordAudit(tx, {
      action: 'pos.order_opened',
      entityType: 'pos_order',
      entityId: order.id,
      after: { number: order.number, label: body.label, outletId: outlet.id, shiftId: shift.id },
    });
    return order.id;
  });
  return orderView(deps.tenantDb, id, deps.clock);
}

/** Locks an open order: one change at a time, and it is settled once (AC). */
async function lockOpenOrder(tx: Tx, orderId: string) {
  await tx.$queryRaw`SELECT id FROM pos_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  const order = await tx.posOrder.findUnique({
    where: { id: orderId },
    include: { lines: true, outlet: true },
  });
  if (!order) throw new AppError('NOT_FOUND', 'Order not found');
  if (order.status !== 'OPEN') {
    throw new AppError('STATE_TRANSITION_INVALID', 'This order is already closed', {
      status: order.status,
    });
  }
  return order;
}

export async function addLine(
  deps: RegisterDeps,
  tenant: TenantContext,
  orderId: string,
  body: { menuItemId: string; quantity: number; modifierIds: string[]; note: string | null },
) {
  await deps.tenantDb.$transaction(async (tx) => {
    const order = await lockOpenOrder(tx, orderId);
    await myShiftAt(tx, tenant, order.outletId);
    const item = await tx.menuItem.findFirst({
      where: {
        id: body.menuItemId,
        active: true,
        category: { active: true, outletId: order.outletId },
      },
      include: { modifiers: { where: { active: true } }, category: true },
    });
    if (!item) throw invalid('body.menuItemId', 'Choose an item on this outlet’s menu');
    const ids = [...new Set(body.modifierIds)];
    const chosen = item.modifiers
      .filter((m) => ids.includes(m.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (chosen.length !== ids.length) {
      throw invalid('body.modifierIds', 'Choose options of this item that are switched on');
    }
    const unit = chosen.reduce((s, m) => s + m.priceMinor, item.priceMinor);
    const name =
      chosen.length > 0 ? `${item.name} (${chosen.map((m) => m.name).join(', ')})` : item.name;
    const line = await tx.posOrderLine.create({
      data: {
        orderId: order.id,
        menuItemId: item.id,
        name,
        quantity: body.quantity,
        unitPriceMinor: unit,
        modifiers: chosen.map((m) => ({
          id: m.id,
          name: m.name,
          priceMinor: m.priceMinor.toString(),
        })),
        revenueCodeId: item.revenueCodeId,
        note: body.note,
        kitchenStation: item.category.kitchenStation,
        addedById: tenant.userId,
        addedAt: deps.clock(),
      } as unknown as Prisma.PosOrderLineUncheckedCreateInput,
    });
    await tx.posOrder.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
    await recordAudit(tx, {
      action: 'pos.item_added',
      entityType: 'pos_order',
      entityId: order.id,
      after: {
        lineId: line.id,
        name,
        quantity: body.quantity,
        unitPriceMinor: unit.toString(),
      },
    });
  });
  return orderView(deps.tenantDb, orderId, deps.clock);
}

/** Posts the order's lines, with their taxes, to a folio window; answers the lines' total. */
async function postLines(
  tx: Tx,
  tenant: TenantContext,
  now: Date,
  order: Awaited<ReturnType<typeof lockOpenOrder>>,
  folio: {
    id: string;
    propertyId: string;
    currency: string;
    windows: { id: string; number: number }[];
    routingRules: { revenueCodeId: string | null; revenueGroup: string | null; windowId: string }[];
  },
  shiftId: string,
) {
  const ids: string[] = [];
  const ctx = { tx, tenant, approvalRequestId: null, now };
  const active = order.lines.filter((l) => !l.voidedAt);
  for (const l of active.sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime())) {
    const code = await tx.revenueCode.findUniqueOrThrow({ where: { id: l.revenueCodeId } });
    const windowId = routedWindow(folio, code);
    if (!windowId) throw new Error('Folio without window 1');
    const posted = await postChargeLines(ctx, {
      folio,
      windowId,
      code,
      description: `${order.outlet.name}: ${l.name}`,
      quantity: l.quantity,
      unitAmountMinor: l.unitPriceMinor,
      note: l.note,
      sourceType: 'POS_ORDER',
      sourceId: order.id,
      shiftId,
    });
    ids.push(...posted);
    if (l.discountMinor === null || !l.discountReason) continue;
    // M8-04: the item's discount, split over the charge and its taxes.
    const [chargeId, ...taxIds] = posted;
    const charge = await tx.folioLine.findUniqueOrThrow({ where: { id: chargeId ?? '' } });
    const taxes = await tx.folioLine.findMany({ where: { id: { in: taxIds } } });
    const gross = taxes.reduce((s, t) => s + t.amountMinor, charge.amountMinor);
    if (gross <= 0n) continue;
    const discountId = await postDiscountLines(ctx, {
      charge,
      taxes,
      gross,
      // Taxes changed since it was given: never more than the item now charges.
      amount: l.discountMinor > gross ? gross : l.discountMinor,
      reason: l.discountReason,
      shiftId,
      sourceType: 'POS_ORDER',
      sourceId: order.id,
    });
    const discountTaxes = await tx.folioLine.findMany({
      where: { parentLineId: discountId },
      select: { id: true },
    });
    ids.push(discountId, ...discountTaxes.map((t) => t.id));
  }
  const posted = await tx.folioLine.aggregate({
    where: { id: { in: ids } },
    _sum: { amountMinor: true },
  });
  return { lineIds: ids, total: posted._sum.amountMinor ?? 0n };
}

function needsLines(order: { lines: { voidedAt: Date | null }[] }) {
  if (!order.lines.some((l) => !l.voidedAt)) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Add items to the order first');
  }
}

/** Paid at the outlet: a POS folio of the order, settled by the payments (M8-03). */
export async function settleOrder(
  deps: RegisterDeps,
  tenant: TenantContext,
  orderId: string,
  body: z.output<typeof SettlePosOrderBody>,
) {
  const now = deps.clock();
  try {
    await deps.tenantDb.$transaction(async (tx) => {
      const order = await lockOpenOrder(tx, orderId);
      needsLines(order);
      const shift = await myShiftAt(tx, tenant, order.outletId);
      // Paid before cooking (counter service): the kitchen gets it now (T-156).
      await sendKitchenLines(tx, tenant, order, now);
      const property = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
      const allowed = posMethods(property.settings);
      const off = body.payments.find((p) => !allowed.includes(p.method));
      if (off) {
        throw invalid(
          'body.payments',
          `${METHOD_NAMES[off.method]} is not switched on for this hotel (setup, payment methods)`,
        );
      }
      const date = await postingDate(tx, property.id, deps.clock);
      const n = await nextPropertyCounter(tx, property.id, COUNTER.FOLIO);
      const folio = await tx.folio.create({
        data: {
          number: `F${String(n).padStart(5, '0')}`,
          kind: 'POS',
          name: `${order.outlet.name} ${order.number} (${order.label})`,
          currency: property.baseCurrency,
          windows: { create: { number: 1, payerType: 'GUEST' } },
        } as unknown as Prisma.FolioUncheckedCreateInput, // tenant IDs come from the client
        include: { windows: true, routingRules: true },
      });
      const { lineIds, total } = await postLines(tx, tenant, now, order, folio, shift.id);
      const paid = body.payments.reduce((s, p) => s + BigInt(p.amountMinor), 0n);
      if (paid !== total) {
        throw invalid('body.payments', 'The payments must add up to the total exactly', {
          totalMinor: total.toString(),
          paidMinor: paid.toString(),
        });
      }
      const window = folio.windows[0];
      if (!window) throw new Error('POS folio without a window');
      const paymentIds: string[] = [];
      for (const p of body.payments) {
        const payment = await tx.payment.create({
          data: {
            folioId: folio.id,
            windowId: window.id,
            method: p.method,
            amountMinor: BigInt(p.amountMinor),
            currency: property.baseCurrency,
            baseAmountMinor: BigInt(p.amountMinor),
            provider: 'MANUAL',
            externalRef: p.externalRef,
            businessDate: dbDate(date),
            shiftId: shift.id,
            receivedById: tenant.userId,
            createdAt: now,
          } as unknown as Prisma.PaymentUncheckedCreateInput,
        });
        paymentIds.push(payment.id);
      }
      await tx.folio.update({
        where: { id: folio.id },
        data: { status: 'SETTLED', version: { increment: 1 } },
      });
      await tx.posOrder.update({
        where: { id: order.id },
        data: {
          status: 'PAID',
          settledAt: now,
          settledById: tenant.userId,
          settledShiftId: shift.id,
          folioId: folio.id,
          totalMinor: total,
          version: { increment: 1 },
        },
      });
      const facts = {
        folioId: folio.id,
        totalMinor: total.toString(),
        shiftId: shift.id,
        payments: body.payments,
      };
      await recordAudit(tx, {
        action: 'pos.order_settled',
        entityType: 'pos_order',
        entityId: order.id,
        before: { status: 'OPEN' },
        after: { status: 'PAID', ...facts },
      });
      await recordEvent(tx, {
        type: 'pos.order_settled',
        payload: { orderId: order.id, lineIds, paymentIds, ...facts },
      });
    });
  } catch (err) {
    if (pgErrorInfo(err)?.constraint === 'payments_manual_ref_key') {
      throw new AppError('PAYMENT_DUPLICATE', 'This reference has already been used for a payment');
    }
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
  return orderView(deps.tenantDb, orderId, deps.clock);
}

/** Charged to a checked-in guest's room, who signs on screen (M8-03 rules). */
export async function chargeToRoom(
  deps: RegisterDeps,
  tenant: TenantContext,
  orderId: string,
  body: { stayId: string; signatureFileId: string },
) {
  const now = deps.clock();
  await deps.tenantDb.$transaction(async (tx) => {
    const order = await lockOpenOrder(tx, orderId);
    needsLines(order);
    const shift = await myShiftAt(tx, tenant, order.outletId);
    await sendKitchenLines(tx, tenant, order, now);
    const stay = await tx.stay.findUnique({ where: { id: body.stayId } });
    if (!stay) throw invalid('body.stayId', 'Choose a checked-in room');
    if (stay.status !== 'CHECKED_IN' || !stay.folioId) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'Only a checked-in guest’s room takes charges',
        {
          status: stay.status,
        },
      );
    }
    // One room charge at a time per folio, so two orders cannot both slip under the limit.
    await tx.$queryRaw`SELECT id FROM folios WHERE id = ${stay.folioId}::uuid FOR UPDATE`;
    const folio = await tx.folio.findUniqueOrThrow({
      where: { id: stay.folioId },
      include: { windows: true, routingRules: true, property: true },
    });
    if (folio.status !== 'OPEN') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This guest’s folio is not open', {
        status: folio.status,
      });
    }
    const signature = await tx.fileObject.findFirst({
      where: { id: body.signatureFileId, entityType: 'PosOrder', scan: { not: 'INFECTED' } },
    });
    if (!signature) {
      throw invalid('body.signatureFileId', 'The guest signs on screen first');
    }
    const before = (await folioBalances(tx, [folio.id])).get(folio.id) ?? 0n;
    const { lineIds, total } = await postLines(tx, tenant, now, order, folio, shift.id);
    const setting = posSettingsOf(folio.property.settings).roomChargeLimitMinor;
    const limit = folio.creditLimitMinor ?? (setting === null ? null : BigInt(setting));
    if (limit !== null && before + total > limit) {
      throw new AppError(
        'CREDIT_LIMIT_EXCEEDED',
        'This would take the room over its credit limit',
        {
          limitMinor: limit.toString(),
          balanceMinor: before.toString(),
          totalMinor: total.toString(),
        },
      );
    }
    await tx.posOrder.update({
      where: { id: order.id },
      data: {
        status: 'ROOM_CHARGED',
        settledAt: now,
        settledById: tenant.userId,
        settledShiftId: shift.id,
        folioId: folio.id,
        stayId: stay.id,
        signatureFileId: signature.id,
        totalMinor: total,
        version: { increment: 1 },
      },
    });
    const facts = {
      folioId: folio.id,
      stayId: stay.id,
      totalMinor: total.toString(),
      shiftId: shift.id,
      signatureFileId: signature.id,
    };
    await recordAudit(tx, {
      action: 'pos.order_charged_to_room',
      entityType: 'pos_order',
      entityId: order.id,
      before: { status: 'OPEN' },
      after: { status: 'ROOM_CHARGED', ...facts },
    });
    await recordEvent(tx, { type: 'folio.charge_posted', payload: { folioId: folio.id, lineIds } });
  });
  return orderView(deps.tenantDb, orderId, deps.clock);
}

export async function cancelOrder(deps: RegisterDeps, tenant: TenantContext, orderId: string) {
  await deps.tenantDb.$transaction(async (tx) => {
    const order = await lockOpenOrder(tx, orderId);
    // Voided items stay on the order with their reasons (M8-04); the rest must be voided first.
    if (order.lines.some((l) => !l.voidedAt)) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'Items are on this order: settle it, or void them first',
      );
    }
    await tx.posOrder.update({
      where: { id: order.id },
      data: {
        status: 'CANCELLED',
        settledAt: deps.clock(),
        settledById: tenant.userId,
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      action: 'pos.order_cancelled',
      entityType: 'pos_order',
      entityId: order.id,
      before: { status: 'OPEN' },
      after: { status: 'CANCELLED' },
    });
  });
  return orderView(deps.tenantDb, orderId, deps.clock);
}

// ── Voids and discounts (M8-04) ─────────────────────────────────────────────────────────

const LineStored = z.object({
  orderId: z.string(),
  lineId: z.string(),
  /** What the guest pays less, taxes included, minor units (worked out when asked). */
  amountMinor: z.string(),
  reason: z.string(),
});
type LinePayload = z.output<typeof LineStored>;

/** An item of an open order that is not voided, and what it charges today. */
async function measureLine(db: Client, clock: Clock, orderId: string, lineId: string) {
  const order = await db.posOrder.findUnique({ where: { id: orderId }, include: { lines: true } });
  if (!order) throw new AppError('NOT_FOUND', 'Order not found');
  if (order.status !== 'OPEN') {
    throw new AppError('STATE_TRANSITION_INVALID', 'This order is already closed', {
      status: order.status,
    });
  }
  const line = order.lines.find((l) => l.id === lineId);
  if (!line) throw new AppError('NOT_FOUND', 'Item not found on this order');
  if (line.voidedAt) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This item is already voided');
  }
  const date = await businessDate(db, order.propertyId, clock);
  const math = (await lineMath(db, [line], date)).get(line.id);
  if (!math) throw new Error('Line without amounts');
  return { order, line, math };
}

/** The line, locked with its order, as it is now (approval re-validates here). */
async function lockLine(tx: Tx, orderId: string, lineId: string) {
  const order = await lockOpenOrder(tx, orderId);
  const line = order.lines.find((l) => l.id === lineId);
  if (!line) throw new AppError('NOT_FOUND', 'Item not found on this order');
  if (line.voidedAt) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This item is already voided');
  }
  return { order, line };
}

async function executeVoid(ctx: ExecuteContext & { now: Date }, p: LinePayload) {
  const { tx } = ctx;
  const { order, line } = await lockLine(tx, p.orderId, p.lineId);
  await tx.posOrderLine.update({
    where: { id: line.id },
    data: {
      voidedAt: ctx.now,
      voidedById: ctx.tenant.userId,
      voidReason: p.reason,
      voidApprovalRequestId: ctx.approvalRequestId,
    },
  });
  await tx.posOrder.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
  const facts = { lineId: line.id, name: line.name, quantity: line.quantity };
  await recordAudit(tx, {
    action: 'pos.item_voided',
    entityType: 'pos_order',
    entityId: order.id,
    reason: p.reason,
    approvalRequestId: ctx.approvalRequestId ?? undefined,
    after: { ...facts, amountMinor: p.amountMinor },
  });
  await recordEvent(tx, {
    type: 'pos.item_voided',
    payload: { orderId: order.id, ...facts, amountMinor: p.amountMinor },
  });
  return line.id;
}

async function executeDiscount(ctx: ExecuteContext & { now: Date }, p: LinePayload) {
  const { tx } = ctx;
  const { order, line } = await lockLine(tx, p.orderId, p.lineId);
  if (line.discountMinor !== null) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This item already has a discount');
  }
  const date = await businessDate(tx, order.propertyId, () => ctx.now);
  const gross = (await lineMath(tx, [line], date)).get(line.id)?.gross ?? 0n;
  const amount = BigInt(p.amountMinor);
  if (amount > gross) {
    throw invalid('body.amountMinor', 'The discount is more than the item charges');
  }
  await tx.posOrderLine.update({
    where: { id: line.id },
    data: {
      discountMinor: amount,
      discountReason: p.reason,
      discountedById: ctx.tenant.userId,
      discountedAt: ctx.now,
      discountApprovalRequestId: ctx.approvalRequestId,
    },
  });
  await tx.posOrder.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
  const facts = { lineId: line.id, name: line.name, amountMinor: p.amountMinor };
  await recordAudit(tx, {
    action: 'pos.discount_given',
    entityType: 'pos_order',
    entityId: order.id,
    reason: p.reason,
    approvalRequestId: ctx.approvalRequestId ?? undefined,
    after: facts,
  });
  await recordEvent(tx, { type: 'pos.discount_given', payload: { orderId: order.id, ...facts } });
  return line.id;
}

const measured = (p: LinePayload) => ({ amountMinor: BigInt(p.amountMinor) });

export function posVoidHandler(deps: RegisterDeps): ApprovalActionHandler<LinePayload> {
  return {
    action: 'pos.void',
    payload: LineStored,
    measure: measured,
    execute: (ctx, p) => executeVoid({ ...ctx, now: deps.clock() }, p),
  };
}

export function posDiscountHandler(deps: RegisterDeps): ApprovalActionHandler<LinePayload> {
  return {
    action: 'pos.discount',
    payload: LineStored,
    measure: measured,
    execute: (ctx, p) => executeDiscount({ ...ctx, now: deps.clock() }, p),
  };
}

/** M8-04: void an item; above the caller's pos.void limit it waits for approval (202). */
export async function voidLine(
  deps: RegisterDeps,
  tenant: TenantContext,
  orderId: string,
  lineId: string,
  body: { reason: string },
) {
  const { math } = await measureLine(deps.tenantDb, deps.clock, orderId, lineId);
  const result = await performOrRequest(
    { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
    tenant,
    posVoidHandler(deps),
    { orderId, lineId, amountMinor: math.total.toString(), reason: body.reason },
    body.reason,
  );
  if (!('resultRef' in result)) return result;
  return orderView(deps.tenantDb, orderId, deps.clock);
}

/** M8-04: a discount on an item; above the caller's pos.void limit it waits for approval. */
export async function discountLine(
  deps: RegisterDeps,
  tenant: TenantContext,
  orderId: string,
  lineId: string,
  body: z.output<typeof DiscountPosOrderLineBody>,
) {
  const { line, math } = await measureLine(deps.tenantDb, deps.clock, orderId, lineId);
  if (line.discountMinor !== null) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This item already has a discount');
  }
  const amount =
    body.percent !== undefined
      ? share(math.gross, BigInt(Math.round(body.percent * 100)), 10_000n)
      : BigInt(body.amountMinor ?? '0');
  if (amount <= 0n) throw invalid('body.amountMinor', 'The discount is more than nothing');
  if (amount > math.gross) {
    throw invalid('body.amountMinor', 'The discount is more than the item charges');
  }
  const result = await performOrRequest(
    { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
    tenant,
    posDiscountHandler(deps),
    { orderId, lineId, amountMinor: amount.toString(), reason: body.reason },
    body.reason,
  );
  if (!('resultRef' in result)) return result;
  return orderView(deps.tenantDb, orderId, deps.clock);
}

export async function listRooms(deps: RegisterDeps) {
  const stays = await deps.tenantDb.stay.findMany({
    where: { status: 'CHECKED_IN', folioId: { not: null }, roomId: { not: null } },
    include: { room: true, guest: true },
  });
  return {
    data: stays
      .map((s) => ({
        stayId: s.id,
        roomNumber: s.room?.number ?? '',
        guest: `${s.guest.firstName} ${s.guest.lastName}`.trim(),
      }))
      .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true })),
  };
}

// ── Settings ────────────────────────────────────────────────────────────────────────────

export async function getSettings(deps: RegisterDeps, tenant: TenantContext) {
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
  });
  return posSettingsOf(property.settings);
}

export async function updateSettings(
  deps: RegisterDeps,
  tenant: TenantContext,
  body: z.output<typeof PosSettings>,
) {
  await deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM properties WHERE id = ${tenant.propertyId}::uuid FOR UPDATE`;
    const property = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
    const settings = (property.settings ?? {}) as Record<string, unknown>;
    const before = posSettingsOf(settings);
    await tx.property.update({
      where: { id: tenant.propertyId },
      data: {
        settings: {
          ...settings,
          pos: { ...(settings['pos'] ?? {}), ...body },
        } as never,
      },
    });
    await recordAudit(tx, {
      action: 'pos.settings_updated',
      entityType: 'property',
      entityId: tenant.propertyId,
      before,
      after: body,
    });
  });
  return getSettings(deps, tenant);
}
