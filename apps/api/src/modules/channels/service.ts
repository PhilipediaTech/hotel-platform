import { CHANNEL_PLAN_KINDS, type ChannelConnectionView } from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import {
  ChannelError,
  type ChannelManager,
  type ChannelRatePlanInput,
} from '../../core/channel-manager.ts';
import type { Clock } from '../../core/clock.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { planRoomTypes } from '../rates/service.ts';

// Channel manager connection (PRD M11-07; T-151). Setup runs step by step: each record the
// channel manager makes is saved here the moment its ID comes back, so a setup that fails
// half-way (Channex refuses, times out) keeps what it made and the next run only does the
// rest; nothing is made twice. A short lease on the connection keeps two setups from running
// at once. The channel manager is never called inside a database transaction.

export interface ChannelDeps {
  tenantDb: TenantDb;
  clock: Clock;
  channel: ChannelManager;
}

const LEASE_MS = 3 * 60_000;
const PROVIDER = 'CHANNEX';

const MEAL: Record<string, ChannelRatePlanInput['mealType']> = {
  ROOM_ONLY: 'room_only',
  BREAKFAST: 'breakfast',
  HALF_BOARD: 'half_board',
  FULL_BOARD: 'full_board',
};

/** Room types with their active rooms: only those with rooms can be sold. */
async function sellableRoomTypes(db: TenantDb) {
  const types = await db.roomType.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { rooms: { where: { active: true } } } } },
  });
  return types.map((t) => ({ ...t, rooms: t._count.rooms }));
}

async function view(deps: ChannelDeps): Promise<z.input<typeof ChannelConnectionView>> {
  const db = deps.tenantDb;
  const [connection, types, plans, mappings] = await Promise.all([
    db.channelConnection.findFirst({
      include: { connectedBy: { select: { id: true, name: true } } },
    }),
    sellableRoomTypes(db),
    db.ratePlan.findMany({
      where: { active: true, kind: { in: [...CHANNEL_PLAN_KINDS] } },
      orderBy: { code: 'asc' },
    }),
    db.channelMapping.findMany(),
  ]);
  const logs = connection
    ? await db.channelSyncLog.findMany({
        where: { connectionId: connection.id },
        orderBy: { id: 'desc' },
        take: 20,
      })
    : [];
  return {
    provider: deps.channel.name,
    connection: connection
      ? {
          status: connection.status,
          externalPropertyId: connection.externalPropertyId,
          lastError: connection.lastError,
          connectedBy: connection.connectedBy,
          createdAt: connection.createdAt.toISOString(),
        }
      : null,
    roomTypes: types.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      rooms: t.rooms,
      mapped: mappings.some((m) => m.kind === 'ROOM_TYPE' && m.roomTypeId === t.id),
    })),
    ratePlans: plans.map((p) => {
      const mine = mappings.filter((m) => m.kind === 'RATE_PLAN' && m.ratePlanId === p.id);
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        kind: p.kind,
        selected: mine.some((m) => m.active),
        mappedRoomTypes: mine.filter((m) => m.active).length,
      };
    }),
    logs: logs.map((l) => ({
      at: l.at.toISOString(),
      kind: l.kind,
      status: l.status as 'OK' | 'WARNING' | 'FAILED',
      items: l.items,
      message: l.message,
    })),
  };
}

export function getChannelConnection(deps: ChannelDeps) {
  return view(deps);
}

async function log(
  deps: ChannelDeps,
  connectionId: string,
  entry: { status: 'OK' | 'WARNING' | 'FAILED'; items: number; message: string | null },
) {
  await deps.tenantDb.channelSyncLog.create({
    data: {
      connectionId,
      kind: 'SETUP',
      ...entry,
    } as unknown as Prisma.ChannelSyncLogUncheckedCreateInput,
  });
}

