import { LEAKAGE_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as leakage from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Leakage Guard review and rule settings (tab 4 row "Leakage"; T-090). */
export function leakageRoutes(deps: leakage.LeakageDeps): Router {
  const router = express.Router();
  const r = LEAKAGE_ROUTES;

  mountRoute(router, r.listLeakageAlerts, ({ query }, { tenant }) =>
    leakage.listAlerts(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.getLeakageAlert, ({ params }, { tenant }) =>
    leakage.getAlert(deps, tenantFrom(tenant), params.alertId),
  );
  mountRoute(router, r.addLeakageAlertOutcome, ({ params, body }, { tenant }) =>
    leakage.addOutcome(deps, tenantFrom(tenant), params.alertId, body),
  );
  mountRoute(router, r.listLeakageRules, (_req, { tenant }) =>
    leakage.listRules(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.updateLeakageRules, ({ body }, { tenant }) =>
    leakage.updateRules(deps, tenantFrom(tenant), body),
  );

  return router;
}
