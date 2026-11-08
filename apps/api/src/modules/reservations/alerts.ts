import {
  addDays,
  type StayAlert,
  type StayAlertKind,
  type StayAlertSettings,
  zonedInstant,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Property } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate, postingDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import type { DbClient } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { stayAlertsOf } from '../setup/service.ts';
import { FEE_SOURCES, postBookingFee } from './fees.ts';
import type { ReservationDeps } from './service.ts';

// Stay alerts (PRD M14-01; T-055). Worked out from the stays each time they are asked for, so
// they are never stale and need no table: late check-outs, departures due soon, tentative
// holds about to expire and the next business date's arrivals whose deposit has not come in.
// Every query names the property, so the WhatsApp job can call it outside a request.

type Alert = z.input<typeof StayAlert>;
type Settings = z.output<typeof StayAlertSettings>;
type PropertyRow = Pick<Property, 'id' | 'timeZone' | 'checkOutTime' | 'settings'>;

const ORDER: Record<StayAlertKind, number> = {
  LATE_CHECK_OUT: 0,
  DUE_OUT_SOON: 1,
  HOLD_EXPIRING: 2,
  DEPOSIT_MISSING: 3,
};

const MINUTE = 60_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const STAY = {
  guest: { select: { firstName: true, lastName: true } },
  room: { select: { number: true } },
  reservation: { select: { confirmationNo: true, guarantee: true, holdExpiresAt: true } },
  nights: { orderBy: { date: 'asc' }, take: 1, select: { amountMinor: true } },
} as const;

/** When a checked-in stay is due out: the check-out time on its departure date, or its day-use end. */
export function dueOutAt(
  stay: { isDayUse: boolean; dayUseEnd: Date | null; departure: Date },
  property: Pick<Property, 'timeZone' | 'checkOutTime'>,
): Date {
  if (stay.isDayUse && stay.dayUseEnd) return stay.dayUseEnd;
  return zonedInstant(day(stay.departure), property.checkOutTime, property.timeZone);
}

/** Stays of the property with a late check-out fee on their folio, not reversed. */
async function lateFeesPosted(db: DbClient, propertyId: string, stayIds: string[]) {
  if (stayIds.length === 0) return new Set<string>();
  const lines = await db.folioLine.findMany({
    where: {
      propertyId,
      kind: 'CHARGE',
      sourceType: FEE_SOURCES.LATE,
      sourceId: { in: stayIds },
      reversedBy: { is: null },
    },
    select: { sourceId: true },
  });
  return new Set(lines.flatMap((l) => (l.sourceId ? [l.sourceId] : [])));
}

export interface StayAlerts {
  date: string;
  settings: Settings;
  data: Alert[];
}

