import { FOLIO_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as folios from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Folios (tab 4 row "Folios"; T-060). */
export function folioRoutes(deps: folios.FolioDeps): Router {
  const router = express.Router();
  const r = FOLIO_ROUTES;

  mountRoute(router, r.listFolios, ({ query }) => folios.listFolios(deps, query));
  mountRoute(router, r.getFolio, ({ params }) => folios.getFolio(deps, params.folioId));
  mountRoute(router, r.openStayFolio, ({ params }) => folios.openStayFolio(deps, params.stayId));
  mountRoute(router, r.postCharge, ({ params, body }, { tenant }) =>
    folios.postCharge(deps, tenantFrom(tenant), params.folioId, body),
  );
  mountRoute(router, r.reverseLine, ({ params, body }, { tenant }) =>
    folios.reverseLine(deps, tenantFrom(tenant), params.lineId, body.reason),
  );
  mountRoute(router, r.addDiscount, ({ params, body }, { tenant }) =>
    folios.addDiscount(deps, tenantFrom(tenant), params.folioId, body),
  );
  mountRoute(router, r.addWindow, ({ params, body }) =>
    folios.addWindow(deps, params.folioId, body),
  );
  mountRoute(router, r.addRoutingRule, ({ params, body }) =>
    folios.addRoutingRule(deps, params.folioId, body),
  );

  return router;
}
