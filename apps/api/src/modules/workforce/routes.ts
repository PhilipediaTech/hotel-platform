import { WORKFORCE_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as work from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Duties, rotas and leave (M7-02, M7-03, M7-05; T-137). */
export function workforceRoutes(deps: work.WorkforceDeps): Router {
  const router = express.Router();
  const r = WORKFORCE_ROUTES;
  mountRoute(router, r.listDuties, () => work.listDuties(deps));
  mountRoute(router, r.createDuty, ({ body }) => work.createDuty(deps, body));
  mountRoute(router, r.updateDuty, ({ params, body }) =>
    work.updateDuty(deps, params.dutyId, body),
  );
  mountRoute(router, r.getRota, ({ query }) => work.getRota(deps, query));
  mountRoute(router, r.addRotaShift, ({ params, body }) =>
    work.addRotaShift(deps, params.departmentId, body),
  );
  mountRoute(router, r.updateRotaShift, ({ params, body }) =>
    work.updateRotaShift(deps, params.shiftId, body),
  );
  mountRoute(router, r.assignShift, ({ body }) => work.assignShift(deps, body));
  mountRoute(router, r.unassignShift, ({ params }) =>
    work.unassignShift(deps, params.assignmentId),
  );
  mountRoute(router, r.publishRota, ({ params, body }) =>
    work.publishRota(deps, params.departmentId, body),
  );
  // /leave-requests/mine before any /leave-requests/{id} route.
  mountRoute(router, r.getMyWork, (_req, { tenant }) => work.getMyWork(deps, tenantFrom(tenant)));
  mountRoute(router, r.requestLeave, ({ body }, { tenant }) =>
    work.requestLeave(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.cancelLeave, ({ params }, { tenant }) =>
    work.cancelLeave(deps, tenantFrom(tenant), params.leaveId),
  );
  mountRoute(router, r.listLeave, ({ query }) => work.listLeave(deps, query));
  mountRoute(router, r.decideLeave, ({ params, body }, { tenant }) =>
    work.decideLeave(deps, tenantFrom(tenant), params.leaveId, body),
  );
  return router;
}
