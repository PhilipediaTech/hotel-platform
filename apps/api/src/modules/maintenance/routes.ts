import { MAINTENANCE_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as preventive from './preventive.ts';
import * as maintenance from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Assets, work orders (T-130) and preventive plans (T-131): tab 4 row "Maintenance"; S34. */
export function maintenanceRoutes(deps: maintenance.MaintenanceDeps): Router {
  const router = express.Router();
  const r = MAINTENANCE_ROUTES;
  mountRoute(router, r.listAssets, ({ query }, { tenant }) =>
    maintenance.listAssets(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.createAsset, ({ body }, { tenant }) =>
    maintenance.createAsset(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getAsset, ({ params }, { tenant }) =>
    maintenance.getAsset(deps, tenantFrom(tenant), params.assetId),
  );
  mountRoute(router, r.updateAsset, ({ params, body }, { tenant }) =>
    maintenance.updateAsset(deps, tenantFrom(tenant), params.assetId, body),
  );
  mountRoute(router, r.saveWorkOrder, ({ params, body }, { tenant }) =>
    maintenance.saveWorkOrder(deps, tenantFrom(tenant), params.taskId, body),
  );
  mountRoute(router, r.listPreventivePlans, ({ query }, { tenant }) =>
    preventive.listPlans(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.createPreventivePlan, ({ body }, { tenant }) =>
    preventive.createPlan(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.updatePreventivePlan, ({ params, body }, { tenant }) =>
    preventive.updatePlan(deps, tenantFrom(tenant), params.planId, body),
  );
  mountRoute(router, r.recordPlanHours, ({ params, body }, { tenant }) =>
    preventive.recordHours(deps, tenantFrom(tenant), params.planId, body),
  );
  return router;
}
