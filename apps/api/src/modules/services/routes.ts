import { SERVICE_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as services from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Other services (M9-09; T-122). */
export function serviceRoutes(deps: services.ServiceDeps): Router {
  const router = express.Router();
  const r = SERVICE_ROUTES;
  mountRoute(router, r.listServices, () => services.listServices(deps));
  mountRoute(router, r.createService, ({ body }) => services.createService(deps, body));
  mountRoute(router, r.updateService, ({ params, body }) =>
    services.updateService(deps, params.serviceId, body),
  );
  mountRoute(router, r.getServiceSlots, ({ params, query }) =>
    services.serviceSlots(deps, params.serviceId, query.date),
  );
  mountRoute(router, r.listServiceBookings, ({ query }, { tenant }) =>
    services.listBookings(deps, tenantFrom(tenant), query.date),
  );
  mountRoute(router, r.createServiceBooking, ({ body }, { tenant }) =>
    services.createBooking(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.completeServiceBooking, ({ params }, { tenant }) =>
    services.completeBooking(deps, tenantFrom(tenant), params.bookingId),
  );
  mountRoute(router, r.cancelServiceBooking, ({ params, body }) =>
    services.cancelBooking(deps, params.bookingId, body.noShow),
  );
  return router;
}
