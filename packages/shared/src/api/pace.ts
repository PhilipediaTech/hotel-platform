import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate } from './primitives.ts';

// Pickup and pace (Versions V2 "revenue-management support"; T-165): for each coming night,
// what is on the books, how much was booked in the last 1, 7 and 30 days, and the same night a
// year earlier, both as it stood the same number of days before and as it finished.

export const MAX_PACE_DAYS = 120;

const Count = z.number().int();

export const PaceNight = z.object({
  date: IsoDate,
  /** Rooms that can be sold: active rooms less those blocked (out of order or service). */
  roomsAvailable: Count,
  rooms: Count,
  revenueMinor: AmountMinor,
  occupancyBps: Count,
  /** Rooms on the books now less rooms on the books 1, 7 and 30 days ago (negative: lost). */
  pickup: z.object({ d1: Count, d7: Count, d30: Count }),
  lastYear: z.object({
    /** The same weekday 52 weeks earlier. */
    date: IsoDate,
    /** On the books as it stood the same number of days before that night. */
    sameTime: Count,
    /** What it finished with. */
    final: Count,
  }),
});

export const PaceReport = z
  .object({
    from: IsoDate,
    days: Count,
    asOf: Instant,
    currency: z.string(),
    nights: z.array(PaceNight),
    totals: z.object({
      roomsAvailable: Count,
      rooms: Count,
      revenueMinor: AmountMinor,
      occupancyBps: Count,
      pickup: z.object({ d1: Count, d7: Count, d30: Count }),
      lastYear: z.object({ sameTime: Count, final: Count }),
    }),
    definitions: z.string(),
  })
  .meta({ id: 'PaceReport' });

export const getPaceReport = defineRoute({
  operationId: 'getPaceReport',
  method: 'get',
  path: '/reports/pace',
  summary: 'Pickup and pace: the coming nights on the books, recent pickup, and last year',
  description: `Not in tab 4: designed in T-165 (Versions V2, revenue-management support). From today by default; at most ${MAX_PACE_DAYS} nights.`,
  tags: ['Reports'],
  propertyScoped: true,
  permission: 'report.dashboard',
  query: z.object({
    from: IsoDate.optional(),
    days: z.coerce.number().int().min(1).max(MAX_PACE_DAYS).default(90),
  }),
  response: PaceReport,
});

export const PACE_ROUTES = { getPaceReport } as const;
