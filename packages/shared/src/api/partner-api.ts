import { z } from 'zod';
import { BOOKING_SOURCES, RESERVATION_STATUSES } from '../reservations.ts';
import { defineRoute } from './contract.ts';
import { FOLIO_STATUSES } from './folios.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';
import { GUARANTEES } from './rates.ts';

// The partner API (Versions V2 "Partner API and webhooks, accounting and POS integrations";
// T-166, Philip's choice: keys and webhooks first, integrations generic). An outside system
// (accounting, a POS, a revenue tool) reads one property with a key the hotel made for it:
// `Authorization: Bearer hk_…`; each key holds only the scopes it was given. The one write is
// an outside POS charging a guest's room (pos:charge, T-167).
// What changes is pushed to the hotel's webhook endpoints (integrations.ts).

const ADDED = 'Not in tab 4: designed in T-166 (Versions V2, partner API).';

export const API_SCOPES = [
  'availability:read',
  'reservations:read',
  /** With reservations:read: the booker's email and phone. */
  'guests:read',
  'folios:read',
  /** An outside POS: in-house rooms, revenue codes, and charges to a room (T-167). */
  'pos:charge',
] as const;
export const ApiScope = z.enum(API_SCOPES);
export type ApiScope = z.infer<typeof ApiScope>;

/** Every key starts with this, so a leaked one is easy to recognise. */
export const API_KEY_PREFIX = 'hk_';

/**
 * What a webhook endpoint can be sent (outbox event types; tab 2 "Audit, outbox and jobs"),
 * each with the payload fields passed on: IDs and plain facts, never guest details.
 */
export const PARTNER_EVENTS = {
  'reservation.created': ['reservationId', 'confirmationNo', 'status'],
  'reservation.modified': ['reservationId'],
  'reservation.cancelled': ['reservationId', 'feeMinor'],
  'reservation.reinstated': ['reservationId'],
  'reservation.no_show': ['reservationId', 'stayId', 'feeMinor'],
  'stay.checked_in': ['stayId', 'reservationId', 'roomId'],
  'stay.checked_out': ['stayId', 'reservationId', 'roomId'],
  'folio.charge_posted': ['folioId', 'lineIds'],
  'payment.captured': ['paymentId'],
  'payment.refunded': ['refundId'],
  /** A day's accounts are closed: the accounting journal for it can be built (T-148). */
  'business_day.closed': ['businessDate', 'nextBusinessDate'],
} as const satisfies Record<string, readonly string[]>;
export type PartnerEventType = keyof typeof PARTNER_EVENTS;
export const PARTNER_EVENT_TYPES = Object.keys(PARTNER_EVENTS) as [
  PartnerEventType,
  ...PartnerEventType[],
];
export const PartnerEventType = z.enum(PARTNER_EVENT_TYPES);
/** Sent by "Send a test": not an outbox event. */
export const TEST_EVENT_TYPE = 'webhook.test';

export const PartnerProperty = z
  .object({
    id: Uuid,
    name: z.string(),
    timeZone: z.string(),
    currency: z.string(),
    checkInTime: z.string(),
    checkOutTime: z.string(),
    roomTypes: z.array(z.object({ id: Uuid, code: z.string(), name: z.string() })),
    /** What this key may read. */
    scopes: z.array(ApiScope),
  })
  .meta({ id: 'PartnerProperty' });

export const getPartnerProperty = defineRoute({
  operationId: 'getPartnerProperty',
  method: 'get',
  path: '/partner/property',
  summary: 'The property this key belongs to, its room types, and what the key may read',
  description: ADDED,
  tags: ['Partner API'],
  auth: 'apiKey',
  response: PartnerProperty,
});

export const MAX_PARTNER_AVAILABILITY_DAYS = 90;

