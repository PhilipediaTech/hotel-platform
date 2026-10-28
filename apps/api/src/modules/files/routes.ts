import { FILE_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as files from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Files (tab 4 row "Files"; T-023). Permissions depend on the file kind. */
export function fileRoutes(deps: files.FileDeps): Router {
  const router = express.Router();
  const r = FILE_ROUTES;

  mountRoute(router, r.createFileUploadUrl, ({ body }, { tenant }) =>
    files.createUploadUrl(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getFileDownloadUrl, ({ params }, { tenant }) =>
    files.getDownloadUrl(deps, tenantFrom(tenant), params.fileId),
  );
  return router;
}
