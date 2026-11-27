import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate } from './primitives.ts';

// Pickup and pace (Versions V2 "revenue-management support"; T-165): for each coming night,
// what is on the books, how much was booked in the last 1, 7 and 30 days, and the same night a
// year earlier, both as it stood the same number of days before and as it finished.
//
// The forecast (Versions V3 "forecasting"; T-179; Philip chose rules, with AI only to explain,
// 2026-11-27) adds the rooms each night can be expected to finish with: on the books now plus
// how the same weekday picked up from the same point before, last year when the hotel has a
// year of history, otherwise over the last 8 weeks. Pickup is net of cancellations.

export const MAX_PACE_DAYS = 120;

const Count = z.number().int();

/** Where a night's expected pickup came from. */
export const FORECAST_METHODS = ['LAST_YEAR', 'RECENT_WEEKS', 'ON_THE_BOOKS'] as const;
/** Past same-weekday nights the recent-weeks method looks at. */
export const FORECAST_RECENT_WEEKS = 8;

export const PaceForecast = z.object({
  /** The likely finish: on the books plus the usual pickup, within 0 and rooms available. */
  rooms: Count,
  low: Count,
  high: Count,
  occupancyBps: Count,
  method: z.enum(FORECAST_METHODS),
  /** The usual (median) pickup from this point among the nights compared. */
  usualPickup: Count,
  /** How many past nights were compared (0 with ON_THE_BOOKS). */
  compared: Count,
});

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
  forecast: PaceForecast,
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
      forecast: z.object({ rooms: Count, low: Count, high: Count, occupancyBps: Count }),
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

export const explainPaceForecast = defineRoute({
  operationId: 'explainPaceForecast',
  method: 'post',
  path: '/reports/pace/explain',
  summary: 'A short AI note on the forecast, in plain words (T-179)',
  description:
    'Written only from the same figures as GET /reports/pace for these nights; a note with a number not among them is refused (503 AI_UNAVAILABLE). Reads only. 403 ALLOWANCE_USED_UP when the month’s AI allowance is gone.',
  tags: ['Reports'],
  propertyScoped: true,
  permission: 'report.dashboard',
  body: z.object({
    from: IsoDate.optional(),
    days: z.number().int().min(1).max(MAX_PACE_DAYS).default(30),
  }),
  response: z.object({ note: z.string() }),
  errors: ['AI_UNAVAILABLE', 'ALLOWANCE_USED_UP'],
});

export const PACE_ROUTES = { getPaceReport, explainPaceForecast } as const;
