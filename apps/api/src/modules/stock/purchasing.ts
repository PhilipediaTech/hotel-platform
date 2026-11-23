import type { GoodsReceiptItem, PurchaseOrderItem, SupplierItem } from '@hotel/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { performOrRequest, type ApprovalActionHandler } from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import {
  activeLocation,
  defined,
  invalid,
  lockItem,
  milli,
  notFound,
  person,
  qty,
  valueMinor,
  writeMovement,
  type Client,
  type Tx,
} from './service.ts';

// Purchasing (PRD M10-03, M10-04; T-146). An order is prepared as a DRAFT and then approved:
// at once when its total is within the caller's po.manage amount limit (or they hold an
// approver role), else by a manager through the approvals engine (action po.approve). Goods
// are received only against an APPROVED or PARTIAL order, never more than is still to come;
// each receipt line is a RECEIPT stock movement at the order's price, and that price becomes
// the item's unit cost (last purchase price).

export interface PurchasingDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

const lineAmount = (quantityMilli: bigint, priceMinor: bigint) =>
  valueMinor(quantityMilli, priceMinor);

// ---------------------------------------------------------------------------------------
// Suppliers

type SupplierRow = Prisma.SupplierGetPayload<object>;

function supplierItem(s: SupplierRow): z.input<typeof SupplierItem> {
  return {
    id: s.id,
    name: s.name,
    contactName: s.contactName,
    phone: s.phone,
    email: s.email,
    note: s.note,
    active: s.active,
  };
}

export async function listSuppliers(deps: PurchasingDeps) {
  const rows = await deps.tenantDb.supplier.findMany({ orderBy: { name: 'asc' } });
  return { data: rows.map(supplierItem) };
}

interface SupplierBody {
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  note: string | null;
}

async function nameFree(tx: Client, name: string, except?: string) {
  const taken = await tx.supplier.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(except ? { NOT: { id: except } } : {}),
    },
  });
  if (taken) throw invalid('body.name', `${name} is already a supplier here`);
}

export async function createSupplier(deps: PurchasingDeps, body: SupplierBody) {
  return deps.tenantDb.$transaction(async (tx) => {
    await nameFree(tx, body.name);
    const s = await tx.supplier.create({
      data: body as unknown as Prisma.SupplierUncheckedCreateInput,
    });
    await recordAudit(tx, {
      action: 'stock.supplier_created',
      entityType: 'supplier',
      entityId: s.id,
      after: body,
    });
    return supplierItem(s);
  });
}

export async function updateSupplier(
  deps: PurchasingDeps,
  supplierId: string,
  body: Partial<SupplierBody> & { active?: boolean | undefined },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.supplier.findFirst({ where: { id: supplierId } });
    if (!before) throw notFound('Supplier');
    if (body.name !== undefined) await nameFree(tx, body.name, supplierId);
    const s = await tx.supplier.update({ where: { id: supplierId }, data: defined(body) });
    await recordAudit(tx, {
      action: 'stock.supplier_updated',
      entityType: 'supplier',
      entityId: supplierId,
      before: supplierItem(before),
      after: body,
    });
    return supplierItem(s);
  });
}

// ---------------------------------------------------------------------------------------
// Purchase orders (M10-03)

const ORDER_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
  lines: { include: { item: { include: { unit: true } } }, orderBy: { item: { name: 'asc' } } },
} as const satisfies Prisma.PurchaseOrderInclude;
type OrderRow = Prisma.PurchaseOrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function orderItem(o: OrderRow): z.input<typeof PurchaseOrderItem> {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    supplier: o.supplier,
    note: o.note,
    expectedOn: dateOnly(o.expectedOn),
    totalMinor: o.totalMinor.toString(),
    createdBy: person(o.createdBy),
    createdAt: o.createdAt.toISOString(),
    approvedBy: o.approvedBy ? person(o.approvedBy) : null,
    approvedAt: o.approvedAt?.toISOString() ?? null,
    closedBy: o.closedBy ? person(o.closedBy) : null,
    closedAt: o.closedAt?.toISOString() ?? null,
    closeReason: o.closeReason,
    lines: o.lines.map((l) => ({
      id: l.id,
      item: { id: l.item.id, code: l.item.code, name: l.item.name, unit: l.item.unit.code },
      quantity: qty(l.quantityMilli),
      unitPriceMinor: l.unitPriceMinor.toString(),
      amountMinor: lineAmount(l.quantityMilli, l.unitPriceMinor).toString(),
      received: qty(l.receivedMilli),
    })),
  };
}

async function orderView(db: Client, id: string) {
  return orderItem(
    await db.purchaseOrder.findFirstOrThrow({ where: { id }, include: ORDER_INCLUDE }),
  );
}

