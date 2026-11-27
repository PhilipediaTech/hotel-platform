import { SEARCH_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { askSearch, type AskSearchDeps } from './ask.ts';
import { search } from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Search from the top bar, plain and with AI (T-178). */
export function searchRoutes(deps: AskSearchDeps): Router {
  const router = express.Router();
  const r = SEARCH_ROUTES;
  mountRoute(router, r.search, ({ query }, { tenant }) =>
    search(deps, tenantFrom(tenant), query.q),
  );
  mountRoute(router, r.askSearch, ({ body }, { tenant }) =>
    askSearch(deps, tenantFrom(tenant), body.question),
  );
  return router;
}
