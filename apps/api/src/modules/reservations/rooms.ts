import {
  MODIFIABLE_STATUSES,
  type AssignableRoom,
  type AssignRoomBody,
  type MoveBody,
} from '@hotel/shared';
import { z } from 'zod';
import type { Room } from '../../generated/prisma/client.ts';
import {
  performOrRequest,
  type ApprovalActionHandler,
  type ExecuteContext,
} from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import { pgErrorInfo } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { propertyToday } from '../availability/inventory.ts';
import { getReservation, type ReservationDeps } from './service.ts';

// Rooms for stays (PRD M3-07, M3-11; tab 3 room_allocations; T-050). A stay holds a room
// through allocations (date ranges, end exclusive); the database refuses two active
// allocations of one room on the same night, so a room is never double-booked even when two
// desks assign at once. `stays.room_id` mirrors the current room. Assigning plans a room
// before check-in; a move changes the room of a checked-in guest from today on.

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
/** Reads go through the tenant client or one of its transactions. */
type Client = Tx | TenantDb;
/** Anything that can end allocations: a tenant transaction or the base client's (hold expiry). */
interface AllocationWriter {
  roomAllocation: {
    updateMany(args: {
      where: { stayId: { in: string[] }; active: boolean };
      data: { active: boolean };
    }): Promise<unknown>;
  };
}
type Assign = z.output<typeof AssignRoomBody>;
type Move = z.output<typeof MoveBody>;
/** The approval context plus the time the action runs. */
export type Ctx = ExecuteContext & { now: Date };

const READY = new Set(['CLEAN', 'INSPECTED']);
/** M1 rule 2 "room move after 00:00": moves from midnight until 05:00 at the property. */
const LATE_MOVE_UNTIL_HOUR = 5;

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const later = (a: string, b: string) => (a > b ? a : b);

const conflict = (message: string, details: Record<string, unknown> = {}) =>
  new AppError('BOOKING_CONFLICT', message, details);

/** The exclusion constraint lost a race: another desk took the room for those nights. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (pgErrorInfo(err)?.constraint === 'room_allocations_no_overlap') {
      throw conflict('This room was just given to another stay on some of those nights');
    }
    throw err;
  }
}

export async function loadStay(db: Client, stayId: string) {
  const stay = await db.stay.findUnique({ where: { id: stayId } });
  if (!stay) throw new AppError('NOT_FOUND', 'Stay not found');
  return stay;
}

/** Rooms of the type with no block and no other stay on any night of [from, to). */
async function freeRooms(
  db: Client,
  stay: { id: string; roomTypeId: string },
  from: string,
  to: string,
): Promise<Room[]> {
  return db.room.findMany({
    where: {
      roomTypeId: stay.roomTypeId,
      active: true,
      blocks: {
        none: { releasedAt: null, startDate: { lt: dbDate(to) }, endDate: { gt: dbDate(from) } },
      },
      allocations: {
        none: {
          active: true,
          stayId: { not: stay.id },
          startDate: { lt: dbDate(to) },
          endDate: { gt: dbDate(from) },
        },
      },
    },
    orderBy: { number: 'asc' },
  });
}

/** M3-07: why a room is not ready for a guest moving in today (empty when it is). */
export async function problemsOf(db: Client, room: Room, stayId: string) {
  const problems: z.input<typeof AssignableRoom>['problems'] = [];
  if (!READY.has(room.hkStatus)) problems.push('NOT_CLEAN');
  const occupant = await db.stay.count({
    where: { roomId: room.id, status: 'CHECKED_IN', id: { not: stayId } },
  });
  if (occupant > 0) problems.push('OCCUPIED');
  return problems;
}

export async function listAssignableRooms(deps: ReservationDeps, stayId: string) {
  const stay = await loadStay(deps.tenantDb, stayId);
  const today = await propertyToday(deps.tenantDb, stay.propertyId, deps.clock);
  const from = stay.status === 'CHECKED_IN' ? later(day(stay.arrival), today) : day(stay.arrival);
  const rooms = await freeRooms(deps.tenantDb, stay, from, day(stay.departure));
  const movingInToday = from <= today;
  const data: z.input<typeof AssignableRoom>[] = [];
  for (const room of rooms.filter((r) => r.id !== stay.roomId)) {
    data.push({
      id: room.id,
      number: room.number,
      floor: room.floor,
      hkStatus: room.hkStatus,
      problems: movingInToday ? await problemsOf(deps.tenantDb, room, stay.id) : [],
    });
  }
  return { data };
}

/** Ends a stay's room allocations (cancellation, hold expiry, room taken back). */
export async function releaseAllocations(db: AllocationWriter, stayIds: string[]): Promise<void> {
  if (stayIds.length === 0) return;
  await db.roomAllocation.updateMany({
    where: { stayId: { in: stayIds }, active: true },
    data: { active: false },
  });
}

/**
 * New dates or room type for a stay with a room (M3-03): it keeps the room when the room is
 * of the new type and free on the new nights; otherwise it goes back to unassigned. Returns
 * the room it ends up with.
 */