export async function listPurchaseOrders(
  deps: PurchasingDeps,
  tenant: TenantContext,
  query: { status?: OrderRow['status'] | undefined },
) {
  const [rows, property] = await Promise.all([
    deps.tenantDb.purchaseOrder.findMany({
      where: defined({ status: query.status }),
      include: ORDER_INCLUDE,
      orderBy: { number: 'desc' },
      take: 200,
    }),
    deps.tenantDb.property.findUniqueOrThrow({ where: { id: tenant.propertyId } }),
  ]);
  return { data: rows.map(orderItem), currency: property.baseCurrency };
}

export async function getPurchaseOrder(deps: PurchasingDeps, id: string) {
  const o = await deps.tenantDb.purchaseOrder.findFirst({ where: { id }, include: ORDER_INCLUDE });
  if (!o) throw notFound('Purchase order');
  return orderItem(o);
}

interface OrderBody {
  supplierId: string;
  expectedOn?: string | null | undefined;
  note?: string | null | undefined;
  lines: { itemId: string; quantity: string; unitPriceMinor: string }[];
}

/** Checks the supplier and items, and works out the lines and total. */
async function orderLines(tx: Tx, body: OrderBody) {
  const supplier = await tx.supplier.findFirst({ where: { id: body.supplierId, active: true } });
  if (!supplier) throw invalid('body.supplierId', 'Choose an active supplier of this property');
  const items = await tx.stockItem.findMany({
    where: { id: { in: body.lines.map((l) => l.itemId) }, active: true },
  });
  const lines = body.lines.map((l, i) => {
    if (!items.some((it) => it.id === l.itemId)) {
      throw invalid(`body.lines.${i}.itemId`, 'Choose an active item of this property');
    }
    return {
      itemId: l.itemId,
      quantityMilli: milli(l.quantity),
      unitPriceMinor: BigInt(l.unitPriceMinor),
    };
  });
  const totalMinor = lines.reduce((s, l) => s + lineAmount(l.quantityMilli, l.unitPriceMinor), 0n);
  return { supplier, lines, totalMinor };
}

async function writeLines(
  tx: Tx,
  orderId: string,
  lines: Awaited<ReturnType<typeof orderLines>>['lines'],
) {
  await tx.purchaseOrderLine.createMany({
    data: lines.map((l) => ({
      purchaseOrderId: orderId,
      ...l,
    })) as unknown as Prisma.PurchaseOrderLineCreateManyInput[],
  });
}

const expected = (v: string | null | undefined) => (v ? new Date(`${v}T00:00:00Z`) : null);

export async function createPurchaseOrder(
  deps: PurchasingDeps,
  tenant: TenantContext,
  body: OrderBody,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const { supplier, lines, totalMinor } = await orderLines(tx, body);
    const number = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.PURCHASE_ORDER);
    const order = await tx.purchaseOrder.create({
      data: {
        number,
        supplierId: supplier.id,
        note: body.note ?? null,
        expectedOn: expected(body.expectedOn),
        totalMinor,
        createdById: tenant.userId,
      } as unknown as Prisma.PurchaseOrderUncheckedCreateInput,
    });
    await writeLines(tx, order.id, lines);
    await recordAudit(tx, {
      action: 'stock.po_created',
      entityType: 'purchase_order',
      entityId: order.id,
      after: {
        number,
        supplier: supplier.name,
        totalMinor: totalMinor.toString(),
        lines: body.lines,
      },
    });
    return orderView(tx, order.id);
  });
}

async function lockOrder(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;
  const o = await tx.purchaseOrder.findFirst({ where: { id }, include: { lines: true } });
  if (!o) throw notFound('Purchase order');
  return o;
}

function mustBe(o: { status: string }, allowed: string[], message: string) {
  if (!allowed.includes(o.status)) {
    throw new AppError('STATE_TRANSITION_INVALID', message, { status: o.status });
  }
}

export async function updatePurchaseOrder(deps: PurchasingDeps, id: string, body: OrderBody) {
  return deps.tenantDb.$transaction(async (tx) => {
    const o = await lockOrder(tx, id);
    mustBe(o, ['DRAFT'], 'Only a draft order can be changed');
    const { supplier, lines, totalMinor } = await orderLines(tx, body);
    await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
    await writeLines(tx, id, lines);
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        supplierId: supplier.id,
        note: body.note ?? null,
        expectedOn: expected(body.expectedOn),
        totalMinor,
      },
    });
    await recordAudit(tx, {
      action: 'stock.po_updated',
      entityType: 'purchase_order',
      entityId: id,
      before: { totalMinor: o.totalMinor.toString() },
      after: { supplier: supplier.name, totalMinor: totalMinor.toString(), lines: body.lines },
    });
    return orderView(tx, id);
  });
}

