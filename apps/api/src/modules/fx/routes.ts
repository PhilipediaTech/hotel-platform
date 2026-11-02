import { FX_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as fx from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Exchange rates (tab 4 row "Tax and FX"; T-065). */
export function fxRoutes(deps: fx.FxDeps): Router {
  const router = express.Router();
  const r = FX_ROUTES;

  mountRoute(router, r.getExchangeRates, ({ params }, { tenant }) =>
    fx.getExchangeRates(deps, tenantFrom(tenant), params.date),
  );
  mountRoute(router, r.putExchangeRates, ({ params, body }, { tenant }) =>
    fx.putExchangeRates(deps, tenantFrom(tenant), params.date, body),
  );

  return router;
}
