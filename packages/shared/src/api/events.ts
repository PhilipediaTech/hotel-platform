import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';

// Events and spaces, first part (PRD M9-01–M9-03, M9 rules and AC; tab 3 spaces, space_layouts,
// space_rate_rules, event_enquiries, event_bookings; tab 4 "Events"; S38; T-119): spaces and
// their prices, enquiries, availability including setup and cleanup, and expiring holds.

export const SPACE_RATE_UNITS = ['HOURLY', 'HALF_DAY', 'FULL_DAY', 'EXTRA'] as const;
export const SPACE_DAY_TYPES = ['ALL', 'WEEKDAY', 'WEEKEND'] as const;
export const EVENT_ENQUIRY_STATUSES = ['OPEN', 'WON', 'LOST'] as const;
export const EVENT_BOOKING_STATUSES = ['HOLD', 'CONFIRMED', 'RELEASED', 'EXPIRED'] as const;

/** Longest single booking of a space. */
export const EVENT_MAX_DAYS = 14;

const Name = z.string().trim().min(1).max(120);
const Minutes = z
  .number()
  .int()
  .min(0)
  .max(24 * 60);
const NonNegativeMinor = AmountMinor.refine((v) => !v.startsWith('-'), 'Must not be negative');

export const SpaceLayoutItem = z
  .object({ id: Uuid, name: z.string(), capacity: z.number().int() })
  .meta({ id: 'SpaceLayout' });

export const SpaceRateRuleItem = z
  .object({
    id: Uuid,
    name: z.string(),
    unit: z.enum(SPACE_RATE_UNITS),
    dayType: z.enum(SPACE_DAY_TYPES),
    seasonFrom: IsoDate.nullable(),
    seasonTo: IsoDate.nullable(),
    amountMinor: AmountMinor,
  })
  .meta({ id: 'SpaceRateRule' });

export const SpaceItem = z
  .object({
    id: Uuid,
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    setupMinutes: z.number().int(),
    cleanupMinutes: z.number().int(),
    minimumHireMinor: AmountMinor,
    active: z.boolean(),
    layouts: z.array(SpaceLayoutItem),
    rateRules: z.array(SpaceRateRuleItem),
  })
  .meta({ id: 'Space' });

const RateRuleBody = z
  .object({
    name: Name,
    unit: z.enum(SPACE_RATE_UNITS),
    dayType: z.enum(SPACE_DAY_TYPES).default('ALL'),
    seasonFrom: IsoDate.nullable().default(null),
    seasonTo: IsoDate.nullable().default(null),
    amountMinor: NonNegativeMinor,
  })
  .refine((r) => (r.seasonFrom === null) === (r.seasonTo === null), {
    path: ['seasonTo'],
    message: 'A season needs both a first and a last day',
  })
  .refine((r) => r.seasonFrom === null || r.seasonTo === null || r.seasonFrom <= r.seasonTo, {
    path: ['seasonTo'],
    message: 'A season ends on or after its first day',
  });

const distinctNames = (layouts: readonly { name: string }[]) =>
  new Set(layouts.map((l) => l.name.toLowerCase())).size === layouts.length;

export const SpaceBody = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/, 'Letters, numbers and dashes only'),
  name: Name,
  description: z.string().trim().max(2000).nullable().default(null),
  setupMinutes: Minutes.default(0),
  cleanupMinutes: Minutes.default(0),
  minimumHireMinor: NonNegativeMinor.default('0'),
  active: z.boolean().default(true),
  layouts: z
    .array(z.object({ name: Name, capacity: z.number().int().min(1).max(100_000) }))
    .min(1, 'Add at least one layout')
    .max(30)
    .refine(distinctNames, 'Each layout needs its own name'),
  rateRules: z.array(RateRuleBody).max(100).default([]),
});

