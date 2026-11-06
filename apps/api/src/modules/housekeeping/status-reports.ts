import {
  OCCUPIED_NO_FOLIO,
  VACANT_IN_HOUSE,
  type ObservedStatus,
  type ReportedRoom,
  type StatusReportBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { businessDate } from '../../core/business-day.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { HousekeepingDeps } from './service.ts';

// Morning room-status report (PRD M5-05, M5 rule 6, M5 AC "a morning report marking a
// PMS-vacant room as occupied creates exactly one discrepancy alert"; M6 core leakage rule
// "occupied without folio"; tab 3 room_status_reports; T-081). Each submission adds a row per
// room; the latest of the business date is the room's report. A room reported in use (occupied,
// slept-out, luggage, do-not-disturb) with no guest checked in raises OCCUPIED_NO_FOLIO; a room
// reported vacant with a guest checked in raises VACANT_IN_HOUSE. The alert's dedupe key is
// rule, date and room, so a room raises at most one per day. M5 rule 6's front-desk task is
// made from the alert when the task engine lands (T-082).

type Client = TenantDb | Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Rule = typeof OCCUPIED_NO_FOLIO | typeof VACANT_IN_HOUSE;

const RULES: Rule[] = [OCCUPIED_NO_FOLIO, VACANT_IN_HOUSE];
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Reports and status reads: attendants (hk.work, M5-05) and supervisors (hk.report). */
function mayReport(tenant: TenantContext) {
  if (!tenant.permissions.has('hk.work') && !tenant.permissions.has('hk.report')) {
    throw new AppError('FORBIDDEN', 'You do not have permission to report room status.', {
      permission: ['hk.work', 'hk.report'],
    });
  }
}

/** The rule a report breaks, if any. */
export function discrepancyOf(observed: ObservedStatus, inHouse: boolean): Rule | null {
  if (observed === 'VACANT') return inHouse ? VACANT_IN_HOUSE : null;
  return inHouse ? null : OCCUPIED_NO_FOLIO;
}

/** Rooms with a guest checked in (day-use too): the front office's "occupied". */
async function checkedIn(db: Client, roomIds?: string[]) {
  const stays = await db.stay.findMany({
    where: {
      status: 'CHECKED_IN',
      roomId: roomIds ? { in: roomIds } : { not: null },
    },
    select: { id: true, roomId: true, guest: { select: { firstName: true, lastName: true } } },
  });
  return new Map(stays.flatMap((s) => (s.roomId ? [[s.roomId, s] as const] : [])));
}

/** The business date's latest report and discrepancy per room. */
export async function reportsOf(db: Client, date: string) {
  const on = dbDate(date);
  const [reports, alerts] = await Promise.all([
    db.roomStatusReport.findMany({ where: { businessDate: on }, orderBy: { at: 'asc' } }),
    db.leakageAlert.findMany({
      where: { businessDate: on, ruleCode: { in: RULES }, entityType: 'room' },
      orderBy: { raisedAt: 'asc' },
    }),
  ]);
  const latest = new Map(reports.map((r) => [r.roomId, r])); // later rows win
  const discrepancy = new Map(alerts.map((a) => [a.entityId, a.ruleCode as Rule]));
  return { latest, discrepancy, alerts };
}

async function reportedRooms(
  db: Client,
  date: string,
  roomIds?: string[],
  floor?: string,
): Promise<{ floors: string[]; data: z.input<typeof ReportedRoom>[] }> {
  const [rooms, occupied, reports] = await Promise.all([
    db.room.findMany({
      where: { active: true, ...(roomIds ? { id: { in: roomIds } } : {}) },
      orderBy: [{ floor: 'asc' }, { number: 'asc' }],
    }),
    checkedIn(db, roomIds),
    reportsOf(db, date),
  ]);
  const floors = [...new Set(rooms.flatMap((r) => (r.floor ? [r.floor] : [])))];
  const data = rooms
    .filter((r) => !floor || r.floor === floor)
    .map((r) => {
      const report = reports.latest.get(r.id);
      return {
        roomId: r.id,
        number: r.number,
        floor: r.floor,
        foStatus: occupied.has(r.id) ? ('OCCUPIED' as const) : ('VACANT' as const),
        observed: report?.observed ?? null,
        reportedAt: report ? iso(report.at) : null,
        discrepancy: reports.discrepancy.get(r.id) ?? null,
      };
    });
  return { floors, data };
}

export async function listStatusReports(
  deps: HousekeepingDeps,
  tenant: TenantContext,
  query: { floor?: string | undefined },
) {
  mayReport(tenant);
  const date = await businessDate(deps.tenantDb, tenant.propertyId, deps.clock);
  const { floors, data } = await reportedRooms(deps.tenantDb, date, undefined, query.floor);
  return { businessDate: date, floors, data };
}

export async function submitStatusReport(
  deps: HousekeepingDeps,
  tenant: TenantContext,
  body: z.output<typeof StatusReportBody>,
) {
  mayReport(tenant);
  const date = await businessDate(deps.tenantDb, tenant.propertyId, deps.clock);
  const roomIds = body.entries.map((e) => e.roomId);
  return deps.tenantDb.$transaction(async (tx) => {
    // One report at a time per property and day, so two never raise the same alert.
    const lock = `room-status:${tenant.propertyId}:${date}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lock}))::text AS locked`;
    const rooms = await tx.room.findMany({ where: { id: { in: roomIds }, active: true } });
    const unknown = roomIds.filter((id) => !rooms.some((r) => r.id === id));
    if (unknown.length) {
      throw new AppError('VALIDATION_ERROR', 'Some rooms were not found.', {
        fields: { entries: ['Unknown room'] },
        roomIds: unknown,
      });
    }
    const occupied = await checkedIn(tx, roomIds);
    const { discrepancy } = await reportsOf(tx, date);
    await tx.roomStatusReport.createMany({
      data: body.entries.map((e) => ({
        businessDate: dbDate(date),
        roomId: e.roomId,
        observed: e.observed,
        reportedById: tenant.userId,
      })) as unknown as Prisma.RoomStatusReportCreateManyInput[], // tenant IDs come from the client
    });
    let raised = 0;
    for (const e of body.entries) {
      const stay = occupied.get(e.roomId);
      const rule = discrepancyOf(e.observed, Boolean(stay));
      if (!rule || discrepancy.has(e.roomId)) continue;
      const room = rooms.find((r) => r.id === e.roomId);
      const dedupeKey = `${rule}:${date}:${e.roomId}`;
      const alert = await tx.leakageAlert.create({
        data: {
          ruleCode: rule,
          businessDate: dbDate(date),
          severity: rule === OCCUPIED_NO_FOLIO ? 'HIGH' : 'NORMAL',
          entityType: 'room',
          entityId: e.roomId,
          evidence: {
            roomNumber: room?.number ?? null,
            observed: e.observed,
            frontOffice: stay ? 'OCCUPIED' : 'VACANT',
            stayId: stay?.id ?? null,
            guest: stay ? `${stay.guest.firstName} ${stay.guest.lastName}`.trim() : null,
            reportedById: tenant.userId,
          },
          dedupeKey,
        } as unknown as Prisma.LeakageAlertUncheckedCreateInput, // tenant IDs come from the client
      });
      discrepancy.set(e.roomId, rule);
      await recordEvent(tx, {
        type: 'leakage.alert_raised',
        payload: { alertId: alert.id, ruleCode: rule, roomId: e.roomId },
      });
      raised += 1;
    }
    const { data } = await reportedRooms(tx, date, roomIds);
    return { businessDate: date, data, alertsRaised: raised };
  });
}
