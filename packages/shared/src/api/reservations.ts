import { z } from 'zod';
import { BOOKING_SOURCES, CANCEL_REASONS, RESERVATION_STATUSES } from '../reservations.ts';
import { Email, Phone } from './auth.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, page, PageQuery, Uuid } from './primitives.ts';
import { GUARANTEES } from './rates.ts';
import { HK_STATUSES } from './rooms.ts';
import { ID_TYPES, STAY_PURPOSES } from '../registration.ts';

// Reservations (tab 4 row "Reservations" and the POST /reservations example; PRD M3-01–M3-05,
// M3 rules 1 and 8; S09; T-042). A booking is made from quotes (one per room), so it charges
// exactly the quoted nights; it takes inventory in the same transaction (sold when confirmed,
// held while tentative) and answers BOOKING_CONFLICT when a night has no room left.

const Name = z.string().trim().min(1).max(80);

/** An existing guest, or the details of a new one (a profile is created). */
export const Booker = z
  .object({
    guestId: Uuid.nullable().default(null),
    firstName: Name.optional(),
    lastName: Name.optional(),
    phone: Phone.nullable().default(null),
    email: Email.nullable().default(null),
  })
  .refine((b) => b.guestId !== null || (b.firstName && b.lastName), {
    message: 'Choose a guest or give a first and last name',
    path: ['lastName'],
  });

export const StayGuest = z
  .object({
    sameAsBooker: z.boolean().default(false),
    guestId: Uuid.nullable().default(null),
    firstName: Name.optional(),
    lastName: Name.optional(),
    phone: Phone.nullable().default(null),
    email: Email.nullable().default(null),
  })
  .refine((g) => g.sameAsBooker || g.guestId !== null || (g.firstName && g.lastName), {
    message: 'Same as the booker, a guest, or a first and last name',
    path: ['lastName'],
  });

export const NewStay = z.object({
  quoteId: Uuid,
  /** Must add up to the guests the quote was priced for; defaults to that many adults. */
  adults: z.number().int().min(1).max(20).optional(),
  children: z.number().int().min(0).max(20).optional(),
  guest: StayGuest.default({
    sameAsBooker: true,
    guestId: null,
    phone: null,
    email: null,
  }),
  /** Assigning rooms arrives with T-050; send null. */
  roomId: Uuid.nullable().default(null),
});

export const ReservationBody = z.object({
  source: z.enum(BOOKING_SOURCES),
  guarantee: z.enum(GUARANTEES).default('NONE'),
  /** Set for a tentative hold (M3-02): inventory is held until then, then released. */
  holdUntil: Instant.nullable().default(null),
  booker: Booker,
  companyId: Uuid.nullable().default(null),
  /** One stay per room (M3-05): one booker, a guest per room. */
  stays: z.array(NewStay).min(1).max(20),
  notes: z.string().trim().max(2000).nullable().default(null),
  /** Needed when a guest is flagged do-not-rent and a manager must approve (M3 rule 8). */
  approvalReason: z.string().trim().max(500).optional(),
});

const GuestRef = z.object({
  id: Uuid,
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
});

export const StayItem = z
  .object({
    id: Uuid,
    status: z.enum(RESERVATION_STATUSES),
    guest: GuestRef,
    roomTypeId: Uuid,
    roomTypeName: z.string(),
    roomId: Uuid.nullable(),
    roomNumber: z.string().nullable(),
    ratePlanId: Uuid,
    ratePlanCode: z.string(),
    arrival: IsoDate,
    departure: IsoDate,
    adults: z.number().int(),
    children: z.number().int(),
    folioId: Uuid.nullable(),
    /** Nightly prices as quoted (M2 rule 4). */
    nights: z.array(z.object({ date: IsoDate, amountMinor: AmountMinor })),
    /** What the guest pays for this stay, taxes included (from its quote). */
    totalMinor: AmountMinor,
    version: z.number().int(),
  })
  .meta({ id: 'Stay' });

