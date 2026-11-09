import { OWNER_ROUTES, REPORT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { askFigures, type AskDeps } from './ai.ts';
import { ownerHome, type OwnerDeps } from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** The owner home (tab 4 row "Owner"; T-091). */
export function ownerRoutes(deps: OwnerDeps & AskDeps): Router {
  const router = express.Router();
  mountRoute(router, OWNER_ROUTES.getOwnerHome, (_req, { tenant }) =>
    ownerHome(deps, tenantFrom(tenant)),
  );
  mountRoute(router, REPORT_ROUTES.askFigures, ({ body }, { tenant }) =>
    askFigures(deps, tenantFrom(tenant), body.question),
  );
  return router;
}
