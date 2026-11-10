import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';

// Other services (PRD M9-09; strategy 11.1 "other services follow the same availability and
// charge-to-folio rules"; tab 3 services, service_bookings; tab 4 /services; T-122): laundry,
// parking, transfers, spa, gym and tours, each with a capacity, opening hours and booking
// window, a price, and whether it is charged to the guest's bill.

export const SERVICE_CATEGORIES = [
  'LAUNDRY',
  'PARKING',
  'TRANSFER',
  'SPA',
  'GYM',
  'TOUR',
  'OTHER',
] as const;
export const SERVICE_PRICING = ['PER_BOOKING', 'PER_PERSON', 'PER_HOUR'] as const;
export const SERVICE_BOOKING_STATUSES = ['BOOKED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const;

const Name = z.string().trim().min(1).max(120);
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time like 09:00');
const NonNegativeMinor = AmountMinor.refine((v) => !v.startsWith('-'), 'Must not be negative');

export const ServiceItem = z
  .object({
    id: Uuid,
    code: z.string(),
    name: z.string(),
    category: z.enum(SERVICE_CATEGORIES),
    description: z.string().nullable(),
    priceMinor: AmountMinor,
    pricing: z.enum(SERVICE_PRICING),
    /** The length of one booking, and the step between start times. */
    durationMinutes: z.number().int(),
    /** How many (people, cars, items) at once; null = no limit. */
    capacity: z.number().int().nullable(),
    opensAt: z.string(),
    closesAt: z.string(),
    minNoticeMinutes: z.number().int(),
    maxAdvanceDays: z.number().int(),
    chargeToFolio: z.boolean(),
    revenueCode: z.string(),
    active: z.boolean(),
  })
  .meta({ id: 'Service' });

export const ServiceBody = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .regex(/^[A-Za-z0-9-]+$/, 'Letters, numbers and dashes only'),
    name: Name,
    category: z.enum(SERVICE_CATEGORIES),
    description: z.string().trim().max(2000).nullable().default(null),
    priceMinor: NonNegativeMinor,
    pricing: z.enum(SERVICE_PRICING).default('PER_BOOKING'),
    durationMinutes: z
      .number()
      .int()
      .min(15)
      .max(24 * 60),
    capacity: z.number().int().min(1).max(10_000).nullable().default(null),
    opensAt: Clock.default('07:00'),
    closesAt: Clock.default('22:00'),
    minNoticeMinutes: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60)
      .default(0),
    maxAdvanceDays: z.number().int().min(0).max(365).default(30),
    chargeToFolio: z.boolean().default(true),
    /** The revenue code the charge posts to; its tax rules apply. */
    revenueCode: z.string().trim().min(1).max(20).default('MISC'),
    active: z.boolean().default(true),
  })
  .refine((b) => b.opensAt < b.closesAt, {
    path: ['closesAt'],
    message: 'It closes after it opens',
  });

export const ServiceBookingItem = z
  .object({
    id: Uuid,
    service: z.object({ id: Uuid, name: z.string(), category: z.enum(SERVICE_CATEGORIES) }),
    status: z.enum(SERVICE_BOOKING_STATUSES),
    startsAt: Instant,
    endsAt: Instant,
    quantity: z.number().int(),
    guestName: z.string(),
    stay: z.object({ id: Uuid, roomNumber: z.string().nullable() }).nullable(),
    amountMinor: AmountMinor,
    /** Posted to the guest's bill. */
    charged: z.boolean(),
    notes: z.string().nullable(),
  })
  .meta({ id: 'ServiceBooking' });

export const ServiceBookingBody = z
  .object({
    serviceId: Uuid,
    startsAt: Instant,
    /** Defaults to the service's own length; per-hour services may be booked longer. */
    durationMinutes: z
      .number()
      .int()
      .min(15)
      .max(24 * 60)
      .optional(),
    /** People, cars or items. */
    quantity: z.number().int().min(1).max(1000).default(1),
    /** An in-house or arriving guest; needed when the service is charged to the bill. */
    stayId: Uuid.nullable().default(null),
    guestName: z.string().trim().max(120).nullable().default(null),
    notes: z.string().trim().max(1000).nullable().default(null),
  })
  .refine((b) => b.stayId !== null || (b.guestName ?? '').length > 0, {
    path: ['guestName'],
    message: 'Choose a guest or give a name',
  });

