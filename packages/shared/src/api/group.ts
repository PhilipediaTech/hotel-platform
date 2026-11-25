import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { RateText } from './fx.ts';
import { MAX_BULK_DAYS } from './rates.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';

// Group dashboards (PRD M1-13 "As a group owner, I add more properties and see group
// dashboards", M12-07 "consolidated group reports with currency conversion"; UI S46 /group;
// T-161). A month's closed days across the properties the owner sees: each property in its own
// currency, side by side, and the group's totals in one group currency. A property in another
// currency counts in the money totals only once the owner has set that month's rate; without
// one it is listed apart, never converted at a guess.

const ADDED = 'Not in tab 4: designed in T-161 (PRD M1-13, M12-07).';

/** "2026-11". */
export const Month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month like 2026-11')
  .meta({ id: 'Month', example: '2026-11' });

const Currency = z.string().regex(/^[A-Z]{3}$/, 'A currency code like NGN');

const Figures = {
  roomsAvailable: z.number().int(),
  roomsSold: z.number().int(),
  occupancyBps: z.number().int(),
  roomRevenueMinor: AmountMinor,
  /** Every revenue line before tax (rooms, food and drink, other). */
  revenueMinor: AmountMinor,
  adrMinor: AmountMinor,
  revparMinor: AmountMinor,
};

const Money = z.object({
  roomRevenueMinor: AmountMinor,
  revenueMinor: AmountMinor,
  adrMinor: AmountMinor,
  revparMinor: AmountMinor,
});

export const GroupDashboard = z
  .object({
    month: Month,
    groupCurrency: Currency,
    properties: z.array(
      z.object({
        propertyId: Uuid,
        code: z.string(),
        name: z.string(),
        currency: Currency,
        /** Closed days counted; the last one (null when none this month). */
        days: z.number().int(),
        through: IsoDate.nullable(),
        ...Figures,
        /** The month's rate into the group currency ("1" in the group currency itself). */
        rate: RateText.nullable(),
        /** The money figures in the group currency; null without a rate. */
        inGroupCurrency: Money.nullable(),
      }),
    ),
    /** Rooms and occupancy count every property; money only those in the group currency. */
    totals: z.object({ ...Figures, propertiesInMoneyTotals: z.number().int() }),
    /** Currencies with no rate for the month: their properties are left out of the money totals. */
    missingRates: z.array(Currency),
    definitions: z.string(),
  })
  .meta({ id: 'GroupDashboard' });

export const GroupRates = z
  .object({
    month: Month,
    groupCurrency: Currency,
    /** Each currency the group's properties keep their books in, besides the group currency. */
    rates: z.array(
      z.object({
        currency: Currency,
        /** Group currency per one unit of `currency`; null when not set for the month. */
        rate: RateText.nullable(),
        setBy: z.string().nullable(),
        setAt: Instant.nullable(),
      }),
    ),
  })
  .meta({ id: 'GroupRates' });

export const GroupRatesBody = z.object({
  month: Month,
  groupCurrency: Currency,
  rates: z
    .array(z.object({ currency: Currency, rate: RateText }))
    .max(20)
    .refine((r) => new Set(r.map((x) => x.currency)).size === r.length, {
      message: 'One rate per currency',
    }),
});

const GROUP = { tags: ['Group'], propertyScoped: true as const, permission: 'report.group' };

export const getGroupDashboard = defineRoute({
  ...GROUP,
  operationId: 'getGroupDashboard',
  method: 'get',
  path: '/group/dashboard',
  summary: 'The group’s month: each property side by side, and totals in the group currency',
  description: `${ADDED} Closed days only, from night audit's kept figures. The month defaults to the current property's.`,
  query: z.object({ month: Month.optional() }),
  response: GroupDashboard,
});

export const getGroupRates = defineRoute({
  ...GROUP,
  operationId: 'getGroupRates',
  method: 'get',
  path: '/group/rates',
  summary: 'The group currency and a month’s rates into it',
  description: ADDED,
  query: z.object({ month: Month }),
  response: GroupRates,
});

