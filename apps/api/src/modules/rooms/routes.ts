import { ROOM_ROUTES } from '@hotel/shared';
import express, { type Response, type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as rooms from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Versioned rooms answer with their ETag, which the next PATCH sends back as If-Match. */
function withEtag<T extends { version: number }>(res: Response, room: T): T {
  res.set('ETag', `"${room.version}"`);
  return room;
}

/** Room types, rooms and blocks (tab 4 row "Rooms"; T-031). */
export function roomRoutes(deps: rooms.RoomDeps): Router {
  const router = express.Router();
  const r = ROOM_ROUTES;

  mountRoute(router, r.listRoomTypes, async () => ({ data: await rooms.listRoomTypes(deps) }));
  mountRoute(router, r.createRoomType, ({ body }) => rooms.createRoomType(deps, body));
  mountRoute(router, r.updateRoomType, ({ params, body }) =>
    rooms.updateRoomType(deps, params.roomTypeId, body),
  );

  mountRoute(router, r.listRooms, async (_input, { tenant }) => ({
    data: await rooms.listRooms(deps, tenantFrom(tenant)),
  }));
  mountRoute(router, r.createRoom, async ({ body }, { tenant, res }) =>
    withEtag(res, await rooms.createRoom(deps, tenantFrom(tenant), body)),
  );
  mountRoute(router, r.updateRoom, async ({ params, body }, { tenant, req, res }) =>
    withEtag(
      res,
      await rooms.updateRoom(
        deps,
        tenantFrom(tenant),
        params.roomId,
        req.get('If-Match') ?? '',
        body,
      ),
    ),
  );

  mountRoute(router, r.createRoomBlock, ({ body }, { tenant }) =>
    rooms.createRoomBlock(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.releaseRoomBlock, ({ params }, { tenant }) =>
    rooms.releaseRoomBlock(deps, tenantFrom(tenant), params.blockId),
  );

  return router;
}
