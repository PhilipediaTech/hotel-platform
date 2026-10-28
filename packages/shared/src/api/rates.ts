import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, IsoDate, Uuid } from './primitives.ts';

// Rate plans, the rate calendar (prices and restrictions), cancellation policies and package
// components (tab 4 row "Rates"; PRD M2-04–M2-08; S23; T-033). Lists are open to everyone at
// the property; changes need rate.manage.

const RATE = 'rate.manage';

/** NEGOTIATED plans arrive with companies (M2-11, V1.1). */
export const RATE_PLAN_KINDS = ['BAR', 'DERIVED', 'PACKAGE', 'DAY_USE', 'NEGOTIATED'] as const;
export const SELLABLE_PLAN_KINDS = ['BAR', 'DERIVED', 'PACKAGE', 'DAY_USE'] as const;
export const MEAL_PLANS = ['ROOM_ONLY', 'BREAKFAST', 'HALF_BOARD', 'FULL_BOARD'] as const;
export const GUARANTEES = ['NONE', 'DEPOSIT', 'CARD_ON_FILE', 'COMPANY'] as const;
export const FEE_TYPES = ['NIGHTS', 'PERCENT'] as const;

/** Longest calendar read; bulk edits may span a year. */
export const MAX_CALENDAR_DAYS = 62;
export const MAX_BULK_DAYS = 366;

const Text = (max: number) => z.string().trim().min(1).max(max);
const NonNegative = AmountMinor.refine((v) => !v.startsWith('-'), 'Must not be negative');
const UniqueIds = z
  .array(Uuid)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, 'Each once');

// ── Cancellation policies ──────────────────────────────────────────────────────────────

const Fee = z
  .object({
    /** NIGHTS: that many nights; PERCENT: share of the stay (0–100). */
    feeType: z.enum(FEE_TYPES),
    value: z.number().int().min(0).max(100),
  })
  .refine((f) => f.feeType !== 'NIGHTS' || f.value <= 30, {
    message: 'At most 30 nights',
    path: ['value'],
  });

export const CancellationPolicyItem = z
  .object({
    id: Uuid,
    name: z.string(),
    /** Fee when cancelling this many days or fewer before arrival. */
    rules: z.array(
      z.object({
        daysBefore: z.number().int(),
        feeType: z.enum(FEE_TYPES),
        value: z.number().int(),
      }),
    ),
    noShowFee: z.object({ feeType: z.enum(FEE_TYPES), value: z.number().int() }),
  })
  .meta({ id: 'CancellationPolicy' });

export const CancellationPolicyBody = z.object({
  name: Text(80),
  rules: z
    .array(Fee.and(z.object({ daysBefore: z.number().int().min(0).max(365) })))
    .max(5)
    .refine(
      (rules) => new Set(rules.map((r) => r.daysBefore)).size === rules.length,
      'One rule per number of days',
    ),
  noShowFee: Fee,
});

export const listCancellationPolicies = defineRoute({
  operationId: 'listCancellationPolicies',
  method: 'get',
  path: '/cancellation-policies',
  summary: 'Cancellation policies of the property',
  tags: ['Rates'],
  propertyScoped: true,
  response: z.object({ data: z.array(CancellationPolicyItem) }),
});

export const createCancellationPolicy = defineRoute({
  operationId: 'createCancellationPolicy',
  method: 'post',
  path: '/cancellation-policies',
  summary: 'Add a cancellation policy',
  tags: ['Rates'],
  propertyScoped: true,
  permission: RATE,
  body: CancellationPolicyBody,
  status: 201,
  response: CancellationPolicyItem,
});

// ── Rate plans ─────────────────────────────────────────────────────────────────────────

export const PackageComponentItem = z
  .object({
    id: Uuid,
    name: z.string(),
    revenueCodeId: Uuid,
    /** Per night; per guest when perPerson. */
    amountMinor: AmountMinor,
    perPerson: z.boolean(),
  })
  .meta({ id: 'PackageComponent' });

