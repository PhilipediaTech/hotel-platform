import { IMPORT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as imports from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Spreadsheet imports (tab 4 row "Imports"; T-034). */
export function importRoutes(deps: imports.ImportDeps): Router {
  const router = express.Router();
  const r = IMPORT_ROUTES;

  mountRoute(router, r.validateImport, ({ body }, { tenant }) =>
    imports.validateImport(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getImport, ({ params }) => imports.getImport(deps, params.importId));
  mountRoute(router, r.applyImport, ({ params }, { tenant }) =>
    imports.applyImport(deps, tenantFrom(tenant), params.importId),
  );

  return router;
}
