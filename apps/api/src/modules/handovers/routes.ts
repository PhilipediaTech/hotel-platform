import { HANDOVER_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as handovers from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Shift handover notes (tab 4 row "Handovers"; T-083). */
export function handoverRoutes(deps: handovers.HandoverDeps): Router {
  const router = express.Router();
  const r = HANDOVER_ROUTES;

  // Before /handovers/{handoverId}/…, so "draft" is never read as an ID.
  mountRoute(router, r.getHandoverDraft, ({ query }, { tenant }) =>
    handovers.getDraft(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.listHandoverNotes, ({ query }, { tenant }) =>
    handovers.listHandovers(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.writeHandoverNote, ({ body }, { tenant }) =>
    handovers.writeHandover(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.acknowledgeHandoverNote, ({ params }, { tenant }) =>
    handovers.acknowledgeHandover(deps, tenantFrom(tenant), params.handoverId),
  );

  return router;
}
