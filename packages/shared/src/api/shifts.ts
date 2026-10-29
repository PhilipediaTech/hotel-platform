import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, Uuid } from './primitives.ts';

// Cashier shifts (PRD M4-10–M4-12, M4 rule 4 and the shift acceptance criterion; tab 4 row
// "Shifts" and the POST /shifts/{id}/close example; S14; T-061). A cashier opens a shift with
// a counted float, hands cash to a colleague or the safe, and closes with a blind count per
// method: expected amounts are revealed only in the close response. A variance above the
// property's tolerance (default ₦500) needs a reason and a supervisor's sign-off, and raises a
// leakage alert; within tolerance the shift closes at once.

export const PAY_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'POS_TERMINAL',
  'CARD_ONLINE',
  'VIRTUAL_ACCOUNT',
  'MOBILE_MONEY',
  'VOUCHER',
  'AR_TRANSFER',
] as const;
export const SHIFT_STATUSES = ['OPEN', 'CLOSING', 'CLOSED'] as const;
/** Default variance tolerance per method (₦500), until the property sets its own. */
export const DEFAULT_SHIFT_TOLERANCE_MINOR = '50000';

const NonNegativeMinor = AmountMinor.refine((v) => !v.startsWith('-'), 'Must not be negative');
const PositiveMinor = AmountMinor.refine(
  (v) => !v.startsWith('-') && v !== '0',
  'Must be more than zero',
);

export const HandoverItem = z
  .object({
    id: Uuid,
    from: z.string(),
    /** Null = the safe. */
    to: z.string().nullable(),
    amountMinor: AmountMinor,
    currency: z.string(),
    at: Instant,
    confirmedAt: Instant.nullable(),
  })
  .meta({ id: 'CashHandover' });

export const ShiftCountLine = z
  .object({
    method: z.enum(PAY_METHODS),
    currency: z.string(),
    expectedMinor: AmountMinor,
    /** Null while the shift is open. */
    countedMinor: AmountMinor.nullable(),
    /** Counted minus expected: negative is short. */
    varianceMinor: AmountMinor.nullable(),
  })
  .meta({ id: 'ShiftCountLine' });

/** A shift as a supervisor sees it, and as the close response reveals it to the cashier. */
export const ShiftItem = z
  .object({
    id: Uuid,
    userId: Uuid.nullable(),
    cashier: z.string(),
    status: z.enum(SHIFT_STATUSES),
    openedAt: Instant,
    closedAt: Instant.nullable(),
    floatMinor: AmountMinor,
    currency: z.string(),
    lines: z.array(ShiftCountLine),
    toleranceMinor: AmountMinor,
    /** A variance above tolerance: waits for a supervisor (M4-11). */
    requiresSignOff: z.boolean(),
    varianceNote: z.string().nullable(),
    signedOffBy: z.string().nullable(),
  })
  .meta({ id: 'Shift' });

/**
 * The cashier's own open shift, blind: float, handovers and how many payments of each method,
 * never the expected amounts.
 */
export const MyShift = z
  .object({
    id: Uuid,
    status: z.literal('OPEN'),
    openedAt: Instant,
    floatMinor: AmountMinor,
    currency: z.string(),
    handoversOut: z.array(HandoverItem),
    /** Confirmed into this shift. */
    handoversIn: z.array(HandoverItem),
    paymentCounts: z.array(z.object({ method: z.enum(PAY_METHODS), count: z.number().int() })),
  })
  .meta({ id: 'MyShift' });

export const CurrentShift = z
  .object({
    shift: MyShift.nullable(),
    /** The caller's counted shifts waiting for a reason or a supervisor. */
    awaitingSignOff: z.array(ShiftItem),
    /** Handovers to the caller not yet confirmed. */
    incoming: z.array(HandoverItem),
    /** Colleagues with an open shift here, who can receive a handover. */
    colleagues: z.array(z.object({ userId: Uuid, name: z.string() })),
  })
  .meta({ id: 'CurrentShift' });

const ShiftParams = z.object({ shiftId: Uuid });

