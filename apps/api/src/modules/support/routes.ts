import { SUPPORT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { getAuth, requireAuth } from '../../core/auth.ts';
import { AppError } from '../../core/errors.ts';
import { isPlatformAdmin } from '../../core/platform-admin.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as support from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** In-app support: Help for hotel staff, the queue in S31 for platform staff (T-170). */
export function supportRoutes(deps: support.SupportDeps): Router {
  const router = express.Router();
  const r = SUPPORT_ROUTES;

  // Platform staff only, as for the rest of /platform (platform/routes.ts).
  router.use(['/platform/support', '/platform/admins', '/platform/tenants'], (req, _res, next) => {
    const auth = getAuth(req);
    if (auth && !isPlatformAdmin(deps.config, auth.user)) {
      throw new AppError('FORBIDDEN', 'Platform staff only.');
    }
    next();
  });

  mountRoute(router, r.listSupportTickets, (_req, { tenant }) =>
    support.listTickets(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.createSupportTicket, ({ body }, { tenant }) =>
    support.createTicket(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getSupportTicket, ({ params }, { tenant }) =>
    support.getTicket(deps, tenantFrom(tenant), params.ticketId),
  );
  mountRoute(router, r.replySupportTicket, ({ params, body }, { tenant }) =>
    support.replyTicket(deps, tenantFrom(tenant), params.ticketId, body.message),
  );
  mountRoute(router, r.resolveSupportTicket, ({ params }, { tenant }) =>
    support.resolveTicket(deps, tenantFrom(tenant), params.ticketId),
  );

  mountRoute(router, r.listPlatformSupportTickets, ({ query }) =>
    support.listQueue(deps, query.status),
  );
  mountRoute(router, r.getPlatformSupportTicket, ({ params }) =>
    support.getQueueTicket(deps, params.ticketId),
  );
  mountRoute(router, r.replyPlatformSupportTicket, ({ params, body }, { req }) =>
    support.answerTicket(deps, requireAuth(req), params.ticketId, body.message),
  );
  mountRoute(router, r.assignPlatformSupportTicket, ({ params, body }, { req }) =>
    support.assignTicket(deps, requireAuth(req), params.ticketId, body.adminUserId),
  );
  mountRoute(router, r.resolvePlatformSupportTicket, ({ params }, { req }) =>
    support.closeTicket(deps, requireAuth(req), params.ticketId),
  );
  mountRoute(router, r.listPlatformAdmins, async () => ({
    data: await support.platformAdmins(deps),
  }));
  mountRoute(router, r.setOnboardingContact, ({ params, body }, { req }) =>
    support.setContact(deps, requireAuth(req), params.organisationId, body.adminUserId),
  );
  return router;
}
