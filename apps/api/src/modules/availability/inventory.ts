import { addDays, INVENTORY_DAYS, localDate } from '@hotel/shared';
import { Prisma } from '../../generated/prisma/client.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db, DbClient } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { defineJob } from '../../core/jobs.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Room-type inventory (tab 2 "Inventory and concurrency"; PRD M2 rules 1–2; T-040).
// capacity and outOfOrder are rebuilt from rooms and blocks whenever they change (and daily,
// which also extends the horizon); sold and held belong to reservations, which take and give
// back nights with conditional updates (T-042). The table's CHECK keeps
// sold + held + out_of_order ≤ capacity + overbook_limit whatever happens.

type Client = DbClient | Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

export interface InventoryConflict {
  roomTypeId: string;
  date: string;
}

/** Today and the last day of the horizon, as YYYY-MM-DD. */
export function inventoryWindow(today: string): { from: string; to: string } {
  return { from: today, to: addDays(today, INVENTORY_DAYS - 1) };
}

/**
 * Days where rebuilding would leave fewer rooms than are sold and held (e.g. a room put out of
 * order on a full night). Checked before writing, so the caller can say which dates.
 */
async function rebuildConflicts(
  db: Client,
  propertyId: string,
  from: string,
  to: string,
  roomTypeIds: string[] | null,
): Promise<InventoryConflict[]> {
  const rows = await db.$queryRaw<{ room_type_id: string; date: Date }[]>`
    WITH fresh AS (${freshRows(propertyId, from, to, roomTypeIds)})
    SELECT i.room_type_id, i.date
    FROM fresh f
    JOIN room_type_inventory i
      ON i.property_id = f.property_id AND i.room_type_id = f.room_type_id AND i.date = f.date
    WHERE i.sold + i.held + f.out_of_order > f.capacity + i.overbook_limit
    ORDER BY i.date, i.room_type_id
    LIMIT 20`;
  return rows.map((r) => ({ roomTypeId: r.room_type_id, date: r.date.toISOString().slice(0, 10) }));
}

/** Capacity and out-of-order count per room type and date, worked out from rooms and blocks. */
function freshRows(propertyId: string, from: string, to: string, roomTypeIds: string[] | null) {
  return Prisma.sql`
    SELECT rt.property_id, rt.id AS room_type_id, d::date AS date,
      (SELECT count(*) FROM rooms r
        WHERE r.room_type_id = rt.id AND r.active)::int AS capacity,
      (SELECT count(*) FROM rooms r
        JOIN room_blocks b ON b.room_id = r.id
        WHERE r.room_type_id = rt.id AND r.active AND b.kind = 'OUT_OF_ORDER'
          AND b.released_at IS NULL AND b.start_date <= d::date AND b.end_date > d::date)::int
        AS out_of_order
    FROM room_types rt, generate_series(${from}::date, ${to}::date, interval '1 day') AS d
    WHERE rt.property_id = ${propertyId}::uuid
      AND (${roomTypeIds === null} OR rt.id = ANY(${roomTypeIds ?? []}::uuid[]))`;
}

/**
 * Rewrites capacity and out-of-order from today to the end of the horizon (for some room
 * types, or all), adding missing days. Refuses with 409 STATE_TRANSITION_INVALID when rooms
 * would run short of what is already sold. Returns the days written.
 */
export async function rebuildInventory(
  db: Client,
  propertyId: string,
  today: string,
  roomTypeIds: string[] | null = null,
): Promise<number> {
  if (roomTypeIds?.length === 0) return 0;
  const { from, to } = inventoryWindow(today);
  const conflicts = await rebuildConflicts(db, propertyId, from, to, roomTypeIds);
  if (conflicts.length > 0) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      `Not enough rooms left for the bookings on ${conflicts[0]?.date ?? 'some dates'}`,
      { conflicts },
    );
  }
  return db.$executeRaw`
    INSERT INTO room_type_inventory AS i (property_id, room_type_id, date, capacity, out_of_order)
    ${freshRows(propertyId, from, to, roomTypeIds)}
    ON CONFLICT (property_id, room_type_id, date) DO UPDATE
      SET capacity = EXCLUDED.capacity, out_of_order = EXCLUDED.out_of_order
      WHERE (i.capacity, i.out_of_order) IS DISTINCT FROM (EXCLUDED.capacity, EXCLUDED.out_of_order)`;
}

/** Today at the property, for callers that only have the property ID. */
export async function propertyToday(db: Client, propertyId: string, clock: Clock): Promise<string> {
  // Raw: the same call on every kind of client (a method call on the union types poorly).
  const rows = await db.$queryRaw<{ time_zone: string }[]>`
    SELECT time_zone FROM properties WHERE id = ${propertyId}::uuid`;
  const timeZone = rows[0]?.time_zone;
  if (!timeZone) throw new Error(`Property ${propertyId} not found`);
  return localDate(clock(), timeZone);
}

