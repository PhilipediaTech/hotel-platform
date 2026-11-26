import { INTEGRATION_ROUTES, PARTNER_API_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import type { ApiKeyContext } from '../../core/api-keys.ts';
import { mountRoute, type RouteContext } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as partner from './partner.ts';
import * as integrations from './service.ts';

/** Integrations settings and the partner API (T-166). */
export function integrationRoutes(deps: integrations.IntegrationDeps): Router {
  const router = express.Router();
  const r = INTEGRATION_ROUTES;
  const t = (ctx: RouteContext) => ctx.tenant as TenantContext;
  mountRoute(router, r.listApiKeys, () => integrations.listApiKeys(deps));
  mountRoute(router, r.createApiKey, ({ body }, ctx) =>
    integrations.createApiKey(deps, t(ctx), body),
  );
  mountRoute(router, r.revokeApiKey, ({ params }, ctx) =>
    integrations.revokeApiKey(deps, t(ctx), params.apiKeyId),
  );
  mountRoute(router, r.listWebhookEndpoints, () => integrations.listWebhookEndpoints(deps));
  mountRoute(router, r.createWebhookEndpoint, ({ body }, ctx) =>
    integrations.createWebhookEndpoint(deps, t(ctx), body),
  );
  mountRoute(router, r.updateWebhookEndpoint, ({ params, body }) =>
    integrations.updateWebhookEndpoint(deps, params.endpointId, body),
  );
  mountRoute(router, r.testWebhookEndpoint, ({ params }, ctx) =>
    integrations.testWebhookEndpoint(deps, t(ctx), params.endpointId),
  );
  mountRoute(router, r.listWebhookDeliveries, ({ query }) =>
    integrations.listWebhookDeliveries(deps, query),
  );
  mountRoute(router, r.retryWebhookDelivery, ({ params }) =>
    integrations.retryWebhookDelivery(deps, params.deliveryId),
  );

  const p = PARTNER_API_ROUTES;
  const key = (ctx: RouteContext) => ctx.apiKey as ApiKeyContext;
  mountRoute(router, p.getPartnerProperty, (_in, ctx) => partner.partnerProperty(deps, key(ctx)));
  mountRoute(router, p.getPartnerAvailability, ({ query }) =>
    partner.partnerAvailability(deps, query),
  );
  mountRoute(router, p.listPartnerReservations, ({ query }, ctx) =>
    partner.listPartnerReservations(deps, key(ctx), query),
  );
  mountRoute(router, p.getPartnerReservation, ({ params }, ctx) =>
    partner.getPartnerReservation(deps, key(ctx), params.reservationId),
  );
  mountRoute(router, p.listPartnerReservationFolios, ({ params }) =>
    partner.listPartnerReservationFolios(deps, params.reservationId),
  );
  return router;
}
