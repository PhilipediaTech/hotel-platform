import { randomUUID } from 'node:crypto';
import {
  formatQuantity,
  parseQuantity,
  type RequisitionItem,
  type StockItemRow,
  type StockMovementItem,
  type StocktakeDetail,
  type StocktakeSummary,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import { pgErrorInfo } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Inventory (PRD M10-01, M10-02, M10-05; T-145). Stock on hand is never stored: it is the sum
// of stock_movements, which are append-only (M10 rule; AC "on-hand equals the movement sum
// after any sequence of receipts, issues, transfers and adjustments"). Every movement that
// takes stock out locks its item first and checks what the location holds, so concurrent
// issues can't take a location below zero. Quantities are thousandths of the item's unit.

export interface StockDeps {
  tenantDb: TenantDb;
}

export type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
export type Client = TenantDb | Tx;

export const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
  });

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);

export const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Contract quantities are validated by zod; this only narrows the type. */
export function milli(text: string): bigint {
  const q = parseQuantity(text);
  if (q === null) throw new Error(`Unvalidated quantity ${text}`);
  return q;
}
export const qty = (m: bigint) => formatQuantity(m);
const qtyOrNull = (m: bigint | null) => (m === null ? null : formatQuantity(m));

/** Value of `m` thousandths at `costMinor` a unit, rounded half away from zero. */
export function valueMinor(m: bigint, costMinor: bigint): bigint {
  const raw = m * costMinor;
  const abs = raw < 0n ? -raw : raw;
  const rounded = (abs + 500n) / 1000n;
  return raw < 0n ? -rounded : rounded;
}

export const person = (u: { id: string; name: string }) => ({ id: u.id, name: u.name });

// ---------------------------------------------------------------------------------------
// On hand

/** Sum of movements per item and location. */
async function onHandMap(db: Client, where: Prisma.StockMovementWhereInput = {}) {
  const sums = await db.stockMovement.groupBy({
    by: ['itemId', 'locationId'],
    where,
    _sum: { quantityMilli: true },
  });
  const map = new Map<string, Map<string, bigint>>();
  for (const s of sums) {
    const byLoc = map.get(s.itemId) ?? new Map<string, bigint>();
    byLoc.set(s.locationId, s._sum.quantityMilli ?? 0n);
    map.set(s.itemId, byLoc);
  }
  return map;
}

async function onHandAt(tx: Tx, itemId: string, locationId: string): Promise<bigint> {
  const sum = await tx.stockMovement.aggregate({
    where: { itemId, locationId },
    _sum: { quantityMilli: true },
  });
  return sum._sum.quantityMilli ?? 0n;
}