export const putGroupRates = defineRoute({
  ...GROUP,
  operationId: 'putGroupRates',
  method: 'put',
  path: '/group/rates',
  summary: 'Set the group currency and a month’s rates into it',
  description: `${ADDED} The listed rates are set or replaced; others stay. Only currencies the group's properties use.`,
  body: GroupRatesBody,
  response: GroupRates,
});

// ── Rate changes across properties (PRD M2-13; T-162) ────────────────────────────────────

const Code = z.string().trim().min(1).max(20);
const Signed = AmountMinor.refine((v) => v !== '0' && v !== '-0', 'Must not be zero');
const NonNegative = AmountMinor.refine((v) => !v.startsWith('-'), 'Must not be negative');

/** How prices change: by a share, by an amount, or to one price (one currency only). */
export const GroupPriceChange = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('PERCENT'),
    /** 1000 = +10%; -500 = −5%. */
    bps: z
      .number()
      .int()
      .min(-9000)
      .max(10_000)
      .refine((v) => v !== 0, 'Must not be zero'),
  }),
  z.object({ mode: z.literal('AMOUNT'), amountMinor: Signed }),
  z.object({ mode: z.literal('SET'), amountMinor: NonNegative }),
]);

export const GroupRestrictions = z
  .object({
    minStay: z.number().int().min(1).max(365).nullable(),
    maxStay: z.number().int().min(1).max(365).nullable(),
    closedToArrival: z.boolean(),
    closedToDeparture: z.boolean(),
    stopSell: z.boolean(),
  })
  .partial()
  .refine((r) => (r.minStay ?? 0) <= (r.maxStay ?? 365), {
    message: 'Maximum stay must be at least the minimum',
    path: ['maxStay'],
  });

export const GroupRateChangeBody = z
  .object({
    propertyIds: z
      .array(Uuid)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, 'Each once'),
    /** The rate plan by its code, in every property (e.g. BAR). */
    ratePlanCode: Code,
    /** Room types by code; every room type the plan sells when left out. */
    roomTypeCodes: z.array(Code).min(1).max(30).optional(),
    from: IsoDate,
    /** Included. */
    to: IsoDate,
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6, 7]),
    price: GroupPriceChange.optional(),
    restrictions: GroupRestrictions.optional(),
    /** Only count what would change; nothing is written. */
    dryRun: z.boolean().default(false),
  })
  .refine((b) => b.to >= b.from, { message: 'End on or after the start', path: ['to'] })
  .refine((b) => b.price !== undefined || Object.keys(b.restrictions ?? {}).length > 0, {
    message: 'Change the price or a restriction',
    path: ['price'],
  });

export const GroupRateChangeResult = z
  .object({
    dryRun: z.boolean(),
    properties: z.array(
      z.object({
        propertyId: Uuid,
        name: z.string(),
        currency: z.string(),
        roomTypeCodes: z.array(z.string()),
        /** Room-type days whose price or restrictions change (or would). */
        changedDays: z.number().int(),
      }),
    ),
    changedDays: z.number().int(),
  })
  .meta({ id: 'GroupRateChangeResult' });

export const changeGroupRates = defineRoute({
  tags: ['Group'],
  propertyScoped: true,
  permission: 'rate.group.manage',
  operationId: 'changeGroupRates',
  method: 'post',
  path: '/group/rate-changes',
  summary: 'Change one rate plan’s prices or restrictions in several properties at once',
  description: `Not in tab 4: designed in T-162 (PRD M2-13). Every property is checked first; any problem (no such plan or room type, a derived plan's price, a date before that property's today, a property you can't change group rates in) refuses the whole change with each problem named, and nothing is written. Then all properties change in one go. A percentage or an amount moves each day's own price (days without one stay so); one price for all needs one currency. At most ${MAX_BULK_DAYS} days. \`dryRun\` counts without writing.`,
  idempotent: true,
  body: GroupRateChangeBody,
  response: GroupRateChangeResult,
});

export const GROUP_ROUTES = {
  getGroupDashboard,
  getGroupRates,
  putGroupRates,
  changeGroupRates,
} as const;