/** The property's stay alerts now. */
export async function stayAlertsFor(
  db: DbClient,
  property: PropertyRow,
  clock: Clock,
): Promise<StayAlerts> {
  const settings = stayAlertsOf(property);
  const now = clock();
  const date = await businessDate(db, property.id, clock);
  const tomorrow = addDays(date, 1);
  const alerts: Alert[] = [];

  const base = (s: {
    id: string;
    reservationId: string;
    arrival: Date;
    departure: Date;
    version: number;
    guest: { firstName: string; lastName: string };
    room: { number: string } | null;
    reservation: { confirmationNo: string };
  }) => ({
    stayId: s.id,
    reservationId: s.reservationId,
    confirmationNo: s.reservation.confirmationNo,
    guestName: `${s.guest.firstName} ${s.guest.lastName}`,
    roomNumber: s.room?.number ?? null,
    arrival: day(s.arrival),
    departure: day(s.departure),
    depositDueMinor: '0',
    lateFeePosted: false,
    version: s.version,
  });

  // In-house guests leaving by the end of the business date (or already past it).
  const leaving = await db.stay.findMany({
    where: { propertyId: property.id, status: 'CHECKED_IN', departure: { lte: dbDate(date) } },
    include: STAY,
  });
  const dueSoonFrom = now.getTime() + settings.dueOutMinutes * MINUTE;
  const late: typeof leaving = [];
  for (const s of leaving) {
    const at = dueOutAt(s, property);
    if (at.getTime() <= now.getTime()) late.push(s);
    else if (at.getTime() <= dueSoonFrom) {
      alerts.push({ ...base(s), kind: 'DUE_OUT_SOON', at: iso(at) });
    }
  }
  const feed = await lateFeesPosted(
    db,
    property.id,
    late.map((s) => s.id),
  );
  for (const s of late) {
    alerts.push({
      ...base(s),
      kind: 'LATE_CHECK_OUT',
      at: iso(dueOutAt(s, property)),
      lateFeePosted: feed.has(s.id),
    });
  }

  // Tentative holds that let their rooms go soon (the hold-expiry job releases them at expiry).
  const holds = await db.stay.findMany({
    where: {
      propertyId: property.id,
      status: 'TENTATIVE',
      reservation: {
        holdExpiresAt: {
          gt: now,
          lte: new Date(now.getTime() + settings.holdWarningMinutes * MINUTE),
        },
      },
    },
    include: STAY,
  });
  for (const s of holds) {
    const at = s.reservation.holdExpiresAt;
    alerts.push({ ...base(s), kind: 'HOLD_EXPIRING', at: at ? iso(at) : null });
  }

  // The next business date's deposit-guaranteed arrivals whose deposit has not come in.
  const arriving = await db.stay.findMany({
    where: {
      propertyId: property.id,
      arrival: dbDate(tomorrow),
      status: { in: ['TENTATIVE', 'CONFIRMED'] },
      reservation: { guarantee: 'DEPOSIT' },
    },
    include: STAY,
  });
  if (arriving.length > 0) {
    // What each booking owes as deposit: the first night of each of its stays still counting.
    const ids = [...new Set(arriving.map((s) => s.reservationId))];
    const counting = await db.stay.findMany({
      where: {
        propertyId: property.id,
        reservationId: { in: ids },
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
      select: { reservationId: true, nights: { orderBy: { date: 'asc' }, take: 1 } },
    });
    const due = new Map<string, bigint>(ids.map((id) => [id, 0n]));
    for (const st of counting) {
      due.set(
        st.reservationId,
        (due.get(st.reservationId) ?? 0n) + (st.nights[0]?.amountMinor ?? 0n),
      );
    }
    // As payments/deposits.ts depositsCovered, on a client outside a tenant context.
    const received = await db.depositLedgerEntry.groupBy({
      by: ['reservationId'],
      where: { propertyId: property.id, reservationId: { in: ids }, kind: 'RECEIVED' },
      _sum: { amountMinor: true },
    });
    const got = new Map(received.map((r) => [r.reservationId, r._sum.amountMinor ?? 0n]));
    const covered = new Set(ids.filter((id) => (got.get(id) ?? 0n) >= (due.get(id) ?? 0n)));
    for (const s of arriving) {
      if (covered.has(s.reservationId)) continue;
      alerts.push({
        ...base(s),
        kind: 'DEPOSIT_MISSING',
        at: null,
        depositDueMinor: (s.nights[0]?.amountMinor ?? 0n).toString(),
      });
    }
  }

  alerts.sort(
    (a, b) =>
      ORDER[a.kind] - ORDER[b.kind] ||
      (a.at ?? '').localeCompare(b.at ?? '') ||
      a.guestName.localeCompare(b.guestName),
  );
  return { date, settings, data: alerts };
}

/** GET /front-desk/alerts. */
export async function listStayAlerts(deps: ReservationDeps, tenant: TenantContext) {
  const property = await deps.db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
  const { date, settings, data } = await stayAlertsFor(deps.db, property, deps.clock);
  return { date, lateCheckOutFeeMinor: settings.lateCheckOutFeeMinor, data };
}

/** POST /stays/{stayId}/late-check-out-fee: the property's fee, once per stay. */
export async function postLateCheckOutFee(
  deps: ReservationDeps,
  tenant: TenantContext,
  stayId: string,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const stay = await tx.stay.findUnique({ where: { id: stayId } });
    if (!stay) throw new AppError('NOT_FOUND', 'Stay not found');
    // One fee at a time per stay: a second request waits here, then sees the first one's line.
    await tx.$queryRaw`SELECT id FROM stays WHERE id = ${stay.id}::uuid FOR UPDATE`;
    const property = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
    const fee = stayAlertsOf(property).lateCheckOutFeeMinor;
    if (fee === null || BigInt(fee) <= 0n) {
      throw new AppError('STATE_TRANSITION_INVALID', 'This property has no late check-out fee', {
        reason: 'NO_FEE_SET',
      });
    }
    const now = deps.clock();
    if (stay.status !== 'CHECKED_IN' || dueOutAt(stay, property).getTime() > now.getTime()) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'A late check-out fee is for a guest still in after the check-out time',
        { reason: 'NOT_LATE', status: stay.status },
      );
    }
    const posted = await tx.folioLine.findFirst({
      where: {
        kind: 'CHARGE',
        sourceType: FEE_SOURCES.LATE,
        sourceId: stay.id,
        reversedBy: { is: null },
      },
      select: { id: true },
    });
    if (posted) {
      throw new AppError('STATE_TRANSITION_INVALID', 'The late check-out fee is already posted', {
        reason: 'ALREADY_POSTED',
      });
    }
    const date = await postingDate(tx, tenant.propertyId, deps.clock);
    const amountMinor = BigInt(fee);
    const folioId = await postBookingFee(
      { tx, tenant, approvalRequestId: null, now },
      {
        stay,
        code: 'LATE',
        amountMinor,
        description: 'Late check-out fee',
        businessDate: date,
        clock: deps.clock,
      },
    );
    await recordAudit(tx, {
      action: 'stay.late_fee_posted',
      entityType: 'stay',
      entityId: stay.id,
      after: { folioId, amountMinor: amountMinor.toString(), businessDate: date },
    });
    return { folioId, amountMinor: amountMinor.toString() };
  });
}
