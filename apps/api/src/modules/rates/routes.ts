import { RATE_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as rates from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Rate plans, calendar, cancellation policies and packages (tab 4 row "Rates"; T-033). */
export function rateRoutes(deps: rates.RateDeps): Router {
  const router = express.Router();
  const r = RATE_ROUTES;

  mountRoute(router, r.listCancellationPolicies, async () => ({
    data: await rates.listCancellationPolicies(deps),
  }));
  mountRoute(router, r.createCancellationPolicy, ({ body }) =>
    rates.createCancellationPolicy(deps, body),
  );

  mountRoute(router, r.listRatePlans, async () => ({ data: await rates.listRatePlans(deps) }));
  mountRoute(router, r.createRatePlan, async ({ body }, { tenant, res }) => {
    const plan = await rates.createRatePlan(deps, tenantFrom(tenant), body);
    res.set('ETag', `"${plan.version}"`);
    return plan;
  });
  mountRoute(router, r.updateRatePlan, async ({ params, body }, { req, res }) => {
    const plan = await rates.updateRatePlan(
      deps,
      params.ratePlanId,
      req.get('If-Match') ?? '',
      body,
    );
    res.set('ETag', `"${plan.version}"`);
    return plan;
  });

  mountRoute(router, r.getRateCalendar, ({ query }) => rates.getRateCalendar(deps, query));
  mountRoute(router, r.updateRateCalendar, ({ body }, { tenant }) =>
    rates.updateRateCalendar(deps, tenantFrom(tenant), body),
  );

  mountRoute(router, r.listPackages, async () => ({
    data: await rates.listRatePlans(deps, 'PACKAGE'),
  }));
  mountRoute(router, r.setPackageComponents, ({ body }) => rates.setPackageComponents(deps, body));

  return router;
}