// ── Taking and giving back nights (reservations, T-042) ────────────────────────────────

export type InventoryField = 'sold' | 'held';

/**
 * Takes `count` rooms of a type for each night from `arrival` to `departure` (exclusive),
 * only where sold + held + out of order stays within capacity + overbooking limit (tab 2).
 * Any night short of rooms (or outside the horizon) throws 409 BOOKING_CONFLICT naming the
 * nights; run it inside the booking's transaction so nothing is kept.
 */
export async function takeInventory(
  db: Client,
  args: {
    propertyId: string;
    roomTypeId: string;
    arrival: string;
    departure: string;
    field: InventoryField;
    count?: number;
  },
): Promise<void> {
  const n = args.count ?? 1;
  const nights = Math.round(
    (Date.parse(`${args.departure}T00:00:00Z`) - Date.parse(`${args.arrival}T00:00:00Z`)) /
      86_400_000,
  );
  // Lock the nights first and check them all, so nothing is taken unless every night has a
  // room (and the error names exactly the nights that are full).
  const rows = await db.$queryRaw<
    {
      date: Date;
      sold: number;
      held: number;
      out_of_order: number;
      capacity: number;
      overbook_limit: number;
    }[]
  >`SELECT date, sold, held, out_of_order, capacity, overbook_limit FROM room_type_inventory
    WHERE property_id = ${args.propertyId}::uuid AND room_type_id = ${args.roomTypeId}::uuid
      AND date >= ${args.arrival}::date AND date < ${args.departure}::date
    ORDER BY date FOR UPDATE`;
  const byDate = new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), r]));
  const full: string[] = [];
  const start = Date.parse(`${args.arrival}T00:00:00Z`);
  for (let i = 0; i < nights; i++) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const r = byDate.get(date);
    if (!r || r.sold + r.held + r.out_of_order + n > r.capacity + r.overbook_limit) full.push(date);
  }
  const conflict = (dates: string[]) =>
    new AppError('BOOKING_CONFLICT', 'No room of this type is left on some nights', {
      roomTypeId: args.roomTypeId,
      dates,
    });
  if (full.length > 0) throw conflict(full);
  const where = Prisma.sql`property_id = ${args.propertyId}::uuid
    AND room_type_id = ${args.roomTypeId}::uuid
    AND date >= ${args.arrival}::date AND date < ${args.departure}::date
    AND sold + held + out_of_order + ${n} <= capacity + overbook_limit`;
  const taken =
    args.field === 'sold'
      ? await db.$executeRaw`UPDATE room_type_inventory SET sold = sold + ${n} WHERE ${where}`
      : await db.$executeRaw`UPDATE room_type_inventory SET held = held + ${n} WHERE ${where}`;
  // Only outside a transaction can another booking slip in between; the caller's
  // transaction must roll back what was taken.
  if (taken !== nights) throw conflict([]);
}

/** Gives back what takeInventory took (cancellation, hold expiry, shortened stay). */
export async function releaseInventory(
  db: Client,
  args: {
    propertyId: string;
    roomTypeId: string;
    arrival: string;
    departure: string;
    field: InventoryField;
    count?: number;
  },
): Promise<void> {
  const n = args.count ?? 1;
  const where = Prisma.sql`property_id = ${args.propertyId}::uuid
    AND room_type_id = ${args.roomTypeId}::uuid
    AND date >= ${args.arrival}::date AND date < ${args.departure}::date`;
  if (args.field === 'sold') {
    await db.$executeRaw`UPDATE room_type_inventory SET sold = sold - ${n} WHERE ${where}`;
  } else {
    await db.$executeRaw`UPDATE room_type_inventory SET held = held - ${n} WHERE ${where}`;
  }
}

// ── Daily rebuild ──────────────────────────────────────────────────────────────────────

/** Rebuilds every property's horizon: adds the new last day and repairs any drift. */
export async function rebuildAllInventory(db: Db, clock: Clock): Promise<number> {
  const properties = await db.property.findMany({
    where: { status: { not: 'ARCHIVED' } },
    select: { id: true, timeZone: true },
  });
  let days = 0;
  for (const p of properties) {
    try {
      days += await db.$transaction((tx) =>
        rebuildInventory(tx, p.id, localDate(clock(), p.timeZone)),
      );
    } catch (err) {
      // One property short of rooms must not stop the others; its rooms changed and staff see
      // the conflict when they next change rooms or blocks.
      if (!(err instanceof AppError)) throw err;
    }
  }
  return days;
}

export const inventoryJob = defineJob({
  name: 'inventory-rebuild',
  // 00:15 UTC = 01:15 in Lagos: after midnight everywhere we sell (Africa).
  schedule: { cron: '15 0 * * *' },
  async run(_data, { db, clock, logger }) {
    const days = await rebuildAllInventory(db, clock);
    logger.info({ days }, 'Inventory rebuilt');
  },
});
