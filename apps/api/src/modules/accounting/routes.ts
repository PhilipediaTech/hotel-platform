import { ACCOUNTING_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as accounting from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Accounting exports: account mapping and the general journal CSV (M10-07; T-148). */
export function accountingRoutes(deps: accounting.AccountingDeps): Router {
  const router = express.Router();
  const r = ACCOUNTING_ROUTES;
  mountRoute(router, r.getAccountingMappings, () => accounting.getAccountingMappings(deps));
  mountRoute(router, r.updateAccountingMappings, ({ body }, { tenant }) =>
    accounting.updateAccountingMappings(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listAccountingExports, (_in, { tenant }) =>
    accounting.listAccountingExports(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.createAccountingExport, ({ body }, { tenant }) =>
    accounting.createAccountingExport(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getAccountingExport, ({ params, query }) =>
    accounting.getAccountingExport(deps, params.exportId, query),
  );
  return router;
}