export const RatePlanItem = z
  .object({
    id: Uuid,
    code: z.string(),
    name: z.string(),
    kind: z.enum(RATE_PLAN_KINDS),
    /** The BAR plan this one follows. */
    parentRatePlanId: Uuid.nullable(),
    /** -1000 = 10% off the parent. */
    derivationBps: z.number().int().nullable(),
    derivationAmountMinor: AmountMinor.nullable(),
    /** Derived prices round to this (10000 = NGN 100). */
    roundingMinor: AmountMinor,
    floorMinor: AmountMinor.nullable(),
    mealPlan: z.enum(MEAL_PLANS),
    cancellationPolicyId: Uuid,
    guarantee: z.enum(GUARANTEES),
    currency: z.string(),
    /** Offered on the booking engine and channels. */
    isPublic: z.boolean(),
    dayUseMaxMinutes: z.number().int().nullable(),
    /** Empty = every room type. */
    roomTypeIds: z.array(Uuid),
    active: z.boolean(),
    /** Send as `If-Match: "<version>"` when changing the plan. */
    version: z.number().int(),
    components: z.array(PackageComponentItem),
  })
  .meta({ id: 'RatePlan' });

const PlanFields = z.object({
  name: Text(80),
  derivationBps: z.number().int().min(-10_000).max(10_000).nullable(),
  derivationAmountMinor: AmountMinor.nullable(),
  roundingMinor: AmountMinor.refine((v) => BigInt(v) >= 1n, 'At least 1'),
  floorMinor: NonNegative.nullable(),
  mealPlan: z.enum(MEAL_PLANS),
  cancellationPolicyId: Uuid,
  guarantee: z.enum(GUARANTEES),
  isPublic: z.boolean(),
  dayUseMaxMinutes: z.number().int().min(30).max(1440).nullable(),
  roomTypeIds: UniqueIds,
});

export const RatePlanBody = PlanFields.extend({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{2,12}$/, 'Two to twelve letters, digits, dashes or underscores'),
  kind: z.enum(RATE_PLAN_KINDS),
  parentRatePlanId: Uuid.nullable().default(null),
  derivationBps: PlanFields.shape.derivationBps.default(null),
  derivationAmountMinor: AmountMinor.nullable().default(null),
  roundingMinor: PlanFields.shape.roundingMinor.default('10000'),
  floorMinor: NonNegative.nullable().default(null),
  mealPlan: z.enum(MEAL_PLANS).default('ROOM_ONLY'),
  guarantee: z.enum(GUARANTEES).default('NONE'),
  isPublic: z.boolean().default(false),
  dayUseMaxMinutes: PlanFields.shape.dayUseMaxMinutes.default(null),
  roomTypeIds: UniqueIds.default([]),
});

/** Code, kind and parent are fixed once created. */
export const RatePlanPatchBody = PlanFields.extend({ active: z.boolean() }).partial();

export const listRatePlans = defineRoute({
  operationId: 'listRatePlans',
  method: 'get',
  path: '/rate-plans',
  summary: 'Rate plans of the property with their package components',
  tags: ['Rates'],
  propertyScoped: true,
  response: z.object({ data: z.array(RatePlanItem) }),
});

export const createRatePlan = defineRoute({
  operationId: 'createRatePlan',
  method: 'post',
  path: '/rate-plans',
  summary: 'Add a rate plan: BAR, derived, package or day-use',
  tags: ['Rates'],
  propertyScoped: true,
  permission: RATE,
  body: RatePlanBody,
  status: 201,
  response: RatePlanItem,
});

