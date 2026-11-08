import { z } from 'zod';
import { BOOKING_SOURCES, RESERVATION_STATUSES } from '../reservations.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';
import { GUARANTEES } from './rates.ts';
import { DayUseTimes } from './reservations.ts';
import { HK_STATUSES } from './rooms.ts';
import { STAY_ALERT_KINDS } from './stay-alerts.ts';

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

// Stay alerts (PRD M14-01; T-055): what is about to go wrong, worked out live each time from
// the stays, the property's check-out time and its alert settings. The desk sees them on the
// front desk bell; the kinds the property chooses also go by WhatsApp to holders of
// `frontdesk.alerts.notify`, once per stay and business date.

export const StayAlert = z
  .object({
    kind: z.enum(STAY_ALERT_KINDS),
    stayId: Uuid,
    reservationId: Uuid,
    confirmationNo: z.string(),
    guestName: z.string(),
    roomNumber: z.string().nullable(),
    arrival: IsoDate,
    departure: IsoDate,
    /** When it happens: the check-out time, the day-use end or the hold expiry; null for a missing deposit. */
    at: Instant.nullable(),
    /** The deposit still to receive (DEPOSIT_MISSING), else 0. */
    depositDueMinor: AmountMinor,
    /** LATE_CHECK_OUT: a late check-out fee is already on the stay's folio. */
    lateFeePosted: z.boolean(),
    /** The stay's version, for check-out (`If-Match`). */
    version: z.number().int(),
  })
  .meta({ id: 'StayAlert' });

export const listStayAlerts = defineRoute({
  operationId: 'listStayAlerts',
  method: 'get',
  path: '/front-desk/alerts',
  summary: 'Late check-outs, departures due soon, holds about to expire and missing deposits',
  description:
    'Worked out at the time of the call (M14-01): late check-outs first, then due out, expiring holds and the next business date’s arrivals without their deposit. Also gives the property’s late check-out fee, so the desk can offer it.',
  tags: ['Front desk'],
  propertyScoped: true,
  permission: 'frontdesk.read',
  response: z.object({
    date: IsoDate,
    lateCheckOutFeeMinor: AmountMinor.nullable(),
    data: z.array(StayAlert),
  }),
});

export const postLateCheckOutFee = defineRoute({
  operationId: 'postLateCheckOutFee',
  method: 'post',
  path: '/stays/{stayId}/late-check-out-fee',
  summary: 'Post the property’s late check-out fee to a checked-in stay past its check-out time',
  description:
    'Posts once per stay (409 STATE_TRANSITION_INVALID when already posted, when the guest is not past the check-out time, or when the property has no fee set). The fee goes on the guest folio under the LATE system code.',
  tags: ['Front desk'],
  propertyScoped: true,
  permission: 'folio.charge',
  idempotent: true,
  params: z.object({ stayId: Uuid }),
  body: z.object({}),
  status: 201,
  response: z.object({ folioId: Uuid, amountMinor: AmountMinor }),
});

export const FRONT_DESK_ROUTES = {
  listArrivals,
  listDepartures,
  listInHouse,
  listStayAlerts,
  postLateCheckOutFee,
} as const;