export async function followRoom(
  tx: Tx,
  stay: { id: string; propertyId: string; roomId: string | null },
  next: { roomTypeId: string; arrival: string; departure: string },
): Promise<string | null> {
  if (!stay.roomId) return null;
  await releaseAllocations(tx, [stay.id]);
  const free = await freeRooms(
    tx,
    { id: stay.id, roomTypeId: next.roomTypeId },
    next.arrival,
    next.departure,
  );
  if (!free.some((r) => r.id === stay.roomId)) return null;
  await guarded(() =>
    tx.roomAllocation.create({
      data: {
        propertyId: stay.propertyId,
        stayId: stay.id,
        roomId: stay.roomId ?? '',
        startDate: dbDate(next.arrival),
        endDate: dbDate(next.departure),
      },
    }),
  );
  return stay.roomId;
}

async function bump(tx: Tx, stay: { id: string; reservationId: string }, roomId: string | null) {
  await tx.stay.update({ where: { id: stay.id }, data: { roomId, version: { increment: 1 } } });
  await tx.reservation.update({
    where: { id: stay.reservationId },
    data: { version: { increment: 1 } },
  });
}

// ── Assign (M3-07) ──────────────────────────────────────────────────────────────────────

const AssignStored = z.object({
  stayId: z.string(),
  roomId: z.string(),
  overrideReason: z.string(),
});
type AssignPayload = z.output<typeof AssignStored>;

/** Gives the stay the room, or takes it back (roomId null). `override` skips readiness. */
export async function assign(
  ctx: Ctx,
  stayId: string,
  roomId: string | null,
  override: string | null,
): Promise<string> {
  const { tx } = ctx;
  const stay = await loadStay(tx, stayId);
  if (stay.status === 'CHECKED_IN') {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'The guest is in the room: move them to another room instead',
      { status: stay.status },
    );
  }
  if (!MODIFIABLE_STATUSES.includes(stay.status)) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      `A ${stay.status.toLowerCase().replace('_', '-')} stay cannot be given a room`,
      { status: stay.status },
    );
  }
  const before = stay.roomId;
  if (roomId === before) return stay.reservationId;
  await releaseAllocations(tx, [stay.id]);

  if (roomId !== null) {
    const room = await tx.room.findUnique({ where: { id: roomId } });
    if (!room || !room.active) {
      throw new AppError('VALIDATION_ERROR', 'Choose an active room', {
        issues: [{ path: 'body.roomId', code: 'custom', message: 'Choose an active room' }],
      });
    }
    if (room.roomTypeId !== stay.roomTypeId) {
      const message =
        'Choose a room of the booked type (change the room type on the booking first)';
      throw new AppError('VALIDATION_ERROR', message, {
        issues: [{ path: 'body.roomId', code: 'custom', message }],
      });
    }
    const arrival = day(stay.arrival);
    const free = await freeRooms(tx, stay, arrival, day(stay.departure));
    if (!free.some((r) => r.id === room.id)) {
      throw conflict(`Room ${room.number} is blocked or taken on some of those nights`, {
        roomId: room.id,
      });
    }
    const today = await propertyToday(tx, stay.propertyId, () => ctx.now);
    if (arrival <= today && override === null) {
      const problems = await problemsOf(tx, room, stay.id);
      if (problems.length > 0) {
        throw new AppError('ROOM_NOT_READY', `Room ${room.number} is not ready for a guest yet`, {
          roomId: room.id,
          hkStatus: room.hkStatus,
          problems,
        });
      }
    }
    await guarded(() =>
      tx.roomAllocation.create({
        data: {
          propertyId: stay.propertyId,
          stayId: stay.id,
          roomId: room.id,
          startDate: stay.arrival,
          endDate: stay.departure,
          reason: override,
        },
      }),
    );
  }
  await bump(tx, stay, roomId);
  await recordAudit(tx, {
    action: roomId ? 'stay.room_assigned' : 'stay.room_released',
    entityType: 'stay',
    entityId: stay.id,
    before: { roomId: before },
    after: { roomId, ...(override ? { overrideReason: override } : {}) },
    approvalRequestId: ctx.approvalRequestId ?? undefined,
  });
  await recordEvent(tx, {
    type: 'stay.room_assigned',
    payload: { stayId: stay.id, reservationId: stay.reservationId, roomId, previousRoomId: before },
  });
  return stay.reservationId;
}

export function roomNotReadyHandler(deps: ReservationDeps): ApprovalActionHandler<AssignPayload> {
  return {
    action: 'room.not_ready',
    payload: AssignStored,
    measure: () => ({}),
    execute: (ctx, p) =>
      assign({ ...ctx, now: deps.clock() }, p.stayId, p.roomId, p.overrideReason),
  };
}