const ApproveStored = z.object({ orderId: z.string(), totalMinor: z.string() });
type ApprovePayload = z.output<typeof ApproveStored>;

async function executeApprove(
  ctx: { tx: Tx; tenant: TenantContext; approvalRequestId: string | null; now: Date },
  p: ApprovePayload,
) {
  const o = await lockOrder(ctx.tx, p.orderId);
  mustBe(o, ['DRAFT'], 'This order is no longer a draft');
  // The order may have been changed while the request waited: approve only what was asked.
  if (o.totalMinor.toString() !== p.totalMinor) {
    throw new AppError('STATE_TRANSITION_INVALID', 'The order changed after approval was asked');
  }
  // Within the limit the raiser approves it; through a request, the manager who decided
  // (the engine records the decision before running the action, in this transaction).
  const decided = ctx.approvalRequestId
    ? await ctx.tx.approvalRequest.findFirst({
        where: { id: ctx.approvalRequestId },
        select: { decidedById: true },
      })
    : null;
  await ctx.tx.purchaseOrder.update({
    where: { id: o.id },
    data: {
      status: 'APPROVED',
      approvedById: decided?.decidedById ?? ctx.tenant.userId,
      approvedAt: ctx.now,
      approvalRequestId: ctx.approvalRequestId,
    },
  });
  await recordAudit(ctx.tx, {
    action: 'stock.po_approved',
    entityType: 'purchase_order',
    entityId: o.id,
    approvalRequestId: ctx.approvalRequestId ?? undefined,
    after: { number: o.number, totalMinor: p.totalMinor },
  });
  return o.id;
}

export function poApproveHandler(deps: { clock: Clock }): ApprovalActionHandler<ApprovePayload> {
  return {
    action: 'po.approve',
    payload: ApproveStored,
    measure: (p) => ({ amountMinor: BigInt(p.totalMinor) }),
    execute: (ctx, p) => executeApprove({ ...ctx, now: deps.clock() }, p),
  };
}

/** M10-03: within the caller's limit the order is approved now; above it a manager decides. */
export async function approvePurchaseOrder(
  deps: PurchasingDeps,
  tenant: TenantContext,
  id: string,
  body: { reason?: string | null | undefined },
) {
  const o = await deps.tenantDb.purchaseOrder.findFirst({ where: { id } });
  if (!o) throw notFound('Purchase order');
  mustBe(o, ['DRAFT'], 'Only a draft order is approved');
  const result = await performOrRequest(
    { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
    tenant,
    poApproveHandler(deps),
    { orderId: id, totalMinor: o.totalMinor.toString() },
    body.reason ?? '',
  );
  if (!('resultRef' in result)) return result;
  return orderView(deps.tenantDb, id);
}

export async function closePurchaseOrder(
  deps: PurchasingDeps,
  tenant: TenantContext,
  id: string,
  body: { reason: string },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const o = await lockOrder(tx, id);
    mustBe(o, ['APPROVED', 'PARTIAL'], 'Only an order waiting for goods can be closed');
    await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedById: tenant.userId,
        closedAt: new Date(),
        closeReason: body.reason,
      },
    });
    await recordAudit(tx, {
      action: 'stock.po_closed',
      entityType: 'purchase_order',
      entityId: id,
      after: { number: o.number, was: o.status },
      reason: body.reason,
    });
    return orderView(tx, id);
  });
}

export async function cancelPurchaseOrder(deps: PurchasingDeps, tenant: TenantContext, id: string) {
  return deps.tenantDb.$transaction(async (tx) => {
    const o = await lockOrder(tx, id);
    mustBe(
      o,
      ['DRAFT', 'APPROVED'],
      'Goods have been received against this order: close it instead',
    );
    await tx.purchaseOrder.update({
      where: { id },
      data: { status: 'CANCELLED', closedById: tenant.userId, closedAt: new Date() },
    });
    await recordAudit(tx, {
      action: 'stock.po_cancelled',
      entityType: 'purchase_order',
      entityId: id,
      after: { number: o.number, was: o.status },
    });
    return orderView(tx, id);
  });
}

// ---------------------------------------------------------------------------------------
// Goods receipts (M10-04)

