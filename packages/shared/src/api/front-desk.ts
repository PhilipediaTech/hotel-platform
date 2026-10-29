import { z } from 'zod';
import { BOOKING_SOURCES, RESERVATION_STATUSES } from '../reservations.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';
import { GUARANTEES } from './rates.ts';
import { DayUseTimes } from './reservations.ts';
import { HK_STATUSES } from './rooms.ts';

// Front desk lists (PRD M3-06; tab 4 row "Front desk"; S06; T-053): arrivals, departures and
// in-house guests for the business date, with balances and flags per row. Until business days
// exist (T-054) the business date is today at the property; until folios exist (T-060) the
// balance is null.

/** What the desk should notice on a row. */
export const FRONT_DESK_FLAGS = [
  /** Guest marked VIP. */
  'VIP',
  /** Guest flagged do-not-rent (M3 rule 8). */
  'DO_NOT_RENT',
  /** A tentative hold, not confirmed yet. */
  'TENTATIVE',
  /** Arriving without a room assigned. */
  'NO_ROOM',
  /** The assigned room is not clean/inspected, or another guest is still in it. */
  'ROOM_NOT_READY',
  /** The plan asks for a deposit (payments arrive later: it shows until then). */
  'DEPOSIT_DUE',
  /** A day-use stay (M3-10). */
  'DAY_USE',
  /** Should have arrived or left already (or a day-use past its end time). */
  'OVERDUE',
  /** The reservation has notes. */
  'NOTES',
] as const;

export type FrontDeskFlag = (typeof FRONT_DESK_FLAGS)[number];

export const FrontDeskRow = z
  .object({
    stayId: Uuid,
    reservationId: Uuid,
    confirmationNo: z.string(),
    status: z.enum(RESERVATION_STATUSES),
    source: z.enum(BOOKING_SOURCES),
    guarantee: z.enum(GUARANTEES),
    guest: z.object({
      id: Uuid,
      firstName: z.string(),
      lastName: z.string(),
      phone: z.string().nullable(),
    }),
    roomTypeName: z.string(),
    roomId: Uuid.nullable(),
    roomNumber: z.string().nullable(),
    hkStatus: z.enum(HK_STATUSES).nullable(),
    ratePlanCode: z.string(),
    arrival: IsoDate,
    departure: IsoDate,
    nights: z.number().int(),
    adults: z.number().int(),
    children: z.number().int(),
    dayUse: DayUseTimes.nullable(),
    checkedInAt: Instant.nullable(),
    checkedOutAt: Instant.nullable(),
    /** What the stay costs, taxes included (from its quote). */
    totalMinor: AmountMinor,
    /** First night when the guarantee is a deposit, else 0. */
    depositDueMinor: AmountMinor,
    /** What the guest still owes on their folio; null until folios (T-060). */
    balanceMinor: AmountMinor.nullable(),
    flags: z.array(z.enum(FRONT_DESK_FLAGS)),
    notes: z.string().nullable(),
    /** The stay's version, for check-in and check-out (`If-Match`). */
    version: z.number().int(),
  })
  .meta({ id: 'FrontDeskRow' });

export const FrontDeskQuery = z.object({
  /** The business date; today at the property when left out. */
  date: IsoDate.optional(),
});

const FrontDeskList = z.object({ date: IsoDate, data: z.array(FrontDeskRow) });

export const listArrivals = defineRoute({
  operationId: 'listArrivals',
  method: 'get',
  path: '/front-desk/arrivals',
  summary: 'Guests arriving on the business date, and those already in',
  description:
    'Confirmed and tentative stays arriving that day (and, for today, earlier ones not arrived yet, flagged OVERDUE), then those checked in. Day-use stays are included with their hours.',
  tags: ['Front desk'],
  propertyScoped: true,
  permission: 'frontdesk.read',
  query: FrontDeskQuery,
  response: FrontDeskList,
});

export const listDepartures = defineRoute({
  operationId: 'listDepartures',
  method: 'get',
  path: '/front-desk/departures',
  summary: 'Guests leaving on the business date, and those already gone',
  description:
    'Checked-in stays departing that day (day-use stays on their date; for today, guests past their departure, flagged OVERDUE), then those checked out.',
  tags: ['Front desk'],
  propertyScoped: true,
  permission: 'frontdesk.read',
  query: FrontDeskQuery,
  response: FrontDeskList,
});

export const listInHouse = defineRoute({
  operationId: 'listInHouse',
  method: 'get',
  path: '/front-desk/in-house',
  summary: 'Guests checked in now',
  tags: ['Front desk'],
  propertyScoped: true,
  permission: 'frontdesk.read',
  response: FrontDeskList,
});

export const FRONT_DESK_ROUTES = { listArrivals, listDepartures, listInHouse } as const;
