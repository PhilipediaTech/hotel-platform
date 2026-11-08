import {
  addDays,
  localDate,
  zonedInstant,
  type VisitorBody,
  type VisitorItem,
  type VisitorQuery,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { defineJob } from '../../core/jobs.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { numberParam, raiseAlert, ruleSettings } from '../leakage/engine.ts';
import { registrationOf } from '../setup/service.ts';
import { addMonths } from './check-in.ts';
import type { ReservationDeps } from './service.ts';

// The visitor register (PRD M14-04, M14-05; T-057). Visitors sign in against a checked-in
// stay and out again. A job raises VISITOR_OVERSTAY for a visitor still in during the night:
// from the property's cut-off hour (default 23:00) until the morning. Adding an extra person
// to the stay since the visitor came (T-056) answers the alert before it is raised.

type Item = z.input<typeof VisitorItem>;

/** The night ends here: a visitor seen in the morning hours is still from the night before. */
const NIGHT_ENDS_HOUR = 6;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const ROW = {
  stay: {
    select: {
      reservationId: true,
      guest: { select: { firstName: true, lastName: true } },
      room: { select: { number: true } },
    },
  },
  signedInBy: { select: { name: true } },
} satisfies Prisma.VisitorInclude;

type Row = Prisma.VisitorGetPayload<{ include: typeof ROW }>;

function toItem(v: Row): Item {
  return {
    id: v.id,
    stayId: v.stayId,
    reservationId: v.stay.reservationId,
    guestName: `${v.stay.guest.firstName} ${v.stay.guest.lastName}`,
    roomNumber: v.stay.room?.number ?? null,
    name: v.name,
    phone: v.phone,
    note: v.note,
    idFileId: v.idFileId,
    signedInAt: iso(v.signedInAt),
    signedInBy: v.signedInBy.name,
    signedOutAt: v.signedOutAt ? iso(v.signedOutAt) : null,
  };
}

export async function listVisitors(
  deps: ReservationDeps,
  tenant: TenantContext,
  query: z.output<typeof VisitorQuery>,
) {
  const property = await deps.tenantDb.property.findFirstOrThrow({
    where: { id: tenant.propertyId },
  });
  const date = query.date ?? localDate(deps.clock(), property.timeZone);
  const from = zonedInstant(date, '00:00', property.timeZone);
  const to = zonedInstant(addDays(date, 1), '00:00', property.timeZone);
  const rows = await deps.tenantDb.visitor.findMany({
    where: { OR: [{ signedOutAt: null }, { signedInAt: { gte: from, lt: to } }] },
    include: ROW,
    orderBy: [{ signedInAt: 'desc' }, { id: 'asc' }],
    take: 500,
  });
  // Still in first, then those who have left.
  const data = [...rows.filter((r) => !r.signedOutAt), ...rows.filter((r) => r.signedOutAt)];
  return { date, data: data.map(toItem) };
}

export function signInVisitor(
  deps: ReservationDeps,
  tenant: TenantContext,
  body: z.output<typeof VisitorBody>,
): Promise<Item> {
  return deps.tenantDb.$transaction(async (tx) => {
    const stay = await tx.stay.findUnique({ where: { id: body.stayId } });
    if (!stay) throw new AppError('NOT_FOUND', 'Stay not found');
    if (stay.status !== 'CHECKED_IN') {
      throw new AppError('STATE_TRANSITION_INVALID', 'Visitors sign in to a checked-in guest', {
        status: stay.status,
      });
    }
    let purgeAfter: Date | null = null;
    if (body.idFileId) {
      const file = await tx.fileObject.findFirst({
        where: { id: body.idFileId, entityType: 'Visitor', scan: { not: 'INFECTED' } },
      });
      if (!file) {
        throw new AppError('VALIDATION_ERROR', 'The ID photo cannot be used', {
          issues: [
            {
              path: 'body.idFileId',
              code: 'invalid_file',
              message: 'The file is missing, of another kind, or was blocked',
            },
          ],
        });
      }
      const property = await tx.property.findFirstOrThrow({ where: { id: tenant.propertyId } });
      const today = localDate(deps.clock(), property.timeZone);
      purgeAfter = dbDate(addMonths(today, registrationOf(property).idRetentionMonths));
    }
    const visitor = await tx.visitor.create({
      data: {
        propertyId: stay.propertyId,
        stayId: stay.id,
        name: body.name,
        phone: body.phone,
        note: body.note,
        idFileId: body.idFileId,
        purgeAfter,
        signedInById: tenant.userId,
        signedInAt: deps.clock(),
      },
      include: ROW,
    });
    await recordAudit(tx, {
      action: 'visitor.signed_in',
      entityType: 'visitor',
      entityId: visitor.id,
      after: { stayId: stay.id, name: visitor.name, idPhoto: visitor.idFileId !== null },
    });
    return toItem(visitor);
  });
}

export function signOutVisitor(
  deps: ReservationDeps,
  tenant: TenantContext,
  visitorId: string,
): Promise<Item> {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!before) throw new AppError('NOT_FOUND', 'Visitor not found');
    const now = deps.clock();
    // Guarded: two desks signing the same visitor out cannot both succeed.
    const claimed = await tx.visitor.updateMany({
      where: { id: visitorId, signedOutAt: null },
      data: { signedOutAt: now, signedOutById: tenant.userId },
    });
    if (claimed.count === 0) {
      throw new AppError('STATE_TRANSITION_INVALID', 'This visitor has already left');
    }
    await recordAudit(tx, {
      action: 'visitor.signed_out',
      entityType: 'visitor',
      entityId: visitorId,
      after: { stayId: before.stayId, name: before.name },
    });
    return toItem(await tx.visitor.findUniqueOrThrow({ where: { id: visitorId }, include: ROW }));
  });
}

