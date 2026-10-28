import { INVENTORY_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as availability from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Room-type inventory and overbooking limits (T-040). */
export function availabilityRoutes(deps: availability.AvailabilityDeps): Router {
  const router = express.Router();
  const r = INVENTORY_ROUTES;

  mountRoute(router, r.getInventory, async ({ query }) => ({
    days: await availability.getInventory(deps, query),
  }));
  mountRoute(router, r.setOverbooking, ({ body }, { tenant }) =>
    availability.setOverbooking(deps, tenantFrom(tenant), body),
  );

  return router;
}
