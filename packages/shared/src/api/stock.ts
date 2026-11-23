import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, page, PageQuery, Uuid } from './primitives.ts';

// Inventory (PRD M10-01 "As a store keeper, I manage items, units, locations, par levels and
// reorder points", stock.manage; M10-02 "As a department, I raise a requisition; the store
// keeper issues against it", stock.requisition; M10-05 "As a store keeper, I run stocktakes
// and see variance by item and location", stock.count; T-145). Tab 4 names /stock-items,
// /stock-movements, /requisitions and /stocktakes; the routes are designed here.
//
// Rules: stock on hand is the sum of movements, never edited; every issue has a requester and
// an approver (the store keeper who issues, never the requester); a stocktake's variance
// posts an adjustment movement with its reason.
//
// Quantities travel as decimal strings in the item's unit, with up to 3 decimals ("1.5" kg).
// The database keeps thousandths of the unit.

const MAX_MILLI = 999_999_999_999n;

/** A quantity in thousandths of its unit, from "12", "1.5" or "-0.25" (null if invalid). */
export function parseQuantity(text: string): bigint | null {
  const m = /^(-?)(\d{1,9})(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  const milli = BigInt(m[2] ?? '0') * 1000n + BigInt((m[3] ?? '').padEnd(3, '0') || '0');
  return m[1] === '-' ? -milli : milli;
}

/** Thousandths of a unit as a decimal string without trailing zeros: 1500n → "1.5". */
export function formatQuantity(milli: bigint): string {
  const sign = milli < 0n ? '-' : '';
  const abs = milli < 0n ? -milli : milli;
  const whole = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}

export const Quantity = z
  .string()
  .regex(/^-?\d{1,9}(\.\d{1,3})?$/, 'A number with up to 3 decimals')
  .meta({ id: 'Quantity', example: '1.5' });
const Positive = Quantity.refine((v) => (parseQuantity(v) ?? 0n) > 0n, 'More than zero');
const ZeroOrMore = Quantity.refine((v) => (parseQuantity(v) ?? -1n) >= 0n, 'Zero or more');
const NonZero = Quantity.refine((v) => {
  const q = parseQuantity(v) ?? 0n;
  return q !== 0n && q <= MAX_MILLI && q >= -MAX_MILLI;
}, 'Not zero');
const Cost = AmountMinor.refine((v) => /^\d+$/.test(v), 'Zero or more');
const Reason = z.string().trim().min(1, 'Give a reason').max(500);
const Name = (max: number) => z.string().trim().min(1).max(max);
const Code = (min: number, max: number) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(new RegExp(`^[A-Z0-9-]{${min},${max}}$`), `${min} to ${max} letters, digits or dashes`);
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();
const Person = z.object({ id: Uuid, name: z.string() });

// ---------------------------------------------------------------------------------------
// Items, units and locations (M10-01)

export const StockUnitItem = z
  .object({ id: Uuid, code: z.string(), name: z.string(), active: z.boolean() })
  .meta({ id: 'StockUnit' });

export const StockLocationItem = z
  .object({ id: Uuid, code: z.string(), name: z.string(), active: z.boolean() })
  .meta({ id: 'StockLocation' });

export const StockItemRow = z
  .object({
    id: Uuid,
    code: z.string(),
    name: z.string(),
    category: z.string().nullable(),
    unit: z.object({ id: Uuid, code: z.string(), name: z.string() }),
    par: Quantity.nullable(),
    reorderPoint: Quantity.nullable(),
    unitCostMinor: AmountMinor,
    active: z.boolean(),
    /** Sum of every movement, all locations. */
    onHand: Quantity,
    byLocation: z.array(z.object({ locationId: Uuid, onHand: Quantity })),
    /** On hand is at or below the reorder point. */
    needsReorder: z.boolean(),
    /** What brings it back up to par (null without a par level, or when at par). */
    toPar: Quantity.nullable(),
  })
  .meta({ id: 'StockItem' });

const StockSetup = z.object({
  items: z.array(StockItemRow),
  units: z.array(StockUnitItem),
  locations: z.array(StockLocationItem),
  currency: z.string(),
});

const MANAGE = { tags: ['Stock'], propertyScoped: true as const, permission: 'stock.manage' };
const ADDED = 'Tab 4 names the resource; the route is designed in T-145.';

export const listStockItems = defineRoute({
  tags: ['Stock'],
  propertyScoped: true,
  // Requisitions pick from this list, so a department that requests stock can read it.
  permission: 'stock.requisition',
  operationId: 'listStockItems',
  method: 'get',
  path: '/stock-items',
  summary: 'Items with stock on hand by location, units and locations (M10-01)',
  description: ADDED,
  response: StockSetup,
});

const ItemFields = {
  name: Name(120),
  category: OptionalText(60),
  unitId: Uuid,
  par: ZeroOrMore.nullable(),
  reorderPoint: ZeroOrMore.nullable(),
  unitCostMinor: Cost,
};

export const createStockItem = defineRoute({
  ...MANAGE,
  operationId: 'createStockItem',
  method: 'post',
  path: '/stock-items',
  summary: 'Add a stock item (M10-01)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: z.object({ code: Code(2, 20), ...ItemFields }),
  response: StockItemRow,
});

export const updateStockItem = defineRoute({
  ...MANAGE,
  operationId: 'updateStockItem',
  method: 'patch',
  path: '/stock-items/{itemId}',
  summary: 'Change an item, its levels or cost, or switch it off (M10-01)',
  description: ADDED,
  params: z.object({ itemId: Uuid }),
  body: z.object({
    name: ItemFields.name.optional(),
    category: ItemFields.category.optional(),
    unitId: Uuid.optional(),
    par: ItemFields.par.optional(),
    reorderPoint: ItemFields.reorderPoint.optional(),
    unitCostMinor: Cost.optional(),
    active: z.boolean().optional(),
  }),
  response: StockItemRow,
});

export const createStockUnit = defineRoute({
  ...MANAGE,
  operationId: 'createStockUnit',
  method: 'post',
  path: '/stock-units',
  summary: 'Add a unit of measure (M10-01)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: z.object({ code: Code(1, 12), name: Name(40) }),
  response: StockUnitItem,
});

export const updateStockUnit = defineRoute({
  ...MANAGE,
  operationId: 'updateStockUnit',
  method: 'patch',
  path: '/stock-units/{unitId}',
  summary: 'Rename a unit, or switch it off (M10-01)',
  description: ADDED,
  params: z.object({ unitId: Uuid }),
  body: z.object({ name: Name(40).optional(), active: z.boolean().optional() }),
  response: StockUnitItem,
});

export const createStockLocation = defineRoute({
  ...MANAGE,
  operationId: 'createStockLocation',
  method: 'post',
  path: '/stock-locations',
  summary: 'Add a store location (M10-01)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: z.object({ code: Code(2, 12), name: Name(80) }),
  response: StockLocationItem,
});

export const updateStockLocation = defineRoute({
  ...MANAGE,
  operationId: 'updateStockLocation',
  method: 'patch',
  path: '/stock-locations/{locationId}',
  summary: 'Rename a location, or switch it off (M10-01)',
  description: ADDED,
  params: z.object({ locationId: Uuid }),
  body: z.object({ name: Name(80).optional(), active: z.boolean().optional() }),
  response: StockLocationItem,
});

// ---------------------------------------------------------------------------------------
// Movements: the ledger, adjustments and transfers

export const StockMovementKind = z.enum(['RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT']);

export const StockMovementItem = z
  .object({
    id: Uuid,
    at: Instant,
    kind: StockMovementKind,
    item: z.object({ id: Uuid, code: z.string(), name: z.string(), unit: z.string() }),
    location: z.object({ id: Uuid, code: z.string(), name: z.string() }),
    /** Signed: in is positive, out negative. */
    quantity: Quantity,
    unitCostMinor: AmountMinor,
    reason: z.string().nullable(),
    by: Person,
    requestedBy: Person.nullable(),
    approvedBy: Person.nullable(),
    requisitionNumber: z.number().int().nullable(),
    stocktakeNumber: z.number().int().nullable(),
  })
  .meta({ id: 'StockMovement' });

export const listStockMovements = defineRoute({
  ...MANAGE,
  operationId: 'listStockMovements',
  method: 'get',
  path: '/stock-movements',
  summary: 'The stock ledger, newest first, by item or location (M10-01)',
  description: ADDED,
  query: PageQuery.extend({ itemId: Uuid.optional(), locationId: Uuid.optional() }),
  response: page(StockMovementItem),
});

export const adjustStock = defineRoute({
  ...MANAGE,
  operationId: 'adjustStock',
  method: 'post',
  path: '/stock-movements/adjustments',
  summary: 'Adjust stock with a reason: opening stock, breakage, spoilage (M10 rule)',
  description: `${ADDED} Stock is never edited: this adds an ADJUSTMENT movement. It may not take the location below zero.`,
  idempotent: true,
  status: 201,
  body: z.object({ itemId: Uuid, locationId: Uuid, quantity: NonZero, reason: Reason }),
  response: StockMovementItem,
});

export const transferStock = defineRoute({
  ...MANAGE,
  operationId: 'transferStock',
  method: 'post',
  path: '/stock-movements/transfers',
  summary: 'Move stock from one location to another',
  description: `${ADDED} Two TRANSFER movements sharing one transfer ID; never more than the source holds.`,
  idempotent: true,
  status: 201,
  body: z
    .object({
      itemId: Uuid,
      fromLocationId: Uuid,
      toLocationId: Uuid,
      quantity: Positive,
      reason: OptionalText(500).optional(),
    })
    .refine((b) => b.fromLocationId !== b.toLocationId, {
      path: ['toLocationId'],
      message: 'Choose a different location',
    }),
  response: z.object({ out: StockMovementItem, in: StockMovementItem }),
});

// ---------------------------------------------------------------------------------------
// Requisitions (M10-02)

export const RequisitionStatus = z.enum(['SUBMITTED', 'PARTIAL', 'ISSUED', 'CLOSED', 'CANCELLED']);

export const RequisitionItem = z
  .object({
    id: Uuid,
    number: z.number().int(),
    status: RequisitionStatus,
    department: z.object({ id: Uuid, code: z.string(), name: z.string() }),
    requestedBy: Person,
    /** The caller raised it: they may withdraw it, and may not issue it. */
    mine: z.boolean(),
    note: z.string().nullable(),
    createdAt: Instant,
    closedBy: Person.nullable(),
    closedAt: Instant.nullable(),
    closeReason: z.string().nullable(),
    lines: z.array(
      z.object({
        id: Uuid,
        item: z.object({ id: Uuid, code: z.string(), name: z.string(), unit: z.string() }),
        quantity: Quantity,
        issued: Quantity,
      }),
    ),
  })
  .meta({ id: 'Requisition' });

const REQUEST = { tags: ['Stock'], propertyScoped: true as const, permission: 'stock.requisition' };

export const listRequisitions = defineRoute({
  ...REQUEST,
  operationId: 'listRequisitions',
  method: 'get',
  path: '/requisitions',
  summary: 'Requisitions, newest first, and the departments that can raise them (M10-02)',
  description: ADDED,
  query: z.object({ status: RequisitionStatus.optional() }),
  response: z.object({
    data: z.array(RequisitionItem),
    departments: z.array(z.object({ id: Uuid, code: z.string(), name: z.string() })),
  }),
});

export const createRequisition = defineRoute({
  ...REQUEST,
  operationId: 'createRequisition',
  method: 'post',
  path: '/requisitions',
  summary: 'Raise a requisition for a department (M10-02)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: z.object({
    departmentId: Uuid,
    note: OptionalText(500).optional(),
    lines: z
      .array(z.object({ itemId: Uuid, quantity: Positive }))
      .min(1, 'Add at least one item')
      .max(50)
      .refine((l) => new Set(l.map((x) => x.itemId)).size === l.length, 'Each item once'),
  }),
  response: RequisitionItem,
});