const RECEIPT_INCLUDE = {
  order: { select: { id: true, number: true, supplier: { select: { name: true } } } },
  location: { select: { id: true, code: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  movements: { include: { item: { include: { unit: true } } }, orderBy: { item: { name: 'asc' } } },
} as const satisfies Prisma.GoodsReceiptInclude;
type ReceiptRow = Prisma.GoodsReceiptGetPayload<{ include: typeof RECEIPT_INCLUDE }>;

function receiptItem(r: ReceiptRow): z.input<typeof GoodsReceiptItem> {
  return {
    id: r.id,
    number: r.number,
    order: { id: r.order.id, number: r.order.number, supplier: r.order.supplier.name },
    location: r.location,
    supplierRef: r.supplierRef,
    note: r.note,
    receivedBy: person(r.receivedBy),
    receivedAt: r.receivedAt.toISOString(),
    lines: r.movements.map((m) => ({
      item: { id: m.item.id, code: m.item.code, name: m.item.name, unit: m.item.unit.code },
      quantity: qty(m.quantityMilli),
      unitPriceMinor: m.unitCostMinor.toString(),
    })),
    valueMinor: r.movements
      .reduce((s, m) => s + lineAmount(m.quantityMilli, m.unitCostMinor), 0n)
      .toString(),
  };
}

export async function listGoodsReceipts(deps: PurchasingDeps) {
  const db = deps.tenantDb;
  const [awaiting, receipts, locations] = await Promise.all([
    db.purchaseOrder.findMany({
      where: { status: { in: ['APPROVED', 'PARTIAL'] } },
      include: ORDER_INCLUDE,
      orderBy: { number: 'asc' },
    }),
    db.goodsReceipt.findMany({ include: RECEIPT_INCLUDE, orderBy: { number: 'desc' }, take: 100 }),
    db.stockLocation.findMany({ orderBy: { name: 'asc' } }),
  ]);
  return {
    awaiting: awaiting.map(orderItem),
    data: receipts.map(receiptItem),
    locations: locations.map((l) => ({ id: l.id, code: l.code, name: l.name, active: l.active })),
  };
}

export async function receiveGoods(
  deps: PurchasingDeps,
  tenant: TenantContext,
  body: {
    purchaseOrderId: string;
    locationId: string;
    supplierRef?: string | null | undefined;
    note?: string | null | undefined;
    lines: { lineId: string; quantity: string }[];
  },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const o = await lockOrder(tx, body.purchaseOrderId);
    mustBe(o, ['APPROVED', 'PARTIAL'], 'Goods are received only against an approved order');
    const location = await activeLocation(tx, body.locationId, 'body.locationId');
    const number = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.GOODS_RECEIPT);
    const receipt = await tx.goodsReceipt.create({
      data: {
        number,
        purchaseOrderId: o.id,
        locationId: location.id,
        supplierRef: body.supplierRef ?? null,
        note: body.note ?? null,
        receivedById: tenant.userId,
      } as unknown as Prisma.GoodsReceiptUncheckedCreateInput,
    });
    const received: { item: string; quantity: string }[] = [];
    for (const [i, l] of body.lines.entries()) {
      const path = `body.lines.${i}`;
      const line = o.lines.find((x) => x.id === l.lineId);
      if (!line) throw invalid(`${path}.lineId`, 'Not a line of this order');
      const quantity = milli(l.quantity);
      const left = line.quantityMilli - line.receivedMilli;
      if (quantity > left) throw invalid(`${path}.quantity`, `Only ${qty(left)} still to come`);
      const item = await lockItem(tx, line.itemId, `${path}.lineId`);
      await writeMovement(tx, {
        itemId: item.id,
        locationId: location.id,
        kind: 'RECEIPT',
        quantityMilli: quantity,
        unitCostMinor: line.unitPriceMinor,
        goodsReceiptId: receipt.id,
        orderLineId: line.id,
        byUserId: tenant.userId,
      });
      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: { receivedMilli: { increment: quantity } },
      });
      line.receivedMilli += quantity;
      // The order's price is what the item now costs (last purchase price).
      if (item.unitCostMinor !== line.unitPriceMinor) {
        await tx.stockItem.update({
          where: { id: item.id },
          data: { unitCostMinor: line.unitPriceMinor },
        });
      }
      received.push({ item: item.code, quantity: l.quantity });
    }
    const done = o.lines.every((l) => l.receivedMilli >= l.quantityMilli);
    await tx.purchaseOrder.update({
      where: { id: o.id },
      data: { status: done ? 'RECEIVED' : 'PARTIAL' },
    });
    await recordAudit(tx, {
      action: 'stock.goods_received',
      entityType: 'goods_receipt',
      entityId: receipt.id,
      after: {
        number,
        order: o.number,
        location: location.code,
        supplierRef: body.supplierRef ?? null,
        received,
      },
    });
    return receiptItem(
      await tx.goodsReceipt.findFirstOrThrow({
        where: { id: receipt.id },
        include: RECEIPT_INCLUDE,
      }),
    );
  });
}
