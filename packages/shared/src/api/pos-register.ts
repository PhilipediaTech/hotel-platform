import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { MenuCategoryItem } from './pos.ts';
import { AmountMinor, Instant, Uuid } from './primitives.ts';
import { CloseShiftBody, ShiftItem } from './shifts.ts';

// Lite POS register (PRD M8-02 "I open an outlet shift with float", M8-03 "I open a tab or
// table, add items, and settle by cash, transfer, POS terminal or charge to room (guest signs
// on screen)", M8-05 "I close my outlet shift with counts and variance"; tab 3 pos_orders,
// pos_order_lines; tab 4 row POS; S33; T-142). Rules: charge to room only for CHECKED_IN stays
// and within the folio's credit limit (default unlimited, configurable); a room charge creates
// folio lines referencing the POS order. AC: a room-charged order appears on the folio once;
// the outlet shift close equals the sum of settlements by method.
//
// An outlet shift is a cashier shift with its outlet (tab 3 cashier_shifts.outletId): the
// same blind count, tolerance, leakage alert and supervisor sign-off as the front desk (M4-11).

/** Ways to pay at an outlet (M8-03), when the property switched them on in setup. */
export const POS_PAY_METHODS = ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL'] as const;
export const POS_ORDER_STATUSES = ['OPEN', 'PAID', 'ROOM_CHARGED', 'CANCELLED'] as const;

const PositiveMinor = AmountMinor.refine(
  (v) => /^\d+$/.test(v) && BigInt(v) > 0n,
  'More than zero',
);
const NonNegativeMinor = AmountMinor.refine((v) => /^\d+$/.test(v), 'Zero or more');

/** POS settings (properties.settings.pos). */
export const PosSettings = z
  .object({
    /**
     * Most a guest folio may owe after a room charge, when the folio has no credit limit of
     * its own; null = unlimited (the PRD default).
     */
    roomChargeLimitMinor: PositiveMinor.nullable(),
  })
  .meta({ id: 'PosSettings' });

export function posSettingsOf(settings: unknown): z.output<typeof PosSettings> {
  const pos = (settings as { pos?: unknown } | null)?.pos;
  const parsed = PosSettings.safeParse(pos);
  return parsed.success ? parsed.data : { roomChargeLimitMinor: null };
}

export const OutletShiftItem = z
  .object({
    id: Uuid,
    outletId: Uuid,
    outlet: z.string(),
    status: z.enum(['OPEN', 'CLOSING']),
    openedAt: Instant,
    floatMinor: AmountMinor,
    /** Blind: how many payments of each method, never the expected amounts. */
    paymentCounts: z.array(z.object({ method: z.string(), count: z.number().int() })),
    roomCharges: z.number().int(),
    openOrders: z.number().int(),
  })
  .meta({ id: 'OutletShift' });

export const PosRegister = z
  .object({
    currency: z.string(),
    /** Active outlets a shift can be opened at. */
    outlets: z.array(z.object({ id: Uuid, code: z.string(), name: z.string() })),
    /** The cashier's own outlet shifts, open or waiting for sign-off. */
    shifts: z.array(OutletShiftItem),
    /** Payment methods switched on for this hotel, of those an outlet takes. */
    methods: z.array(z.enum(POS_PAY_METHODS)),
  })
  .meta({ id: 'PosRegister' });

export const PosOrderLineItem = z
  .object({
    id: Uuid,
    name: z.string(),
    quantity: z.number().int(),
    unitPriceMinor: AmountMinor,
    /** Before tax. */
    amountMinor: AmountMinor,
    note: z.string().nullable(),
    addedBy: z.string(),
    addedAt: Instant,
    /** M8-04: a voided item stays on the order with its reason, and is not charged. */
    voided: z.object({ at: Instant, by: z.string(), reason: z.string() }).nullable(),
    /** M8-04: what the guest pays less for this line, taxes included. */
    discount: z
      .object({ amountMinor: AmountMinor, at: Instant, by: z.string(), reason: z.string() })
      .nullable(),
    /** What the line charges with its taxes, after its discount; 0 when voided. */
    totalMinor: AmountMinor,
  })
  .meta({ id: 'PosOrderLine' });