export const cancelRequisition = defineRoute({
  ...REQUEST,
  operationId: 'cancelRequisition',
  method: 'post',
  path: '/requisitions/{requisitionId}/cancel',
  summary: 'Withdraw your own requisition before anything is issued (M10-02)',
  description: ADDED,
  params: z.object({ requisitionId: Uuid }),
  response: RequisitionItem,
});

export const issueRequisition = defineRoute({
  ...MANAGE,
  operationId: 'issueRequisition',
  method: 'post',
  path: '/requisitions/{requisitionId}/issue',
  summary: 'Issue stock against a requisition, in full or in part (M10-02)',
  description: `${ADDED} The store keeper who issues is the approver and may not be the requester. Each line issues at most what is still asked for and what the location holds.`,
  idempotent: true,
  params: z.object({ requisitionId: Uuid }),
  body: z.object({
    locationId: Uuid,
    lines: z
      .array(z.object({ lineId: Uuid, quantity: Positive }))
      .min(1, 'Issue at least one item')
      .refine((l) => new Set(l.map((x) => x.lineId)).size === l.length, 'Each line once'),
  }),
  response: RequisitionItem,
});

export const closeRequisition = defineRoute({
  ...MANAGE,
  operationId: 'closeRequisition',
  method: 'post',
  path: '/requisitions/{requisitionId}/close',
  summary: 'Refuse a requisition, or close what is left of it, with a reason (M10-02)',
  description: ADDED,
  params: z.object({ requisitionId: Uuid }),
  body: z.object({ reason: Reason }),
  response: RequisitionItem,
});