export const ServiceSlotsView = z
  .object({
    service: z.object({ id: Uuid, name: z.string(), capacity: z.number().int().nullable() }),
    slots: z.array(
      z.object({
        startsAt: Instant,
        endsAt: Instant,
        /** Null when the service has no limit. */
        left: z.number().int().nullable(),
        /** Outside the booking window (too soon, too far ahead, or past). */
        bookable: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'ServiceSlots' });

const COMMON = {
  tags: ['Services'],
  propertyScoped: true as const,
  module: 'events' as const,
};
const BOOK = { ...COMMON, permission: 'folio.charge' };
const SETUP = { ...COMMON, permission: 'service.manage' };

export const listServices = defineRoute({
  ...BOOK,
  operationId: 'listServices',
  method: 'get',
  path: '/services',
  summary: 'The hotel’s other services (M9-09)',
  response: z.object({ data: z.array(ServiceItem) }),
});

export const createService = defineRoute({
  ...SETUP,
  operationId: 'createService',
  method: 'post',
  path: '/services',
  summary: 'Set up a service with its capacity, booking window and price (M9-09)',
  status: 201,
  body: ServiceBody,
  response: ServiceItem,
});

export const updateService = defineRoute({
  ...SETUP,
  operationId: 'updateService',
  method: 'put',
  path: '/services/{serviceId}',
  summary: 'Change a service',
  description: 'Bookings already made keep the price they were made at.',
  params: z.object({ serviceId: Uuid }),
  body: ServiceBody,
  response: ServiceItem,
});

export const getServiceSlots = defineRoute({
  ...BOOK,
  operationId: 'getServiceSlots',
  method: 'get',
  path: '/services/{serviceId}/slots',
  summary: 'A day’s start times for a service and how many places each has left',
  params: z.object({ serviceId: Uuid }),
  query: z.object({ date: IsoDate }),
  response: ServiceSlotsView,
});

export const listServiceBookings = defineRoute({
  ...BOOK,
  operationId: 'listServiceBookings',
  method: 'get',
  path: '/service-bookings',
  summary: 'Service bookings on a day, in the hotel’s time',
  query: z.object({ date: IsoDate }),
  response: z.object({ data: z.array(ServiceBookingItem) }),
});

export const createServiceBooking = defineRoute({
  ...BOOK,
  operationId: 'createServiceBooking',
  method: 'post',
  path: '/service-bookings',
  summary: 'Book a service, within its opening hours, booking window and capacity',
  description: '409 BOOKING_CONFLICT when the service is full at that time.',
  idempotent: true,
  status: 201,
  body: ServiceBookingBody,
  response: ServiceBookingItem,
  errors: ['BOOKING_CONFLICT'],
});

export const completeServiceBooking = defineRoute({
  ...BOOK,
  operationId: 'completeServiceBooking',
  method: 'post',
  path: '/service-bookings/{bookingId}/complete',
  summary: 'Mark a service delivered; a charge-to-bill service posts to the guest’s folio',
  idempotent: true,
  params: z.object({ bookingId: Uuid }),
  body: z.object({}),
  response: ServiceBookingItem,
  errors: ['STATE_TRANSITION_INVALID', 'BUSINESS_DAY_CLOSED'],
});

export const cancelServiceBooking = defineRoute({
  ...BOOK,
  operationId: 'cancelServiceBooking',
  method: 'post',
  path: '/service-bookings/{bookingId}/cancel',
  summary: 'Cancel a service booking, or record that the guest did not come',
  params: z.object({ bookingId: Uuid }),
  body: z.object({ noShow: z.boolean().default(false) }),
  response: ServiceBookingItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const SERVICE_ROUTES = {
  listServices,
  createService,
  updateService,
  getServiceSlots,
  listServiceBookings,
  createServiceBooking,
  completeServiceBooking,
  cancelServiceBooking,
} as const;
