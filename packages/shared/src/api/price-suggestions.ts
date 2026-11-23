import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, IsoDate, Uuid } from './primitives.ts';

// Price suggestions (PRD M14-13 "As a revenue user, I see suggested price changes per room type
// and date with the reason (booking pace, occupancy, past results); nothing changes until I
// accept", rate.manage; T-149). Worked out on request from the hotel's own books, never by a
// model, so each suggestion can show its arithmetic: rooms sold for the date, the same weekday
// last year at the same point before arrival, and how last year finished. Only best-available
// (BAR) plans are suggested on; derived plans follow them. Accepting writes the price into the
// rate calendar like any other price change, audited; nothing is stored until then. Strategy:
// Professional and Group plans (module "pricing").

export const PriceSuggestionItem = z
  .object({
    ratePlan: z.object({ id: Uuid, code: z.string(), name: z.string() }),
    roomType: z.object({ id: Uuid, code: z.string(), name: z.string() }),
    date: IsoDate,
    currentMinor: AmountMinor,
    suggestedMinor: AmountMinor,
    /** Basis points: +1000 is 10% up. */
    changeBps: z.number().int(),
    /** On the books now. */
    sold: z.number().int(),
    capacity: z.number().int(),
    daysOut: z.number().int(),
    lastYear: z
      .object({
        date: IsoDate,
        /** Sold for that date at the same number of days before it. */
        soldThen: z.number().int(),
        /** What it finished at. */
        soldFinal: z.number().int(),
        capacity: z.number().int(),
      })
      .nullable(),
    reasons: z.array(z.string()),
  })
  .meta({ id: 'PriceSuggestion' });

const PRICING = {
  tags: ['Rates'],
  propertyScoped: true as const,
  permission: 'rate.manage',
  module: 'pricing' as const,
};
const ADDED = 'Not in tab 4: designed in T-149 for M14-13.';

export const listPriceSuggestions = defineRoute({
  ...PRICING,
  operationId: 'listPriceSuggestions',
  method: 'get',
  path: '/price-suggestions',
  summary: 'Suggested price changes per room type and date, with their reasons (M14-13)',
  description: `${ADDED} From the business date for \`days\` days (default 30, at most 90). Only dates with a price and a change to suggest are listed.`,
  query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }),
  response: z.object({ data: z.array(PriceSuggestionItem), currency: z.string() }),
});

export const acceptPriceSuggestions = defineRoute({
  ...PRICING,
  operationId: 'acceptPriceSuggestions',
  method: 'post',
  path: '/price-suggestions/accept',
  summary: 'Accept suggestions, as suggested or changed: they become the prices (M14-13)',
  description: `${ADDED} Each item sets one room type's price on one date of a BAR plan, from today on, as a rate calendar change (audited, with the suggestion alongside).`,
  idempotent: true,
  body: z.object({
    items: z
      .array(
        z.object({
          ratePlanId: Uuid,
          roomTypeId: Uuid,
          date: IsoDate,
          amountMinor: AmountMinor.refine(
            (v) => /^\d+$/.test(v) && BigInt(v) > 0n,
            'More than zero',
          ),
          suggestedMinor: AmountMinor.optional(),
        }),
      )
      .min(1)
      .max(200),
  }),
  response: z.object({ changedDays: z.number().int() }),
});

export const PRICE_SUGGESTION_ROUTES = { listPriceSuggestions, acceptPriceSuggestions } as const;