export const ReservationItem = z
  .object({
    id: Uuid,
    confirmationNo: z.string(),
    status: z.enum(RESERVATION_STATUSES),
    source: z.enum(BOOKING_SOURCES),
    guarantee: z.enum(GUARANTEES),
    holdExpiresAt: Instant.nullable(),
    booker: GuestRef,
    company: z.object({ id: Uuid, name: z.string() }).nullable(),
    notes: z.string().nullable(),
    cancelReason: z.string().nullable(),
    cancelledAt: Instant.nullable(),
    currency: z.string(),
    totalMinor: AmountMinor,
    /** First night of each stay when the guarantee is DEPOSIT, else 0. */
    depositDueMinor: AmountMinor,
    stays: z.array(StayItem),
    createdAt: Instant,
    updatedAt: Instant,
    /** Send as `If-Match: "<version>"` when changing the reservation. */
    version: z.number().int(),
  })
  .meta({ id: 'Reservation' });

export const ReservationSummary = z
  .object({
    id: Uuid,
    confirmationNo: z.string(),
    status: z.enum(RESERVATION_STATUSES),
    source: z.enum(BOOKING_SOURCES),
    bookerName: z.string(),
    arrival: IsoDate,
    departure: IsoDate,
    rooms: z.number().int(),
    totalMinor: AmountMinor,
    holdExpiresAt: Instant.nullable(),
  })
  .meta({ id: 'ReservationSummary' });

export const ReservationQuery = PageQuery.extend({
  /** Confirmation number, or the start of the booker's last name, or phone digits. */
  q: z.string().trim().max(100).optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
  /** Stays arriving from (inclusive) … to (inclusive). */
  arrivalFrom: IsoDate.optional(),
  arrivalTo: IsoDate.optional(),
});

const ReservationParams = z.object({ reservationId: Uuid });

export const listReservations = defineRoute({
  operationId: 'listReservations',
  method: 'get',
  path: '/reservations',
  summary: 'Find reservations (newest first)',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'frontdesk.read',
  query: ReservationQuery,
  response: page(ReservationSummary),
});

export const createReservation = defineRoute({
  operationId: 'createReservation',
  method: 'post',
  path: '/reservations',
  summary: 'Book one or more rooms from quotes',
  description:
    'Each stay names a quote (POST /quotes) that has not expired; its nights and prices are kept. With `holdUntil` the booking is a tentative hold that is released when it runs out; without, it is confirmed. A do-not-rent guest needs a manager’s approval: the answer is 202 with the request (give `approvalReason`), unless the caller can approve.',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'reservation.create',
  idempotent: true,
  approval: true,
  body: ReservationBody,
  status: 201,
  response: ReservationItem,
  errors: ['BOOKING_CONFLICT', 'PROPERTY_NOT_LIVE', 'STATE_TRANSITION_INVALID'],
});

export const getReservation = defineRoute({
  operationId: 'getReservation',
  method: 'get',
  path: '/reservations/{reservationId}',
  summary: 'A reservation with its stays',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'frontdesk.read',
  params: ReservationParams,
  response: ReservationItem,
});

export const StayChange = z.object({
  stayId: Uuid,
  /** A new quote: new dates, room type or plan (M3-03). */
  quoteId: Uuid.optional(),
  adults: z.number().int().min(1).max(20).optional(),
  children: z.number().int().min(0).max(20).optional(),
  guestId: Uuid.optional(),
});

export const ReservationPatchBody = z
  .object({
    notes: z.string().trim().max(2000).nullable().optional(),
    guarantee: z.enum(GUARANTEES).optional(),
    companyId: Uuid.nullable().optional(),
    /** A tentative hold only: move its expiry. */
    holdUntil: Instant.optional(),
    /** Turn a tentative hold into a confirmed booking. */
    confirm: z.literal(true).optional(),
    stays: z.array(StayChange).min(1).max(20).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'Change at least one thing',
  });

export const ReservationChange = ReservationItem.extend({
  /** New total minus the old one (negative when the guest now pays less). */
  differenceMinor: AmountMinor,
}).meta({ id: 'ReservationChange' });

