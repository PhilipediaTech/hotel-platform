import { localDate } from '@hotel/shared';
import type { Clock } from './clock.ts';
import type { DbClient } from './db.ts';
import type { TenantDb } from './tenant-db.ts';

// Business days (tab 3 business_days; PRD global rule "dates are property-local business
// dates"; T-054). A live property trades on one open business day at a time. Night audit
// (T-073) will close it and open the next; until it exists, the open day rolls over by itself
// once the property's local date has moved on (checked whenever the business date is read).

type Client = DbClient | Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

export interface BusinessDayInfo {
  date: string;
  status: 'OPEN' | 'AUDITING' | 'CLOSED';
  /** Null for a property that is not live yet (it has no business days). */
  openedAt: Date | null;
}

/**
 * The property's current business day. A property not live yet has none: its local date is
 * used. Raw SQL: the same call on every kind of client.
 */
export async function businessDay(
  db: Client,
  propertyId: string,
  clock: Clock,
): Promise<BusinessDayInfo> {
  const rows = await db.$queryRaw<{ time_zone: string; status: string }[]>`
    SELECT time_zone, status FROM properties WHERE id = ${propertyId}::uuid`;
  const property = rows[0];
  if (!property) throw new Error(`Property ${propertyId} not found`);
  const now = clock();
  const today = localDate(now, property.time_zone);
  if (property.status !== 'LIVE') return { date: today, status: 'OPEN', openedAt: null };

  // Interim rollover until night audit: close an open day that is behind, open today's.
  await db.$executeRaw`
    UPDATE business_days SET status = 'CLOSED', closed_at = ${now}
    WHERE property_id = ${propertyId}::uuid AND status = 'OPEN' AND date < ${today}::date`;
  await db.$executeRaw`
    INSERT INTO business_days (property_id, date, status, opened_at)
    SELECT ${propertyId}::uuid, ${today}::date, 'OPEN', ${now}
    WHERE NOT EXISTS (
      SELECT 1 FROM business_days WHERE property_id = ${propertyId}::uuid AND status <> 'CLOSED')
    ON CONFLICT DO NOTHING`;
  const days = await db.$queryRaw<
    { date: Date; status: BusinessDayInfo['status']; opened_at: Date }[]
  >`
    SELECT date, status, opened_at FROM business_days
    WHERE property_id = ${propertyId}::uuid AND status <> 'CLOSED'
    ORDER BY date DESC LIMIT 1`;
  const day = days[0];
  if (!day) return { date: today, status: 'OPEN', openedAt: null };
  return { date: day.date.toISOString().slice(0, 10), status: day.status, openedAt: day.opened_at };
}

/** The property's business date (`YYYY-MM-DD`). */
export async function businessDate(db: Client, propertyId: string, clock: Clock): Promise<string> {
  return (await businessDay(db, propertyId, clock)).date;
}