export const PosOrderItem = z
  .object({
    id: Uuid,
    number: z.string(),
    label: z.string(),
    status: z.enum(POS_ORDER_STATUSES),
    outletId: Uuid,
    outlet: z.string(),
    openedBy: z.string(),
    openedAt: Instant,
    currency: z.string(),
    lines: z.array(PosOrderLineItem),
    /** Before tax. */
    subtotalMinor: AmountMinor,
    taxMinor: AmountMinor,
    /** Discounts given on the lines, taxes included (M8-04). */
    discountMinor: AmountMinor,
    /** What the guest pays: settled total once settled, else worked out for today. */
    totalMinor: AmountMinor,
    settledAt: Instant.nullable(),
    settledBy: z.string().nullable(),
    payments: z.array(
      z.object({
        method: z.string(),
        amountMinor: AmountMinor,
        externalRef: z.string().nullable(),
      }),
    ),
    /** Charged to room: the room and the folio the lines went to. */
    room: z.object({ stayId: Uuid, roomNumber: z.string().nullable(), folioId: Uuid }).nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'PosOrder' });

const POS = { tags: ['POS'], propertyScoped: true as const };
const ADDED = 'Tab 4 row POS names the paths; the bodies are designed in T-142.';
const OrderParams = z.object({ orderId: Uuid });
const ShiftParams = z.object({ shiftId: Uuid });

export const getPosRegister = defineRoute({
  ...POS,
  operationId: 'getPosRegister',
  method: 'get',
  path: '/pos/register',
  summary: "The cashier's outlet shifts, the outlets and payment methods (M8-02, M8-03)",
  description: ADDED,
  permission: 'pos.order',
  response: PosRegister,
});

