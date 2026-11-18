import { ATTENDANCE_ROUTES } from '@hotel/shared';
import express, { type Request, type Router } from 'express';
import type { AuthContext } from '../../core/auth.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as attendance from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

function authFrom(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('Session missing on a signed-in route');
  return auth;
}

/** The client's address, as Express sees it (behind the proxy in production). */
const ipOf = (req: Request) => req.ip ?? null;

/** Clocking in and out, and the attendance settings (M7-04; T-138). */
export function attendanceRoutes(deps: attendance.AttendanceDeps): Router {
  const router = express.Router();
  const r = ATTENDANCE_ROUTES;
  mountRoute(router, r.getMyAttendance, (_in, { tenant, auth }) =>
    attendance.getMyAttendance(deps, tenantFrom(tenant), authFrom(auth)),
  );
  mountRoute(router, r.clockAttendance, ({ body }, { tenant, auth, req }) =>
    attendance.clockAttendance(deps, tenantFrom(tenant), authFrom(auth), ipOf(req), body),
  );
  mountRoute(router, r.setLocationConsent, ({ body }, { tenant, auth }) =>
    attendance.setLocationConsent(deps, tenantFrom(tenant), authFrom(auth), body.consent),
  );
  mountRoute(router, r.getAttendanceSettings, (_in, { tenant, req }) =>
    attendance.getAttendanceSettings(deps, tenantFrom(tenant), ipOf(req)),
  );
  mountRoute(router, r.updateAttendanceSettings, ({ body }, { tenant, req }) =>
    attendance.updateAttendanceSettings(deps, tenantFrom(tenant), ipOf(req), body),
  );
  // After /attendance/me and /attendance/settings.
  mountRoute(router, r.listAttendance, ({ query }, { tenant }) =>
    attendance.listAttendance(deps, tenantFrom(tenant), query),
  );
  return router;
}
