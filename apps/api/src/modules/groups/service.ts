import {
  addDays,
  daysBetween,
  GROUP_BLOCK_MAX_NIGHTS,
  ReservationBody,
  type GroupBlockBody,
  type GroupBlockDetail,
  type GroupBlockItem,
  type GroupBlockUpdateBody,
  type RoomingListBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { propertyToday, releaseInventory, takeInventory } from '../availability/inventory.ts';
import { createQuote } from '../availability/quotes.ts';
import { createReservation } from '../reservations/service.ts';

// Group blocks and allotments (PRD M3-17, M2-12, M2 rule 1; T-123). See packages/shared
// api/group-blocks.ts for the rules. Each night of a block keeps how many rooms of a type were
// agreed and how many are still held; the held rooms sit in the inventory's `held`, so nothing
// else can sell them. Pick-up (how many are booked) is counted from the reservations made
// against the block.

export interface GroupDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

export type BlockKind = 'GROUP' | 'ALLOTMENT';
type TenantTx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | TenantTx;
type Item = z.input<typeof GroupBlockItem>;
type Detail = z.input<typeof GroupBlockDetail>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });
const stateError = (message: string, details?: Record<string, unknown>) =>
  new AppError('STATE_TRANSITION_INVALID', message, details);
const notFound = (kind: BlockKind) =>
  new AppError('NOT_FOUND', kind === 'GROUP' ? 'Group block not found' : 'Allotment not found');

/** Stays that count as picked up. */
const PICKED = ['TENTATIVE', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] as const;

const BLOCK_INCLUDE = {
  company: { select: { id: true, name: true } },
  ratePlan: { select: { id: true, code: true, name: true } },
  nights: { orderBy: [{ date: 'asc' }, { roomTypeId: 'asc' }] },
} satisfies Prisma.GroupBlockInclude;
type BlockRow = Prisma.GroupBlockGetPayload<{ include: typeof BLOCK_INCLUDE }>;

/** Whether a night of a block is due to go back: its release point has come, or it has passed. */
function due(
  b: { kind: string; releaseDate: Date | null; releaseDays: number | null },
  date: string,
  today: string,
): boolean {
  if (date < today) return true;
  if (b.kind === 'GROUP') return b.releaseDate !== null && day(b.releaseDate) <= today;
  return addDays(date, -(b.releaseDays ?? 0)) <= today;
}

async function stayCounts(db: Client, blockId: string) {
  const stays = await db.stay.findMany({
    where: { reservation: { groupBlockId: blockId }, status: { in: [...PICKED] } },
    include: {
      guest: { select: { firstName: true, lastName: true } },
      room: { select: { number: true } },
      reservation: { select: { id: true, confirmationNo: true } },
    },
    orderBy: [{ arrival: 'asc' }, { id: 'asc' }],
  });
  const perNight = new Map<string, number>();
  for (const s of stays) {
    for (let d = day(s.arrival); d < day(s.departure); d = addDays(d, 1)) {
      const key = `${s.roomTypeId}|${d}`;
      perNight.set(key, (perNight.get(key) ?? 0) + 1);
    }
  }
  return { stays, perNight };
}

async function roomTypeNames(db: Client, ids: string[]) {
  const types = await db.roomType.findMany({ where: { id: { in: ids } } });
  return new Map(types.map((t) => [t.id, t.name]));
}

async function detailOf(db: Client, b: BlockRow): Promise<Detail> {
  const { stays, perNight } = await stayCounts(db, b.id);
  const typeIds = [...new Set(b.nights.map((n) => n.roomTypeId))];
  const names = await roomTypeNames(db, typeIds);
  const nights = b.nights.map((n) => ({
    roomTypeId: n.roomTypeId,
    date: day(n.date),
    rooms: n.rooms,
    pickedUp: perNight.get(`${n.roomTypeId}|${day(n.date)}`) ?? 0,
    remaining: n.remaining,
    released: n.releasedAt !== null,
  }));
  const item: Item = {
    id: b.id,
    kind: b.kind as Item['kind'],
    code: b.code,
    name: b.name,
    status: b.status as Item['status'],
    company: b.company,
    ratePlan: b.ratePlan,
    arrival: day(b.arrival),
    departure: day(b.departure),
    releaseDate: b.releaseDate ? day(b.releaseDate) : null,
    releaseDays: b.releaseDays,
    notes: b.notes,
    roomTypes: typeIds.map((id) => {
      const mine = nights.filter((n) => n.roomTypeId === id);
      return {
        id,
        name: names.get(id) ?? '',
        // The most agreed and picked up on any one night.
        rooms: Math.max(0, ...mine.map((n) => n.rooms)),
        pickedUp: Math.max(0, ...mine.map((n) => n.pickedUp)),
      };
    }),
    createdAt: iso(b.createdAt),
  };
  return {
    ...item,
    nights,
    rooming: stays.map((s) => ({
      reservationId: s.reservation.id,
      confirmationNo: s.reservation.confirmationNo,
      stayId: s.id,
      guestName: `${s.guest.firstName} ${s.guest.lastName}`.trim(),
      roomTypeId: s.roomTypeId,
      roomNumber: s.room?.number ?? null,
      arrival: day(s.arrival),
      departure: day(s.departure),
      status: s.status,
    })),
  };
}

