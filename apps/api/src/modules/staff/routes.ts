import { STAFF_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as staff from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Staff profiles and certifications (M7-01, M7-10; T-136). */
export function staffRoutes(deps: staff.StaffDeps): Router {
  const router = express.Router();
  const r = STAFF_ROUTES;
  mountRoute(router, r.listStaff, ({ query }, { tenant }) =>
    staff.listStaff(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.createStaff, ({ body }, { tenant }) =>
    staff.createStaff(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getStaff, ({ params }, { tenant }) =>
    staff.getStaff(deps, tenantFrom(tenant), params.staffId),
  );
  mountRoute(router, r.updateStaff, ({ params, body }, { tenant }) =>
    staff.updateStaff(deps, tenantFrom(tenant), params.staffId, body),
  );
  mountRoute(router, r.getEmergencyContact, ({ params }) =>
    staff.getEmergencyContact(deps, params.staffId),
  );
  mountRoute(router, r.addCertification, ({ params, body }, { tenant }) =>
    staff.addCertification(deps, tenantFrom(tenant), params.staffId, body),
  );
  mountRoute(router, r.updateCertification, ({ params, body }, { tenant }) =>
    staff.updateCertification(
      deps,
      tenantFrom(tenant),
      params.staffId,
      params.certificationId,
      body,
    ),
  );
  mountRoute(router, r.removeCertification, ({ params }, { tenant }) =>
    staff.removeCertification(deps, tenantFrom(tenant), params.staffId, params.certificationId),
  );
  return router;
}
