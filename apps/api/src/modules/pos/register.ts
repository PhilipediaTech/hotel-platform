import {
  calculateTaxes,
  POS_PAY_METHODS,
  posSettingsOf,
  type CloseShiftBody,
  type PosOrderItem,
  type PosRegister,
  type PosSettings,
  type SettlePosOrderBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
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
// Items are priced when added (item + options). Voids and discounts are M8-04.

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
    include: { addedBy: { select: { name: true } } },
  },
} satisfies Prisma.PosOrderInclude;
type OrderRow = Prisma.PosOrderGetPayload<{ include: typeof ORDER }>;

/** Lines' totals: as posted once settled; worked out for the open day while open. */
async function totalsOf(db: Client, o: OrderRow, clock: Clock) {
  if (o.status === 'CANCELLED') return { subtotal: 0n, tax: 0n, total: 0n };
  if (o.folioId && o.totalMinor !== null) {
    const charges = await db.folioLine.findMany({
      where: { folioId: o.folioId, kind: 'CHARGE', sourceType: 'POS_ORDER', sourceId: o.id },
      select: { id: true, amountMinor: true },
    });
    const subtotal = charges.reduce((s, l) => s + l.amountMinor, 0n);
    return { subtotal, tax: o.totalMinor - subtotal, total: o.totalMinor };
  }
  if (o.lines.length === 0) return { subtotal: 0n, tax: 0n, total: 0n };
  const date = await businessDate(db, o.propertyId, clock);
  let subtotal = 0n;
  let total = 0n;
  const codes = new Map<string, Awaited<ReturnType<typeof taxesFor>>['versions']>();
  for (const l of o.lines) {
    let versions = codes.get(l.revenueCodeId);
    if (!versions) {
      const code = await db.revenueCode.findUniqueOrThrow({ where: { id: l.revenueCodeId } });
      versions = (await taxesFor(db, code, date)).versions;
      codes.set(l.revenueCodeId, versions);
    }
    const r = calculateTaxes(l.unitPriceMinor * BigInt(l.quantity), versions);
    subtotal += r.netMinor;
    total += r.totalMinor;
  }
  return { subtotal, tax: total - subtotal, total };
}

async function orderItem(
  db: Client,
  o: OrderRow,
  currency: string,
  clock: Clock,
): Promise<z.input<typeof PosOrderItem>> {
  const [totals, payments] = await Promise.all([
    totalsOf(db, o, clock),
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
    })),
    subtotalMinor: totals.subtotal.toString(),
    taxMinor: totals.tax.toString(),
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
    version: o.version,
  };
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
      include: { modifiers: { where: { active: true } } },
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
  for (const l of [...order.lines].sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime())) {
    const code = await tx.revenueCode.findUniqueOrThrow({ where: { id: l.revenueCodeId } });
    const windowId = routedWindow(folio, code);
    if (!windowId) throw new Error('Folio without window 1');
    ids.push(
      ...(await postChargeLines(
        { tx, tenant, approvalRequestId: null, now },
        {
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
        },
      )),
    );
  }
  const posted = await tx.folioLine.aggregate({
    where: { id: { in: ids } },
    _sum: { amountMinor: true },
  });
  return { lineIds: ids, total: posted._sum.amountMinor ?? 0n };
}

function needsLines(order: { lines: unknown[] }) {
  if (order.lines.length === 0) {
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
    if (order.lines.length > 0) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'Items are on this order: settle it, or void them (M8-04)',
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