async function loadBlock(db: Client, kind: BlockKind, blockId: string) {
  const b = await db.groupBlock.findFirst({ where: { id: blockId, kind }, include: BLOCK_INCLUDE });
  if (!b) throw notFound(kind);
  return b;
}

export async function listBlocks(deps: GroupDeps, kind: BlockKind, status?: string) {
  const rows = await deps.tenantDb.groupBlock.findMany({
    where: { kind, ...(status ? { status } : {}) },
    include: BLOCK_INCLUDE,
    orderBy: [{ arrival: 'asc' }, { code: 'asc' }],
    take: 200,
  });
  const data: Item[] = [];
  for (const r of rows) {
    const { nights: _n, rooming: _r, ...item } = await detailOf(deps.tenantDb, r);
    data.push(item);
  }
  return { data };
}

export async function getBlock(deps: GroupDeps, kind: BlockKind, blockId: string) {
  return detailOf(deps.tenantDb, await loadBlock(deps.tenantDb, kind, blockId));
}

// ── Holding and giving back ─────────────────────────────────────────────────────────────

/** Holds `count` more rooms of a type on each date; one error naming every short night. */
async function hold(
  tx: TenantTx,
  propertyId: string,
  wants: { roomTypeId: string; date: string; count: number }[],
) {
  const short: { roomTypeId: string; date: string }[] = [];
  const sorted = [...wants].sort(
    (x, y) => x.roomTypeId.localeCompare(y.roomTypeId) || x.date.localeCompare(y.date),
  );
  for (const w of sorted) {
    if (w.count <= 0) continue;
    try {
      await takeInventory(tx, {
        propertyId,
        roomTypeId: w.roomTypeId,
        arrival: w.date,
        departure: addDays(w.date, 1),
        field: 'held',
        count: w.count,
      });
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'BOOKING_CONFLICT') throw err;
      short.push({ roomTypeId: w.roomTypeId, date: w.date });
    }
  }
  if (short.length > 0) {
    throw new AppError(
      'BOOKING_CONFLICT',
      `Not enough rooms to hold on ${short.length === 1 ? short[0]?.date : `${short.length} nights`}`,
      { nights: short },
    );
  }
}

async function giveBack(
  tx: Client,
  propertyId: string,
  night: { id: string; roomTypeId: string; date: Date; remaining: number },
  now: Date,
) {
  if (night.remaining > 0) {
    await releaseInventory(tx as never, {
      propertyId,
      roomTypeId: night.roomTypeId,
      arrival: day(night.date),
      departure: addDays(day(night.date), 1),
      field: 'held',
      count: night.remaining,
    });
  }
  await tx.groupBlockNight.update({
    where: { id: night.id },
    data: { remaining: 0, releasedAt: now },
  });
}

function checkRelease(
  kind: BlockKind,
  body: { releaseDate: string | null; releaseDays: number | null },
  arrival: string,
  today: string,
) {
  if (kind === 'GROUP') {
    if (!body.releaseDate) throw invalid('releaseDate', 'Give the date unpicked rooms go back');
    if (body.releaseDate > arrival) {
      throw invalid('releaseDate', 'Rooms go back on or before the group arrives');
    }
    if (body.releaseDate < today) throw invalid('releaseDate', 'The release date has passed');
    if (body.releaseDays !== null) throw invalid('releaseDays', 'A group has a release date');
  } else {
    if (body.releaseDays === null) {
      throw invalid('releaseDays', 'Give how many days before each night it goes back');
    }
    if (body.releaseDate !== null) throw invalid('releaseDate', 'An allotment has release days');
  }
}

