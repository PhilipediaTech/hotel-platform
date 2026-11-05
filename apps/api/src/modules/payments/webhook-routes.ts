import { VIRTUAL_ACCOUNT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { IntentDeps } from './intents.ts';
import * as accounts from './virtual-accounts.ts';
import { receiveWebhook } from './webhooks.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** The raw body the JSON parser kept for webhook paths (signatures are over the bytes). */
export const RAW_BODY = Symbol('rawBody');

/** Webhooks, virtual accounts and unmatched transfers (tab 4 rows "Payments", "Webhooks"; T-071). */
export function webhookRoutes(deps: IntentDeps): Router {
  const router = express.Router();
  const r = VIRTUAL_ACCOUNT_ROUTES;

  mountRoute(router, r.paymentWebhook, ({ params }, { req }) =>
    receiveWebhook(
      deps,
      params.provider,
      (req as unknown as Record<symbol, Buffer | undefined>)[RAW_BODY],
      req.headers,
    ),
  );
  mountRoute(router, r.createVirtualAccount, ({ body }, { tenant }) =>
    accounts.createVirtualAccount(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listVirtualAccounts, ({ query }) =>
    accounts.listVirtualAccounts(deps, query),
  );
  mountRoute(router, r.listUnmatchedTransfers, ({ query }) =>
    accounts.listUnmatchedTransfers(deps, query),
  );
  mountRoute(router, r.matchUnmatchedTransfer, ({ params, body }, { tenant }) =>
    accounts.matchUnmatchedTransfer(deps, tenantFrom(tenant), params.unmatchedTransferId, body),
  );

  return router;
}
