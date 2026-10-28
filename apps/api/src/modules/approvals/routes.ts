import { APPROVAL_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { approveRequest, rejectRequest, type ApprovalDeps } from '../../core/approvals.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as approvals from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Approvals (tab 4 row "Approvals"; T-022). */
export function approvalRoutes(deps: ApprovalDeps & { otpSecret: string }): Router {
  const router = express.Router();
  const r = APPROVAL_ROUTES;

  mountRoute(router, r.listApprovals, ({ query }, { tenant }) =>
    approvals.listApprovals(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.getApproval, ({ params }, { tenant }) =>
    approvals.getApproval(deps, tenantFrom(tenant), params.approvalId),
  );
  mountRoute(router, r.approveApproval, ({ params, body }, { tenant }) =>
    approveRequest(deps, tenantFrom(tenant), params.approvalId, body),
  );
  mountRoute(router, r.rejectApproval, ({ params, body }, { tenant }) =>
    rejectRequest(deps, tenantFrom(tenant), params.approvalId, body),
  );
  mountRoute(router, r.listApprovalPolicies, () => approvals.listPolicies(deps));
  mountRoute(router, r.updateApprovalPolicies, ({ body }) =>
    approvals.updatePolicies(deps, body.policies),
  );
  return router;
}
