import type { OwnerFlash, OwnerPropertyCard } from '@hotel/shared';
import type { z } from 'zod';
import { businessDay } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { AuditReports } from '../nightaudit/reports.ts';

// Owner home (PRD M6-11, M4-15; tab 4 row "Owner"; S04; T-091). One card per property where
// the caller holds owner.read: an organisation-wide owner sees every property, a property
// owner theirs. The plain client is used on purpose (the home spans properties); every
// query names the organisation and property it reads.

export interface OwnerDeps {
  db: Db;
  clock: Clock;
}

type Card = z.infer<typeof OwnerPropertyCard>;
type Flash = z.infer<typeof OwnerFlash>;

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const s = (n: bigint) => n.toString();
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

/** Revenue leaves out money moving between ledgers (deposits applied, folio transfers). */
const NOT_REVENUE = ['DEPOSIT', 'TRANSFER'];
const TRANSFER_METHODS = ['BANK_TRANSFER', 'VIRTUAL_ACCOUNT'] as const;

/** The properties of the caller's organisation where they hold `permission`. */
export async function propertiesWith(
  db: Db,
  organisationId: string,
  userId: string,
  permission: string,
): Promise<{ id: string; code: string; name: string; baseCurrency: string; status: string }[]> {
  const memberships = await db.membership.findMany({
    where: {
      userId,
      organisationId,
      active: true,
      role: { permissions: { has: permission } },
    },
    select: { propertyId: true },
  });
  if (memberships.length === 0) return [];
  const orgWide = memberships.some((m) => m.propertyId === null);
  const ids = memberships.flatMap((m) => (m.propertyId ? [m.propertyId] : []));
  return db.property.findMany({
    where: { organisationId, ...(orgWide ? {} : { id: { in: ids } }) },
    select: { id: true, code: true, name: true, baseCurrency: true, status: true },
    orderBy: [{ name: 'asc' }, { code: 'asc' }],
  });
}

/** Rooms that can be sold on `date`: active, not out of order or service, not blocked. */
export async function roomsAvailable(db: Db, propertyId: string, date: string): Promise<number> {
  const on = dbDate(date);
  const [rooms, blocked] = await Promise.all([
    db.room.findMany({ where: { propertyId, active: true }, select: { id: true, hkStatus: true } }),
    db.roomBlock.findMany({
      where: { propertyId, releasedAt: null, startDate: { lte: on }, endDate: { gt: on } },
      select: { roomId: true },
    }),
  ]);
  const out = new Set([
    ...rooms
      .filter((r) => r.hkStatus === 'OUT_OF_ORDER' || r.hkStatus === 'OUT_OF_SERVICE')
      .map((r) => r.id),
    ...blocked.map((b) => b.roomId).filter((id) => rooms.some((r) => r.id === id)),
  ]);
  return rooms.length - out.size;
}

async function revenue(db: Db, propertyId: string, from: string, to: string): Promise<bigint> {
  const lines = await db.folioLine.findMany({
    where: {
      propertyId,
      businessDate: { gte: dbDate(from), lte: dbDate(to) },
      revenueCode: { code: { notIn: NOT_REVENUE } },
    },
    select: { amountMinor: true },
  });
  return sum(lines.map((l) => l.amountMinor));
}

/** The flash report night audit kept for the last closed day (M4-15). */
export async function lastFlash(db: Db, propertyId: string): Promise<Flash | null> {
  const runs = await db.nightAuditRun.findMany({
    where: { propertyId },
    orderBy: { businessDate: 'desc' },
    take: 5,
    select: { businessDate: true, summary: true },
  });
  for (const run of runs) {
    const flash = (run.summary as { reports?: AuditReports } | null)?.reports?.flash;
    if (flash) return flashOf(run.businessDate.toISOString().slice(0, 10), flash);
  }
  return null;
}

export function flashOf(businessDate: string, f: AuditReports['flash']): Flash {
  return {
    businessDate,
    roomsAvailable: f.roomsAvailable,
    roomsSold: f.roomsSold,
    occupancyBps: f.occupancyBps,
    roomRevenueMinor: f.roomRevenueMinor,
    adrMinor: f.adrMinor,
    revparMinor: f.revparMinor,
    paymentsMinor: s(sum(f.paymentsByMethod.map((p) => BigInt(p.amountMinor)))),
  };
}

async function card(
  deps: OwnerDeps,
  p: { id: string; code: string; name: string; baseCurrency: string; status: string },
): Promise<Card> {
  const { db } = deps;
  const today = await businessDay(db, p.id, deps.clock);
  const date = today.date;
  const on = dbDate(date);
  const monthStart = `${date.slice(0, 8)}01`;
  const [available, occupied, todayRevenue, monthRevenue, payments, openAlerts, approvals, flash] =
    await Promise.all([
      roomsAvailable(db, p.id, date),
      db.stay.count({
        where: {
          propertyId: p.id,
          status: 'CHECKED_IN',
          isDayUse: false,
          arrival: { lte: on },
          departure: { gt: on },
        },
      }),
      revenue(db, p.id, date, date),
      revenue(db, p.id, monthStart, date),
      db.payment.findMany({
        where: { propertyId: p.id, businessDate: on },
        select: { method: true, baseAmountMinor: true },
      }),
      db.leakageAlert.count({ where: { propertyId: p.id, status: 'OPEN' } }),
      db.approvalRequest.count({
        where: { propertyId: p.id, status: 'PENDING', expiresAt: { gt: deps.clock() } },
      }),
      lastFlash(db, p.id),
    ]);
  const byMethod = (methods: readonly string[]) =>
    sum(payments.filter((x) => methods.includes(x.method)).map((x) => x.baseAmountMinor));
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    currency: p.baseCurrency,
    status: p.status,
    businessDate: date,
    roomsAvailable: available,
    roomsOccupied: occupied,
    occupancyBps: available > 0 ? Math.round((occupied * 10_000) / available) : 0,
    revenueTodayMinor: s(todayRevenue),
    revenueMonthMinor: s(monthRevenue),
    cashTodayMinor: s(byMethod(['CASH'])),
    transfersTodayMinor: s(byMethod(TRANSFER_METHODS)),
    openAlerts,
    pendingApprovals: approvals,
    lastFlash: flash,
  };
}

export async function ownerHome(
  deps: OwnerDeps,
  tenant: TenantContext,
): Promise<{ properties: Card[] }> {
  const properties = await propertiesWith(
    deps.db,
    tenant.organisationId,
    tenant.userId,
    'owner.read',
  );
  return { properties: await Promise.all(properties.map((p) => card(deps, p))) };
}
