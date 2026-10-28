import { GUEST_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as guests from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Guest and company profiles (tab 4 row "Guests"; T-043). */
export function guestRoutes(deps: guests.GuestDeps): Router {
  const router = express.Router();
  const r = GUEST_ROUTES;

  mountRoute(router, r.listGuests, ({ query }, { tenant }) =>
    guests.listGuests(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.createGuest, ({ body }, { tenant }) =>
    guests.createGuest(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getGuest, ({ params }, { tenant }) =>
    guests.getGuest(deps, tenantFrom(tenant), params.guestId),
  );
  mountRoute(router, r.updateGuest, ({ params, body }, { tenant }) =>
    guests.updateGuest(deps, tenantFrom(tenant), params.guestId, body),
  );
  mountRoute(router, r.mergeGuests, ({ params, body }, { tenant }) =>
    guests.mergeGuests(deps, tenantFrom(tenant), params.guestId, body.otherGuestId),
  );
  mountRoute(router, r.flagGuest, ({ params, body }, { tenant }) =>
    guests.flagGuest(deps, tenantFrom(tenant), params.guestId, body),
  );

  mountRoute(router, r.listCompanies, async ({ query }) => ({
    data: await guests.listCompanies(deps, query),
  }));
  mountRoute(router, r.createCompany, ({ body }) => guests.createCompany(deps, body));
  mountRoute(router, r.getCompany, ({ params }) => guests.getCompany(deps, params.companyId));
  mountRoute(router, r.updateCompany, ({ params, body }) =>
    guests.updateCompany(deps, params.companyId, body),
  );

  return router;
}