export const PartnerAvailabilityDay = z.object({
  date: IsoDate,
  roomTypeId: Uuid,
  roomTypeCode: z.string(),
  /** Rooms that can still be sold that night (the same figure the desk sees). */
  available: z.number().int(),
  capacity: z.number().int(),
  sold: z.number().int(),
});

export const getPartnerAvailability = defineRoute({
  operationId: 'getPartnerAvailability',
  method: 'get',
  path: '/partner/availability',
  summary: 'Rooms left to sell, per room type and night',
  description: `${ADDED} At most ${MAX_PARTNER_AVAILABILITY_DAYS} nights.`,
  tags: ['Partner API'],
  auth: 'apiKey',
  scope: 'availability:read',
  query: z.object({ from: IsoDate, to: IsoDate }),
  response: z.object({ days: z.array(PartnerAvailabilityDay) }),
});

export const PartnerReservation = z
  .object({
    id: Uuid,
    confirmationNo: z.string(),
    status: z.enum(RESERVATION_STATUSES),
    source: z.enum(BOOKING_SOURCES),
    /** The channel's own booking reference (OTA bookings). */
    channelRef: z.string().nullable(),
    guarantee: z.enum(GUARANTEES),
    booker: z.object({
      firstName: z.string(),
      lastName: z.string(),
      /** Only for a key with guests:read. */
      email: z.string().nullable(),
      phone: z.string().nullable(),
    }),
    companyName: z.string().nullable(),
    createdAt: Instant,
    updatedAt: Instant,
    cancelledAt: Instant.nullable(),
    stays: z.array(
      z.object({
        id: Uuid,
        status: z.enum(RESERVATION_STATUSES),
        arrival: IsoDate,
        departure: IsoDate,
        adults: z.number().int(),
        children: z.number().int(),
        isDayUse: z.boolean(),
        roomTypeCode: z.string(),
        ratePlanCode: z.string(),
        roomNumber: z.string().nullable(),
        checkedInAt: Instant.nullable(),
        checkedOutAt: Instant.nullable(),
      }),
    ),
  })
  .meta({ id: 'PartnerReservation' });

export const MAX_PARTNER_PAGE = 100;

export const listPartnerReservations = defineRoute({
  operationId: 'listPartnerReservations',
  method: 'get',
  path: '/partner/reservations',
  summary: 'Reservations, oldest change first: page with `cursor` to follow every change',
  description: `${ADDED} \`updatedSince\` and \`cursor\` give each reservation changed since a point; the arrival filters narrow by first arrival.`,
  tags: ['Partner API'],
  auth: 'apiKey',
  scope: 'reservations:read',
  query: z.object({
    updatedSince: Instant.optional(),
    arrivalFrom: IsoDate.optional(),
    arrivalTo: IsoDate.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PARTNER_PAGE).default(50),
  }),
  response: z.object({ data: z.array(PartnerReservation), nextCursor: z.string().nullable() }),
  errors: ['VALIDATION_ERROR'],
});

export const getPartnerReservation = defineRoute({
  operationId: 'getPartnerReservation',
  method: 'get',
  path: '/partner/reservations/{reservationId}',
  summary: 'One reservation and its stays',
  description: ADDED,
  tags: ['Partner API'],
  auth: 'apiKey',
  scope: 'reservations:read',
  params: z.object({ reservationId: Uuid }),
  response: PartnerReservation,
});

export const PartnerFolio = z.object({
  id: Uuid,
  number: z.string(),
  status: z.enum(FOLIO_STATUSES),
  currency: z.string(),
  /** Charges less reversals, tax included. */
  chargesMinor: AmountMinor,
  paymentsMinor: AmountMinor,
  balanceMinor: AmountMinor,
});

export const listPartnerReservationFolios = defineRoute({
  operationId: 'listPartnerReservationFolios',
  method: 'get',
  path: '/partner/reservations/{reservationId}/folios',
  summary: 'The bills of a reservation, with their totals',
  description: ADDED,
  tags: ['Partner API'],
  auth: 'apiKey',
  scope: 'folios:read',
  params: z.object({ reservationId: Uuid }),
  response: z.object({ data: z.array(PartnerFolio) }),
});