// ---------------------------------------------------------------------------------------
// Stocktakes (M10-05)

export const StocktakeStatus = z.enum(['COUNTING', 'POSTED', 'CANCELLED']);

export const StocktakeSummary = z
  .object({
    id: Uuid,
    number: z.number().int(),
    status: StocktakeStatus,
    location: z.object({ id: Uuid, code: z.string(), name: z.string() }),
    startedBy: Person,
    startedAt: Instant,
    postedBy: Person.nullable(),
    postedAt: Instant.nullable(),
    reason: z.string().nullable(),
    counted: z.number().int(),
    lineCount: z.number().int(),
    /** Variance value at unit cost (posted only). */
    varianceMinor: AmountMinor.nullable(),
  })
  .meta({ id: 'StocktakeSummary' });

export const StocktakeDetail = StocktakeSummary.extend({
  lines: z.array(
    z.object({
      item: z.object({ id: Uuid, code: z.string(), name: z.string(), unit: z.string() }),
      counted: Quantity.nullable(),
      /** Hidden while counting (a blind count); set when posted. */
      expected: Quantity.nullable(),
      variance: Quantity.nullable(),
      varianceMinor: AmountMinor.nullable(),
    }),
  ),
}).meta({ id: 'Stocktake' });

const COUNT = { tags: ['Stock'], propertyScoped: true as const, permission: 'stock.count' };