/** Locks the item so no other movement out of it runs until this transaction ends. */
export async function lockItem(tx: Tx, itemId: string, path: string) {
  await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${itemId}::uuid FOR UPDATE`;
  const item = await tx.stockItem.findFirst({ where: { id: itemId }, include: { unit: true } });
  if (!item) throw invalid(path, 'Choose an item of this property');
  return item;
}

export async function activeLocation(db: Client, locationId: string, path: string) {
  const location = await db.stockLocation.findFirst({ where: { id: locationId, active: true } });
  if (!location) throw invalid(path, 'Choose an active location of this property');
  return location;
}

function notEnough(path: string, held: bigint, unit: string, location: string) {
  return invalid(path, `Only ${qty(held)} ${unit} at ${location}`);
}

// ---------------------------------------------------------------------------------------
// Items, units and locations (M10-01)

const ITEM_INCLUDE = { unit: true } as const satisfies Prisma.StockItemInclude;
type ItemRow = Prisma.StockItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

function itemRow(i: ItemRow, byLoc: Map<string, bigint> | undefined): z.input<typeof StockItemRow> {
  const entries = [...(byLoc ?? new Map<string, bigint>()).entries()];
  const onHand = entries.reduce((sum, [, v]) => sum + v, 0n);
  const toPar = i.parMilli !== null && i.parMilli > onHand ? i.parMilli - onHand : null;
  return {
    id: i.id,
    code: i.code,
    name: i.name,
    category: i.category,
    unit: { id: i.unit.id, code: i.unit.code, name: i.unit.name },
    par: qtyOrNull(i.parMilli),
    reorderPoint: qtyOrNull(i.reorderMilli),
    unitCostMinor: i.unitCostMinor.toString(),
    active: i.active,
    onHand: qty(onHand),
    byLocation: entries
      .filter(([, v]) => v !== 0n)
      .map(([locationId, v]) => ({ locationId, onHand: qty(v) })),
    needsReorder: i.active && i.reorderMilli !== null && onHand <= i.reorderMilli,
    toPar: toPar === null ? null : qty(toPar),
  };
}

async function itemView(db: Client, itemId: string) {
  const item = await db.stockItem.findFirstOrThrow({
    where: { id: itemId },
    include: ITEM_INCLUDE,
  });
  const map = await onHandMap(db, { itemId });
  return itemRow(item, map.get(itemId));
}

const unitItem = (u: { id: string; code: string; name: string; active: boolean }) => ({
  id: u.id,
  code: u.code,
  name: u.name,
  active: u.active,
});

export async function listStockItems(deps: StockDeps, tenant: TenantContext) {
  const db = deps.tenantDb;
  const [items, units, locations, property, map] = await Promise.all([
    db.stockItem.findMany({ include: ITEM_INCLUDE, orderBy: [{ name: 'asc' }, { code: 'asc' }] }),
    db.stockUnit.findMany({ orderBy: { code: 'asc' } }),
    db.stockLocation.findMany({ orderBy: { name: 'asc' } }),
    db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } }),
    onHandMap(db),
  ]);
  return {
    items: items.map((i) => itemRow(i, map.get(i.id))),
    units: units.map(unitItem),
    locations: locations.map(unitItem),
    currency: property.baseCurrency,
  };
}

async function activeUnit(db: Client, unitId: string) {
  const unit = await db.stockUnit.findFirst({ where: { id: unitId, active: true } });
  if (!unit) throw invalid('body.unitId', 'Choose an active unit of this property');
  return unit;
}

function checkLevels(par: bigint | null, reorder: bigint | null) {
  if (par !== null && reorder !== null && reorder > par) {
    throw invalid('body.reorderPoint', 'The reorder point can’t be above the par level');
  }
}

const levelOrNull = (v: string | null) => (v === null ? null : milli(v));

interface ItemBody {
  code: string;
  name: string;
  category: string | null;
  unitId: string;
  par: string | null;
  reorderPoint: string | null;
  unitCostMinor: string;
}

export async function createStockItem(deps: StockDeps, body: ItemBody) {
  return deps.tenantDb.$transaction(async (tx) => {
    if (await tx.stockItem.findFirst({ where: { code: body.code } })) {
      throw invalid('body.code', `${body.code} is already an item here`);
    }
    await activeUnit(tx, body.unitId);
    const par = levelOrNull(body.par);
    const reorder = levelOrNull(body.reorderPoint);
    checkLevels(par, reorder);
    const item = await tx.stockItem.create({
      data: {
        code: body.code,
        name: body.name,
        category: body.category,
        unitId: body.unitId,
        parMilli: par,
        reorderMilli: reorder,
        unitCostMinor: BigInt(body.unitCostMinor),
      } as unknown as Prisma.StockItemUncheckedCreateInput,
    });
    await recordAudit(tx, {
      action: 'stock.item_created',
      entityType: 'stock_item',
      entityId: item.id,
      after: body,
    });
    return itemView(tx, item.id);
  });
}

export async function updateStockItem(
  deps: StockDeps,
  itemId: string,
  body: Partial<Omit<ItemBody, 'code'>> & { active?: boolean | undefined },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.stockItem.findFirst({ where: { id: itemId } });
    if (!before) throw notFound('Item');
    if (body.unitId !== undefined && body.unitId !== before.unitId) {
      await activeUnit(tx, body.unitId);
    }
    const par = body.par === undefined ? before.parMilli : levelOrNull(body.par);
    const reorder =
      body.reorderPoint === undefined ? before.reorderMilli : levelOrNull(body.reorderPoint);
    checkLevels(par, reorder);
    await tx.stockItem.update({
      where: { id: itemId },
      data: defined({
        name: body.name,
        category: body.category,
        unitId: body.unitId,
        parMilli: body.par === undefined ? undefined : par,
        reorderMilli: body.reorderPoint === undefined ? undefined : reorder,
        unitCostMinor: body.unitCostMinor === undefined ? undefined : BigInt(body.unitCostMinor),
        active: body.active,
      }),
    });
    await recordAudit(tx, {
      action: 'stock.item_updated',
      entityType: 'stock_item',
      entityId: itemId,
      before: {
        name: before.name,
        category: before.category,
        unitId: before.unitId,
        par: qtyOrNull(before.parMilli),
        reorderPoint: qtyOrNull(before.reorderMilli),
        unitCostMinor: before.unitCostMinor.toString(),
        active: before.active,
      },
      after: body,
    });
    return itemView(tx, itemId);
  });
}

type NamedModel = 'stockUnit' | 'stockLocation';

async function createNamed(
  deps: StockDeps,
  model: NamedModel,
  body: { code: string; name: string },
) {
  const label = model === 'stockUnit' ? 'unit' : 'location';
  return deps.tenantDb.$transaction(async (tx) => {
    const delegate = tx[model] as unknown as {
      findFirst(a: object): Promise<unknown>;
      create(a: object): Promise<{ id: string; code: string; name: string; active: boolean }>;
    };
    if (await delegate.findFirst({ where: { code: body.code } })) {
      throw invalid('body.code', `${body.code} is already a ${label} here`);
    }
    const row = await delegate.create({ data: { code: body.code, name: body.name } });
    await recordAudit(tx, {
      action: `stock.${label}_created`,
      entityType: `stock_${label}`,
      entityId: row.id,
      after: body,
    });
    return unitItem(row);
  });
}

async function updateNamed(
  deps: StockDeps,
  model: NamedModel,
  id: string,
  body: { name?: string | undefined; active?: boolean | undefined },
) {
  const label = model === 'stockUnit' ? 'unit' : 'location';
  return deps.tenantDb.$transaction(async (tx) => {
    const delegate = tx[model] as unknown as {
      findFirst(a: object): Promise<{ name: string; active: boolean } | null>;
      update(a: object): Promise<{ id: string; code: string; name: string; active: boolean }>;
    };
    const before = await delegate.findFirst({ where: { id } });
    if (!before) throw notFound(label === 'unit' ? 'Unit' : 'Location');
    const row = await delegate.update({ where: { id }, data: defined(body) });
    await recordAudit(tx, {
      action: `stock.${label}_updated`,
      entityType: `stock_${label}`,
      entityId: id,
      before: { name: before.name, active: before.active },
      after: body,
    });
    return unitItem(row);
  });
}

export const createStockUnit = (deps: StockDeps, body: { code: string; name: string }) =>
  createNamed(deps, 'stockUnit', body);
export const updateStockUnit = (
  deps: StockDeps,
  id: string,
  body: { name?: string | undefined; active?: boolean | undefined },
) => updateNamed(deps, 'stockUnit', id, body);
export const createStockLocation = (deps: StockDeps, body: { code: string; name: string }) =>
  createNamed(deps, 'stockLocation', body);
export const updateStockLocation = (
  deps: StockDeps,
  id: string,
  body: { name?: string | undefined; active?: boolean | undefined },
) => updateNamed(deps, 'stockLocation', id, body);

// ---------------------------------------------------------------------------------------
// Movements

const MOVEMENT_INCLUDE = {
  item: { include: { unit: true } },
  location: true,
  by: { select: { id: true, name: true } },
  requestedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  requisition: { select: { number: true } },
  stocktake: { select: { number: true } },
  goodsReceipt: { select: { number: true } },
  posOrderLine: { select: { order: { select: { number: true } } } },
} as const satisfies Prisma.StockMovementInclude;
type MovementRow = Prisma.StockMovementGetPayload<{ include: typeof MOVEMENT_INCLUDE }>;

function movementItem(m: MovementRow): z.input<typeof StockMovementItem> {
  return {
    id: m.id,
    at: m.at.toISOString(),
    kind: m.kind,
    item: { id: m.item.id, code: m.item.code, name: m.item.name, unit: m.item.unit.code },
    location: { id: m.location.id, code: m.location.code, name: m.location.name },
    quantity: qty(m.quantityMilli),
    unitCostMinor: m.unitCostMinor.toString(),
    reason: m.reason,
    by: person(m.by),
    requestedBy: m.requestedBy ? person(m.requestedBy) : null,
    approvedBy: m.approvedBy ? person(m.approvedBy) : null,
    requisitionNumber: m.requisition?.number ?? null,
    stocktakeNumber: m.stocktake?.number ?? null,
    receiptNumber: m.goodsReceipt?.number ?? null,
    posOrderNumber: m.posOrderLine?.order.number ?? null,
  };
}

const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function listStockMovements(
  deps: StockDeps,
  query: {
    limit: number;
    cursor?: string | undefined;
    itemId?: string | undefined;
    locationId?: string | undefined;
  },
) {
  const offset = decodeCursor(query.cursor);
  const rows = await deps.tenantDb.stockMovement.findMany({
    where: defined({ itemId: query.itemId, locationId: query.locationId }),
    include: MOVEMENT_INCLUDE,
    orderBy: [{ at: 'desc' }, { id: 'asc' }],
    skip: offset,
    take: query.limit + 1,
  });
  return {
    data: rows.slice(0, query.limit).map(movementItem),
    nextCursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
  };
}

export async function writeMovement(
  tx: Tx,
  data: Omit<Prisma.StockMovementUncheckedCreateInput, 'propertyId'>,
): Promise<MovementRow> {
  const m = await tx.stockMovement.create({
    data: data as Prisma.StockMovementUncheckedCreateInput,
    include: MOVEMENT_INCLUDE,
  });
  return m;
}

export async function adjustStock(
  deps: StockDeps,
  tenant: TenantContext,
  body: { itemId: string; locationId: string; quantity: string; reason: string },
) {
  const quantity = milli(body.quantity);
  return deps.tenantDb.$transaction(async (tx) => {
    const item = await lockItem(tx, body.itemId, 'body.itemId');
    const location = await activeLocation(tx, body.locationId, 'body.locationId');
    if (quantity < 0n) {
      const held = await onHandAt(tx, item.id, location.id);
      if (held + quantity < 0n)
        throw notEnough('body.quantity', held, item.unit.code, location.name);
    }
    const m = await writeMovement(tx, {
      itemId: item.id,
      locationId: location.id,
      kind: 'ADJUSTMENT',
      quantityMilli: quantity,
      unitCostMinor: item.unitCostMinor,
      reason: body.reason,
      byUserId: tenant.userId,
    });
    await recordAudit(tx, {
      action: 'stock.adjusted',
      entityType: 'stock_item',
      entityId: item.id,
      after: { location: location.code, quantity: body.quantity },
      reason: body.reason,
    });
    return movementItem(m);
  });
}

export async function transferStock(
  deps: StockDeps,
  tenant: TenantContext,
  body: {
    itemId: string;
    fromLocationId: string;
    toLocationId: string;
    quantity: string;
    reason?: string | null | undefined;
  },
) {
  const quantity = milli(body.quantity);
  return deps.tenantDb.$transaction(async (tx) => {
    const item = await lockItem(tx, body.itemId, 'body.itemId');
    const from = await activeLocation(tx, body.fromLocationId, 'body.fromLocationId');
    const to = await activeLocation(tx, body.toLocationId, 'body.toLocationId');
    const held = await onHandAt(tx, item.id, from.id);
    if (held < quantity) throw notEnough('body.quantity', held, item.unit.code, from.name);
    const transferId = randomUUID();
    const common = {
      itemId: item.id,
      kind: 'TRANSFER' as const,
      unitCostMinor: item.unitCostMinor,
      reason: body.reason ?? null,
      transferId,
      byUserId: tenant.userId,
    };
    const out = await writeMovement(tx, {
      ...common,
      locationId: from.id,
      quantityMilli: -quantity,
    });
    const inn = await writeMovement(tx, { ...common, locationId: to.id, quantityMilli: quantity });
    await recordAudit(tx, {
      action: 'stock.transferred',
      entityType: 'stock_item',
      entityId: item.id,
      after: { from: from.code, to: to.code, quantity: body.quantity, transferId },
      reason: body.reason ?? undefined,
    });
    return { out: movementItem(out), in: movementItem(inn) };
  });
}

// ---------------------------------------------------------------------------------------
// Requisitions (M10-02)

const REQUISITION_INCLUDE = {
  department: { select: { id: true, code: true, name: true } },
  requestedBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
  lines: { include: { item: { include: { unit: true } } }, orderBy: { item: { name: 'asc' } } },
} as const satisfies Prisma.RequisitionInclude;
type RequisitionRow = Prisma.RequisitionGetPayload<{ include: typeof REQUISITION_INCLUDE }>;

function requisitionItem(r: RequisitionRow, userId: string): z.input<typeof RequisitionItem> {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    department: r.department,
    requestedBy: person(r.requestedBy),
    mine: r.requestedById === userId,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    closedBy: r.closedBy ? person(r.closedBy) : null,
    closedAt: r.closedAt?.toISOString() ?? null,
    closeReason: r.closeReason,
    lines: r.lines.map((l) => ({
      id: l.id,
      item: { id: l.item.id, code: l.item.code, name: l.item.name, unit: l.item.unit.code },
      quantity: qty(l.quantityMilli),
      issued: qty(l.issuedMilli),
    })),
  };
}

async function requisitionView(db: Client, id: string, userId: string) {
  return requisitionItem(
    await db.requisition.findFirstOrThrow({ where: { id }, include: REQUISITION_INCLUDE }),
    userId,
  );
}

export async function listRequisitions(
  deps: StockDeps,
  tenant: TenantContext,
  query: { status?: z.infer<typeof RequisitionItem>['status'] | undefined },
) {
  const [rows, departments] = await Promise.all([
    deps.tenantDb.requisition.findMany({
      where: defined({ status: query.status }),
      include: REQUISITION_INCLUDE,
      orderBy: { number: 'desc' },
      take: 200,
    }),
    deps.tenantDb.department.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  return { data: rows.map((r) => requisitionItem(r, tenant.userId)), departments };
}

export async function createRequisition(
  deps: StockDeps,
  tenant: TenantContext,
  body: {
    departmentId: string;
    note?: string | null | undefined;
    lines: { itemId: string; quantity: string }[];
  },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const department = await tx.department.findFirst({ where: { id: body.departmentId } });
    if (!department) throw invalid('body.departmentId', 'Choose a department of this property');
    const ids = body.lines.map((l) => l.itemId);
    const items = await tx.stockItem.findMany({ where: { id: { in: ids }, active: true } });
    body.lines.forEach((l, i) => {
      if (!items.some((it) => it.id === l.itemId)) {
        throw invalid(`body.lines.${i}.itemId`, 'Choose an active item of this property');
      }
    });
    const number = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.REQUISITION);
    const requisition = await tx.requisition.create({
      data: {
        number,
        departmentId: department.id,
        requestedById: tenant.userId,
        note: body.note ?? null,
      } as unknown as Prisma.RequisitionUncheckedCreateInput,
    });
    await tx.requisitionLine.createMany({
      data: body.lines.map((l) => ({
        requisitionId: requisition.id,
        itemId: l.itemId,
        quantityMilli: milli(l.quantity),
      })) as unknown as Prisma.RequisitionLineCreateManyInput[],
    });
    await recordAudit(tx, {
      action: 'stock.requisition_raised',
      entityType: 'requisition',
      entityId: requisition.id,
      after: { number, department: department.code, lines: body.lines },
    });
    return requisitionView(tx, requisition.id, tenant.userId);
  });
}

async function lockRequisition(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM requisitions WHERE id = ${id}::uuid FOR UPDATE`;
  const r = await tx.requisition.findFirst({ where: { id }, include: { lines: true } });
  if (!r) throw notFound('Requisition');
  return r;
}

