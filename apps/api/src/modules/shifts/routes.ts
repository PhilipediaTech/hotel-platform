import { SHIFT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as shifts from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Cashier shifts (tab 4 row "Shifts"; T-061). */
export function shiftRoutes(deps: shifts.ShiftDeps): Router {
  const router = express.Router();
  const r = SHIFT_ROUTES;

  mountRoute(router, r.getCurrentShift, (_req, { tenant }) =>
    shifts.currentShift(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.listShifts, ({ query }) => shifts.listShifts(deps, query));
  mountRoute(router, r.openShift, ({ body }, { tenant }) =>
    shifts.openShift(deps, tenantFrom(tenant), body.floatMinor),
  );
  mountRoute(router, r.closeShift, ({ params, body }, { tenant }) =>
    shifts.closeShift(deps, tenantFrom(tenant), params.shiftId, body),
  );
  mountRoute(router, r.addVarianceNote, ({ params, body }, { tenant }) =>
    shifts.addVarianceNote(deps, tenantFrom(tenant), params.shiftId, body.note),
  );
  mountRoute(router, r.signOffShift, ({ params, body }, { tenant }) =>
    shifts.signOffShift(deps, tenantFrom(tenant), params.shiftId, body.note),
  );
  mountRoute(router, r.createHandover, ({ body }, { tenant }) =>
    shifts.createHandover(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.confirmHandover, ({ params }, { tenant }) =>
    shifts.confirmHandover(deps, tenantFrom(tenant), params.handoverId),
  );

  return router;
}
