import { PAYROLL_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as payroll from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Timesheets, advances and deductions, the payroll file (M7-06–M7-08; T-139). */
export function payrollRoutes(deps: payroll.PayrollDeps): Router {
  const router = express.Router();
  const r = PAYROLL_ROUTES;
  mountRoute(router, r.listTimesheets, ({ query }, { tenant }) =>
    payroll.listTimesheets(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.createTimesheet, ({ body }, { tenant }) =>
    payroll.createTimesheet(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.recalculateTimesheet, ({ params }, { tenant }) =>
    payroll.recalculateTimesheet(deps, tenantFrom(tenant), params.timesheetId),
  );
  mountRoute(router, r.approveTimesheet, ({ params, body }, { tenant }) =>
    payroll.approveTimesheet(deps, tenantFrom(tenant), params.timesheetId, body),
  );
  mountRoute(router, r.deleteTimesheet, ({ params }) =>
    payroll.deleteTimesheet(deps, params.timesheetId),
  );
  mountRoute(router, r.listPayItems, ({ query }) => payroll.listPayItems(deps, query));
  mountRoute(router, r.createPayItem, ({ body }, { tenant }) =>
    payroll.createPayItem(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.decidePayItem, ({ params, body }, { tenant }) =>
    payroll.decidePayItem(deps, tenantFrom(tenant), params.payItemId, body),
  );
  mountRoute(router, r.cancelPayItem, ({ params }) =>
    payroll.cancelPayItem(deps, params.payItemId),
  );
  mountRoute(router, r.getPayrollExport, ({ query }, { tenant }) =>
    payroll.getPayrollExport(deps, tenantFrom(tenant), query),
  );
  return router;
}