export async function assignRoom(
  deps: ReservationDeps,
  tenant: TenantContext,
  stayId: string,
  body: Assign,
) {
  const reason = body.overrideReason ?? null;
  if (body.roomId === null || reason === null) {
    const reservationId = await deps.tenantDb.$transaction((tx) =>
      assign({ tx, tenant, approvalRequestId: null, now: deps.clock() }, stayId, body.roomId, null),
    );
    return getReservation(deps, reservationId);
  }
  // A room that is not ready: a manager approves (or the caller is one). Everything is
  // checked again when it runs.
  const result = await performOrRequest(
    { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
    tenant,
    roomNotReadyHandler(deps),
    { stayId, roomId: body.roomId, overrideReason: reason },
    reason,
  );
  if (!('resultRef' in result)) return result;
  return getReservation(deps, result.resultRef);
}

// ── Move (M3-11) ────────────────────────────────────────────────────────────────────────

const MoveStored = z.object({ stayId: z.string(), roomId: z.string(), reason: z.string() });
type MovePayload = z.output<typeof MoveStored>;

async function move(ctx: Ctx, p: MovePayload): Promise<string> {
  const { tx } = ctx;
  const stay = await loadStay(tx, p.stayId);
  if (stay.status !== 'CHECKED_IN' || !stay.roomId) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'Only a checked-in guest is moved; change the room of a booking with assign-room',
      { status: stay.status },
    );
  }
  if (p.roomId === stay.roomId) {
    throw new AppError('VALIDATION_ERROR', 'The guest is already in this room', {
      issues: [{ path: 'body.roomId', code: 'custom', message: 'Choose another room' }],
    });
  }
  const room = await tx.room.findUnique({ where: { id: p.roomId } });
  if (!room || !room.active || room.roomTypeId !== stay.roomTypeId) {
    const message = 'Choose an active room of the same type';
    throw new AppError('VALIDATION_ERROR', message, {
      issues: [{ path: 'body.roomId', code: 'custom', message }],
    });
  }
  const today = await propertyToday(tx, stay.propertyId, () => ctx.now);
  const from = later(day(stay.arrival), today);
  const to = day(stay.departure);
  if (from >= to) {
    throw new AppError('STATE_TRANSITION_INVALID', 'The stay has no nights left to move');
  }
  const free = await freeRooms(tx, stay, from, to);
  if (!free.some((r) => r.id === room.id)) {
    throw conflict(`Room ${room.number} is blocked or taken on some of those nights`, {
      roomId: room.id,
    });
  }
  const problems = await problemsOf(tx, room, stay.id);
  if (problems.length > 0) {
    throw new AppError('ROOM_NOT_READY', `Room ${room.number} is not ready for a guest yet`, {
      roomId: room.id,
      hkStatus: room.hkStatus,
      problems,
    });
  }

  // Nights before today stay with the old room; the old room needs cleaning.
  const current = await tx.roomAllocation.findMany({ where: { stayId: stay.id, active: true } });
  for (const a of current) {
    if (day(a.startDate) < from) {
      await tx.roomAllocation.update({ where: { id: a.id }, data: { endDate: dbDate(from) } });
    } else {
      await tx.roomAllocation.update({ where: { id: a.id }, data: { active: false } });
    }
  }
  await guarded(() =>
    tx.roomAllocation.create({
      data: {
        propertyId: stay.propertyId,
        stayId: stay.id,
        roomId: room.id,
        startDate: dbDate(from),
        endDate: stay.departure,
        reason: p.reason,
      },
    }),
  );
  await tx.room.update({
    where: { id: stay.roomId },
    data: { hkStatus: 'DIRTY', hkStatusAt: ctx.now, version: { increment: 1 } },
  });
  await bump(tx, stay, room.id);
  await recordAudit(tx, {
    action: 'stay.moved',
    entityType: 'stay',
    entityId: stay.id,
    before: { roomId: stay.roomId },
    after: { roomId: room.id, from, reason: p.reason },
    approvalRequestId: ctx.approvalRequestId ?? undefined,
  });
  await recordEvent(tx, {
    type: 'stay.moved',
    payload: {
      stayId: stay.id,
      reservationId: stay.reservationId,
      fromRoomId: stay.roomId,
      toRoomId: room.id,
      from,
    },
  });
  return stay.reservationId;
}

/** Hour of the day at the property. */
function localHour(now: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(now),
  );
}

export function roomMoveHandler(deps: ReservationDeps): ApprovalActionHandler<MovePayload> {
  return {
    action: 'room.move',
    payload: MoveStored,
    measure: () => ({ count: 1 }),
    execute: (ctx, p) => move({ ...ctx, now: deps.clock() }, p),
  };
}

export async function moveStay(
  deps: ReservationDeps,
  tenant: TenantContext,
  stayId: string,
  body: Move,
) {
  const payload = { stayId, roomId: body.roomId, reason: body.reason };
  const now = deps.clock();
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
    select: { timeZone: true },
  });
  if (localHour(now, property.timeZone) >= LATE_MOVE_UNTIL_HOUR) {
    const reservationId = await deps.tenantDb.$transaction((tx) =>
      move({ tx, tenant, approvalRequestId: null, now }, payload),
    );
    return getReservation(deps, reservationId);
  }
  // After midnight a move needs approval unless the caller's role allows it (M1 rule 2).
  const result = await performOrRequest(
    { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
    tenant,
    roomMoveHandler(deps),
    payload,
    body.reason,
  );
  if (!('resultRef' in result)) return result;
  return getReservation(deps, result.resultRef);
}
