import { randomBytes } from 'node:crypto';
import {
  daysBetween,
  localDate,
  MAX_BLOCK_DAYS,
  type RoomBlockBody,
  type RoomBlockItem,
  type RoomBody,
  type RoomItem,
  type RoomPatchBody,
  type RoomTypeBody,
  type RoomTypeItem,
  type RoomTypePatchBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma, Room, RoomBlock, RoomType, User } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { TenantContext } from '../../core/tenancy.ts';

// Room types, rooms and out-of-order/out-of-service blocks (PRD M2-01–M2-03; T-031).
// Dates are the property's local calendar dates until business days arrive (T-054).

export interface RoomDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type TypeItem = z.input<typeof RoomTypeItem>;
type RoomOut = z.input<typeof RoomItem>;
type BlockOut = z.input<typeof RoomBlockItem>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

/** Today at the property, as `YYYY-MM-DD`. */
async function today(deps: RoomDeps, tenant: TenantContext): Promise<string> {
  const { timeZone } = await deps.db.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
    select: { timeZone: true },
  });
  return localDate(deps.clock(), timeZone);
}

/** A unique index named `index` was hit: the field's value is taken. */
function taken(err: unknown, index: string, field: string, message: string): never {
  const info = pgErrorInfo(err);
  if (info?.sqlState === '23505' && info.constraint === index) throw invalid(field, message);
  throw err;
}

// ── Room types ─────────────────────────────────────────────────────────────────────────

function typeItem(t: RoomType, roomCount: number): TypeItem {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    baseOccupancy: t.baseOccupancy,
    maxOccupancy: t.maxOccupancy,
    description: t.description,
    amenities: t.amenities,
    photoFileIds: t.photoFileIds,
    sortOrder: t.sortOrder,
    active: t.active,
    roomCount,
  };
}

async function activeRoomCounts(db: TenantDb | Tx): Promise<Map<string, number>> {
  const rows = await db.room.groupBy({
    by: ['roomTypeId'],
    where: { active: true },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.roomTypeId, r._count._all]));
}

export async function listRoomTypes(deps: RoomDeps): Promise<TypeItem[]> {
  const [types, counts] = await Promise.all([
    deps.tenantDb.roomType.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    activeRoomCounts(deps.tenantDb),
  ]);
  return types.map((t) => typeItem(t, counts.get(t.id) ?? 0));
}

/**
 * Photos must be RoomType files of this property that the scan has not blocked. They are
 * linked to the room type (files.entity_id); photos taken off the list are unlinked.
 */
async function linkPhotos(tx: Tx, roomTypeId: string, ids: string[], before: string[]) {
  const files = await tx.fileObject.findMany({
    where: { id: { in: ids }, entityType: 'RoomType', scan: { not: 'INFECTED' } },
    select: { id: true },
  });
  if (files.length !== ids.length) {
    throw invalid(
      'photoFileIds',
      'A photo is missing, of another kind, or was blocked by the scan',
    );
  }
  const removed = before.filter((id) => !ids.includes(id));
  if (removed.length > 0) {
    await tx.fileObject.updateMany({
      where: { id: { in: removed }, entityId: roomTypeId },
      data: { entityId: null },
    });
  }
  if (ids.length > 0) {
    await tx.fileObject.updateMany({ where: { id: { in: ids } }, data: { entityId: roomTypeId } });
  }
}

const auditType = (t: RoomType) => ({
  // `code` is a secret key name in audit rows (MFA codes), so it is spelled out.
  typeCode: t.code,
  name: t.name,
  baseOccupancy: t.baseOccupancy,
  maxOccupancy: t.maxOccupancy,
  description: t.description,
  amenities: t.amenities,
  photoFileIds: t.photoFileIds,
  sortOrder: t.sortOrder,
  active: t.active,
});

export async function createRoomType(
  deps: RoomDeps,
  body: z.output<typeof RoomTypeBody>,
): Promise<TypeItem> {
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const created = await tx.roomType.create({
        data: { ...body, photoFileIds: body.photoFileIds } as Prisma.RoomTypeUncheckedCreateInput,
      });
      await linkPhotos(tx, created.id, body.photoFileIds, []);
      await recordAudit(tx, {
        action: 'roomtype.created',
        entityType: 'room_type',
        entityId: created.id,
        after: auditType(created),
      });
      return typeItem(created, 0);
    });
  } catch (err) {
    return taken(
      err,
      'room_types_property_id_code_key',
      'code',
      'Another room type uses this code',
    );
  }
}