async function checkRefs(
  tx: TenantTx,
  kind: BlockKind,
  body: { companyId: string | null; ratePlanId: string; rooms: { roomTypeId: string }[] },
) {
  if (body.companyId) {
    const company = await tx.company.findUnique({ where: { id: body.companyId } });
    if (!company?.active) throw invalid('companyId', 'Choose an active company');
  } else if (kind === 'ALLOTMENT') {
    throw invalid('companyId', 'An allotment is for a company or travel agent');
  }
  const plan = await tx.ratePlan.findFirst({ where: { id: body.ratePlanId, active: true } });
  if (!plan) throw invalid('ratePlanId', 'Choose an active rate plan');
  const types = await tx.roomType.findMany({
    where: { id: { in: body.rooms.map((r) => r.roomTypeId) }, active: true },
  });
  for (const r of body.rooms) {
    if (!types.some((t) => t.id === r.roomTypeId)) {
      throw invalid('rooms', 'Choose active room types of this property');
    }
    if (plan.roomTypeIds.length > 0 && !plan.roomTypeIds.includes(r.roomTypeId)) {
      throw invalid('rooms', `${plan.name} does not sell every room type chosen`);
    }
  }
}

const codeTaken = (err: unknown, code: string) =>
  pgErrorInfo(err)?.sqlState === '23505' &&
  pgErrorInfo(err)?.constraint === 'group_blocks_property_id_code_key'
    ? invalid('code', `Another block already has the code ${code}`)
    : err;

export async function createBlock(
  deps: GroupDeps,
  tenant: TenantContext,
  kind: BlockKind,
  body: z.output<typeof GroupBlockBody>,
) {
  const now = deps.clock();
  const today = await propertyToday(deps.tenantDb, tenant.propertyId, deps.clock);
  if (body.arrival < today) throw invalid('arrival', 'The block starts today or later');
  if (daysBetween(body.arrival, body.departure) > GROUP_BLOCK_MAX_NIGHTS) {
    throw invalid('departure', `A block covers at most ${GROUP_BLOCK_MAX_NIGHTS} nights`);
  }
  checkRelease(kind, body, body.arrival, today);
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      await checkRefs(tx, kind, body);
      const block = await tx.groupBlock.create({
        data: {
          kind,
          code: body.code,
          name: body.name,
          companyId: body.companyId,
          ratePlanId: body.ratePlanId,
          arrival: dbDate(body.arrival),
          departure: dbDate(body.departure),
          releaseDate: body.releaseDate ? dbDate(body.releaseDate) : null,
          releaseDays: body.releaseDays,
          notes: body.notes,
          createdById: tenant.userId,
          createdAt: now,
        } as unknown as Prisma.GroupBlockUncheckedCreateInput,
      });
      const wants: { roomTypeId: string; date: string; count: number }[] = [];
      for (const r of body.rooms) {
        for (let d = body.arrival; d < body.departure; d = addDays(d, 1)) {
          const gone = due(block, d, today);
          await tx.groupBlockNight.create({
            data: {
              blockId: block.id,
              roomTypeId: r.roomTypeId,
              date: dbDate(d),
              rooms: r.count,
              remaining: gone ? 0 : r.count,
              releasedAt: gone ? now : null,
            } as unknown as Prisma.GroupBlockNightUncheckedCreateInput,
          });
          if (!gone) wants.push({ roomTypeId: r.roomTypeId, date: d, count: r.count });
        }
      }
      await hold(tx, tenant.propertyId, wants);
      await recordAudit(tx, {
        action: kind === 'GROUP' ? 'group_block.created' : 'allotment.created',
        entityType: 'group_block',
        entityId: block.id,
        after: {
          code: body.code,
          arrival: body.arrival,
          departure: body.departure,
          rooms: body.rooms,
          releaseDate: body.releaseDate,
          releaseDays: body.releaseDays,
        },
      });
      return detailOf(tx, await loadBlock(tx, kind, block.id));
    });
  } catch (err) {
    throw codeTaken(err, body.code);
  }
}