export const EventBookingItem = z
  .object({
    id: Uuid,
    title: z.string(),
    status: z.enum(EVENT_BOOKING_STATUSES),
    space: z.object({ id: Uuid, name: z.string() }),
    layout: z.object({ id: Uuid, name: z.string() }).nullable(),
    enquiryId: Uuid.nullable(),
    startsAt: Instant,
    endsAt: Instant,
    /** The event with its setup and cleanup: nothing else can use the space then. */
    blockedFrom: Instant,
    blockedUntil: Instant,
    expectedGuests: z.number().int(),
    holdExpiresAt: Instant.nullable(),
    /** Confirmed without the signed contract or the deposit, on an approved override. */
    confirmedByOverride: z.boolean(),
  })
  .meta({ id: 'EventBooking' });

export const EventEnquiryItem = z
  .object({
    id: Uuid,
    status: z.enum(EVENT_ENQUIRY_STATUSES),
    contactName: z.string(),
    contactPhone: z.string().nullable(),
    contactEmail: z.string().nullable(),
    eventType: z.string(),
    eventDate: IsoDate.nullable(),
    expectedGuests: z.number().int().nullable(),
    notes: z.string().nullable(),
    lostReason: z.string().nullable(),
    createdAt: Instant,
    bookings: z.array(EventBookingItem),
  })
  .meta({ id: 'EventEnquiry' });

const EnquiryFields = {
  contactName: Name,
  contactPhone: z.string().trim().max(30).nullable().default(null),
  contactEmail: z.email().max(200).nullable().default(null),
  eventType: Name,
  eventDate: IsoDate.nullable().default(null),
  expectedGuests: z.number().int().min(1).max(100_000).nullable().default(null),
  notes: z.string().trim().max(4000).nullable().default(null),
};

export const EventEnquiryBody = z.object(EnquiryFields);

export const EventEnquiryUpdateBody = z
  .object({
    ...EnquiryFields,
    status: z.enum(['OPEN', 'LOST']),
    lostReason: z.string().trim().max(500).nullable().default(null),
  })
  .refine((b) => b.status !== 'LOST' || (b.lostReason ?? '').length > 0, {
    path: ['lostReason'],
    message: 'Say why the enquiry was lost',
  });

export const EventHoldBody = z
  .object({
    enquiryId: Uuid.nullable().default(null),
    spaceId: Uuid,
    layoutId: Uuid,
    title: Name,
    startsAt: Instant,
    endsAt: Instant,
    expectedGuests: z.number().int().min(1).max(100_000),
    holdUntil: Instant,
  })
  .refine((b) => b.endsAt > b.startsAt, {
    path: ['endsAt'],
    message: 'The event ends after it starts',
  });

export const SpaceAvailabilityItem = z
  .object({
    space: z.object({ id: Uuid, name: z.string() }),
    available: z.boolean(),
    /** The time this event would take up, with this space's setup and cleanup. */
    blockedFrom: Instant,
    blockedUntil: Instant,
    minimumHireMinor: AmountMinor,
    /** The layouts that seat the party; all of them when no party size was given. */
    layouts: z.array(SpaceLayoutItem),
    conflicts: z.array(
      z.object({
        title: z.string(),
        status: z.enum(['HOLD', 'CONFIRMED']),
        blockedFrom: Instant,
        blockedUntil: Instant,
      }),
    ),
  })
  .meta({ id: 'SpaceAvailability' });

const COMMON = {
  tags: ['Events'],
  propertyScoped: true as const,
  module: 'events' as const,
};
const READ = { ...COMMON, permission: 'event.enquiry' };

export const listSpaces = defineRoute({
  ...READ,
  operationId: 'listSpaces',
  method: 'get',
  path: '/spaces',
  summary: 'Event spaces with their layouts and prices (M9-01)',
  response: z.object({ data: z.array(SpaceItem) }),
});

export const createSpace = defineRoute({
  ...COMMON,
  permission: 'space.manage',
  operationId: 'createSpace',
  method: 'post',
  path: '/spaces',
  summary: 'Add an event space (M9-01)',
  status: 201,
  body: SpaceBody,
  response: SpaceItem,
});