const OPEN_REQUISITION = new Set(['SUBMITTED', 'PARTIAL']);

export async function cancelRequisition(deps: StockDeps, tenant: TenantContext, id: string) {
  return deps.tenantDb.$transaction(async (tx) => {
    const r = await lockRequisition(tx, id);
    if (r.requestedById !== tenant.userId) {
      throw new AppError('FORBIDDEN', 'Only the person who raised a requisition can withdraw it');
    }
    if (r.status !== 'SUBMITTED') {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'Stock has already been issued or the requisition is closed',
      );
    }
    await tx.requisition.update({
      where: { id },
      data: { status: 'CANCELLED', closedById: tenant.userId, closedAt: new Date() },
    });
    await recordAudit(tx, {
      action: 'stock.requisition_cancelled',
      entityType: 'requisition',
      entityId: id,
      after: { number: r.number },
    });
    return requisitionView(tx, id, tenant.userId);
  });
}

export async function issueRequisition(
  deps: StockDeps,
  tenant: TenantContext,
  id: string,
  body: { locationId: string; lines: { lineId: string; quantity: string }[] },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const r = await lockRequisition(tx, id);
    if (!OPEN_REQUISITION.has(r.status)) {
      throw new AppError('STATE_TRANSITION_INVALID', 'This requisition is no longer open');
    }
    // M10 rule: every issue has a requester and an approver; the store keeper who issues
    // approves it, so it can't be the person who asked.
    if (r.requestedById === tenant.userId) {
      throw new AppError(
        'FORBIDDEN',
        'You raised this requisition: another store keeper issues it',
      );
    }
    const location = await activeLocation(tx, body.locationId, 'body.locationId');
    // Lock items in a fixed order so two issues can't deadlock each other.
    const wanted = body.lines
      .map((l, i) => ({ ...l, i, line: r.lines.find((x) => x.id === l.lineId) }))
      .sort((a, b) => (a.line?.itemId ?? '').localeCompare(b.line?.itemId ?? ''));
    const issued: { item: string; quantity: string }[] = [];
    for (const w of wanted) {
      const path = `body.lines.${w.i}`;
      if (!w.line) throw invalid(`${path}.lineId`, 'Not a line of this requisition');
      const quantity = milli(w.quantity);
      const left = w.line.quantityMilli - w.line.issuedMilli;
      if (quantity > left) {
        throw invalid(`${path}.quantity`, `Only ${qty(left)} still asked for`);
      }
      const item = await lockItem(tx, w.line.itemId, `${path}.lineId`);
      const held = await onHandAt(tx, item.id, location.id);
      if (held < quantity) throw notEnough(`${path}.quantity`, held, item.unit.code, location.name);
      await writeMovement(tx, {
        itemId: item.id,
        locationId: location.id,
        kind: 'ISSUE',
        quantityMilli: -quantity,
        unitCostMinor: item.unitCostMinor,
        requisitionId: r.id,
        requisitionLineId: w.line.id,
        byUserId: tenant.userId,
        requestedById: r.requestedById,
        approvedById: tenant.userId,
      });
      await tx.requisitionLine.update({
        where: { id: w.line.id },
        data: { issuedMilli: { increment: quantity } },
      });
      w.line.issuedMilli += quantity;
      issued.push({ item: item.code, quantity: w.quantity });
    }
    const done = r.lines.every((l) => l.issuedMilli >= l.quantityMilli);
    await tx.requisition.update({ where: { id }, data: { status: done ? 'ISSUED' : 'PARTIAL' } });
    await recordAudit(tx, {
      action: 'stock.issued',
      entityType: 'requisition',
      entityId: id,
      after: {
        number: r.number,
        location: location.code,
        issued,
        status: done ? 'ISSUED' : 'PARTIAL',
      },
    });
    return requisitionView(tx, id, tenant.userId);
  });
}

