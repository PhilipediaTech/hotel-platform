import type { InspectionBody, InspectionItem } from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDay } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { assignmentItem, type HousekeepingDeps } from './service.ts';

// Room inspection (PRD M5-06 "As a supervisor, I inspect a room (pass/fail with reasons); fail
// sends it back to dirty", hk.inspect; M5 rule 1; tab 3 inspections; tab 4 POST /inspections;
// T-129). A supervisor inspects a cleaned room (CLEAN), or spot-checks one already passed
// (INSPECTED). A pass sets the room INSPECTED. A fail sets it DIRTY and opens the day's
// cleaning job again for its attendant, checklist unticked, so the room comes back on their
// list with the reasons on it. Whether a hotel needs the pass before a guest gets the room is
// its housekeeping setting (settings.ts).

type Client = TenantDb | Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Row = Prisma.InspectionGetPayload<{ include: { inspector: true } }>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const DAY = 86_400_000;

export function inspectionItem(r: Row): z.input<typeof InspectionItem> {
  return {
    id: r.id,
    roomId: r.roomId,
    passed: r.passed,
    failReasons: r.failReasons,
    at: iso(r.at),
    inspector: { id: r.inspector.id, name: r.inspector.name },
  };
}

/**
 * The latest inspection of each room in the current business day: since the day opened (or,
 * for a property not live yet, the last 24 hours).
 */
export async function inspectionsToday(
  db: Client,
  propertyId: string,
  clock: Clock,
): Promise<Map<string, Row>> {
  const today = await businessDay(db, propertyId, clock);
  const since = today.openedAt ?? new Date(clock().getTime() - DAY);
  const rows = await db.inspection.findMany({
    where: { at: { gte: since } },
    include: { inspector: true },
    orderBy: { at: 'desc' },
  });
  const latest = new Map<string, Row>();
  for (const r of rows) if (!latest.has(r.roomId)) latest.set(r.roomId, r);
  return latest;
}

export async function recordInspection(
  deps: HousekeepingDeps,
  tenant: TenantContext,
  body: z.output<typeof InspectionBody>,
) {
  const now = deps.clock();
  const { inspectionId, reopenedId } = await deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${body.roomId}::uuid FOR UPDATE`;
    const room = await tx.room.findFirst({ where: { id: body.roomId, active: true } });
    if (!room) throw new AppError('NOT_FOUND', 'Room not found');
    if (room.hkStatus !== 'CLEAN' && room.hkStatus !== 'INSPECTED') {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `Room ${room.number} is ${room.hkStatus.toLowerCase().replace(/_/g, ' ')}: inspect it once it is clean`,
        { roomId: room.id, hkStatus: room.hkStatus },
      );
    }
    const inspection = await tx.inspection.create({
      data: {
        roomId: room.id,
        inspectorId: tenant.userId,
        passed: body.passed,
        failReasons: body.failReasons,
        at: now,
      } as unknown as Prisma.InspectionUncheckedCreateInput, // tenant IDs come from the client
    });
    const to = body.passed ? 'INSPECTED' : 'DIRTY';
    if (room.hkStatus !== to) {
      await tx.room.update({
        where: { id: room.id },
        data: { hkStatus: to, hkStatusAt: now, version: { increment: 1 } },
      });
      await recordAudit(tx, {
        action: 'room.hk_status_changed',
        entityType: 'room',
        entityId: room.id,
        before: { hkStatus: room.hkStatus },
        after: { hkStatus: to, inspectionId: inspection.id },
      });
      await recordEvent(tx, {
        type: 'room.hk_status_changed',
        payload: { roomId: room.id, from: room.hkStatus, to },
      });
    }
    // A fail puts the room back on its attendant's list for the business date.
    let reopened: string | null = null;
    if (!body.passed) {
      const date = (await businessDay(tx, tenant.propertyId, deps.clock)).date;
      const job = await tx.hkAssignment.findFirst({
        where: { businessDate: dbDate(date), roomId: room.id, status: 'DONE' },
      });
      if (job) {
        await tx.hkAssignment.update({
          where: { id: job.id },
          data: {
            status: 'PENDING',
            completedAt: null,
            checklist: (job.checklist as { item: string; done: boolean }[]).map((c) => ({
              item: c.item,
              done: false,
            })),
          },
        });
        reopened = job.id;
      }
    }
    await recordAudit(tx, {
      action: body.passed ? 'housekeeping.inspection_passed' : 'housekeeping.inspection_failed',
      entityType: 'inspection',
      entityId: inspection.id,
      after: {
        roomId: room.id,
        passed: body.passed,
        failReasons: body.failReasons,
        reopenedAssignmentId: reopened,
      },
    });
    return { inspectionId: inspection.id, reopenedId: reopened };
  });

  const row = await deps.tenantDb.inspection.findUniqueOrThrow({
    where: { id: inspectionId },
    include: { inspector: true, room: true },
  });
  const job = reopenedId
    ? await deps.tenantDb.hkAssignment.findUniqueOrThrow({
        where: { id: reopenedId },
        include: { room: true, attendant: true },
      })
    : null;
  return {
    inspection: inspectionItem(row),
    hkStatus: row.room.hkStatus,
    reopened: job ? assignmentItem(job, row) : null,
  };
}