export async function updateRoomType(
  deps: RoomDeps,
  roomTypeId: string,
  body: z.output<typeof RoomTypePatchBody>,
): Promise<TypeItem> {
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const before = await tx.roomType.findUnique({ where: { id: roomTypeId } });
      if (!before) throw new AppError('NOT_FOUND', 'Room type not found');
      const base = body.baseOccupancy ?? before.baseOccupancy;
      const max = body.maxOccupancy ?? before.maxOccupancy;
      if (base > max) {
        throw invalid('maxOccupancy', 'Maximum occupancy must be at least the base occupancy');
      }
      const counts = await activeRoomCounts(tx);
      const rooms = counts.get(before.id) ?? 0;
      if (body.active === false && before.active && rooms > 0) {
        throw new AppError(
          'STATE_TRANSITION_INVALID',
          'Move or deactivate the rooms of this type first',
          { activeRooms: rooms },
        );
      }
      if (body.photoFileIds)
        await linkPhotos(tx, before.id, body.photoFileIds, before.photoFileIds);
      const after = await tx.roomType.update({ where: { id: before.id }, data: body });
      const was = auditType(before);
      const now = auditType(after);
      const changed = (Object.keys(now) as (keyof typeof now)[]).filter(
        (k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]),
      );
      if (changed.length > 0) {
        await recordAudit(tx, {
          action: 'roomtype.updated',
          entityType: 'room_type',
          entityId: before.id,
          before: Object.fromEntries(changed.map((k) => [k, was[k]])),
          after: Object.fromEntries(changed.map((k) => [k, now[k]])),
        });
      }
      return typeItem(after, rooms);
    });
  } catch (err) {
    return taken(
      err,
      'room_types_property_id_code_key',
      'code',
      'Another room type uses this code',
    );
  }
}

// ── Rooms ──────────────────────────────────────────────────────────────────────────────

type BlockRow = RoomBlock & { createdBy: User };

function blockItem(b: BlockRow): BlockOut {
  return {
    id: b.id,
    roomId: b.roomId,
    kind: b.kind,
    startDate: day(b.startDate),
    endDate: day(b.endDate),
    reason: b.reason,
    createdBy: { id: b.createdBy.id, name: b.createdBy.name },
    createdAt: iso(b.createdAt),
    releasedAt: b.releasedAt ? iso(b.releasedAt) : null,
  };
}

function roomItem(r: Room & { blocks: BlockRow[] }): RoomOut {
  return {
    id: r.id,
    number: r.number,
    roomTypeId: r.roomTypeId,
    floor: r.floor,
    building: r.building,
    features: r.features,
    connectingRoomId: r.connectingRoomId,
    hkStatus: r.hkStatus,
    qrToken: r.qrToken,
    active: r.active,
    version: r.version,
    blocks: r.blocks.map(blockItem),
  };
}

/** Unreleased blocks that end after `today`: the current one and those to come. */
const openBlocks = (today: string) => ({
  where: { releasedAt: null, endDate: { gt: dbDate(today) } },
  orderBy: { startDate: 'asc' as const },
  include: { createdBy: true },
});

/** Natural order: 101 before 1001, B-2 before B-10. */
const byNumber = (a: { number: string }, b: { number: string }) =>
  a.number.localeCompare(b.number, 'en', { numeric: true });

export async function listRooms(deps: RoomDeps, tenant: TenantContext): Promise<RoomOut[]> {
  const rooms = await deps.tenantDb.room.findMany({
    include: { blocks: openBlocks(await today(deps, tenant)) },
  });
  return rooms.sort(byNumber).map(roomItem);
}

async function loadRoom(tx: Tx, roomId: string, today: string) {
  const room = await tx.room.findUnique({
    where: { id: roomId },
    include: { blocks: openBlocks(today) },
  });
  if (!room) throw new AppError('NOT_FOUND', 'Room not found');
  return room;
}

async function activeType(tx: Tx, roomTypeId: string): Promise<void> {
  const type = await tx.roomType.findUnique({ where: { id: roomTypeId } });
  if (!type?.active) throw invalid('roomTypeId', 'Choose an active room type of this property');
}

/**
 * Makes `roomId` and `partnerId` (or nobody) connect to each other, unlinking whatever each
 * was connected to before. A partner already connected elsewhere is refused.
 */
async function connect(tx: Tx, room: Room, partnerId: string | null): Promise<void> {
  if (room.connectingRoomId === partnerId) return;
  if (partnerId === room.id) throw invalid('connectingRoomId', 'A room cannot connect to itself');
  if (partnerId) {
    const partner = await tx.room.findUnique({ where: { id: partnerId } });
    if (!partner) throw invalid('connectingRoomId', 'Choose a room of this property');
    if (partner.connectingRoomId && partner.connectingRoomId !== room.id) {
      throw invalid('connectingRoomId', `Room ${partner.number} already connects to another room`);
    }
    await tx.room.update({
      where: { id: partner.id },
      data: { connectingRoomId: room.id, version: { increment: 1 } },
    });
  }
  if (room.connectingRoomId) {
    await tx.room.updateMany({
      where: { id: room.connectingRoomId, connectingRoomId: room.id },
      data: { connectingRoomId: null, version: { increment: 1 } },
    });
  }
}