export async function closeRequisition(
  deps: StockDeps,
  tenant: TenantContext,
  id: string,
  body: { reason: string },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const r = await lockRequisition(tx, id);
    if (!OPEN_REQUISITION.has(r.status)) {
      throw new AppError('STATE_TRANSITION_INVALID', 'This requisition is no longer open');
    }
    await tx.requisition.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedById: tenant.userId,
        closedAt: new Date(),
        closeReason: body.reason,
      },
    });
    await recordAudit(tx, {
      action: 'stock.requisition_closed',
      entityType: 'requisition',
      entityId: id,
      after: { number: r.number, was: r.status },
      reason: body.reason,
    });
    return requisitionView(tx, id, tenant.userId);
  });
}

// ---------------------------------------------------------------------------------------
// Stocktakes (M10-05)

const STOCKTAKE_INCLUDE = {
  location: { select: { id: true, code: true, name: true } },
  startedBy: { select: { id: true, name: true } },
  postedBy: { select: { id: true, name: true } },
  lines: { include: { item: { include: { unit: true } } }, orderBy: { item: { name: 'asc' } } },
} as const satisfies Prisma.StocktakeInclude;
type StocktakeRow = Prisma.StocktakeGetPayload<{ include: typeof STOCKTAKE_INCLUDE }>;

