import {
  EVENT_CANCELLATION_ROUTES,
  EVENT_CLOSEOUT_ROUTES,
  EVENT_ROUTES,
  EVENT_SALES_ROUTES,
} from '@hotel/shared';
import express, { type Router } from 'express';
import { defineJob } from '../../core/jobs.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as cancellation from './cancellation.ts';
import * as closeout from './closeout.ts';
import * as sales from './sales.ts';
import * as events from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Events and spaces (M9-01–M9-08; T-119–T-121). */
export function eventRoutes(deps: sales.EventSalesDeps): Router {
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
  const s = EVENT_SALES_ROUTES;
  mountRoute(router, s.getEventQuotes, ({ params }) => sales.getQuotes(deps, params.bookingId));
  mountRoute(router, s.createEventQuoteVersion, ({ params, body }, { tenant }) =>
    sales.saveQuoteVersion(deps, tenantFrom(tenant), params.bookingId, body),
  );
  mountRoute(router, s.getEventContract, ({ params }) => sales.getContract(deps, params.bookingId));
  mountRoute(router, s.getEventContractPdf, ({ params }) =>
    sales.contractPdf(deps, params.bookingId),
  );
  mountRoute(router, s.issueEventContract, ({ params, body }, { tenant }) =>
    sales.issueContract(deps, tenantFrom(tenant), params.bookingId, body),
  );
  mountRoute(router, s.signEventContract, ({ params, body }) =>
    sales.signContract(deps, params.bookingId, body),
  );
  mountRoute(router, s.confirmEventBooking, ({ params, body }, { tenant }) =>
    sales.confirmBooking(deps, tenantFrom(tenant), params.bookingId, body),
  );
  const c = EVENT_CLOSEOUT_ROUTES;
  mountRoute(router, c.getEventBrief, ({ params }) => closeout.getBrief(deps, params.bookingId));
  mountRoute(router, c.saveEventBrief, ({ params, body }, { tenant }) =>
    closeout.saveBrief(deps, tenantFrom(tenant), params.bookingId, body),
  );
  mountRoute(router, c.getEventBriefPdf, ({ params, query }) =>
    closeout.briefPdf(deps, params.bookingId, query.departmentId),
  );
  mountRoute(router, c.getEventCloseOut, ({ params }) =>
    closeout.getCloseOut(deps, params.bookingId),
  );
  mountRoute(router, c.inspectEvent, ({ params, body }, { tenant }) =>
    closeout.inspect(deps, tenantFrom(tenant), params.bookingId, body),
  );
  mountRoute(router, c.getEventInvoicePdf, ({ params }) =>
    closeout.invoicePdf(deps, params.bookingId),
  );
  mountRoute(router, c.closeEvent, ({ params }) => closeout.closeBooking(deps, params.bookingId));
  const x = EVENT_CANCELLATION_ROUTES;
  mountRoute(router, x.getEventCancellation, ({ params }) =>
    cancellation.getCancellation(deps, params.bookingId),
  );
  mountRoute(router, x.cancelEvent, ({ params, body }, { tenant }) =>
    cancellation.cancelBooking(deps, tenantFrom(tenant), params.bookingId, body),
  );
  mountRoute(router, x.getEventSettings, (_input, { tenant }) =>
    cancellation.getSettings(deps, tenantFrom(tenant)),
  );
  mountRoute(router, x.updateEventSettings, ({ body }, { tenant }) =>
    cancellation.updateSettings(deps, tenantFrom(tenant), body.cancellation),
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
