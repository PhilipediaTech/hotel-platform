import { EVENT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { defineJob } from '../../core/jobs.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as events from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Events and spaces (M9-01–M9-03; T-119). */
export function eventRoutes(deps: events.EventDeps): Router {
  const router = express.Router();
  const r = EVENT_ROUTES;
  // Before /spaces/{spaceId}, which only answers PUT, for clarity when reading the list.
  mountRoute(router, r.getSpaceAvailability, ({ query }) => events.spaceAvailability(deps, query));
  mountRoute(router, r.listSpaces, () => events.listSpaces(deps));
  mountRoute(router, r.createSpace, ({ body }) => events.createSpace(deps, body));
  mountRoute(router, r.updateSpace, ({ params, body }) =>
    events.updateSpace(deps, params.spaceId, body),
  );
  mountRoute(router, r.listEventEnquiries, ({ query }) => events.listEnquiries(deps, query));
  mountRoute(router, r.createEventEnquiry, ({ body }, { tenant }) =>
    events.createEnquiry(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.updateEventEnquiry, ({ params, body }) =>
    events.updateEnquiry(deps, params.enquiryId, body),
  );
  mountRoute(router, r.listEventBookings, ({ query }) => events.listBookings(deps, query));
  mountRoute(router, r.createEventBooking, ({ body }, { tenant }) =>
    events.createHold(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.releaseEventHold, ({ params }) =>
    events.releaseHold(deps, params.bookingId),
  );
  return router;
}

/** Holds give back their space within a minute of running out (M9 rule). */
export const eventHoldExpiryJob = defineJob({
  name: 'event-hold-expiry',
  schedule: { cron: '* * * * *' },
  async run(_data, { db, clock, logger }) {
    const expired = await events.expireHolds(db, clock);
    if (expired > 0) logger.info({ expired }, 'Event holds expired');
  },
});
