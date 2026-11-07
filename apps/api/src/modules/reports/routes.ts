import { REPORT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as reports from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Reports (tab 4 row "Reports"; T-092). */
export function reportRoutes(deps: reports.ReportDeps): Router {
  const router = express.Router();
  const r = REPORT_ROUTES;
  mountRoute(router, r.getDashboardReport, ({ query }, { tenant }) =>
    reports.dashboard(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.getFlashReport, ({ query }, { tenant }) =>
    reports.flash(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.getTrialBalanceReport, ({ query }, { tenant }) =>
    reports.trialBalance(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.getCashierReport, ({ query }, { tenant }) =>
    reports.cashier(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.getTaxReport, ({ query }, { tenant }) =>
    reports.tax(deps, tenantFrom(tenant), query),
  );
  return router;
}
