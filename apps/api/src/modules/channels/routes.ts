import { CHANNEL_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as channels from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Channel manager connection and mapping (M11-07; T-151). */
export function channelRoutes(deps: channels.ChannelDeps): Router {
  const router = express.Router();
  const r = CHANNEL_ROUTES;
  mountRoute(router, r.getChannelConnection, () => channels.getChannelConnection(deps));
  mountRoute(router, r.connectChannel, ({ body }, { tenant }) =>
    channels.connectChannel(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.pauseChannel, ({ body }) => channels.pauseChannel(deps, body));
  mountRoute(router, r.requestChannelFullSync, () => channels.requestFullSync(deps));
  return router;
}
