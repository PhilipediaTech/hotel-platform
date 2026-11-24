import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, Uuid } from './primitives.ts';

// Channel manager connection (PRD M11-07 "As the system, I sync availability, rates and
// restrictions to OTAs through the channel manager and import OTA bookings as reservations";
// Strategy: Channex white-label; T-151). Connecting creates the property at the channel
// manager, one room type per room type with rooms, and one rate plan per rate plan and room
// type the hotel chooses to sell online, and keeps their IDs. Setup can be run again: it only
// creates what is missing, so a setup that failed half-way finishes on the next try. Syncing
// prices and availability (T-152) and taking in bookings (T-153) build on these mappings.

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

export const CHANNEL_ROUTES = { getChannelConnection, connectChannel, pauseChannel } as const;