function lineVariance(l: StocktakeRow['lines'][number]) {
  if (l.countedMilli === null || l.expectedMilli === null) return null;
  return l.countedMilli - l.expectedMilli;
}

function stocktakeSummary(s: StocktakeRow): z.input<typeof StocktakeSummary> {
  const posted = s.status === 'POSTED';
  const value = s.lines.reduce((sum, l) => {
    const v = lineVariance(l);
    return v === null ? sum : sum + valueMinor(v, l.item.unitCostMinor);
  }, 0n);
  return {
    id: s.id,
    number: s.number,
    status: s.status,
    location: s.location,
    startedBy: person(s.startedBy),
    startedAt: s.startedAt.toISOString(),
    postedBy: s.postedBy ? person(s.postedBy) : null,
    postedAt: s.postedAt?.toISOString() ?? null,
    reason: s.reason,
    counted: s.lines.filter((l) => l.countedMilli !== null).length,
    lineCount: s.lines.length,
    varianceMinor: posted ? value.toString() : null,
  };
}

function stocktakeDetail(s: StocktakeRow): z.input<typeof StocktakeDetail> {
  const posted = s.status === 'POSTED';
  return {
    ...stocktakeSummary(s),
    lines: s.lines.map((l) => {
      const v = posted ? lineVariance(l) : null;
      return {
        item: { id: l.item.id, code: l.item.code, name: l.item.name, unit: l.item.unit.code },
        counted: qtyOrNull(l.countedMilli),
        // A blind count: what the books expect stays hidden until the stocktake is posted.
        expected: posted ? qtyOrNull(l.expectedMilli) : null,
        variance: v === null ? null : qty(v),
        varianceMinor: v === null ? null : valueMinor(v, l.item.unitCostMinor).toString(),
      };
    }),
  };
}

