import {
  daysBetween,
  MAX_INVENTORY_READ_DAYS,
  type InventoryDay,
  type OverbookingBody,
} from '@hotel/shared';
import type { z } from 'zod';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { inventoryWindow, propertyToday } from './inventory.ts';

// Inventory read and overbooking limits (PRD M2 rule 1, M2-09; T-040).

export interface AvailabilityDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
  });

export async function getInventory(
  deps: AvailabilityDeps,
  query: { from: string; to: string },
): Promise<z.input<typeof InventoryDay>[]> {
  const span = daysBetween(query.from, query.to) + 1;
  if (span < 1 || span > MAX_INVENTORY_READ_DAYS) {
    throw invalid('query.to', `Ask for 1 to ${MAX_INVENTORY_READ_DAYS} days`);
  }
  const rows = await deps.tenantDb.roomTypeInventory.findMany({
    where: { date: { gte: dbDate(query.from), lte: dbDate(query.to) } },
    include: { roomType: { select: { sortOrder: true, name: true } } },
  });
  return rows
    .sort(
      (a, b) =>
        a.roomType.sortOrder - b.roomType.sortOrder ||
        a.roomType.name.localeCompare(b.roomType.name) ||
        a.date.getTime() - b.date.getTime(),
    )
    .map((r) => ({
      roomTypeId: r.roomTypeId,
      date: day(r.date),
      capacity: r.capacity,
      outOfOrder: r.outOfOrder,
      sold: r.sold,
      held: r.held,
      overbookLimit: r.overbookLimit,
      available: r.capacity - r.outOfOrder - r.sold - r.held + r.overbookLimit,
    }));
}

export async function setOverbooking(
  deps: AvailabilityDeps,
  tenant: TenantContext,
  body: z.output<typeof OverbookingBody>,
): Promise<{ changedDays: number }> {
  const today = await propertyToday(deps.db, tenant.propertyId, deps.clock);
  const { to: horizon } = inventoryWindow(today);
  if (body.from < today) throw invalid('body.from', 'Overbooking limits change from today on');
  if (body.to > horizon) throw invalid('body.to', `Set limits up to ${horizon}`);
  return deps.tenantDb.$transaction(async (tx) => {
    const types = await tx.roomType.count({ where: { id: { in: body.roomTypeIds } } });
    if (types !== body.roomTypeIds.length) {
      throw invalid('body.roomTypeIds', 'Choose room types of this property');
    }
    const range = { gte: dbDate(body.from), lte: dbDate(body.to) };
    // A lower limit must still cover what is already sold and held.
    const short = await tx.roomTypeInventory.findMany({
      where: { roomTypeId: { in: body.roomTypeIds }, date: range },
      orderBy: { date: 'asc' },
    });
    const conflicts = short
      .filter((r) => r.sold + r.held + r.outOfOrder > r.capacity + body.limit)
      .slice(0, 20)
      .map((r) => ({ roomTypeId: r.roomTypeId, date: day(r.date) }));
    if (conflicts.length > 0) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `More rooms are already sold on ${conflicts[0]?.date ?? 'some dates'} than this limit allows`,
        { conflicts },
      );
    }
    const { count } = await tx.roomTypeInventory.updateMany({
      where: {
        roomTypeId: { in: body.roomTypeIds },
        date: range,
        overbookLimit: { not: body.limit },
      },
      data: { overbookLimit: body.limit },
    });
    if (count > 0) {
      await recordAudit(tx, {
        action: 'inventory.overbooking_set',
        entityType: 'property',
        entityId: tenant.propertyId,
        after: {
          roomTypeIds: body.roomTypeIds,
          from: body.from,
          to: body.to,
          limit: body.limit,
          changedDays: count,
        },
      });
    }
    return { changedDays: count };
  });
}
