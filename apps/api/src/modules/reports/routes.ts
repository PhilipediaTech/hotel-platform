import { GROUP_ROUTES, PACE_ROUTES, REPORT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as group from './group.ts';
import { operations } from './operations.ts';
import { explainPaceForecast, type PaceNoteDeps } from './pace-note.ts';
import { paceReport } from './pace.ts';
import * as reports from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Reports (tab 4 row "Reports"; T-092). */
export function reportRoutes(deps: PaceNoteDeps): Router {
  const router = express.Router();
  const r = REPORT_ROUTES;
  // Pickup and pace (T-165).
  mountRoute(router, PACE_ROUTES.getPaceReport, ({ query }, { tenant }) =>
    paceReport(deps, tenantFrom(tenant), query),
  );
  // The forecast's AI note (T-179).
  mountRoute(router, PACE_ROUTES.explainPaceForecast, ({ body }, { tenant }) =>
    explainPaceForecast(deps, tenantFrom(tenant), body),
  );
  // Group dashboards (S46; T-161).
  const g = GROUP_ROUTES;
  mountRoute(router, g.getGroupDashboard, ({ query }, { tenant }) =>
    group.groupDashboard(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, g.getGroupRates, ({ query }, { tenant }) =>
    group.getGroupRates(deps, tenantFrom(tenant), query.month),
  );
  mountRoute(router, g.putGroupRates, ({ body }, { tenant }) =>
    group.putGroupRates(deps, tenantFrom(tenant), body),
  );
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
  mountRoute(router, r.getOperationsReport, ({ query }, { tenant }) =>
    operations(deps, tenantFrom(tenant), query),
  );
  return router;
}
