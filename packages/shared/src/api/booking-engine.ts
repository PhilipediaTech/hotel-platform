import { z } from 'zod';
import { Email, Phone } from './auth.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, IsoDate, Uuid } from './primitives.ts';
import { MEAL_PLANS } from './rates.ts';

// The booking engine (PRD M11-01–M11-03, M11 rules; tab 4 "Public booking"; S39, S40; T-112).
// Public routes answer at /public/v1/... (an alias of /api/v1/public/...). Availability and
// prices come from the same services the front desk uses: no separate inventory.

const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, 'Use lowercase letters, numbers and hyphens');
const Bps = z.number().int().min(0).max(10_000);

export const PromoCodeValue = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{3,30}$/, 'Use letters, numbers and hyphens');

// ── Settings (M11-03; S40) ──────────────────────────────────────────────────────────────

export const BookingEngineSettingsBody = z.object({
  slug: Slug,
  enabled: z.boolean(),
  headline: z.string().trim().max(120).nullable(),
  description: z.string().trim().max(2000).nullable(),
  policies: z.string().trim().max(4000).nullable(),
  photoFileIds: z.array(Uuid).max(12),
  allowPayFull: z.boolean(),
  allowDeposit: z.boolean(),
  /** Share of the total taken as a deposit: 3000 = 30%. */
  depositBps: Bps,
  allowPayAtHotel: z.boolean(),
});

export const BookingEngineSettingsItem = BookingEngineSettingsBody.extend({
  slug: z.string().nullable(),
  /** The page's address and the snippet for the hotel's own website; null until saved. */
  pageUrl: z.string().nullable(),
  embedSnippet: z.string().nullable(),
}).meta({ id: 'BookingEngineSettings' });

export const PromoItem = z
  .object({
    id: Uuid,
    code: z.string(),
    discountBps: z.number().int(),
    validFrom: IsoDate.nullable(),
    validTo: IsoDate.nullable(),
    maxUses: z.number().int().nullable(),
    usedCount: z.number().int(),
    active: z.boolean(),
  })
  .meta({ id: 'PromoCode' });

export const PromoBody = z
  .object({
    code: PromoCodeValue,
    discountBps: z.number().int().min(1).max(10_000),
    validFrom: IsoDate.nullable().default(null),
    validTo: IsoDate.nullable().default(null),
    maxUses: z.number().int().min(1).max(100_000).nullable().default(null),
  })
  .refine((b) => !b.validFrom || !b.validTo || b.validFrom <= b.validTo, {
    message: 'The end date is before the start date',
    path: ['validTo'],
  });

const MANAGE = {
  tags: ['Booking engine'],
  propertyScoped: true as const,
  permission: 'bookingengine.manage',
};

export const getBookingEngineSettings = defineRoute({
  ...MANAGE,
  operationId: 'getBookingEngineSettings',
  method: 'get',
  path: '/booking-engine/settings',
  summary: 'The booking page’s settings and embed snippet (M11-03)',
  response: BookingEngineSettingsItem,
});

export const saveBookingEngineSettings = defineRoute({
  ...MANAGE,
  operationId: 'saveBookingEngineSettings',
  method: 'put',
  path: '/booking-engine/settings',
  summary: 'Save the booking page’s settings (M11-03)',
  body: BookingEngineSettingsBody,
  response: BookingEngineSettingsItem,
});

export const listPromoCodes = defineRoute({
  ...MANAGE,
  operationId: 'listPromoCodes',
  method: 'get',
  path: '/booking-engine/promo-codes',
  summary: 'Promo codes of the booking page',
  response: z.object({ data: z.array(PromoItem) }),
});

export const createPromoCode = defineRoute({
  ...MANAGE,
  operationId: 'createPromoCode',
  method: 'post',
  path: '/booking-engine/promo-codes',
  summary: 'Add a promo code',
  idempotent: true,
  status: 201,
  body: PromoBody,
  response: PromoItem,
});

export const updatePromoCode = defineRoute({
  ...MANAGE,
  operationId: 'updatePromoCode',
  method: 'patch',
  path: '/booking-engine/promo-codes/{promoId}',
  summary: 'Switch a promo code on or off',
  params: z.object({ promoId: Uuid }),
  body: z.object({ active: z.boolean() }),
  response: PromoItem,
});

// ── Public (M11-01, M11-02; S39) ────────────────────────────────────────────────────────

const PUBLIC = { tags: ['Public booking'], auth: 'none' as const };

export const PublicProperty = z
  .object({
    slug: z.string(),
    name: z.string(),
    headline: z.string().nullable(),
    description: z.string().nullable(),
    policies: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    address: z.record(z.string(), z.unknown()),
    currency: z.string(),
    checkInTime: z.string(),
    checkOutTime: z.string(),
    photoUrls: z.array(z.string()),
    payment: z.object({
      full: z.boolean(),
      deposit: z.boolean(),
      depositBps: z.number().int(),
      atHotel: z.boolean(),
    }),
    roomTypes: z.array(
      z.object({
        id: Uuid,
        name: z.string(),
        description: z.string().nullable(),
        maxOccupancy: z.number().int(),
        amenities: z.array(z.string()),
        photoUrls: z.array(z.string()),
      }),
    ),
  })
  .meta({ id: 'PublicProperty' });