const auditRoom = (r: Room) => ({
  number: r.number,
  roomTypeId: r.roomTypeId,
  floor: r.floor,
  building: r.building,
  features: r.features,
  connectingRoomId: r.connectingRoomId,
  active: r.active,
});

const numberTaken = (err: unknown) =>
  taken(err, 'rooms_property_id_number_key', 'number', 'Another room has this number');

export async function createRoom(
  deps: RoomDeps,
  tenant: TenantContext,
  body: z.output<typeof RoomBody>,
): Promise<RoomOut> {
  const now = await today(deps, tenant);
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      await activeType(tx, body.roomTypeId);
      const { connectingRoomId, ...fields } = body;
      const created = await tx.room.create({
        data: {
          ...fields,
          qrToken: randomBytes(16).toString('base64url'),
        } as Prisma.RoomUncheckedCreateInput,
      });
      await connect(tx, created, connectingRoomId);
      if (connectingRoomId) {
        await tx.room.update({ where: { id: created.id }, data: { connectingRoomId } });
      }
      const room = await loadRoom(tx, created.id, now);
      await recordAudit(tx, {
        action: 'room.created',
        entityType: 'room',
        entityId: room.id,
        after: auditRoom(room),
      });
      return roomItem(room);
    });
  } catch (err) {
    return numberTaken(err);
  }
}

/** `If-Match: "3"` (or `W/"3"`) → 3. */
function versionFrom(ifMatch: string): number | null {
  const m = /^(?:W\/)?"(\d+)"$/.exec(ifMatch.trim());
  return m ? Number(m[1]) : null;
}

export async function updateRoom(
  deps: RoomDeps,
  tenant: TenantContext,
  roomId: string,
  ifMatch: string,
  body: z.output<typeof RoomPatchBody>,
): Promise<RoomOut> {
  const now = await today(deps, tenant);
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const before = await loadRoom(tx, roomId, now);
      if (versionFrom(ifMatch) !== before.version) {
        throw new AppError('VERSION_CONFLICT', 'Someone changed this room; reload and try again', {
          version: before.version,
        });
      }
      if (body.roomTypeId && body.roomTypeId !== before.roomTypeId) {
        await activeType(tx, body.roomTypeId);
      }
      const { connectingRoomId, ...fields } = body;
      if (connectingRoomId !== undefined) await connect(tx, before, connectingRoomId);
      const claimed = await tx.room.updateMany({
        where: { id: before.id, version: before.version },
        data: {
          ...fields,
          ...(connectingRoomId !== undefined ? { connectingRoomId } : {}),
          version: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        throw new AppError('VERSION_CONFLICT', 'Someone changed this room; reload and try again');
      }
      const after = await loadRoom(tx, before.id, now);
      const was = auditRoom(before);
      const is = auditRoom(after);
      const changed = (Object.keys(is) as (keyof typeof is)[]).filter(
        (k) => JSON.stringify(was[k]) !== JSON.stringify(is[k]),
      );
      if (changed.length > 0) {
        await recordAudit(tx, {
          action: 'room.updated',
          entityType: 'room',
          entityId: before.id,
          before: Object.fromEntries(changed.map((k) => [k, was[k]])),
          after: Object.fromEntries(changed.map((k) => [k, is[k]])),
        });
      }
      return roomItem(after);
    });
  } catch (err) {
    return numberTaken(err);
  }
}

// ── Blocks ─────────────────────────────────────────────────────────────────────────────

const blockOverlap = (err: unknown) =>
  pgErrorInfo(err)?.sqlState === '23P01' &&
  pgErrorInfo(err)?.constraint === 'room_blocks_no_overlap';

