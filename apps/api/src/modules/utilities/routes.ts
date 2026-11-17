import { UTILITIES_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as utilities from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Generators, fuel and meters (tab 4 row "Utilities"; S35; T-132). */
export function utilitiesRoutes(deps: utilities.UtilitiesDeps): Router {
  const router = express.Router();
  const r = UTILITIES_ROUTES;
  mountRoute(router, r.listGenerators, (_req, { tenant }) =>
    utilities.listGenerators(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.createGenerator, ({ body }, { tenant }) =>
    utilities.createGenerator(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getGenerator, ({ params }, { tenant }) =>
    utilities.getGenerator(deps, tenantFrom(tenant), params.generatorId),
  );
  mountRoute(router, r.startGeneratorRun, ({ params, body }, { tenant }) =>
    utilities.startRun(deps, tenantFrom(tenant), params.generatorId, body),
  );
  mountRoute(router, r.stopGeneratorRun, ({ params, body }, { tenant }) =>
    utilities.stopRun(deps, tenantFrom(tenant), params.runId, body),
  );
  mountRoute(router, r.recordFuelMovement, ({ body }, { tenant }) =>
    utilities.recordFuel(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.recordMeterReading, ({ body }, { tenant }) =>
    utilities.recordReading(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listMeterReadings, ({ query }, { tenant }) =>
    utilities.listReadings(deps, tenantFrom(tenant), query),
  );
  return router;
}