// ── Room charges from an outside POS (T-167; Philip's choice: room number and surname) ──

const ADDED_POS = 'Not in tab 4: designed in T-167 (Versions V2, POS integration).';

export const PartnerInHouseRoom = z.object({
  stayId: Uuid,
  roomNumber: z.string(),
  arrival: IsoDate,
  departure: IsoDate,
  adults: z.number().int(),
  children: z.number().int(),
});

export const listPartnerInHouse = defineRoute({
  operationId: 'listPartnerInHouse',
  method: 'get',
  path: '/partner/in-house',
  summary: 'Rooms with a guest checked in who can take charges (no names: the guest gives theirs)',
  description: ADDED_POS,
  tags: ['Partner API'],
  auth: 'apiKey',
  scope: 'pos:charge',
  response: z.object({ data: z.array(PartnerInHouseRoom) }),
});

export const listPartnerRevenueCodes = defineRoute({
  operationId: 'listPartnerRevenueCodes',
  method: 'get',
  path: '/partner/revenue-codes',
  summary: 'The revenue codes a charge can carry, to map the POS items to',
  description: ADDED_POS,
  tags: ['Partner API'],
  auth: 'apiKey',
  scope: 'pos:charge',
  response: z.object({
    data: z.array(z.object({ code: z.string(), name: z.string(), group: z.string() })),
  }),
});

export const PartnerRoomChargeBody = z.object({
  roomNumber: z.string().trim().min(1).max(20),
  /** The guest's surname as they give it at the till; must match the guest in the room. */
  lastName: z.string().trim().min(1).max(100),
  /** The POS's own check or bill number: the same one twice posts once. */
  checkNumber: z.string().trim().min(1).max(64),
  revenueCode: z.string().trim().min(1).max(20),
  description: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(999).default(1),
  /** Price of one, as charged (taxes added, or included when the tax is inclusive). */
  unitAmountMinor: AmountMinor,
});

export const PartnerRoomCharge = z
  .object({
    /** The charge line on the guest's bill. */
    chargeId: Uuid,
    stayId: Uuid,
    roomNumber: z.string(),
    checkNumber: z.string(),
    currency: z.string(),
    /** With the taxes the hotel's rules add. */
    totalMinor: AmountMinor,
    postedAt: Instant,
    /** True when this check number was posted before: nothing new was charged. */
    duplicate: z.boolean(),
  })
  .meta({ id: 'PartnerRoomCharge' });

export const createPartnerRoomCharge = defineRoute({
  operationId: 'createPartnerRoomCharge',
  method: 'post',
  path: '/partner/room-charges',
  summary: 'Charge a checked-in guest’s room; the same check number twice posts once',
  description: `${ADDED_POS} Refused unless the surname matches the guest in the room, the stay's bill is open and the room's credit limit allows it. A void is the hotel's (a reversal at the desk). The same check number again answers 200 with duplicate true; with different contents, 409 IDEMPOTENCY_KEY_REUSED.`,
  tags: ['Partner API'],
  auth: 'apiKey',
  scope: 'pos:charge',
  body: PartnerRoomChargeBody,
  status: 201,
  response: PartnerRoomCharge,
  errors: [
    'VALIDATION_ERROR',
    'STATE_TRANSITION_INVALID',
    'CREDIT_LIMIT_EXCEEDED',
    'BUSINESS_DAY_CLOSED',
    'IDEMPOTENCY_KEY_REUSED',
  ],
});

export const PARTNER_API_ROUTES = {
  listPartnerInHouse,
  listPartnerRevenueCodes,
  createPartnerRoomCharge,
  getPartnerProperty,
  getPartnerAvailability,
  listPartnerReservations,
  getPartnerReservation,
  listPartnerReservationFolios,
} as const;