/** M11-07: connect the property, or finish or change its setup. */
export async function connectChannel(
  deps: ChannelDeps,
  tenant: TenantContext,
  body: { ratePlanIds: string[] },
) {
  const db = deps.tenantDb;
  if (deps.channel.name === 'OFF') {
    throw new AppError('CHANNEL_UNAVAILABLE', 'No channel manager is set up for this platform yet');
  }
  const plans = await db.ratePlan.findMany({
    where: { id: { in: body.ratePlanIds }, active: true, kind: { in: [...CHANNEL_PLAN_KINDS] } },
  });
  body.ratePlanIds.forEach((id, i) => {
    if (!plans.some((p) => p.id === id)) {
      throw new AppError('VALIDATION_ERROR', 'Choose active rate plans that can be sold online', {
        issues: [
          {
            path: `body.ratePlanIds.${i}`,
            code: 'custom',
            message: 'Not an active best-available, derived or package plan here',
          },
        ],
      });
    }
  });

  // The connection row exists before anything is made at the channel manager.
  let connection = await db.channelConnection.findFirst();
  if (!connection) {
    connection = await db.channelConnection
      .create({
        data: {
          provider: PROVIDER,
          connectedById: tenant.userId,
        } as unknown as Prisma.ChannelConnectionUncheckedCreateInput,
      })
      .catch(async () => db.channelConnection.findFirstOrThrow());
  }
  const now = deps.clock();
  const claimed = await db.channelConnection.updateMany({
    where: {
      id: connection.id,
      OR: [{ setupLockedUntil: null }, { setupLockedUntil: { lt: now } }],
    },
    data: { setupLockedUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count !== 1) {
    throw new AppError('STATE_TRANSITION_INVALID', 'A setup is already running: try again shortly');
  }

  let made = 0;
  try {
    // 1. The property.
    let externalPropertyId = connection.externalPropertyId;
    if (!externalPropertyId) {
      const property = await db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
      const address = (property.address ?? {}) as {
        line1?: string | null;
        city?: string | null;
        country?: string | null;
      };
      const created = await deps.channel.createProperty({
        title: property.name,
        currency: property.baseCurrency,
        timezone: property.timeZone,
        propertyType: 'hotel',
        country: address.country ?? undefined,
        city: address.city ?? undefined,
        address: address.line1 ?? undefined,
        email: property.email ?? undefined,
        phone: property.phone ?? undefined,
      });
      externalPropertyId = created.id;
      made += 1;
      await db.channelConnection.update({
        where: { id: connection.id },
        data: { externalPropertyId },
      });
    }

    // 2. Room types with rooms.
    const mappings = await db.channelMapping.findMany({ where: { connectionId: connection.id } });
    const roomTypeMap = new Map(
      mappings.filter((m) => m.kind === 'ROOM_TYPE').map((m) => [m.roomTypeId, m.externalId]),
    );
    for (const t of await sellableRoomTypes(db)) {
      if (t.rooms === 0 || roomTypeMap.has(t.id)) continue;
      const created = await deps.channel.createRoomType({
        propertyId: externalPropertyId,
        title: t.name,
        countOfRooms: t.rooms,
        occAdults: t.maxOccupancy,
        defaultOccupancy: Math.min(t.baseOccupancy, t.maxOccupancy),
      });
      made += 1;
      await db.channelMapping.create({
        data: {
          connectionId: connection.id,
          kind: 'ROOM_TYPE',
          roomTypeId: t.id,
          externalId: created.id,
        } as unknown as Prisma.ChannelMappingUncheckedCreateInput,
      });
      roomTypeMap.set(t.id, created.id);
    }

    // 3. Rate plans, one per (plan, room type) the plan sells; the rest stop being sent.
    const types = new Map((await db.roomType.findMany()).map((t) => [t.id, t]));
    const wanted = new Set<string>();
    for (const plan of plans) {
      for (const roomTypeId of await planRoomTypes(db, plan)) {
        const externalRoomTypeId = roomTypeMap.get(roomTypeId);
        const type = types.get(roomTypeId);
        if (!externalRoomTypeId || !type) continue;
        wanted.add(`${plan.id}|${roomTypeId}`);
        const existing = mappings.find(
          (m) => m.kind === 'RATE_PLAN' && m.ratePlanId === plan.id && m.roomTypeId === roomTypeId,
        );
        if (existing) {
          if (!existing.active) {
            await db.channelMapping.update({ where: { id: existing.id }, data: { active: true } });
          }
          continue;
        }
        const created = await deps.channel.createRatePlan({
          propertyId: externalPropertyId,
          roomTypeId: externalRoomTypeId,
          title: `${plan.name} · ${type.name}`.slice(0, 255),
          currency: plan.currency,
          occupancy: type.maxOccupancy,
          mealType: MEAL[plan.mealPlan] ?? 'none',
        });
        made += 1;
        await db.channelMapping.create({
          data: {
            connectionId: connection.id,
            kind: 'RATE_PLAN',
            roomTypeId,
            ratePlanId: plan.id,
            externalId: created.id,
          } as unknown as Prisma.ChannelMappingUncheckedCreateInput,
        });
      }
    }
    for (const m of mappings) {
      if (m.kind === 'RATE_PLAN' && m.active && !wanted.has(`${m.ratePlanId}|${m.roomTypeId}`)) {
        await db.channelMapping.update({ where: { id: m.id }, data: { active: false } });
      }
    }

    await db.channelConnection.update({
      where: { id: connection.id },
      data: {
        status: connection.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
        lastError: null,
        setupLockedUntil: null,
      },
    });
    await log(deps, connection.id, { status: 'OK', items: made, message: null });
    await recordAudit(db, {
      action: 'channel.setup',
      entityType: 'channel_connection',
      entityId: connection.id,
      after: { ratePlanIds: body.ratePlanIds, created: made },
    });
  } catch (err) {
    const message =
      err instanceof ChannelError ? err.message : 'The setup stopped on an unexpected error';
    await db.channelConnection.update({
      where: { id: connection.id },
      data: { lastError: message, setupLockedUntil: null },
    });
    await log(deps, connection.id, { status: 'FAILED', items: made, message });
    if (err instanceof ChannelError) {
      throw new AppError(
        'CHANNEL_UNAVAILABLE',
        `${message}. What was set up so far is kept: try again to finish.`,
        err.details ? { channel: err.details } : undefined,
      );
    }
    throw err;
  }
  return view(deps);
}

export async function pauseChannel(deps: ChannelDeps, body: { paused: boolean }) {
  const db = deps.tenantDb;
  const connection = await db.channelConnection.findFirst();
  if (!connection || connection.status === 'CONNECTING') {
    throw new AppError('STATE_TRANSITION_INVALID', 'Connect the channel manager first');
  }
  const status = body.paused ? 'PAUSED' : 'ACTIVE';
  if (connection.status !== status) {
    await db.channelConnection.update({ where: { id: connection.id }, data: { status } });
    await recordAudit(db, {
      action: body.paused ? 'channel.paused' : 'channel.resumed',
      entityType: 'channel_connection',
      entityId: connection.id,
      before: { status: connection.status },
      after: { status },
    });
  }
  return view(deps);
}
