import { TAX_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as tax from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Revenue codes and taxes (tab 4 row "Tax and FX"; T-032). */
export function taxRoutes(deps: tax.TaxDeps): Router {
  const router = express.Router();
  const r = TAX_ROUTES;

  mountRoute(router, r.listRevenueCodes, async () => ({
    data: await tax.listRevenueCodes(deps),
  }));
  mountRoute(router, r.createRevenueCode, ({ body }) => tax.createRevenueCode(deps, body));
  mountRoute(router, r.updateRevenueCode, ({ params, body }) =>
    tax.updateRevenueCode(deps, params.revenueCodeId, body),
  );

  // Before /tax-rules/{taxRuleId}/… so "confirm" is never read as an ID.
  mountRoute(router, r.confirmTaxes, (_input, { tenant }) =>
    tax.confirmTaxes(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.listTaxRules, (_input, { tenant }) =>
    tax.listTaxRules(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.createTaxRule, ({ body }, { tenant }) =>
    tax.createTaxRule(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.addTaxRuleVersion, ({ params, body }, { tenant }) =>
    tax.addTaxRuleVersion(deps, tenantFrom(tenant), params.taxRuleId, body),
  );

  return router;
}
