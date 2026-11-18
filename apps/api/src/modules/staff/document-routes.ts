import { STAFF_DOCUMENT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as docs from './documents.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Staff documents and their retention (M7-09; T-140). */
export function staffDocumentRoutes(deps: docs.StaffDocumentDeps): Router {
  const router = express.Router();
  const r = STAFF_DOCUMENT_ROUTES;
  mountRoute(router, r.listStaffDocuments, ({ params }, { tenant }) =>
    docs.listStaffDocuments(deps, tenantFrom(tenant), params.staffId),
  );
  mountRoute(router, r.addStaffDocument, ({ params, body }, { tenant }) =>
    docs.addStaffDocument(deps, tenantFrom(tenant), params.staffId, body),
  );
  mountRoute(router, r.getStaffDocumentLink, ({ params }) =>
    docs.getStaffDocumentLink(deps, params.staffId, params.documentId),
  );
  mountRoute(router, r.removeStaffDocument, ({ params }) =>
    docs.removeStaffDocument(deps, params.staffId, params.documentId),
  );
  mountRoute(router, r.getStaffDocumentSettings, (_in, { tenant }) =>
    docs.getStaffDocumentSettings(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.updateStaffDocumentSettings, ({ body }, { tenant }) =>
    docs.updateStaffDocumentSettings(deps, tenantFrom(tenant), body.retention),
  );
  return router;
}
