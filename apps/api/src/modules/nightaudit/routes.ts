import { NIGHT_AUDIT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { businessDay } from '../../core/business-day.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as audit from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Business day and night audit (tab 4 row "Night audit"; T-054, T-073). */
export function nightAuditRoutes(deps: audit.NightAuditDeps): Router {
  const router = express.Router();
  const r = NIGHT_AUDIT_ROUTES;

  mountRoute(router, r.getBusinessDay, async (_input, { tenant }) => {
    const d = await businessDay(deps.tenantDb, tenantFrom(tenant).propertyId, deps.clock);
    return {
      date: d.date,
      status: d.status,
      openedAt: d.openedAt ? d.openedAt.toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
      nightAuditId: d.openedAt ? await audit.runIdFor(deps.tenantDb, d.date) : null,
    };
  });
  mountRoute(router, r.startNightAudit, ({ body }, { tenant }) =>
    audit.startNightAudit(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getNightAudit, ({ params }) =>
    audit.getNightAudit(deps, params.nightAuditId),
  );
  mountRoute(router, r.resumeNightAudit, ({ params }, { tenant }) =>
    audit.resumeNightAudit(deps, tenantFrom(tenant), params.nightAuditId),
  );

  mountRoute(router, r.getNightAuditReport, ({ params }, { tenant }) =>
    audit.nightAuditReport(deps, tenantFrom(tenant), params.nightAuditId, params.report),
  );

  return router;
}
