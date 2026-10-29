import { FRONT_DESK_ROUTES, NIGHT_AUDIT_ROUTES, RESERVATION_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { businessDay } from '../../core/business-day.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as checkIns from './check-in.ts';
import * as dayUse from './day-use.ts';
import * as extend from './extend.ts';
import * as frontDesk from './front-desk.ts';
import * as rooms from './rooms.ts';
import * as reservations from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Reservations (tab 4 row "Reservations"; T-042). */
export function reservationRoutes(deps: checkIns.CheckInDeps): Router {
  const router = express.Router();
  const r = RESERVATION_ROUTES;
  const etag = <T extends { version: number }>(res: express.Response, item: T) => {
    res.set('ETag', `"${item.version}"`);
    return item;
  };

  mountRoute(router, r.listReservations, ({ query }) => reservations.listReservations(deps, query));
  mountRoute(router, r.createReservation, async ({ body }, { tenant, res }) => {
    const result = await reservations.createReservation(deps, tenantFrom(tenant), body);
    return 'version' in result ? etag(res, result) : result;
  });
  mountRoute(router, r.getReservation, async ({ params }, { res }) =>
    etag(res, await reservations.getReservation(deps, params.reservationId)),
  );
  mountRoute(router, r.updateReservation, async ({ params, body }, { tenant, req, res }) =>
    etag(
      res,
      await reservations.updateReservation(
        deps,
        tenantFrom(tenant),
        params.reservationId,
        req.get('If-Match') ?? '',
        body,
      ),
    ),
  );
  mountRoute(router, r.cancelReservation, async ({ params, body }, { tenant, res }) =>
    etag(
      res,
      await reservations.cancelReservation(deps, tenantFrom(tenant), params.reservationId, body),
    ),
  );
  mountRoute(router, r.reinstateReservation, async ({ params }, { tenant, res }) =>
    etag(
      res,
      await reservations.reinstateReservation(deps, tenantFrom(tenant), params.reservationId),
    ),
  );
  mountRoute(router, r.getReservationHistory, ({ params }) =>
    reservations.getHistory(deps, params.reservationId),
  );
  mountRoute(router, r.getCalendar, ({ query }) => reservations.getCalendar(deps, query));
  mountRoute(router, r.listAssignableRooms, ({ params }) =>
    rooms.listAssignableRooms(deps, params.stayId),
  );
  mountRoute(router, r.assignRoom, async ({ params, body }, { tenant, res }) => {
    const result = await rooms.assignRoom(deps, tenantFrom(tenant), params.stayId, body);
    return 'version' in result ? etag(res, result) : result;
  });
  mountRoute(router, r.moveStay, async ({ params, body }, { tenant, res }) => {
    const result = await rooms.moveStay(deps, tenantFrom(tenant), params.stayId, body);
    return 'version' in result ? etag(res, result) : result;
  });

  mountRoute(router, r.checkIn, ({ params, body }, { tenant, req }) =>
    checkIns.checkIn(deps, tenantFrom(tenant), params.stayId, req.get('If-Match') ?? '', body),
  );
  mountRoute(router, r.getRegistrationCard, ({ params }) =>
    checkIns.getRegistrationCard(deps, params.stayId),
  );
  mountRoute(router, r.listKeys, ({ params }) => checkIns.listKeys(deps, params.stayId));
  mountRoute(router, r.issueKeys, ({ params, body }, { tenant }) =>
    checkIns.issueKeys(deps, tenantFrom(tenant), params.stayId, body.count),
  );

  mountRoute(router, r.getDayUseAvailability, ({ query }, { tenant }) =>
    dayUse.getDayUseAvailability(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, r.createDayUse, async ({ body }, { tenant, res }) =>
    etag(res, await dayUse.createDayUse(deps, tenantFrom(tenant), body)),
  );
  mountRoute(router, r.checkOut, async ({ params, body }, { tenant, req, res }) =>
    etag(
      res,
      await dayUse.checkOut(
        deps,
        tenantFrom(tenant),
        params.stayId,
        req.get('If-Match') ?? '',
        body,
      ),
    ),
  );

  mountRoute(router, r.extendStay, async ({ params, body }, { tenant, req, res }) =>
    etag(
      res,
      await extend.extendStay(
        deps,
        tenantFrom(tenant),
        params.stayId,
        req.get('If-Match') ?? '',
        body,
      ),
    ),
  );
  mountRoute(router, NIGHT_AUDIT_ROUTES.getBusinessDay, async (_input, { tenant }) => {
    const d = await businessDay(deps.tenantDb, tenantFrom(tenant).propertyId, deps.clock);
    return {
      date: d.date,
      status: d.status,
      openedAt: d.openedAt ? d.openedAt.toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    };
  });

  const fd = FRONT_DESK_ROUTES;
  mountRoute(router, fd.listArrivals, ({ query }, { tenant }) =>
    frontDesk.listArrivals(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, fd.listDepartures, ({ query }, { tenant }) =>
    frontDesk.listDepartures(deps, tenantFrom(tenant), query),
  );
  mountRoute(router, fd.listInHouse, (_input, { tenant }) =>
    frontDesk.listInHouse(deps, tenantFrom(tenant)),
  );

  return router;
}
