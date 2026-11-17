import { LOST_FOUND_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as lostFound from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Lost and found (M5-13; T-133). */
export function lostFoundRoutes(deps: lostFound.LostFoundDeps): Router {
  const router = express.Router();
  const r = LOST_FOUND_ROUTES;
  mountRoute(router, r.listLostItems, ({ query }, { tenant }) =>
    lostFound.listItems(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.createLostItem, ({ body }, { tenant }) =>
    lostFound.createItem(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getLostItem, ({ params }, { tenant }) =>
    lostFound.getItem(deps, tenantFrom(tenant), params.itemId),
  );
  mountRoute(router, r.moveLostItem, ({ params, body }, { tenant }) =>
    lostFound.moveItem(deps, tenantFrom(tenant), params.itemId, body),
  );
  mountRoute(router, r.returnLostItem, ({ params, body }, { tenant }) =>
    lostFound.returnItem(deps, tenantFrom(tenant), params.itemId, body),
  );
  mountRoute(router, r.disposeLostItem, ({ params, body }, { tenant }) =>
    lostFound.disposeItem(deps, tenantFrom(tenant), params.itemId, body),
  );
  return router;
}
