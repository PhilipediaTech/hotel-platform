import { AR_ROUTES, COMMISSION_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as commissions from './commissions.ts';
import * as ar from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** City ledger (M4-21; T-126) and travel-agent commissions (M4-22; T-127). */
export function arRoutes(deps: ar.ArDeps): Router {
  const router = express.Router();
  const r = AR_ROUTES;
  mountRoute(router, r.listArAccounts, (_i, { tenant }) =>
    ar.listAccounts(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.createArAccount, ({ body }, { tenant }) =>
    ar.createAccount(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getArAccount, ({ params }, { tenant }) =>
    ar.getAccount(deps, tenantFrom(tenant), params.accountId),
  );
  mountRoute(router, r.updateArAccount, ({ params, body }, { tenant }) =>
    ar.updateAccount(deps, tenantFrom(tenant), params.accountId, body),
  );
  mountRoute(router, r.transferToAr, ({ params, body }, { tenant }) =>
    ar.transfer(deps, tenantFrom(tenant), params.accountId, body),
  );
  mountRoute(router, r.recordArPayment, ({ params, body }, { tenant }) =>
    ar.recordPayment(deps, tenantFrom(tenant), params.accountId, body),
  );
  mountRoute(router, r.allocateArPayment, ({ params, body }, { tenant }) =>
    ar.allocate(deps, tenantFrom(tenant), params.paymentId, body),
  );
  mountRoute(router, r.getArStatement, ({ params, query }, { tenant }) =>
    ar.statement(deps, tenantFrom(tenant), params.accountId, query),
  );
  mountRoute(router, r.getArStatementPdf, async ({ params, query }, { tenant }) => {
    const { filename, content } = await ar.statementPdf(
      deps,
      tenantFrom(tenant),
      params.accountId,
      query,
    );
    return { filename, content };
  });
  mountRoute(router, r.sendArStatement, ({ params, body }, { tenant }) =>
    ar.sendStatement(deps, tenantFrom(tenant), params.accountId, body),
  );
  mountRoute(router, r.getArAgeing, ({ query }, { tenant }) =>
    ar.ageing(deps, tenantFrom(tenant), query.asOf),
  );
  // Travel-agent commissions (M4-22; T-127).
  const c = COMMISSION_ROUTES;
  mountRoute(router, c.listCommissions, ({ query }, { tenant }) =>
    commissions.list(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, c.calculateCommissions, ({ body }, { tenant }) =>
    commissions.calculate(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, c.settleCommissions, ({ body }, { tenant }) =>
    commissions.settle(deps, tenantFrom(tenant), body),
  );
  return router;
}