export const updateSpace = defineRoute({
  ...COMMON,
  permission: 'space.manage',
  operationId: 'updateSpace',
  method: 'put',
  path: '/spaces/{spaceId}',
  summary: 'Change an event space, its layouts and prices (M9-01)',
  description:
    'A layout left out is retired, so bookings that used it keep their record. New setup or cleanup times apply to bookings made from now on.',
  params: z.object({ spaceId: Uuid }),
  body: SpaceBody,
  response: SpaceItem,
});

export const getSpaceAvailability = defineRoute({
  ...READ,
  operationId: 'getSpaceAvailability',
  method: 'get',
  path: '/spaces/availability',
  summary: 'Which spaces are free for an event, including setup and cleanup (M9-02)',
  query: z
    .object({
      startsAt: Instant,
      endsAt: Instant,
      guests: z.coerce.number().int().min(1).optional(),
    })
    .refine((q) => q.endsAt > q.startsAt, {
      path: ['endsAt'],
      message: 'The event ends after it starts',
    }),
  response: z.object({ data: z.array(SpaceAvailabilityItem) }),
});

export const listEventEnquiries = defineRoute({
  ...READ,
  operationId: 'listEventEnquiries',
  method: 'get',
  path: '/event-enquiries',
  summary: 'Event enquiries, newest first (M9-02)',
  query: z.object({ status: z.enum(EVENT_ENQUIRY_STATUSES).optional() }),
  response: z.object({ data: z.array(EventEnquiryItem) }),
});

export const createEventEnquiry = defineRoute({
  ...READ,
  operationId: 'createEventEnquiry',
  method: 'post',
  path: '/event-enquiries',
  summary: 'Log an event enquiry (M9-02)',
  status: 201,
  body: EventEnquiryBody,
  response: EventEnquiryItem,
});

export const updateEventEnquiry = defineRoute({
  ...READ,
  operationId: 'updateEventEnquiry',
  method: 'put',
  path: '/event-enquiries/{enquiryId}',
  summary: 'Change an enquiry, mark it lost, or reopen it',
  description: 'Marking an enquiry lost gives back any space it is holding.',
  params: z.object({ enquiryId: Uuid }),
  body: EventEnquiryUpdateBody,
  response: EventEnquiryItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const listEventBookings = defineRoute({
  ...READ,
  operationId: 'listEventBookings',
  method: 'get',
  path: '/event-bookings',
  summary: 'Holds and bookings between two instants, for the space calendar',
  query: z
    .object({ from: Instant, to: Instant })
    .refine((q) => q.to > q.from, { path: ['to'], message: 'The end comes after the start' }),
  response: z.object({ data: z.array(EventBookingItem) }),
});

export const createEventBooking = defineRoute({
  ...COMMON,
  permission: 'event.hold',
  operationId: 'createEventBooking',
  method: 'post',
  path: '/event-bookings',
  summary: 'Place an expiring hold on a space (M9-03)',
  description:
    '409 BOOKING_CONFLICT when the event, with its setup and cleanup, overlaps another hold or booking on the space (M9 AC).',
  idempotent: true,
  status: 201,
  body: EventHoldBody,
  response: EventBookingItem,
  errors: ['BOOKING_CONFLICT'],
});

export const releaseEventHold = defineRoute({
  ...COMMON,
  permission: 'event.hold',
  operationId: 'releaseEventHold',
  method: 'post',
  path: '/event-bookings/{bookingId}/release',
  summary: 'Give a held space back',
  params: z.object({ bookingId: Uuid }),
  body: z.object({}),
  response: EventBookingItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const EVENT_ROUTES = {
  listSpaces,
  createSpace,
  updateSpace,
  getSpaceAvailability,
  listEventEnquiries,
  createEventEnquiry,
  updateEventEnquiry,
  listEventBookings,
  createEventBooking,
  releaseEventHold,
} as const;
