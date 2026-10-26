import { ACCESS_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { getAuth } from '../../core/auth.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as access from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Users and roles (tab 4 row "Users and roles"; T-013). */
export function accessRoutes(deps: access.AccessDeps): Router {
  const router = express.Router();
  const r = ACCESS_ROUTES;

  mountRoute(router, r.listPermissions, () => ({ data: access.listPermissions() }));
  mountRoute(router, r.listRoles, async () => ({ data: await access.listRoles(deps) }));
  mountRoute(router, r.createRole, ({ body }) => access.createRole(deps, body));
  mountRoute(router, r.updateRole, ({ params, body }) =>
    access.updateRole(deps, params.roleId, body),
  );

  mountRoute(router, r.listUsers, ({ query }, { tenant }) =>
    access.listUsers(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.updateUser, ({ params, body }, { tenant }) =>
    access.updateUser(deps, tenantFrom(tenant), params.userId, body),
  );
  mountRoute(router, r.createPasswordResetLink, ({ params }, { tenant }) =>
    access.createPasswordResetLink(deps, tenantFrom(tenant), params.userId),
  );

  mountRoute(router, r.listInvitations, async (_input, { tenant }) => ({
    data: await access.listInvitations(deps, tenantFrom(tenant)),
  }));
  mountRoute(router, r.createInvitation, ({ body }, { tenant }) =>
    access.createInvitation(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.revokeInvitation, ({ params }) =>
    access.revokeInvitation(deps, params.invitationId),
  );

  mountRoute(router, r.previewInvitation, ({ body }) => access.previewInvitation(deps, body.token));
  mountRoute(router, r.acceptInvitation, ({ body }, { req }) =>
    access.acceptInvitation(deps, getAuth(req), body),
  );

  return router;
}
