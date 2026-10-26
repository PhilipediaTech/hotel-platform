import { AUDIT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import * as audit from './service.ts';

/** Audit log (tab 4 row "Audit"; T-014). */
export function auditRoutes(deps: audit.AuditDeps): Router {
  const router = express.Router();
  mountRoute(router, AUDIT_ROUTES.listAuditEvents, ({ query }, { tenant }) => {
    if (!tenant) throw new Error('Tenant missing on a property-scoped route');
    return audit.listAuditEvents(deps, tenant, query);
  });
  return router;
}
