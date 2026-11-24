import { CHANNEL_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import type { Db } from '../../core/db.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { RAW_BODY } from '../payments/webhook-routes.ts';
import * as bookings from './bookings.ts';
import * as channels from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Channel manager connection, mapping and OTA bookings (M11-07; T-151–T-153). */
export function channelRoutes(
  deps: channels.ChannelDeps & {
    db: Db;
    /** Booking webhook signing secrets (T-153). */
    webhookSecrets: readonly string[];
  },
): Router {
  const router = express.Router();
  const r = CHANNEL_ROUTES;
  mountRoute(router, r.getChannelConnection, () => channels.getChannelConnection(deps));
  mountRoute(router, r.connectChannel, ({ body }, { tenant }) =>
    channels.connectChannel(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.pauseChannel, ({ body }) => channels.pauseChannel(deps, body));
  mountRoute(router, r.requestChannelFullSync, () => channels.requestFullSync(deps));
  mountRoute(router, r.listChannelBookings, ({ query }) =>
    bookings.listChannelBookings(deps.tenantDb, query),
  );
  mountRoute(router, r.retryChannelBooking, ({ params }, { tenant }) =>
    bookings.retryChannelBooking(deps, tenantFrom(tenant), params.channelBookingId),
  );
  mountRoute(router, r.dismissChannelBooking, ({ params, body }, { tenant }) =>
    bookings.dismissChannelBooking(deps, tenantFrom(tenant), params.channelBookingId, body),
  );
  mountRoute(router, r.channelWebhook, ({ params }, { req }) =>
    bookings.receiveChannelWebhook(
      { db: deps.db, clock: deps.clock, secrets: deps.webhookSecrets },
      params.provider,
      (req as unknown as Record<symbol, Buffer | undefined>)[RAW_BODY],
      req.headers,
    ),
  );
  return router;
}