export const listStocktakes = defineRoute({
  ...COUNT,
  operationId: 'listStocktakes',
  method: 'get',
  path: '/stocktakes',
  summary: 'Stocktakes, newest first (M10-05)',
  description: ADDED,
  response: z.object({ data: z.array(StocktakeSummary) }),
});

export const startStocktake = defineRoute({
  ...COUNT,
  operationId: 'startStocktake',
  method: 'post',
  path: '/stocktakes',
  summary: 'Start counting a location: one count per location at a time (M10-05)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: z.object({ locationId: Uuid }),
  response: StocktakeDetail,
});

export const getStocktake = defineRoute({
  ...COUNT,
  operationId: 'getStocktake',
  method: 'get',
  path: '/stocktakes/{stocktakeId}',
  summary: 'A stocktake with its counts; expected and variance once posted (M10-05)',
  description: ADDED,
  params: z.object({ stocktakeId: Uuid }),
  response: StocktakeDetail,
});

export const recordStocktakeCounts = defineRoute({
  ...COUNT,
  operationId: 'recordStocktakeCounts',
  method: 'put',
  path: '/stocktakes/{stocktakeId}/counts',
  summary: 'Record or correct counts while counting (M10-05)',
  description: ADDED,
  params: z.object({ stocktakeId: Uuid }),
  body: z.object({
    counts: z
      .array(z.object({ itemId: Uuid, counted: ZeroOrMore.nullable() }))
      .min(1)
      .max(500),
  }),
  response: StocktakeDetail,
});

export const postStocktake = defineRoute({
  ...MANAGE,
  operationId: 'postStocktake',
  method: 'post',
  path: '/stocktakes/{stocktakeId}/post',
  summary: 'Post a stocktake: each variance becomes an adjustment with the reason (M10-05)',
  description: `${ADDED} Compares each counted item with the books at posting time. Uncounted items are left as they are. A reason is needed when anything differs.`,
  idempotent: true,
  params: z.object({ stocktakeId: Uuid }),
  body: z.object({ reason: OptionalText(500).optional() }),
  response: StocktakeDetail,
});

export const cancelStocktake = defineRoute({
  ...COUNT,
  operationId: 'cancelStocktake',
  method: 'post',
  path: '/stocktakes/{stocktakeId}/cancel',
  summary: 'Abandon a count that has not been posted (M10-05)',
  description: ADDED,
  params: z.object({ stocktakeId: Uuid }),
  response: StocktakeDetail,
});

export const STOCK_ROUTES = {
  listStockItems,
  createStockItem,
  updateStockItem,
  createStockUnit,
  updateStockUnit,
  createStockLocation,
  updateStockLocation,
  listStockMovements,
  adjustStock,
  transferStock,
  listRequisitions,
  createRequisition,
  cancelRequisition,
  issueRequisition,
  closeRequisition,
  listStocktakes,
  startStocktake,
  getStocktake,
  recordStocktakeCounts,
  postStocktake,
  cancelStocktake,
} as const;
