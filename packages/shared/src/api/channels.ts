import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';

// Channel manager connection (PRD M11-07 "As the system, I sync availability, rates and
// restrictions to OTAs through the channel manager and import OTA bookings as reservations";
// Strategy: Channex white-label; T-151). Connecting creates the property at the channel
// manager, one room type per room type with rooms, and one rate plan per rate plan and room
// type the hotel chooses to sell online, and keeps their IDs. Setup can be run again: it only
// creates what is missing, so a setup that failed half-way finishes on the next try. Syncing
// prices and availability (T-152) and taking in bookings (T-153) build on these mappings.
// T-152: a worker sends what changed every minute and everything once a day.
// T-153: OTA bookings come in from the channel manager's booking feed (read every minute, and
// at once when its signed webhook says a booking is waiting) and become reservations with
// source OTA_CHANNEL; what cannot be booked safely waits here for staff.

export const ChannelConnectionStatus = z.enum(['CONNECTING', 'ACTIVE', 'PAUSED']);

/** Rate plan kinds that can be sold through OTAs: not company or day-use plans. */
export const CHANNEL_PLAN_KINDS = ['BAR', 'DERIVED', 'PACKAGE'] as const;

export const ChannelConnectionView = z
  .object({
    /** OFF until the platform sets up a channel manager; FAKE locally. */
    provider: z.enum(['OFF', 'FAKE', 'CHANNEX']),
    connection: z
      .object({
        status: ChannelConnectionStatus,
        externalPropertyId: z.string().nullable(),
        lastError: z.string().nullable(),
        connectedBy: z.object({ id: Uuid, name: z.string() }),
        createdAt: Instant,
        /** Prices and availability (T-152): last time all was compared and up to date. */
        checkedAt: Instant.nullable(),
        /** Last completed full sync; one runs daily and on request. */
        fullSyncAt: Instant.nullable(),
        fullSyncPending: z.boolean(),
        /** The last sending problem, until a send goes through. */
        syncError: z.string().nullable(),
        /** After a problem: the next try. */
        retryAt: Instant.nullable(),
        /** Bookings (T-153): last time the booking feed was read to the end. */
        bookingsCheckedAt: Instant.nullable(),
        /** The last problem reading the booking feed, until a read goes through. */
        bookingsError: z.string().nullable(),
        /** OTA bookings waiting for staff. */
        heldBookings: z.number().int(),
      })
      .nullable(),
    roomTypes: z.array(
      z.object({
        id: Uuid,
        code: z.string(),
        name: z.string(),
        rooms: z.number().int(),
        mapped: z.boolean(),
      }),
    ),
    ratePlans: z.array(
      z.object({
        id: Uuid,
        code: z.string(),
        name: z.string(),
        kind: z.string(),
        /** Sold through the channel manager now. */
        selected: z.boolean(),
        /** How many of its room types are set up at the channel manager. */
        mappedRoomTypes: z.number().int(),
      }),
    ),
    logs: z.array(
      z.object({
        at: Instant,
        kind: z.string(),
        status: z.enum(['OK', 'WARNING', 'FAILED']),
        items: z.number().int(),
        message: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'ChannelConnection' });

const MANAGE = {
  tags: ['Channels'],
  propertyScoped: true as const,
  permission: 'channel.manage',
};
const ADDED = 'Not in tab 4 (tab 4 lists only the channel webhook): designed in T-151.';

export const getChannelConnection = defineRoute({
  ...MANAGE,
  operationId: 'getChannelConnection',
  method: 'get',
  path: '/channel-connection',
  summary: 'The property’s channel manager connection, what is mapped, and recent activity',
  description: ADDED,
  response: ChannelConnectionView,
});

export const connectChannel = defineRoute({
  ...MANAGE,
  operationId: 'connectChannel',
  method: 'post',
  path: '/channel-connection',
  summary: 'Connect, or finish or change the setup: sell these rate plans through OTAs',
  description: `${ADDED} Creates at the channel manager only what is missing. Rate plans left out stop being sent (the channel manager keeps their record). 409 while another setup runs; 502 CHANNEL_UNAVAILABLE when the channel manager refuses or cannot be reached, with what was done so far kept.`,
  idempotent: true,
  body: z.object({
    ratePlanIds: z
      .array(Uuid)
      .min(1, 'Choose at least one rate plan to sell')
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, 'Each plan once'),
  }),
  response: ChannelConnectionView,
  errors: ['CHANNEL_UNAVAILABLE', 'STATE_TRANSITION_INVALID'],
});

export const pauseChannel = defineRoute({
  ...MANAGE,
  operationId: 'pauseChannel',
  method: 'patch',
  path: '/channel-connection',
  summary: 'Pause or resume the connection: nothing is sent or taken in while paused',
  description: ADDED,
  body: z.object({ paused: z.boolean() }),
  response: ChannelConnectionView,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const requestChannelFullSync = defineRoute({
  ...MANAGE,
  operationId: 'requestChannelFullSync',
  method: 'post',
  path: '/channel-connection/full-sync',
  summary: 'Send all prices, availability and restrictions again (within a few minutes)',
  description: `${ADDED} Designed in T-152. Also runs by itself once a day. 409 unless connected and not paused.`,
  idempotent: true,
  response: ChannelConnectionView,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const CHANNEL_HOLD_REASONS = [
  'UNMAPPED_ROOM',
  'UNMAPPED_RATE',
  'NO_ROOM',
  'CURRENCY',
  'IN_HOUSE',
  'CANCELLED_HERE',
  'ROOMS_CHANGED',
  'INVALID',
  'REFUSED',
] as const;

/** One revision of an OTA booking as taken in (T-153), and what became of it. */
export const ChannelBookingItem = z
  .object({
    id: Uuid,
    /** The channel manager's booking ID (the reservation's channel reference). */
    externalBookingId: z.string(),
    kind: z.enum(['NEW', 'MODIFIED', 'CANCELLED']),
    otaName: z.string().nullable(),
    /** The OTA's own reservation number. */
    otaCode: z.string().nullable(),
    guestName: z.string(),
    arrival: IsoDate.nullable(),
    departure: IsoDate.nullable(),
    receivedAt: Instant,
    outcome: z.enum(['PENDING', 'APPLIED', 'HELD', 'SUPERSEDED', 'DISMISSED']),
    holdReason: z.enum(CHANNEL_HOLD_REASONS).nullable(),
    message: z.string().nullable(),
    reservationId: Uuid.nullable(),
    confirmationNo: z.string().nullable(),
  })
  .meta({ id: 'ChannelBooking' });

const BOOKINGS = 'Not in tab 4 (tab 4 lists only the channel webhook): designed in T-153.';

export const listChannelBookings = defineRoute({
  ...MANAGE,
  operationId: 'listChannelBookings',
  method: 'get',
  path: '/channel-bookings',
  summary: 'OTA bookings taken in: those waiting for staff, or the latest 50',
  description: BOOKINGS,
  query: z.object({ held: z.stringbool().optional() }),
  response: z.array(ChannelBookingItem),
});

const ChannelBookingParams = z.object({ channelBookingId: Uuid });

export const retryChannelBooking = defineRoute({
  ...MANAGE,
  operationId: 'retryChannelBooking',
  method: 'post',
  path: '/channel-bookings/{channelBookingId}/retry',
  summary: 'Try a held OTA booking again (after setting up the room or plan, making room…)',
  description: `${BOOKINGS} Answers what became of it: applied, or held again with the reason. 409 unless it is held.`,
  idempotent: true,
  params: ChannelBookingParams,
  response: ChannelBookingItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const dismissChannelBooking = defineRoute({
  ...MANAGE,
  operationId: 'dismissChannelBooking',
  method: 'post',
  path: '/channel-bookings/{channelBookingId}/dismiss',
  summary: 'Mark a held OTA booking as handled by hand',
  description: `${BOOKINGS} 409 unless it is held.`,
  idempotent: true,
  params: ChannelBookingParams,
  body: z.object({ note: z.string().trim().min(1, 'Say how it was handled').max(500) }),
  response: ChannelBookingItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const channelWebhook = defineRoute({
  operationId: 'channelWebhook',
  method: 'post',
  path: '/webhooks/channel/{provider}',
  summary: 'Channel manager webhook',
  description:
    'Signed by Channex: `x-hmac-signature-256` is lowercase hex HMAC-SHA256 of "<x-hmac-timestamp>.<raw body>" (a call more than 5 minutes old is refused). A bad signature answers 401 and stores nothing; a call already received answers 200. A booking event makes the worker read the booking feed at once (T-153).',
  tags: ['Webhooks'],
  auth: 'none',
  params: z.object({ provider: z.string().regex(/^[a-z]+$/) }),
  body: z.record(z.string(), z.unknown()),
  response: z.object({ received: z.literal(true) }),
});

export const CHANNEL_ROUTES = {
  getChannelConnection,
  connectChannel,
  pauseChannel,
  requestChannelFullSync,
  listChannelBookings,
  retryChannelBooking,
  dismissChannelBooking,
  channelWebhook,
} as const;