export async function updateBlock(
  deps: GroupDeps,
  tenant: TenantContext,
  kind: BlockKind,
  blockId: string,
  body: z.output<typeof GroupBlockUpdateBody>,
) {
  const now = deps.clock();
  const today = await propertyToday(deps.tenantDb, tenant.propertyId, deps.clock);
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM group_blocks WHERE id = ${blockId}::uuid FOR UPDATE`;
      const before = await loadBlock(tx, kind, blockId);
      if (before.status !== 'ACTIVE') throw stateError('This block has been released');
      checkRelease(kind, body, day(before.arrival), today);
      await checkRefs(tx, kind, body);
      await tx.groupBlock.update({
        where: { id: blockId },
        data: {
          code: body.code,
          name: body.name,
          companyId: body.companyId,
          ratePlanId: body.ratePlanId,
          releaseDate: body.releaseDate ? dbDate(body.releaseDate) : null,
          releaseDays: body.releaseDays,
          notes: body.notes,
          version: { increment: 1 },
        },
      });
      const after = { ...before, releaseDate: body.releaseDate ? dbDate(body.releaseDate) : null };
      after.releaseDays = body.releaseDays;
      const wants: { roomTypeId: string; date: string; count: number }[] = [];
      const counts = new Map(body.rooms.map((r) => [r.roomTypeId, r.count]));
      const known = new Set(before.nights.map((n) => n.roomTypeId));
      for (const [roomTypeId, count] of counts) {
        if (known.has(roomTypeId)) continue;
        for (let d = day(before.arrival); d < day(before.departure); d = addDays(d, 1)) {
          const gone = due(after, d, today);
          await tx.groupBlockNight.create({
            data: {
              blockId,
              roomTypeId,
              date: dbDate(d),
              rooms: count,
              remaining: gone ? 0 : count,
              releasedAt: gone ? now : null,
            } as unknown as Prisma.GroupBlockNightUncheckedCreateInput,
          });
          if (!gone) wants.push({ roomTypeId, date: d, count });
        }
      }
      for (const n of before.nights) {
        if (n.releasedAt) continue;
        const target = counts.get(n.roomTypeId) ?? 0;
        const delta = target - n.rooms;
        if (delta === 0) continue;
        if (delta < 0 && n.remaining < -delta) {
          throw stateError(
            `Rooms already booked on ${day(n.date)}: the block can go down to ${n.rooms - n.remaining}`,
            { date: day(n.date), roomTypeId: n.roomTypeId },
          );
        }
        if (delta < 0) {
          await releaseInventory(tx as never, {
            propertyId: tenant.propertyId,
            roomTypeId: n.roomTypeId,
            arrival: day(n.date),
            departure: addDays(day(n.date), 1),
            field: 'held',
            count: -delta,
          });
        } else {
          wants.push({ roomTypeId: n.roomTypeId, date: day(n.date), count: delta });
        }
        await tx.groupBlockNight.update({
          where: { id: n.id },
          data: { rooms: target, remaining: n.remaining + delta },
        });
      }
      await hold(tx, tenant.propertyId, wants);
      // A new release point may already have come.
      await releaseDueIn(tx, blockId, today, now);
      await recordAudit(tx, {
        action: kind === 'GROUP' ? 'group_block.updated' : 'allotment.updated',
        entityType: 'group_block',
        entityId: blockId,
        before: {
          rooms: [...new Set(before.nights.map((n) => n.roomTypeId))].map((id) => ({
            roomTypeId: id,
            count: before.nights.find((n) => n.roomTypeId === id && !n.releasedAt)?.rooms ?? 0,
          })),
          releaseDate: before.releaseDate ? day(before.releaseDate) : null,
          releaseDays: before.releaseDays,
        },
        after: { rooms: body.rooms, releaseDate: body.releaseDate, releaseDays: body.releaseDays },
      });
      return detailOf(tx, await loadBlock(tx, kind, blockId));
    });
  } catch (err) {
    throw codeTaken(err, body.code);
  }
}

/** Gives back the block's nights that are due; marks it RELEASED when none is left. */
async function releaseDueIn(tx: Client, blockId: string, today: string, now: Date) {
  const b = await tx.groupBlock.findUniqueOrThrow({
    where: { id: blockId },
    include: { nights: true },
  });
  if (b.status !== 'ACTIVE') return 0;
  let released = 0;
  for (const n of b.nights) {
    if (n.releasedAt || !due(b, day(n.date), today)) continue;
    await giveBack(tx, b.propertyId, n, now);
    released += 1;
  }
  const left = await tx.groupBlockNight.count({ where: { blockId, releasedAt: null } });
  if (left === 0) {
    await tx.groupBlock.update({
      where: { id: blockId },
      data: { status: 'RELEASED', releasedAt: now, version: { increment: 1 } },
    });
  }
  return released;
}

export async function releaseBlock(
  deps: GroupDeps,
  kind: BlockKind,
  blockId: string,
  cancel: boolean,
) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM group_blocks WHERE id = ${blockId}::uuid FOR UPDATE`;
    const b = await loadBlock(tx, kind, blockId);
    if (b.status !== 'ACTIVE') throw stateError('This block has been released already');
    let rooms = 0;
    for (const n of b.nights) {
      if (n.releasedAt) continue;
      rooms += n.remaining;
      await giveBack(tx, b.propertyId, n, now);
    }
    await tx.groupBlock.update({
      where: { id: blockId },
      data: {
        status: cancel ? 'CANCELLED' : 'RELEASED',
        releasedAt: now,
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      action: cancel ? 'group_block.cancelled' : 'group_block.released',
      entityType: 'group_block',
      entityId: blockId,
      before: { status: 'ACTIVE' },
      after: { status: cancel ? 'CANCELLED' : 'RELEASED', roomNightsGivenBack: rooms },
    });
    return detailOf(tx, await loadBlock(tx, kind, blockId));
  });
}

