import { POS_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as setup from './setup.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Lite POS: outlets and menus (M8-01; T-141). */
export function posRoutes(deps: setup.PosDeps): Router {
  const router = express.Router();
  const r = POS_ROUTES;
  mountRoute(router, r.listOutlets, (_in, { tenant }) =>
    setup.listOutlets(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.createOutlet, ({ body }) => setup.createOutlet(deps, body));
  mountRoute(router, r.updateOutlet, ({ params, body }) =>
    setup.updateOutlet(deps, params.outletId, body),
  );
  mountRoute(router, r.addMenuCategory, ({ params, body }) =>
    setup.addMenuCategory(deps, params.outletId, body),
  );
  mountRoute(router, r.updateMenuCategory, ({ params, body }) =>
    setup.updateMenuCategory(deps, params.categoryId, body),
  );
  mountRoute(router, r.addMenuItem, ({ params, body }) =>
    setup.addMenuItem(deps, params.categoryId, body),
  );
  mountRoute(router, r.updateMenuItem, ({ params, body }) =>
    setup.updateMenuItem(deps, params.itemId, body),
  );
  mountRoute(router, r.addMenuModifier, ({ params, body }) =>
    setup.addMenuModifier(deps, params.itemId, body),
  );
  mountRoute(router, r.updateMenuModifier, ({ params, body }) =>
    setup.updateMenuModifier(deps, params.modifierId, body),
  );
  return router;
}
