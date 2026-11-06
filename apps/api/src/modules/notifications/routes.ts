import { MESSAGE_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { RAW_BODY } from '../payments/webhook-routes.ts';
import * as messaging from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Message templates, test messages and the WhatsApp webhook (T-024). */
export function messagingRoutes(deps: messaging.MessagingDeps): Router {
  const router = express.Router();
  const r = MESSAGE_ROUTES;

  mountRoute(router, r.listMessageTemplates, (_req, { tenant }) =>
    messaging.listTemplates(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.saveMessageTemplate, ({ body }, { tenant }) =>
    messaging.saveTemplate(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.resetMessageTemplate, ({ params }, { tenant }) =>
    messaging.resetTemplate(deps, tenantFrom(tenant), params),
  );
  mountRoute(router, r.sendTestMessage, ({ body }, { tenant }) =>
    messaging.sendTest(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listMessageDeliveries, ({ query }, { tenant }) =>
    messaging.listDeliveries(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.whatsappWebhookVerify, ({ params, query }) =>
    messaging.verifyWebhook(deps, params.provider, query),
  );
  mountRoute(router, r.whatsappWebhook, ({ params, body }, { req }) =>
    messaging.receiveWebhook(
      deps,
      params.provider,
      (req as unknown as Record<symbol, Buffer | undefined>)[RAW_BODY],
      req.headers,
      body,
    ),
  );

  return router;
}