async function stocktakeView(db: Client, id: string) {
  return stocktakeDetail(
    await db.stocktake.findFirstOrThrow({ where: { id }, include: STOCKTAKE_INCLUDE }),
  );
}

export async function listStocktakes(deps: StockDeps) {
  const rows = await deps.tenantDb.stocktake.findMany({
    include: STOCKTAKE_INCLUDE,
    orderBy: { number: 'desc' },
    take: 100,
  });
  return { data: rows.map(stocktakeSummary) };
}

export async function getStocktake(deps: StockDeps, id: string) {
  const s = await deps.tenantDb.stocktake.findFirst({ where: { id }, include: STOCKTAKE_INCLUDE });
  if (!s) throw notFound('Stocktake');
  return stocktakeDetail(s);
}

export async function startStocktake(
  deps: StockDeps,
  tenant: TenantContext,
  body: { locationId: string },
) {
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const location = await activeLocation(tx, body.locationId, 'body.locationId');
      const number = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.STOCKTAKE);
      const stocktake = await tx.stocktake.create({
        data: {
          number,
          locationId: location.id,
          startedById: tenant.userId,
        } as unknown as Prisma.StocktakeUncheckedCreateInput,
      });
      const items = await tx.stockItem.findMany({ where: { active: true }, select: { id: true } });
      if (items.length > 0) {
        await tx.stocktakeLine.createMany({
          data: items.map((i) => ({
            stocktakeId: stocktake.id,
            itemId: i.id,
          })) as unknown as Prisma.StocktakeLineCreateManyInput[],
        });
      }
      await recordAudit(tx, {
        action: 'stock.stocktake_started',
        entityType: 'stocktake',
        entityId: stocktake.id,
        after: { number, location: location.code },
      });
      return stocktakeView(tx, stocktake.id);
    });
  } catch (err) {
    if (pgErrorInfo(err)?.constraint === 'stocktakes_one_counting') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This location is already being counted');
    }
    throw err;
  }
}

