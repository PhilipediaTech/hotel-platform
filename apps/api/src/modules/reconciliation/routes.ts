import { RECONCILIATION_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as recon from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Bank reconciliation (M4-23; S37; T-128). */
export function reconciliationRoutes(deps: recon.ReconDeps): Router {
  const router = express.Router();
  const r = RECONCILIATION_ROUTES;
  mountRoute(router, r.importBankStatement, ({ body }, { tenant }) =>
    recon.importStatement(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listBankStatementLines, ({ query }) => recon.listLines(deps, query));
  mountRoute(router, r.listBookEntries, ({ query }) => recon.listEntries(deps, query));
  mountRoute(router, r.autoMatchBankLines, (_i, { tenant }) =>
    recon.autoMatch(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.matchBankLine, ({ params, body }, { tenant }) =>
    recon.match(deps, tenantFrom(tenant), params.lineId, body),
  );
  mountRoute(router, r.explainBankLine, ({ params, body }, { tenant }) =>
    recon.explain(deps, tenantFrom(tenant), params.lineId, body.note),
  );
  mountRoute(router, r.unmatchBankLine, ({ params, body }, { tenant }) =>
    recon.unmatch(deps, tenantFrom(tenant), params.lineId, body.reason),
  );
  return router;
}