export const openShift = defineRoute({
  operationId: 'openShift',
  method: 'post',
  path: '/shifts',
  summary: 'Open a cashier shift with a counted float',
  description: 'One open shift per cashier per property (M4 rule 4).',
  tags: ['Shifts'],
  propertyScoped: true,
  permission: 'shift.open',
  idempotent: true,
  body: z.object({ floatMinor: NonNegativeMinor }),
  status: 201,
  response: CurrentShift,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const getCurrentShift = defineRoute({
  operationId: 'getCurrentShift',
  method: 'get',
  path: '/shifts/current',
  summary: 'The caller’s open shift (blind), counted shifts waiting, and incoming handovers',
  tags: ['Shifts'],
  propertyScoped: true,
  permission: 'shift.open',
  response: CurrentShift,
});

export const ShiftQuery = z.object({ status: z.enum(SHIFT_STATUSES).default('CLOSING') });

export const listShifts = defineRoute({
  operationId: 'listShifts',
  method: 'get',
  path: '/shifts',
  summary: 'Shifts with expected, counted and variance per method (supervisors)',
  description: 'Waiting for sign-off by default. Open shifts show what is expected so far.',
  tags: ['Shifts'],
  propertyScoped: true,
  permission: 'shift.signoff',
  query: ShiftQuery,
  response: z.object({ data: z.array(ShiftItem) }),
});

export const CloseShiftBody = z
  .object({
    counts: z
      .array(
        z.object({
          method: z.enum(PAY_METHODS),
          currency: z.string().regex(/^[A-Z]{3}$/),
          countedMinor: NonNegativeMinor,
        }),
      )
      .min(1)
      .max(20),
    varianceNote: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .refine((b) => b.counts.some((c) => c.method === 'CASH'), {
    message: 'Count the cash',
    path: ['counts'],
  })
  .refine(
    (b) => new Set(b.counts.map((c) => `${c.method} ${c.currency}`)).size === b.counts.length,
    { message: 'Count each method once', path: ['counts'] },
  );

export const closeShift = defineRoute({
  operationId: 'closeShift',
  method: 'post',
  path: '/shifts/{shiftId}/close',
  summary: 'Close a shift with a blind count per method',
  description:
    'Expected amounts are revealed only in this response. A method not counted counts as zero. Within tolerance the shift is CLOSED; above it the shift is CLOSING until a supervisor signs off, needs a reason, and raises a leakage alert. Closing someone else’s shift needs shift.signoff.',
  tags: ['Shifts'],
  propertyScoped: true,
  permission: 'shift.close',
  idempotent: true,
  params: ShiftParams,
  body: CloseShiftBody,
  response: ShiftItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const addVarianceNote = defineRoute({
  operationId: 'addVarianceNote',
  method: 'post',
  path: '/shifts/{shiftId}/variance-note',
  summary: 'Give the reason for a variance after seeing it',
  tags: ['Shifts'],
  propertyScoped: true,
  permission: 'shift.close',
  params: ShiftParams,
  body: z.object({ note: z.string().trim().min(1).max(500) }),
  response: ShiftItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const signOffShift = defineRoute({
  operationId: 'signOffShift',
  method: 'post',
  path: '/shifts/{shiftId}/sign-off',
  summary: 'Sign off a shift whose variance is above tolerance',
  description: 'By a supervisor other than the cashier, once the cashier has given a reason.',
  tags: ['Shifts'],
  propertyScoped: true,
  permission: 'shift.signoff',
  params: ShiftParams,
  body: z.object({ note: z.string().trim().max(500).nullable().default(null) }),
  response: ShiftItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const createHandover = defineRoute({
  operationId: 'createHandover',
  method: 'post',
  path: '/cash-handovers',
  summary: 'Hand cash from your open shift to a colleague or the safe',
  description:
    'To the safe it is confirmed at once; a colleague with an open shift confirms it into theirs. 409 SHIFT_NOT_OPEN without an open shift.',
  tags: ['Shifts'],
  propertyScoped: true,
  permission: 'shift.handover',
  idempotent: true,
  body: z.object({
    /** Null = the safe. */
    toUserId: Uuid.nullable(),
    amountMinor: PositiveMinor,
  }),
  status: 201,
  response: CurrentShift,
  errors: ['SHIFT_NOT_OPEN'],
});

export const confirmHandover = defineRoute({
  operationId: 'confirmHandover',
  method: 'post',
  path: '/cash-handovers/{handoverId}/confirm',
  summary: 'Confirm cash handed to you into your open shift',
  tags: ['Shifts'],
  propertyScoped: true,
  permission: 'shift.open',
  params: z.object({ handoverId: Uuid }),
  response: CurrentShift,
  errors: ['SHIFT_NOT_OPEN', 'STATE_TRANSITION_INVALID'],
});

export const SHIFT_ROUTES = {
  openShift,
  getCurrentShift,
  listShifts,
  closeShift,
  addVarianceNote,
  signOffShift,
  createHandover,
  confirmHandover,
} as const;