/** The job: gives back every block's nights whose release point has come. */
export async function releaseDueBlocks(db: Db, clock: Clock): Promise<number> {
  const blocks = await db.groupBlock.findMany({
    where: { status: 'ACTIVE' },
    include: { property: { select: { organisationId: true, timeZone: true } } },
  });
  let nights = 0;
  for (const b of blocks) {
    const today = await propertyToday(db, b.propertyId, clock);
    const now = clock();
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM group_blocks WHERE id = ${b.id}::uuid FOR UPDATE`;
      const released = await releaseDueIn(tx as never, b.id, today, now);
      if (released === 0) return;
      nights += released;
      await recordAudit(tx, {
        organisationId: b.property.organisationId,
        propertyId: b.propertyId,
        action: 'group_block.nights_released',
        entityType: 'group_block',
        entityId: b.id,
        actorType: 'SYSTEM',
        actorUserId: null,
        after: { nights: released, today },
      });
    });
  }
  return nights;
}

// ── Rooming list ────────────────────────────────────────────────────────────────────────

export async function bookRoomingList(
  deps: GroupDeps,
  tenant: TenantContext,
  kind: BlockKind,
  blockId: string,
  body: z.output<typeof RoomingListBody>,
) {
  const b = await loadBlock(deps.tenantDb, kind, blockId);
  if (b.status !== 'ACTIVE') throw stateError('This block has been released');
  const company = b.companyId
    ? await deps.tenantDb.company.findUnique({ where: { id: b.companyId } })
    : null;
  const source =
    company?.kind === 'TRAVEL_AGENT' ? 'TRAVEL_AGENT' : company ? 'CORPORATE' : 'PHONE';
  const booked: { line: number; confirmationNo: string }[] = [];
  const failed: { line: number; message: string }[] = [];
  for (const [i, r] of body.rooms.entries()) {
    const line = i + 1;
    try {
      const quote = await createQuote(deps, tenant, {
        arrival: day(b.arrival),
        departure: day(b.departure),
        adults: r.adults,
        children: 0,
        roomTypeId: r.roomTypeId,
        ratePlanId: b.ratePlanId,
      });
      const parsed = ReservationBody.safeParse({
        source,
        booker: { firstName: r.firstName, lastName: r.lastName, phone: r.phone, email: r.email },
        companyId: b.companyId,
        groupBlockId: b.id,
        stays: [{ quoteId: quote.quoteId, adults: r.adults, guest: { sameAsBooker: true } }],
      });
      if (!parsed.success) {
        failed.push({ line, message: parsed.error.issues[0]?.message ?? 'Invalid line' });
        continue;
      }
      const made = await createReservation(deps, tenant, parsed.data);
      if (!('confirmationNo' in made)) {
        failed.push({ line, message: 'Needs a manager’s approval: book this guest on their own' });
        continue;
      }
      booked.push({ line, confirmationNo: made.confirmationNo });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      failed.push({ line, message: err.message });
    }
  }
  return { booked, failed, block: await getBlock(deps, kind, blockId) };
}