export async function createRoomBlock(
  deps: RoomDeps,
  tenant: TenantContext,
  body: z.output<typeof RoomBlockBody>,
): Promise<BlockOut> {
  const now = await today(deps, tenant);
  if (body.startDate < now) throw invalid('startDate', 'A block starts today or later');
  if (daysBetween(body.startDate, body.endDate) > MAX_BLOCK_DAYS) {
    throw invalid('endDate', `A block lasts at most ${MAX_BLOCK_DAYS} days`);
  }
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const room = await tx.room.findUnique({ where: { id: body.roomId } });
      if (!room?.active) throw invalid('roomId', 'Choose an active room of this property');
      const clash = await tx.roomBlock.findFirst({
        where: {
          roomId: room.id,
          releasedAt: null,
          startDate: { lt: dbDate(body.endDate) },
          endDate: { gt: dbDate(body.startDate) },
        },
      });
      if (clash) {
        throw invalid(
          'startDate',
          `Room ${room.number} is already blocked from ${day(clash.startDate)} to ${day(clash.endDate)}`,
        );
      }
      const block = await tx.roomBlock.create({
        data: {
          roomId: room.id,
          kind: body.kind,
          startDate: dbDate(body.startDate),
          endDate: dbDate(body.endDate),
          reason: body.reason,
          createdById: tenant.userId,
        } as Prisma.RoomBlockUncheckedCreateInput,
        include: { createdBy: true },
      });
      // A block starting today takes the room off at once (PRD M5 rule 1).
      if (body.startDate === now) {
        await tx.room.update({
          where: { id: room.id },
          data: { hkStatus: body.kind, hkStatusAt: deps.clock(), version: { increment: 1 } },
        });
      }
      await recordAudit(tx, {
        action: 'room.blocked',
        entityType: 'room',
        entityId: room.id,
        reason: body.reason,
        after: {
          blockId: block.id,
          number: room.number,
          kind: body.kind,
          startDate: body.startDate,
          endDate: body.endDate,
        },
      });
      return blockItem(block);
    });
  } catch (err) {
    // Two blocks for one room created at the same moment: the constraint decides.
    if (blockOverlap(err))
      throw invalid('startDate', 'The room is already blocked for these dates');
    throw err;
  }
}

export async function releaseRoomBlock(
  deps: RoomDeps,
  tenant: TenantContext,
  blockId: string,
): Promise<BlockOut> {
  const now = await today(deps, tenant);
  return deps.tenantDb.$transaction(async (tx) => {
    const block = await tx.roomBlock.findUnique({
      where: { id: blockId },
      include: { room: true },
    });
    if (!block) throw new AppError('NOT_FOUND', 'Block not found');
    if (block.releasedAt) {
      throw new AppError('STATE_TRANSITION_INVALID', 'This block is already released', {
        releasedAt: iso(block.releasedAt),
      });
    }
    const released = await tx.roomBlock.update({
      where: { id: block.id },
      data: { releasedAt: deps.clock() },
      include: { createdBy: true },
    });
    // The room comes back dirty: it is cleaned before it is sold (PRD M5 rule 1).
    const current = day(block.startDate) <= now && now < day(block.endDate);
    if (current && block.room.hkStatus === block.kind) {
      await tx.room.update({
        where: { id: block.roomId },
        data: { hkStatus: 'DIRTY', hkStatusAt: deps.clock(), version: { increment: 1 } },
      });
    }
    await recordAudit(tx, {
      action: 'room.block_released',
      entityType: 'room',
      entityId: block.roomId,
      before: { blockId: block.id, kind: block.kind, endDate: day(block.endDate) },
      after: { releasedOn: now, early: current },
    });
    return blockItem(released);
  });
}

/**
 * Keeps housekeeping status in step with blocks as days pass (every 15 minutes): a room
 * whose block starts today goes OUT_OF_ORDER/OUT_OF_SERVICE; one whose block has ended comes
 * back DIRTY. Runs across all properties, each on its own local date.
 */
export async function syncBlockStatuses(
  db: Db,
  clock: Clock,
): Promise<{ started: number; ended: number }> {
  const properties = await db.property.findMany({
    where: { status: { not: 'ARCHIVED' } },
    select: { id: true, timeZone: true },
  });
  let started = 0;
  let ended = 0;
  for (const p of properties) {
    const date = dbDate(localDate(clock(), p.timeZone));
    const rooms = await db.room.findMany({
      where: { propertyId: p.id },
      include: {
        blocks: {
          where: { releasedAt: null, startDate: { lte: date }, endDate: { gt: date } },
          take: 1,
        },
      },
    });
    for (const room of rooms) {
      const block = room.blocks[0];
      const blockedStatus = room.hkStatus === 'OUT_OF_ORDER' || room.hkStatus === 'OUT_OF_SERVICE';
      const next = block ? block.kind : blockedStatus ? 'DIRTY' : null;
      if (!next || next === room.hkStatus) continue;
      // Only if nobody changed the room since we read it.
      const done = await db.room.updateMany({
        where: { id: room.id, version: room.version },
        data: { hkStatus: next, hkStatusAt: clock(), version: { increment: 1 } },
      });
      if (done.count > 0) {
        if (block) started++;
        else ended++;
      }
    }
  }
  return { started, ended };
}
