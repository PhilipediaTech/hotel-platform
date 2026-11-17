import { CHECKLISTS_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as checklists from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Recurring checklists (M6-13; T-134). */
export function checklistRoutes(deps: checklists.ChecklistDeps): Router {
  const router = express.Router();
  const r = CHECKLISTS_ROUTES;
  mountRoute(router, r.listChecklists, (_req, { tenant }) =>
    checklists.listChecklists(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.createChecklist, ({ body }, { tenant }) =>
    checklists.createChecklist(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.updateChecklist, ({ params, body }, { tenant }) =>
    checklists.updateChecklist(deps, tenantFrom(tenant), params.checklistId, body),
  );
  mountRoute(router, r.listChecklistRuns, ({ query }, { tenant }) =>
    checklists.listRuns(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.completeChecklistRun, ({ params, body }, { tenant }) =>
    checklists.completeRun(deps, tenantFrom(tenant), params.runId, body),
  );
  return router;
}