export const openOutletShift = defineRoute({
  ...POS,
  operationId: 'openOutletShift',
  method: 'post',
  path: '/outlet-shifts',
  summary: 'Open an outlet shift with a counted float (M8-02)',
  description: `${ADDED} One open shift per cashier and outlet.`,
  permission: 'pos.shift',
  idempotent: true,
  status: 201,
  body: z.object({ outletId: Uuid, floatMinor: NonNegativeMinor }),
  response: PosRegister,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const closeOutletShift = defineRoute({
  ...POS,
  operationId: 'closeOutletShift',
  method: 'post',
  path: '/outlet-shifts/{shiftId}/close',
  summary: 'Close an outlet shift with a blind count per method (M8-05)',
  description:
    'As the front desk close (M4-11): expected = float + settlements by method on the shift; revealed only in this response. Above tolerance the shift waits for a supervisor’s sign-off (POST /shifts/{id}/sign-off), needs a reason and raises a leakage alert. Room charges are not in the drawer.',
  permission: 'pos.shift',
  idempotent: true,
  params: ShiftParams,
  body: CloseShiftBody,
  response: ShiftItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const addOutletVarianceNote = defineRoute({
  ...POS,
  operationId: 'addOutletVarianceNote',
  method: 'post',
  path: '/outlet-shifts/{shiftId}/variance-note',
  summary: 'Give the reason for an outlet shift variance (M8-05)',
  description: ADDED,
  permission: 'pos.shift',
  params: ShiftParams,
  body: z.object({ note: z.string().trim().min(1).max(500) }),
  response: ShiftItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const getOutletMenu = defineRoute({
  ...POS,
  operationId: 'getOutletMenu',
  method: 'get',
  path: '/menu-items',
  summary: "An outlet's menu to take orders from: what is switched on (M8-03)",
  description: ADDED,
  permission: 'pos.order',
  query: z.object({ outletId: Uuid }),
  response: z.object({
    outletId: Uuid,
    outlet: z.string(),
    currency: z.string(),
    categories: z.array(MenuCategoryItem),
  }),
});

export const listPosOrders = defineRoute({
  ...POS,
  operationId: 'listPosOrders',
  method: 'get',
  path: '/pos/orders',
  summary: "An outlet's orders: open tabs and tables, or today's settled ones (M8-03)",
  description: ADDED,
  permission: 'pos.order',
  query: z.object({
    outletId: Uuid,
    status: z.enum(['OPEN', 'CLOSED']).default('OPEN'),
  }),
  response: z.object({ data: z.array(PosOrderItem) }),
});

export const getPosOrder = defineRoute({
  ...POS,
  operationId: 'getPosOrder',
  method: 'get',
  path: '/pos/orders/{orderId}',
  summary: 'An order with its lines and totals (M8-03)',
  description: ADDED,
  permission: 'pos.order',
  params: OrderParams,
  response: PosOrderItem,
});

export const openPosOrder = defineRoute({
  ...POS,
  operationId: 'openPosOrder',
  method: 'post',
  path: '/pos/orders',
  summary: 'Open a tab or a table (M8-03)',
  description: `${ADDED} Needs your open shift at the outlet (SHIFT_NOT_OPEN).`,
  permission: 'pos.order',
  idempotent: true,
  status: 201,
  body: z.object({ outletId: Uuid, label: z.string().trim().min(1).max(40) }),
  response: PosOrderItem,
  errors: ['SHIFT_NOT_OPEN'],
});

export const addPosOrderLine = defineRoute({
  ...POS,
  operationId: 'addPosOrderLine',
  method: 'post',
  path: '/pos/orders/{orderId}/lines',
  summary: 'Add an item, with its options, to an open order (M8-03)',
  description: `${ADDED} Priced when added: the item plus its options.`,
  permission: 'pos.order',
  idempotent: true,
  status: 201,
  params: OrderParams,
  body: z.object({
    menuItemId: Uuid,
    quantity: z.number().int().min(1).max(99).default(1),
    modifierIds: z.array(Uuid).max(10).default([]),
    note: z
      .string()
      .trim()
      .max(200)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .default(null),
  }),
  response: PosOrderItem,
  errors: ['SHIFT_NOT_OPEN', 'STATE_TRANSITION_INVALID'],
});

export const SettlePosOrderBody = z
  .object({
    payments: z
      .array(
        z.object({
          method: z.enum(POS_PAY_METHODS),
          amountMinor: PositiveMinor,
          /** POS slip or transfer reference; required except for cash. */
          externalRef: z.string().trim().min(1).max(100).nullable().default(null),
        }),
      )
      .min(1)
      .max(3),
  })
  .refine((b) => b.payments.every((p) => p.method === 'CASH' || p.externalRef !== null), {
    message: 'Give the reference (POS slip or transfer number)',
    path: ['payments'],
  });

export const settlePosOrder = defineRoute({
  ...POS,
  operationId: 'settlePosOrder',
  method: 'post',
  path: '/pos/orders/{orderId}/settle',
  summary: 'Settle an order by cash, transfer or POS terminal, or a mix (M8-03)',
  description: `${ADDED} The payments must add up to the total exactly; they go to your outlet shift. The lines post, with their taxes, to a POS folio of the order, which the payments settle.`,
  permission: 'pos.order',
  idempotent: true,
  params: OrderParams,
  body: SettlePosOrderBody,
  response: PosOrderItem,
  errors: ['SHIFT_NOT_OPEN', 'STATE_TRANSITION_INVALID', 'PAYMENT_DUPLICATE'],
});

export const chargePosOrderToRoom = defineRoute({
  ...POS,
  operationId: 'chargePosOrderToRoom',
  method: 'post',
  path: '/pos/orders/{orderId}/charge-to-room',
  summary: "Charge an order to a checked-in guest's room; the guest signs on screen (M8-03)",
  description:
    'Only for CHECKED_IN stays, within the folio’s credit limit (its own, else the POS setting; unlimited by default). The lines post with their taxes to the guest folio, each referencing the order, once.',
  permission: 'pos.order',
  idempotent: true,
  params: OrderParams,
  body: z.object({ stayId: Uuid, signatureFileId: Uuid }),
  response: PosOrderItem,
  errors: ['SHIFT_NOT_OPEN', 'STATE_TRANSITION_INVALID', 'CREDIT_LIMIT_EXCEEDED'],
});

export const cancelPosOrder = defineRoute({
  ...POS,
  operationId: 'cancelPosOrder',
  method: 'post',
  path: '/pos/orders/{orderId}/cancel',
  summary: 'Close an order opened by mistake, before anything is on it (M8-03)',
  description: `${ADDED} Once items are on it, void them all first (M8-04).`,
  permission: 'pos.order',
  params: OrderParams,
  response: PosOrderItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

const LineParams = z.object({ orderId: Uuid, lineId: Uuid });
const Reason = z.string().trim().min(1).max(500);
const M804 =
  'Tab 4 row POS; the paths and bodies are designed in T-143. Needs pos.void; within your pos.void amount limit it happens at once, above it (or with no limit set) the answer is 202 and a manager approves (M8-04). Measured by what the guest pays less, taxes included.';

export const voidPosOrderLine = defineRoute({
  ...POS,
  operationId: 'voidPosOrderLine',
  method: 'post',
  path: '/pos/orders/{orderId}/lines/{lineId}/void',
  summary: 'Void an item on an open order, with a reason (M8-04)',
  description: `${M804} The voided item stays on the order with its reason, and is not charged.`,
  permission: 'pos.void',
  idempotent: true,
  approval: true,
  params: LineParams,
  body: z.object({ reason: Reason }),
  response: PosOrderItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const DiscountPosOrderLineBody = z
  .object({
    /** Percent off the line with its taxes, up to 100. */
    percent: z.number().gt(0).max(100).optional(),
    /** Or an amount off the line with its taxes, minor units. */
    amountMinor: PositiveMinor.optional(),
    reason: Reason,
  })
  .refine((b) => (b.percent === undefined) !== (b.amountMinor === undefined), {
    message: 'Give a percent or an amount',
    path: ['percent'],
  });

export const discountPosOrderLine = defineRoute({
  ...POS,
  operationId: 'discountPosOrderLine',
  method: 'post',
  path: '/pos/orders/{orderId}/lines/{lineId}/discount',
  summary: 'Give a discount on an item of an open order, with a reason (M8-04)',
  description: `${M804} One discount per item, at most what the item charges. When the order is settled it posts as a discount line taking its share off the charge and each of its taxes.`,
  permission: 'pos.void',
  idempotent: true,
  approval: true,
  params: LineParams,
  body: DiscountPosOrderLineBody,
  response: PosOrderItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const listPosRooms = defineRoute({
  ...POS,
  operationId: 'listPosRooms',
  method: 'get',
  path: '/pos/rooms',
  summary: 'Checked-in rooms an order can be charged to (M8-03)',
  description: ADDED,
  permission: 'pos.order',
  response: z.object({
    data: z.array(z.object({ stayId: Uuid, roomNumber: z.string(), guest: z.string() })),
  }),
});

export const getPosSettings = defineRoute({
  ...POS,
  operationId: 'getPosSettings',
  method: 'get',
  path: '/pos/settings',
  summary: 'POS settings: the room charge limit (M8-03)',
  description: ADDED,
  permission: 'pos.setup',
  response: PosSettings,
});

export const updatePosSettings = defineRoute({
  ...POS,
  operationId: 'updatePosSettings',
  method: 'put',
  path: '/pos/settings',
  summary: 'Change the room charge limit (M8-03)',
  description: `${ADDED} Audited.`,
  permission: 'pos.setup',
  body: PosSettings,
  response: PosSettings,
});

export const POS_REGISTER_ROUTES = {
  getPosRegister,
  openOutletShift,
  closeOutletShift,
  addOutletVarianceNote,
  getOutletMenu,
  listPosOrders,
  getPosOrder,
  openPosOrder,
  addPosOrderLine,
  settlePosOrder,
  chargePosOrderToRoom,
  cancelPosOrder,
  voidPosOrderLine,
  discountPosOrderLine,
  listPosRooms,
  getPosSettings,
  updatePosSettings,
} as const;
