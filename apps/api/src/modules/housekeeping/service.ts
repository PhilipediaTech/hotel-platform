import {
  DEFAULT_CHECKLISTS,
  type AssignBody,
  type AssignmentPatch,
  type BoardRoom,
  type HkAssignmentItem,
  type HkTaskKind,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Housekeeping (PRD M5-01–M5-04, M5 rules 1–2; tab 4 row "Housekeeping"; T-080). A business
// date's cleaning list has one assignment per room: a DEPARTURE for a room whose guest leaves
// that day (and for a vacant room still dirty), a STAYOVER for one whose guest stays on, an
// ARRIVAL for a vacant room given to a guest arriving, and a few DEEP_CLEANs for vacant rooms
// that have gone longest without one. Night audit makes the list when it opens the day; the
// board makes it on first look too (the same rows: one per room and date). An attendant
// works a room through PENDING → IN_PROGRESS ⇄ PAUSED → DONE: starting sets the room CLEANING,
// completing (every checklist item ticked) sets it CLEAN, so it can be given to a guest at
// once (inspection, M5-06, is V1.1).

export interface HousekeepingDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;
type Assignment = Prisma.HkAssignmentGetPayload<{ include: { room: true; attendant: true } }>;

/** Deep cleans added to a day's list, at most (vacant rooms longest without one). */
export const DEEP_CLEANS_PER_DAY = 2;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const checklistOf = (kind: HkTaskKind) =>
  DEFAULT_CHECKLISTS[kind].map((item) => ({ item, done: false }));

function assignmentItem(a: Assignment): z.input<typeof HkAssignmentItem> {
  return {
    id: a.id,
    businessDate: day(a.businessDate),
    roomId: a.roomId,
    roomNumber: a.room.number,
    floor: a.room.floor,
    kind: a.kind,
    status: a.status as z.input<typeof HkAssignmentItem>['status'],
    attendant: a.attendant ? { id: a.attendant.id, name: a.attendant.name } : null,
    startedAt: a.startedAt ? iso(a.startedAt) : null,
    completedAt: a.completedAt ? iso(a.completedAt) : null,
    checklist: a.checklist as { item: string; done: boolean }[],
    minibar: (a.minibar ?? []) as { item: string; quantity: number }[],
    notes: a.notes,
    hkStatus: a.room.hkStatus,
  };
}

/** Who is in which room on `date`, and who arrives in which. */
async function frontOffice(db: Client, date: string) {
  const on = dbDate(date);
  const [inHouse, arriving] = await Promise.all([
    db.stay.findMany({
      where: { status: 'CHECKED_IN', isDayUse: false, roomId: { not: null }, arrival: { lte: on } },
      select: { roomId: true, departure: true },
    }),
    db.stay.findMany({
      where: {
        status: { in: ['CONFIRMED', 'TENTATIVE'] },
        isDayUse: false,
        arrival: on,
        roomId: { not: null },
      },
      select: { roomId: true },
    }),
  ]);
  const occupied = new Map<string, { dueOut: boolean }>();
  for (const s of inHouse) {
    if (!s.roomId) continue;
    const dueOut = day(s.departure) <= date;
    // A room with a guest leaving and none staying is due out; any guest staying wins.
    const before = occupied.get(s.roomId);
    occupied.set(s.roomId, { dueOut: (before?.dueOut ?? true) && dueOut });
  }
  return { occupied, arriving: new Set(arriving.flatMap((s) => (s.roomId ? [s.roomId] : []))) };
}

/** The kind of clean a room needs on `date`, or null when it needs none. */
function kindFor(
  room: { id: string; hkStatus: string },
  fo: Awaited<ReturnType<typeof frontOffice>>,
): HkTaskKind | null {
  const here = fo.occupied.get(room.id);
  if (here) return here.dueOut ? 'DEPARTURE' : 'STAYOVER';
  if (room.hkStatus === 'OUT_OF_ORDER' || room.hkStatus === 'OUT_OF_SERVICE') return null;
  if (room.hkStatus === 'DIRTY') return 'DEPARTURE';
  if (fo.arriving.has(room.id)) return 'ARRIVAL';
  return null;
}

/**
 * Makes `date`'s cleaning list (M5-02); rooms already on it are left alone. Answers how many
 * rooms it added.
 */
export async function ensureCleaningList(db: Client, propertyId: string, date: string) {
  const on = dbDate(date);
  const [rooms, listed, fo] = await Promise.all([
    db.room.findMany({ where: { active: true }, orderBy: { number: 'asc' } }),
    db.hkAssignment.findMany({ where: { businessDate: on }, select: { roomId: true } }),
    frontOffice(db, date),
  ]);
  const have = new Set(listed.map((a) => a.roomId));
  const rows: { roomId: string; kind: HkTaskKind }[] = [];
  for (const room of rooms) {
    if (have.has(room.id)) continue;
    const kind = kindFor(room, fo);
    if (kind) rows.push({ roomId: room.id, kind });
  }
  // Deep cleans: vacant clean rooms not on the list, longest since their last one.
  const free = rooms.filter(
    (r) =>
      !have.has(r.id) &&
      !rows.some((x) => x.roomId === r.id) &&
      !fo.occupied.has(r.id) &&
      (r.hkStatus === 'CLEAN' || r.hkStatus === 'INSPECTED'),
  );
  if (free.length > 0 && !listed.length) {
    const last = await db.hkAssignment.groupBy({
      by: ['roomId'],
      where: { kind: 'DEEP_CLEAN', status: 'DONE', roomId: { in: free.map((r) => r.id) } },
      _max: { businessDate: true },
    });
    const lastOf = new Map(last.map((l) => [l.roomId, l._max.businessDate?.getTime() ?? 0]));
    free
      .sort(
        (a, b) =>
          (lastOf.get(a.id) ?? 0) - (lastOf.get(b.id) ?? 0) || a.number.localeCompare(b.number),
      )
      .slice(0, DEEP_CLEANS_PER_DAY)
      .forEach((r) => rows.push({ roomId: r.id, kind: 'DEEP_CLEAN' }));
  }
  if (rows.length === 0) return 0;
  const made = await db.hkAssignment.createMany({
    data: rows.map((r) => ({
      propertyId,
      businessDate: on,
      roomId: r.roomId,
      kind: r.kind,
      checklist: checklistOf(r.kind),
    })),
    skipDuplicates: true,
  });
  return made.count;
}

const WITH = { room: true, attendant: true } as const;

export async function getBoard(
  deps: HousekeepingDeps,
  tenant: TenantContext,
  query: { floor?: string | undefined },
) {
  const date = await businessDate(deps.tenantDb, tenant.propertyId, deps.clock);
  await ensureCleaningList(deps.tenantDb, tenant.propertyId, date);
  const [rooms, assignments, fo, attendants] = await Promise.all([
    deps.tenantDb.room.findMany({
      where: { active: true },
      include: { roomType: true },
      orderBy: [{ floor: 'asc' }, { number: 'asc' }],
    }),
    deps.tenantDb.hkAssignment.findMany({ where: { businessDate: dbDate(date) }, include: WITH }),
    frontOffice(deps.tenantDb, date),
    attendantsOf(deps, tenant),
  ]);
  const byRoom = new Map(assignments.map((a) => [a.roomId, a]));
  const floors = [...new Set(rooms.flatMap((r) => (r.floor ? [r.floor] : [])))];
  const shown = query.floor ? rooms.filter((r) => r.floor === query.floor) : rooms;
  const data: z.input<typeof BoardRoom>[] = shown.map((r) => {
    const here = fo.occupied.get(r.id);
    const arrival = fo.arriving.has(r.id);
    const a = byRoom.get(r.id);
    const ready = r.hkStatus === 'CLEAN' || r.hkStatus === 'INSPECTED';
    return {
      roomId: r.id,
      number: r.number,
      floor: r.floor,
      roomType: r.roomType.name,
      hkStatus: r.hkStatus,
      foStatus: here ? 'OCCUPIED' : 'VACANT',
      dueOut: here?.dueOut ?? false,
      arrival,
      priority:
        arrival && !ready
          ? 'HIGH'
          : a && a.kind !== 'STAYOVER' && a.kind !== 'DEEP_CLEAN'
            ? 'NORMAL'
            : 'LOW',
      assignment: a ? assignmentItem(a) : null,
    };
  });
  return { businessDate: date, floors, rooms: data, attendants };
}

/**
 * Staff of this property who clean rooms: hk.work without hk.assign (managers and owners hold
 * every permission, but are not given rooms).
 */
async function attendantsOf(deps: HousekeepingDeps, tenant: TenantContext) {
  const members = await deps.db.membership.findMany({
    where: {
      active: true,
      organisationId: tenant.organisationId,
      OR: [{ propertyId: tenant.propertyId }, { propertyId: null }],
      user: { status: 'ACTIVE' },
    },
    include: { user: true, role: true },
  });
  const perms = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  for (const m of members) {
    const set = perms.get(m.userId) ?? new Set<string>();
    for (const code of m.role.permissions) set.add(code);
    perms.set(m.userId, set);
    names.set(m.userId, m.user.name);
  }
  return [...perms.entries()]
    .filter(([, set]) => set.has('hk.work') && !set.has('hk.assign'))
    .map(([id]) => ({ id, name: names.get(id) ?? '' }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

export async function assignRooms(
  deps: HousekeepingDeps,
  tenant: TenantContext,
  body: z.output<typeof AssignBody>,
) {
  const date = await businessDate(deps.tenantDb, tenant.propertyId, deps.clock);
  if (body.attendantId) {
    const attendants = await attendantsOf(deps, tenant);
    if (!attendants.some((a) => a.id === body.attendantId)) {
      throw new AppError('VALIDATION_ERROR', 'Choose someone who cleans rooms here', {
        issues: [
          {
            path: 'body.attendantId',
            code: 'custom',
            message: 'Choose someone who cleans rooms here',
          },
        ],
      });
    }
  }
  const ids = await deps.tenantDb.$transaction(async (tx) => {
    const rooms = await tx.room.findMany({ where: { id: { in: body.roomIds }, active: true } });
    if (rooms.length !== new Set(body.roomIds).size)
      throw new AppError('NOT_FOUND', 'Room not found');
    const fo = await frontOffice(tx, date);
    const out: string[] = [];
    for (const room of rooms) {
      let a = await tx.hkAssignment.findFirst({
        where: { businessDate: dbDate(date), roomId: room.id },
      });
      if (!a) {
        // A room not on the list (a late check-out, a day-use end…): a clean of the kind it needs.
        const kind = kindFor(room, fo) ?? 'DEPARTURE';
        if (room.hkStatus === 'OUT_OF_ORDER' || room.hkStatus === 'OUT_OF_SERVICE') {
          throw new AppError('STATE_TRANSITION_INVALID', `Room ${room.number} is out of order`, {
            roomId: room.id,
          });
        }
        a = await tx.hkAssignment.create({
          data: {
            businessDate: dbDate(date),
            roomId: room.id,
            kind,
            checklist: checklistOf(kind),
          } as unknown as Prisma.HkAssignmentUncheckedCreateInput, // tenant IDs come from the client
        });
      }
      if (a.status === 'DONE') {
        throw new AppError('STATE_TRANSITION_INVALID', `Room ${room.number} is done for today`, {
          roomId: room.id,
        });
      }
      await tx.hkAssignment.update({
        where: { id: a.id },
        data: { attendantId: body.attendantId },
      });
      out.push(a.id);
    }
    await recordAudit(tx, {
      action: 'housekeeping.rooms_assigned',
      entityType: 'hk_assignment',
      entityId: date,
      after: { roomIds: body.roomIds, attendantId: body.attendantId },
    });
    return out;
  });
  const rows = await deps.tenantDb.hkAssignment.findMany({
    where: { id: { in: ids } },
    include: WITH,
    orderBy: { room: { number: 'asc' } },
  });
  return { data: rows.map(assignmentItem) };
}

export async function myAssignments(deps: HousekeepingDeps, tenant: TenantContext) {
  const date = await businessDate(deps.tenantDb, tenant.propertyId, deps.clock);
  const rows = await deps.tenantDb.hkAssignment.findMany({
    where: { businessDate: dbDate(date), attendantId: tenant.userId },
    include: WITH,
    orderBy: { room: { number: 'asc' } },
  });
  // Rooms to do first, done ones last.
  const order = { IN_PROGRESS: 0, PAUSED: 1, PENDING: 2, DONE: 3 } as Record<string, number>;
  rows.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  return { businessDate: date, data: rows.map(assignmentItem) };
}

export async function updateAssignment(
  deps: HousekeepingDeps,
  tenant: TenantContext,
  id: string,
  body: z.output<typeof AssignmentPatch>,
) {
  const now = deps.clock();
  await deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM hk_assignments WHERE id = ${id}::uuid FOR UPDATE`;
    const a = await tx.hkAssignment.findUnique({ where: { id }, include: { room: true } });
    if (!a) throw new AppError('NOT_FOUND', 'Assignment not found');
    if (a.attendantId !== tenant.userId && !tenant.permissions.has('hk.assign')) {
      throw new AppError('FORBIDDEN', 'This room is not yours to clean');
    }
    const today = await businessDate(tx, tenant.propertyId, deps.clock);
    if (day(a.businessDate) !== today) {
      throw new AppError('STATE_TRANSITION_INVALID', 'This is an earlier day’s list');
    }
    if (a.status === 'DONE') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This room is done for today');
    }
    const checklist = body.checklist ?? (a.checklist as { item: string; done: boolean }[]);
    const data: Prisma.HkAssignmentUncheckedUpdateInput = {
      ...(body.checklist ? { checklist: body.checklist } : {}),
      ...(body.minibar ? { minibar: body.minibar } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    };
    let roomStatus: 'CLEANING' | 'CLEAN' | null = null;
    if (body.action === 'START') {
      if (a.status === 'IN_PROGRESS')
        throw new AppError('STATE_TRANSITION_INVALID', 'Already started');
      if (a.room.hkStatus === 'OUT_OF_ORDER' || a.room.hkStatus === 'OUT_OF_SERVICE') {
        throw new AppError('STATE_TRANSITION_INVALID', `Room ${a.room.number} is out of order`);
      }
      // One room at a time: anything else in progress is paused.
      await tx.hkAssignment.updateMany({
        where: {
          attendantId: a.attendantId ?? tenant.userId,
          status: 'IN_PROGRESS',
          id: { not: a.id },
        },
        data: { status: 'PAUSED' },
      });
      Object.assign(data, {
        status: 'IN_PROGRESS',
        startedAt: a.startedAt ?? now,
        ...(a.attendantId ? {} : { attendantId: tenant.userId }),
      });
      roomStatus = 'CLEANING';
    } else if (body.action === 'PAUSE') {
      if (a.status !== 'IN_PROGRESS')
        throw new AppError('STATE_TRANSITION_INVALID', 'Start the room first');
      data.status = 'PAUSED';
    } else if (body.action === 'COMPLETE') {
      if (a.status === 'PENDING')
        throw new AppError('STATE_TRANSITION_INVALID', 'Start the room first');
      const open = checklist.filter((c) => !c.done);
      if (open.length > 0) {
        throw new AppError('VALIDATION_ERROR', 'Tick every checklist item first', {
          issues: [
            {
              path: 'body.checklist',
              code: 'custom',
              message: `Still to do: ${open.map((c) => c.item).join(', ')}`,
            },
          ],
        });
      }
      Object.assign(data, { status: 'DONE', completedAt: now });
      // M5 AC: with inspection off a completed room is CLEAN, ready for a guest at once.
      roomStatus = 'CLEAN';
    }
    await tx.hkAssignment.update({ where: { id: a.id }, data });
    if (roomStatus && a.room.hkStatus !== roomStatus) {
      await tx.room.update({
        where: { id: a.roomId },
        data: { hkStatus: roomStatus, hkStatusAt: now, version: { increment: 1 } },
      });
      await recordAudit(tx, {
        action: 'room.hk_status_changed',
        entityType: 'room',
        entityId: a.roomId,
        before: { hkStatus: a.room.hkStatus },
        after: { hkStatus: roomStatus, assignmentId: a.id },
      });
      await recordEvent(tx, {
        type: 'room.hk_status_changed',
        payload: { roomId: a.roomId, from: a.room.hkStatus, to: roomStatus },
      });
    }
    if (body.action) {
      await recordAudit(tx, {
        action: `housekeeping.${body.action.toLowerCase()}`,
        entityType: 'hk_assignment',
        entityId: a.id,
        after: { status: data.status, roomId: a.roomId },
      });
    }
  });
  const row = await deps.tenantDb.hkAssignment.findUniqueOrThrow({ where: { id }, include: WITH });
  return assignmentItem(row);
}