export const getPublicProperty = defineRoute({
  ...PUBLIC,
  operationId: 'getPublicProperty',
  method: 'get',
  path: '/public/properties/{slug}',
  summary: 'A hotel’s booking page (M11-01)',
  params: z.object({ slug: z.string().max(60) }),
  response: PublicProperty,
});

export const PublicAvailabilityQuery = z.object({
  slug: z.string().max(60),
  arrival: IsoDate,
  departure: IsoDate,
  adults: z.coerce.number().int().min(1).max(20),
  children: z.coerce.number().int().min(0).max(20).default(0),
  promo: PromoCodeValue.optional(),
});

export const getPublicAvailability = defineRoute({
  ...PUBLIC,
  operationId: 'getPublicAvailability',
  method: 'get',
  path: '/public/availability',
  summary: 'Rooms and public plans for the dates (M11-01)',
  description: 'The front desk’s availability, narrowed to public plans that can be sold.',
  query: PublicAvailabilityQuery,
  response: z.object({
    arrival: IsoDate,
    departure: IsoDate,
    nights: z.number().int(),
    currency: z.string(),
    /** False when a promo code was given and cannot be used for these dates. */
    promoApplied: z.boolean(),
    roomTypes: z.array(
      z.object({
        roomTypeId: Uuid,
        name: z.string(),
        maxOccupancy: z.number().int(),
        available: z.number().int(),
        plans: z.array(
          z.object({
            ratePlanId: Uuid,
            name: z.string(),
            mealPlan: z.enum(MEAL_PLANS),
            totalMinor: AmountMinor,
          }),
        ),
      }),
    ),
  }),
});

export const PUBLIC_PAYMENT_CHOICES = ['FULL', 'DEPOSIT', 'AT_HOTEL'] as const;

export const PublicBookingBody = z.object({
  slug: z.string().max(60),
  /** A UUID the page makes once per booking: sending it again returns the same booking. */
  bookingKey: Uuid,
  roomTypeId: Uuid,
  ratePlanId: Uuid,
  arrival: IsoDate,
  departure: IsoDate,
  adults: z.number().int().min(1).max(20),
  children: z.number().int().min(0).max(20).default(0),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: Email,
  phone: Phone,
  payment: z.enum(PUBLIC_PAYMENT_CHOICES),
  promo: PromoCodeValue.optional(),
  /** Stays on file only when the guest ticks it (M11 rule: opt out of marketing). */
  marketingConsent: z.boolean().default(false),
  /** Where the payment page returns the guest. */
  returnUrl: z.url().max(500).optional(),
});

export const PublicBookingCreated = z
  .object({
    token: z.string(),
    confirmationNo: z.string(),
    status: z.enum(['TENTATIVE', 'CONFIRMED']),
    /** Open this to pay; null when paying at the hotel. */
    paymentUrl: z.string().nullable(),
    amountDueNowMinor: AmountMinor,
    totalMinor: AmountMinor,
    currency: z.string(),
  })
  .meta({ id: 'PublicBookingCreated' });

export const createPublicBooking = defineRoute({
  ...PUBLIC,
  operationId: 'createPublicBooking',
  method: 'post',
  path: '/public/bookings',
  summary: 'Book a room from the booking page (M11-01)',
  description:
    'Paying online holds the room for 30 minutes and confirms when the payment arrives; paying at the hotel confirms at once. Sending the same `bookingKey` again returns the same booking.',
  status: 201,
  body: PublicBookingBody,
  response: PublicBookingCreated,
  errors: ['BOOKING_CONFLICT', 'RESTRICTION_VIOLATED', 'STATE_TRANSITION_INVALID'],
});

const TokenParams = z.object({ token: z.string().min(20).max(100) });

export const PublicBooking = z
  .object({
    confirmationNo: z.string(),
    status: z.string(),
    hotel: z.object({
      name: z.string(),
      slug: z.string(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
    }),
    guestName: z.string(),
    arrival: IsoDate,
    departure: IsoDate,
    roomType: z.string(),
    ratePlan: z.string(),
    adults: z.number().int(),
    children: z.number().int(),
    totalMinor: AmountMinor,
    paidMinor: AmountMinor,
    currency: z.string(),
    cancellation: z.object({
      allowed: z.boolean(),
      /** What cancelling now would cost under the plan's policy. */
      feeMinor: AmountMinor,
    }),
  })
  .meta({ id: 'PublicBooking' });

export const getPublicBooking = defineRoute({
  ...PUBLIC,
  operationId: 'getPublicBooking',
  method: 'get',
  path: '/public/bookings/{token}',
  summary: 'A guest’s booking, from their secure link (M11-02)',
  params: TokenParams,
  response: PublicBooking,
});

export const cancelPublicBooking = defineRoute({
  ...PUBLIC,
  operationId: 'cancelPublicBooking',
  method: 'post',
  path: '/public/bookings/{token}/cancel',
  summary: 'Cancel a booking within its policy, from the secure link (M11-02)',
  description:
    '`acceptedFeeMinor` is the fee the guest was shown: if the fee is now higher, 409 and nothing changes.',
  params: TokenParams,
  body: z.object({ acceptedFeeMinor: AmountMinor.default('0') }),
  response: PublicBooking,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const BOOKING_ENGINE_ROUTES = {
  getBookingEngineSettings,
  saveBookingEngineSettings,
  listPromoCodes,
  createPromoCode,
  updatePromoCode,
  getPublicProperty,
  getPublicAvailability,
  createPublicBooking,
  getPublicBooking,
  cancelPublicBooking,
} as const;
