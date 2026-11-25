import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { RateText } from './fx.ts';
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

export const GROUP_ROUTES = { getGroupDashboard, getGroupRates, putGroupRates } as const;
