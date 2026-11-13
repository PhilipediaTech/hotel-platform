import { HOUSEKEEPING_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as inspections from './inspections.ts';
import * as hk from './service.ts';
import * as settings from './settings.ts';
import * as reports from './status-reports.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Housekeeping (tab 4 row "Housekeeping"; T-080, morning status reports T-081, inspection T-129). */
export function housekeepingRoutes(deps: hk.HousekeepingDeps): Router {
  const router = express.Router();
  const r = HOUSEKEEPING_ROUTES;

  mountRoute(router, r.getHousekeepingBoard, ({ query }, { tenant }) =>
    hk.getBoard(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.assignRooms, ({ body }, { tenant }) =>
    hk.assignRooms(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listMyAssignments, (_input, { tenant }) =>
    hk.myAssignments(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.updateAssignment, ({ params, body }, { tenant }) =>
    hk.updateAssignment(deps, tenantFrom(tenant), params.assignmentId, body),
  );
  mountRoute(router, r.listStatusReports, ({ query }, { tenant }) =>
    reports.listStatusReports(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.submitStatusReport, ({ body }, { tenant }) =>
    reports.submitStatusReport(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.recordInspection, ({ body }, { tenant }) =>
    inspections.recordInspection(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.updateHousekeepingSettings, ({ body }, { tenant }) =>
    settings.updateHousekeepingSettings(deps, tenantFrom(tenant), body),
  );

  return router;
}
