import { GROUP_BLOCK_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { defineJob } from '../../core/jobs.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as groups from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Group blocks (M3-17) and allotments (M2-12): the same engine, two permissions (T-123). */
export function groupRoutes(deps: groups.GroupDeps): Router {
  const router = express.Router();
  const r = GROUP_BLOCK_ROUTES;
  const sets = [
    {
      kind: 'GROUP' as const,
      list: r.listGroupBlocks,
      create: r.createGroupBlock,
      get: r.getGroupBlock,
      update: r.updateGroupBlock,
      release: r.releaseGroupBlock,
      rooming: r.bookGroupBlockRoomingList,
    },
    {
      kind: 'ALLOTMENT' as const,
      list: r.listAllotments,
      create: r.createAllotment,
      get: r.getAllotment,
      update: r.updateAllotment,
      release: r.releaseAllotment,
      rooming: r.bookAllotmentRoomingList,
    },
  ];
  for (const s of sets) {
    mountRoute(router, s.list, ({ query }) => groups.listBlocks(deps, s.kind, query.status));
    mountRoute(router, s.create, ({ body }, { tenant }) =>
      groups.createBlock(deps, tenantFrom(tenant), s.kind, body),
    );
    mountRoute(router, s.get, ({ params }) => groups.getBlock(deps, s.kind, params.blockId));
    mountRoute(router, s.update, ({ params, body }, { tenant }) =>
      groups.updateBlock(deps, tenantFrom(tenant), s.kind, params.blockId, body),
    );
    mountRoute(router, s.release, ({ params, body }) =>
      groups.releaseBlock(deps, s.kind, params.blockId, body.cancel),
    );
    mountRoute(router, s.rooming, ({ params, body }, { tenant }) =>
      groups.bookRoomingList(deps, tenantFrom(tenant), s.kind, params.blockId, body),
    );
  }
  return router;
}

/** Rooms not picked up go back when their release point comes (M3-17, M2-12). */
export const groupBlockReleaseJob = defineJob({
  name: 'group-block-release',
  // Hourly: an allotment's nights each come due at the property's midnight.
  schedule: { cron: '5 * * * *' },
  async run(_data, { db, clock, logger }) {
    const nights = await groups.releaseDueBlocks(db, clock);
    if (nights > 0) logger.info({ nights }, 'Group block nights released');
  },
});