export const updateRatePlan = defineRoute({
  operationId: 'updateRatePlan',
  method: 'patch',
  path: '/rate-plans/{ratePlanId}',
  summary: 'Change a rate plan; existing reservations keep their prices',
  tags: ['Rates'],
  propertyScoped: true,
  permission: RATE,
  ifMatch: true,
  params: z.object({ ratePlanId: Uuid }),
  body: RatePlanPatchBody,
  response: RatePlanItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

// ── Rate calendar ──────────────────────────────────────────────────────────────────────

export const RateCalendarDay = z
  .object({
    roomTypeId: Uuid,
    date: IsoDate,
    /** The price that sells: the plan's own, or worked out from its parent. Null = no price. */
    amountMinor: AmountMinor.nullable(),
    /** Set on this plan (null on derived plans and unpriced days). */
    ownAmountMinor: AmountMinor.nullable(),
    minStay: z.number().int().nullable(),
    maxStay: z.number().int().nullable(),
    closedToArrival: z.boolean(),
    closedToDeparture: z.boolean(),
    stopSell: z.boolean(),
    /** Goes up on every change; quotes store it. Null = never set. */
    ruleVersion: z.number().int().nullable(),
  })
  .meta({ id: 'RateCalendarDay' });

export const getRateCalendar = defineRoute({
  operationId: 'getRateCalendar',
  method: 'get',
  path: '/rate-calendar',
  summary: 'Prices and restrictions of one plan by room type and date',
  description: `\`to\` is included; at most ${MAX_CALENDAR_DAYS} days.`,
  tags: ['Rates'],
  propertyScoped: true,
  query: z.object({ ratePlanId: Uuid, from: IsoDate, to: IsoDate }),
  response: z.object({ ratePlanId: Uuid, days: z.array(RateCalendarDay) }),
});

export const RateCalendarSet = z
  .object({
    /** Null clears the price. Not on derived plans. */
    amountMinor: NonNegative.nullable(),
    minStay: z.number().int().min(1).max(365).nullable(),
    maxStay: z.number().int().min(1).max(365).nullable(),
    closedToArrival: z.boolean(),
    closedToDeparture: z.boolean(),
    stopSell: z.boolean(),
  })
  .partial()
  .refine((s) => Object.keys(s).length > 0, 'Change at least one thing')
  .refine((s) => (s.minStay ?? 0) <= (s.maxStay ?? 365), {
    message: 'Maximum stay must be at least the minimum',
    path: ['maxStay'],
  });

export const RateCalendarUpdateBody = z
  .object({
    ratePlanId: Uuid,
    roomTypeIds: UniqueIds.min(1),
    from: IsoDate,
    /** Included. */
    to: IsoDate,
    /** ISO weekdays to change (1 = Monday … 7 = Sunday); all when left out. */
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6, 7]),
    set: RateCalendarSet,
  })
  .refine((b) => b.to >= b.from, { message: 'End on or after the start', path: ['to'] });

export const updateRateCalendar = defineRoute({
  operationId: 'updateRateCalendar',
  method: 'put',
  path: '/rate-calendar',
  summary: 'Bulk edit prices and restrictions by date range, weekday and room type',
  description:
    'Only the fields in `set` change. Days whose values change get a new rule version; quotes and reservations made earlier keep theirs.',
  tags: ['Rates'],
  propertyScoped: true,
  permission: RATE,
  body: RateCalendarUpdateBody,
  response: z.object({ changedDays: z.number().int() }),
});

// ── Packages ───────────────────────────────────────────────────────────────────────────

export const PackageBody = z.object({
  ratePlanId: Uuid,
  components: z
    .array(
      z.object({
        name: Text(80),
        revenueCodeId: Uuid,
        amountMinor: NonNegative,
        perPerson: z.boolean().default(false),
      }),
    )
    .max(10),
});

export const listPackages = defineRoute({
  operationId: 'listPackages',
  method: 'get',
  path: '/packages',
  summary: 'Package plans and their components',
  tags: ['Rates'],
  propertyScoped: true,
  response: z.object({ data: z.array(RatePlanItem) }),
});

export const setPackageComponents = defineRoute({
  operationId: 'setPackageComponents',
  method: 'post',
  path: '/packages',
  summary: 'Set the components of a package plan (replaces the list)',
  tags: ['Rates'],
  propertyScoped: true,
  permission: RATE,
  body: PackageBody,
  response: RatePlanItem,
});

export const RATE_ROUTES = {
  listCancellationPolicies,
  createCancellationPolicy,
  listRatePlans,
  createRatePlan,
  updateRatePlan,
  getRateCalendar,
  updateRateCalendar,
  listPackages,
  setPackageComponents,
} as const;
