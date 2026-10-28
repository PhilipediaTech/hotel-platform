import { PROPERTY_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as setup from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Organisation and properties: setup checklist and go-live (tab 4 row "Organisation"; T-030). */
export function setupRoutes(deps: setup.SetupDeps): Router {
  const router = express.Router();
  const r = PROPERTY_ROUTES;

  mountRoute(router, r.getOrganisation, (_input, { tenant }) =>
    setup.getOrganisation(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.updateOrganisation, ({ body }, { tenant }) =>
    setup.updateOrganisation(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listProperties, async (_input, { tenant }) => ({
    data: await setup.listProperties(deps, tenantFrom(tenant)),
  }));
  mountRoute(router, r.createProperty, ({ body }, { tenant }) =>
    setup.createProperty(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getProperty, ({ params }, { tenant }) =>
    setup.getProperty(deps, tenantFrom(tenant), params.propertyId),
  );
  mountRoute(router, r.updateProperty, ({ params, body }, { tenant }) =>
    setup.updateProperty(deps, tenantFrom(tenant), params.propertyId, body),
  );
  mountRoute(router, r.goLiveProperty, ({ params }, { tenant }) =>
    setup.goLive(deps, tenantFrom(tenant), params.propertyId),
  );

  return router;
}