/** Whether `now` is in the property's night: from the cut-off hour to the morning. */
export function inNight(
  now: Date,
  signedInAt: Date,
  timeZone: string,
  cutoffHour: number,
): boolean {
  if (localDate(signedInAt, timeZone) < localDate(now, timeZone)) return true;
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(now),
  );
  return hour >= cutoffHour || hour < NIGHT_ENDS_HOUR;
}

/** Raises VISITOR_OVERSTAY for every live property's visitors in during the night. */
export async function raiseVisitorAlerts(db: Db, clock: Clock): Promise<number> {
  const now = clock();
  const properties = await db.property.findMany({ where: { status: 'LIVE' } });
  let raised = 0;
  for (const property of properties) {
    const settings = await ruleSettings(db, property.id, 'VISITOR_OVERSTAY');
    if (!settings.enabled) continue;
    const cutoffHour = numberParam(settings, 'cutoffHour');
    const visitors = await db.visitor.findMany({
      where: { propertyId: property.id, signedOutAt: null, stay: { status: 'CHECKED_IN' } },
      include: {
        stay: {
          select: {
            id: true,
            guest: { select: { firstName: true, lastName: true } },
            room: { select: { number: true } },
            reservation: { select: { confirmationNo: true } },
          },
        },
      },
    });
    const due = visitors.filter((v) => inNight(now, v.signedInAt, property.timeZone, cutoffHour));
    if (due.length === 0) continue;
    const date = await businessDate(db, property.id, clock);
    for (const v of due) {
      const added = await db.stayOccupant.count({
        where: { stayId: v.stayId, removedAt: null, addedAt: { gte: v.signedInAt } },
      });
      if (added > 0) continue;
      const id = await raiseAlert(db, {
        propertyId: property.id,
        organisationId: property.organisationId,
        ruleCode: 'VISITOR_OVERSTAY',
        businessDate: date,
        severity: 'HIGH',
        entityType: 'visitor',
        entityId: v.id,
        evidence: {
          visitor: v.name,
          guest: `${v.stay.guest.firstName} ${v.stay.guest.lastName}`,
          room: v.stay.room?.number ?? null,
          reservation: v.stay.reservation.confirmationNo,
          signedInAt: iso(v.signedInAt),
          cutoffHour,
        },
        dedupeKey: `visitor:${v.id}`,
        settings,
      });
      if (id) raised += 1;
    }
  }
  return raised;
}

export const visitorCutoffJob = defineJob({
  name: 'visitor-cutoff',
  schedule: { cron: '*/15 * * * *' },
  async run(_data, { db, clock, logger }) {
    const raised = await raiseVisitorAlerts(db, clock);
    if (raised > 0) logger.info({ raised }, 'Visitor cut-off alerts raised');
  },
});
