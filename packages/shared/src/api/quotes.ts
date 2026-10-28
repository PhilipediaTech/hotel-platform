import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';
import { MEAL_PLANS, GUARANTEES, RATE_PLAN_KINDS } from './rates.ts';

// Availability search and quotes (tab 4 row "Availability" and the POST /quotes example;
// PRD M2-06, M2-09, M2-10, M2 rules 1, 4–5; T-041). Availability is worked out live from the
// inventory, rates and restrictions (no cache); a quote keeps nightly prices, rule versions
// and taxes for 30 minutes so a booking made from it charges exactly that.

export const QUOTE_MINUTES = 30;
/** Longest stay one search or quote covers. */
export const MAX_STAY_NIGHTS = 60;

/** Why a plan can't be sold for the stay: a restriction (M2-06) or no price on a night. */
export const VIOLATION_RULES = [
  'STOP_SELL',
  'CLOSED_TO_ARRIVAL',
  'CLOSED_TO_DEPARTURE',
  'MIN_STAY',
  'MAX_STAY',
  'NO_PRICE',
] as const;

export const Violation = z
  .object({
    rule: z.enum(VIOLATION_RULES),
    date: IsoDate,
    limit: z.number().int().optional(),
  })
  .meta({ id: 'RestrictionViolation' });

const Stay = z.object({
  arrival: IsoDate,
  departure: IsoDate,
  adults: z.coerce.number().int().min(1).max(20),
  children: z.coerce.number().int().min(0).max(20).default(0),
});

export const AvailabilityQuery = Stay.extend({ roomTypeId: Uuid.optional() });

export const AvailabilityPlan = z
  .object({
    ratePlanId: Uuid,
    code: z.string(),
    name: z.string(),
    kind: z.enum(RATE_PLAN_KINDS),
    mealPlan: z.enum(MEAL_PLANS),
    guarantee: z.enum(GUARANTEES),
    /** Room price for the whole stay before taxes; null when a night has no price. */
    roomMinor: AmountMinor.nullable(),
    /** What the guest pays, taxes included. */
    totalMinor: AmountMinor.nullable(),
    /** True when nothing below stops the sale and a room is left. */
    sellable: z.boolean(),
    violations: z.array(Violation),
  })
  .meta({ id: 'AvailabilityPlan' });

export const AvailabilityRoomType = z
  .object({
    roomTypeId: Uuid,
    code: z.string(),
    name: z.string(),
    maxOccupancy: z.number().int(),
    /** Rooms left on the fullest night (overbooking included; M2 rule 1). */
    available: z.number().int(),
    plans: z.array(AvailabilityPlan),
  })
  .meta({ id: 'AvailabilityRoomType' });

export const getAvailability = defineRoute({
  operationId: 'getAvailability',
  method: 'get',
  path: '/availability',
  summary: 'Room types that fit the guests, rooms left, and the price per rate plan',
  description: `Overnight stays from today, at most ${MAX_STAY_NIGHTS} nights. Day-use plans are quoted with day-use bookings (T-052).`,
  tags: ['Availability'],
  propertyScoped: true,
  permission: 'availability.read',
  query: AvailabilityQuery,
  response: z.object({
    arrival: IsoDate,
    departure: IsoDate,
    nights: z.number().int(),
    currency: z.string(),
    roomTypes: z.array(AvailabilityRoomType),
  }),
});

export const QuoteBody = Stay.extend({ roomTypeId: Uuid, ratePlanId: Uuid });

export const QuoteItem = z
  .object({
    quoteId: Uuid,
    ratePlanId: Uuid,
    roomTypeId: Uuid,
    arrival: IsoDate,
    departure: IsoDate,
    currency: z.string(),
    nights: z.array(
      z.object({
        date: IsoDate,
        amountMinor: AmountMinor,
        /** Version of the rate day that priced the night (M2 rule 4). */
        ruleVersion: z.number().int(),
      }),
    ),
    /** Per tax line code (e.g. SVC, VAT, LCT), summed over the nights. */
    taxes: z.array(z.object({ code: z.string(), name: z.string(), amountMinor: AmountMinor })),
    /** Room price before taxes (inclusive taxes taken out). */
    netMinor: AmountMinor,
    totalMinor: AmountMinor,
    createdAt: Instant,
    expiresAt: Instant,
  })
  .meta({ id: 'Quote' });

export const createQuote = defineRoute({
  operationId: 'createQuote',
  method: 'post',
  path: '/quotes',
  summary: 'Price a stay on one rate plan; the quote holds for 30 minutes',
  description:
    'Answers 422 RESTRICTION_VIOLATED with details.violations (min/max stay, closed to arrival or departure, stop-sell, no price), 409 BOOKING_CONFLICT with details.dates when no room of the type is left, and 409 STATE_TRANSITION_INVALID when the property has no room revenue code yet.',
  tags: ['Availability'],
  propertyScoped: true,
  permission: 'availability.read',
  body: QuoteBody,
  status: 201,
  response: QuoteItem,
  errors: ['RESTRICTION_VIOLATED', 'BOOKING_CONFLICT', 'STATE_TRANSITION_INVALID'],
});

export const QUOTE_ROUTES = { getAvailability, createQuote } as const;