async function lockCounting(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM stocktakes WHERE id = ${id}::uuid FOR UPDATE`;
  const s = await tx.stocktake.findFirst({ where: { id }, include: { lines: true } });
  if (!s) throw notFound('Stocktake');
  if (s.status !== 'COUNTING') {
    throw new AppError('STATE_TRANSITION_INVALID', 'This stocktake is no longer being counted');
  }
  return s;
}

export async function recordStocktakeCounts(
  deps: StockDeps,
  tenant: TenantContext,
  id: string,
  body: { counts: { itemId: string; counted: string | null }[] },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const s = await lockCounting(tx, id);
    const now = new Date();
    for (const [i, c] of body.counts.entries()) {
      const counted = c.counted === null ? null : milli(c.counted);
      const data = {
        countedMilli: counted,
        countedById: counted === null ? null : tenant.userId,
        countedAt: counted === null ? null : now,
      };
      const line = s.lines.find((l) => l.itemId === c.itemId);
      if (line) {
        await tx.stocktakeLine.update({ where: { id: line.id }, data });
        continue;
      }
      // An item added after the count started can still be counted.
      const item = await tx.stockItem.findFirst({ where: { id: c.itemId, active: true } });
      if (!item) throw invalid(`body.counts.${i}.itemId`, 'Choose an active item of this property');
      await tx.stocktakeLine.create({
        data: {
          stocktakeId: id,
          itemId: item.id,
          ...data,
        } as unknown as Prisma.StocktakeLineUncheckedCreateInput,
      });
    }
    return stocktakeView(tx, id);
  });
}

export async function postStocktake(
  deps: StockDeps,
  tenant: TenantContext,
  id: string,
  body: { reason?: string | null | undefined },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const s = await lockCounting(tx, id);
    const counted = s.lines
      .filter((l) => l.countedMilli !== null)
      .sort((a, b) => a.itemId.localeCompare(b.itemId));
    // The books at posting time, with each item locked so nothing moves meanwhile.
    const results: {
      lineId: string;
      itemId: string;
      expected: bigint;
      variance: bigint;
      cost: bigint;
    }[] = [];
    for (const l of counted) {
      const item = await lockItem(tx, l.itemId, 'stocktake');
      const expected = await onHandAt(tx, l.itemId, s.locationId);
      results.push({
        lineId: l.id,
        itemId: l.itemId,
        expected,
        variance: (l.countedMilli ?? 0n) - expected,
        cost: item.unitCostMinor,
      });
    }
    const differs = results.filter((r) => r.variance !== 0n);
    const reason = body.reason ?? null;
    if (differs.length > 0 && !reason) {
      throw invalid('body.reason', 'Give a reason for the differences');
    }
    for (const r of results) {
      await tx.stocktakeLine.update({
        where: { id: r.lineId },
        data: { expectedMilli: r.expected },
      });
    }
    for (const r of differs) {
      // AC: a stocktake variance posts an adjustment movement with its reason.
      await writeMovement(tx, {
        itemId: r.itemId,
        locationId: s.locationId,
        kind: 'ADJUSTMENT',
        quantityMilli: r.variance,
        unitCostMinor: r.cost,
        reason: `Stocktake ${s.number}: ${reason ?? ''}`.slice(0, 500),
        stocktakeId: s.id,
        byUserId: tenant.userId,
      });
    }
    await tx.stocktake.update({
      where: { id },
      data: { status: 'POSTED', postedById: tenant.userId, postedAt: new Date(), reason },
    });
    await recordAudit(tx, {
      action: 'stock.stocktake_posted',
      entityType: 'stocktake',
      entityId: id,
      after: {
        number: s.number,
        counted: results.length,
        adjusted: differs.length,
        varianceMinor: differs
          .reduce((sum, r) => sum + valueMinor(r.variance, r.cost), 0n)
          .toString(),
      },
      reason: reason ?? undefined,
    });
    return stocktakeView(tx, id);
  });
}

export async function cancelStocktake(deps: StockDeps, id: string) {
  return deps.tenantDb.$transaction(async (tx) => {
    const s = await lockCounting(tx, id);
    await tx.stocktake.update({ where: { id }, data: { status: 'CANCELLED' } });
    await recordAudit(tx, {
      action: 'stock.stocktake_cancelled',
      entityType: 'stocktake',
      entityId: id,
      after: { number: s.number },
    });
    return stocktakeView(tx, id);
  });
}