export const updateReservation = defineRoute({
  operationId: 'updateReservation',
  method: 'patch',
  path: '/reservations/{reservationId}',
  summary: 'Change a reservation: details, a stay’s quote or guests, or confirm a hold',
  description:
    'A stay changed to a new quote gives back its old nights and takes the new ones in one transaction (BOOKING_CONFLICT if a night is full); the answer says how much the total changed.',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'reservation.modify',
  ifMatch: true,
  params: ReservationParams,
  body: ReservationPatchBody,
  response: ReservationChange,
  errors: ['BOOKING_CONFLICT', 'VERSION_CONFLICT', 'STATE_TRANSITION_INVALID'],
});

export const CancelBody = z.object({
  reason: z.enum(CANCEL_REASONS),
  note: z.string().trim().max(500).nullable().default(null),
});

export const ReservationCancelled = ReservationItem.extend({
  /** Cancellation fee per the plans' policies; posted to the folio with T-060. */
  feeMinor: AmountMinor,
}).meta({ id: 'ReservationCancelled' });

export const cancelReservation = defineRoute({
  operationId: 'cancelReservation',
  method: 'post',
  path: '/reservations/{reservationId}/cancel',
  summary: 'Cancel with a reason; gives back the rooms and works out the fee',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'reservation.cancel',
  idempotent: true,
  params: ReservationParams,
  body: CancelBody,
  response: ReservationCancelled,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const reinstateReservation = defineRoute({
  operationId: 'reinstateReservation',
  method: 'post',
  path: '/reservations/{reservationId}/reinstate',
  summary: 'Bring back a cancelled reservation if its rooms are still free',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'reservation.modify',
  idempotent: true,
  params: ReservationParams,
  response: ReservationItem,
  errors: ['BOOKING_CONFLICT', 'STATE_TRANSITION_INVALID'],
});

export const ReservationHistoryItem = z
  .object({
    at: Instant,
    stayId: Uuid.nullable(),
    fromStatus: z.enum(RESERVATION_STATUSES).nullable(),
    toStatus: z.enum(RESERVATION_STATUSES),
    reason: z.string().nullable(),
    byName: z.string().nullable(),
  })
  .meta({ id: 'ReservationHistoryItem' });

export const getReservationHistory = defineRoute({
  operationId: 'getReservationHistory',
  method: 'get',
  path: '/reservations/{reservationId}/history',
  summary: 'Status changes of a reservation, oldest first',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'frontdesk.read',
  params: ReservationParams,
  response: z.object({ data: z.array(ReservationHistoryItem) }),
});

// ── Calendar (S07; T-044) ──────────────────────────────────────────────────────────────

/** Longest window the calendar reads at once. */
export const CALENDAR_MAX_DAYS = 31;

export const CalendarQuery = z
  .object({
    from: IsoDate,
    /** Exclusive. */
    to: IsoDate,
  })
  .refine((q) => q.to > q.from, { message: 'End after the start', path: ['to'] })
  .refine(
    (q) =>
      (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 <=
      CALENDAR_MAX_DAYS,
    { message: `At most ${CALENDAR_MAX_DAYS} days`, path: ['to'] },
  );

export const CalendarStay = z
  .object({
    id: Uuid,
    reservationId: Uuid,
    confirmationNo: z.string(),
    status: z.enum(RESERVATION_STATUSES),
    roomTypeId: Uuid,
    /** The current room; null until one is assigned (shown on the type's unassigned row). */
    roomId: Uuid.nullable(),
    /** Which room on which nights (a moved guest has two); empty while unassigned. */
    rooms: z.array(z.object({ roomId: Uuid, startDate: IsoDate, endDate: IsoDate })),
    arrival: IsoDate,
    departure: IsoDate,
    guestName: z.string(),
    adults: z.number().int(),
    children: z.number().int(),
  })
  .meta({ id: 'CalendarStay' });

export const getCalendar = defineRoute({
  operationId: 'getCalendar',
  method: 'get',
  path: '/calendar',
  summary: 'Stays in a date window, for the reservation calendar',
  description: `Stays that are in the hotel on any night from \`from\` up to \`to\` (exclusive; at most ${CALENDAR_MAX_DAYS} days), cancelled and no-show ones left out. Rooms, blocks and rooms left come from GET /rooms and GET /inventory.`,
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'frontdesk.read',
  query: CalendarQuery,
  response: z.object({ data: z.array(CalendarStay) }),
});

// ── Rooms for stays (M3-07, M3-11; T-050) ──────────────────────────────────────────────

const StayParams = z.object({ stayId: Uuid });

/** Why a free room is not ready for a guest arriving today (M3-07). */
export const ROOM_PROBLEMS = ['NOT_CLEAN', 'OCCUPIED'] as const;

export const AssignableRoom = z
  .object({
    id: Uuid,
    number: z.string(),
    floor: z.string().nullable(),
    hkStatus: z.enum(HK_STATUSES),
    /** Empty when the room can be given as it is; else it needs an approved override. */
    problems: z.array(z.enum(ROOM_PROBLEMS)),
  })
  .meta({ id: 'AssignableRoom' });

export const listAssignableRooms = defineRoute({
  operationId: 'listAssignableRooms',
  method: 'get',
  path: '/stays/{stayId}/rooms',
  summary: 'Rooms of the stay’s type that are free for its remaining nights',
  description:
    'Active rooms of the type with no block and no other stay on those nights. For a guest arriving today, `problems` says when the room is not clean or inspected, or still has a guest in it.',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'room.assign',
  params: StayParams,
  response: z.object({ data: z.array(AssignableRoom) }),
});

export const AssignRoomBody = z.object({
  /** Null takes the room back (before check-in). */
  roomId: Uuid.nullable(),
  /** A room that is not ready, for a guest arriving today: a manager must approve. */
  overrideReason: z.string().trim().min(1).max(500).optional(),
});

export const assignRoom = defineRoute({
  operationId: 'assignRoom',
  method: 'post',
  path: '/stays/{stayId}/assign-room',
  summary: 'Give a stay a room, change it, or take it back (before check-in)',
  description:
    'The room must be of the stay’s type, active, unblocked and free on every night (409 BOOKING_CONFLICT). For a guest arriving today it must be clean or inspected and empty: otherwise 409 ROOM_NOT_READY, or with `overrideReason` a manager’s approval (202) unless the caller can approve. A checked-in guest is moved with /move.',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'room.assign',
  approval: true,
  params: StayParams,
  body: AssignRoomBody,
  response: ReservationItem,
  errors: ['BOOKING_CONFLICT', 'ROOM_NOT_READY', 'STATE_TRANSITION_INVALID'],
});

export const MoveBody = z.object({
  roomId: Uuid,
  reason: z.string().trim().min(1).max(500),
});

export const moveStay = defineRoute({
  operationId: 'moveStay',
  method: 'post',
  path: '/stays/{stayId}/move',
  summary: 'Move a checked-in guest to another room of the same type, with a reason',
  description:
    'From today to the end of the stay; the old room becomes dirty and the stay keeps its folio. The new room must be clean or inspected and empty (409 ROOM_NOT_READY). Between 00:00 and 05:00 at the property a move needs approval (202) unless the caller’s role allows it.',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'room.move',
  idempotent: true,
  approval: true,
  params: StayParams,
  body: MoveBody,
  response: ReservationItem,
  errors: ['BOOKING_CONFLICT', 'ROOM_NOT_READY', 'STATE_TRANSITION_INVALID'],
});

// ── Check-in, registration card and keys (M3-08, M3-19, M3 rules 2 and 6; T-051) ─────

export const RegistrationBody = z.object({
  nationality: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Two-letter country code, e.g. NG')
    .optional(),
  address: z.string().trim().min(1).max(300).optional(),
  purpose: z.enum(STAY_PURPOSES).optional(),
  idType: z.enum(ID_TYPES).optional(),
  idNumber: z.string().trim().min(3).max(40).optional(),
  idExpiry: IsoDate.optional(),
  /** A scan or photo of the ID (an uploaded IdDocument file). */
  idFileId: Uuid.optional(),
});

export const CheckInBody = z.object({
  /** The room, when the stay has none yet or gets another one now; else its assigned room. */
  roomId: Uuid.optional(),
  /** Only the fields the property requires are kept; the others are ignored. */
  registration: RegistrationBody.default({}),
  /** The guest's signature drawn on screen (a RegistrationCard file); none = signed on paper. */
  signatureFileId: Uuid.optional(),
  keysIssued: z.number().int().min(0).max(10).default(0),
});

export const CheckInResult = z
  .object({
    stayId: Uuid,
    status: z.enum(RESERVATION_STATUSES),
    /** The stay's folio; folios arrive with T-060. */
    folioId: Uuid.nullable(),
    roomId: Uuid,
    version: z.number().int(),
  })
  .meta({ id: 'CheckInResult' });

export const checkIn = defineRoute({
  operationId: 'checkIn',
  method: 'post',
  path: '/stays/{stayId}/check-in',
  summary: 'Check a guest in: room, registration details, signature and keys',
  description:
    'The stay must be confirmed and arriving today (or overdue). The room must be clean or inspected and empty, unless it was given with an approved override (409 ROOM_NOT_READY). Every registration field the property requires must be filled (400). ID details are stored encrypted and deleted after the property’s retention period. Send `If-Match` with the stay’s version.',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'reservation.checkin',
  idempotent: true,
  ifMatch: true,
  params: StayParams,
  body: CheckInBody,
  response: CheckInResult,
  errors: ['ROOM_NOT_READY', 'BOOKING_CONFLICT', 'VERSION_CONFLICT', 'STATE_TRANSITION_INVALID'],
});

export const RegistrationCardItem = z
  .object({
    stayId: Uuid,
    confirmationNo: z.string(),
    property: z.object({ name: z.string(), address: z.string() }),
    guest: z.object({
      firstName: z.string(),
      lastName: z.string(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
    }),
    roomNumber: z.string(),
    roomTypeName: z.string(),
    arrival: IsoDate,
    departure: IsoDate,
    adults: z.number().int(),
    children: z.number().int(),
    nationality: z.string().nullable(),
    address: z.string().nullable(),
    purpose: z.enum(STAY_PURPOSES).nullable(),
    idType: z.enum(ID_TYPES).nullable(),
    /** Only the last four characters, e.g. "•••• 4567"; null once purged or not collected. */
    idNumberMasked: z.string().nullable(),
    idExpiry: IsoDate.nullable(),
    /** Signed on screen (a signature image) or on the printed card. */
    signature: z.enum(['SCREEN', 'PAPER']),
    signatureFileId: Uuid.nullable(),
    checkedInAt: Instant,
    checkedInBy: z.string().nullable(),
  })
  .meta({ id: 'RegistrationCard' });

export const getRegistrationCard = defineRoute({
  operationId: 'getRegistrationCard',
  method: 'get',
  path: '/stays/{stayId}/registration-card',
  summary: 'The registration card of a checked-in stay, for printing',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'frontdesk.read',
  params: StayParams,
  response: RegistrationCardItem,
});

export const KeyIssueItem = z
  .object({
    id: Uuid,
    roomNumber: z.string(),
    count: z.number().int(),
    issuedBy: z.string().nullable(),
    issuedAt: Instant,
  })
  .meta({ id: 'KeyIssue' });

export const listKeys = defineRoute({
  operationId: 'listKeys',
  method: 'get',
  path: '/stays/{stayId}/keys',
  summary: 'Key cards issued for a stay, newest first',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'frontdesk.read',
  params: StayParams,
  response: z.object({ data: z.array(KeyIssueItem) }),
});

export const issueKeys = defineRoute({
  operationId: 'issueKeys',
  method: 'post',
  path: '/stays/{stayId}/keys',
  summary: 'Log key cards issued to a checked-in guest (M3-19)',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'key.issue',
  params: StayParams,
  body: z.object({ count: z.number().int().min(1).max(10) }),
  status: 201,
  response: KeyIssueItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const RESERVATION_ROUTES = {
  listReservations,
  createReservation,
  getReservation,
  updateReservation,
  cancelReservation,
  reinstateReservation,
  getReservationHistory,
  getCalendar,
  listAssignableRooms,
  assignRoom,
  moveStay,
  checkIn,
  getRegistrationCard,
  listKeys,
  issueKeys,
} as const;
