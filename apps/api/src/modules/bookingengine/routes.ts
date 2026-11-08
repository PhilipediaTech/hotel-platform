import { BOOKING_ENGINE_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as engine from './service.ts';

function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** The booking engine (tab 4 "Public booking"; T-112). */
export function bookingEngineRoutes(deps: engine.BookingEngineDeps): Router {
  const router = express.Router();
  const r = BOOKING_ENGINE_ROUTES;
  mountRoute(router, r.getBookingEngineSettings, () => engine.getSettings(deps));
  mountRoute(router, r.saveBookingEngineSettings, ({ body }, { tenant }) =>
    engine.saveSettings(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listPromoCodes, () => engine.listPromos(deps));
  mountRoute(router, r.createPromoCode, ({ body }) => engine.createPromo(deps, body));
  mountRoute(router, r.updatePromoCode, ({ params, body }) =>
    engine.updatePromo(deps, params.promoId, body.active),
  );
  mountRoute(router, r.getPublicProperty, ({ params }) => engine.publicProperty(deps, params.slug));
  mountRoute(router, r.getPublicAvailability, ({ query }) =>
    engine.publicAvailability(deps, query),
  );
  mountRoute(router, r.createPublicBooking, ({ body }) => engine.createPublicBooking(deps, body));
  mountRoute(router, r.getPublicBooking, ({ params }) => engine.publicBooking(deps, params.token));
  mountRoute(router, r.cancelPublicBooking, ({ params, body }) =>
    engine.cancelPublicBooking(deps, params.token, body.acceptedFeeMinor),
  );
  return router;
}
