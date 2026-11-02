import { localDate } from '@hotel/shared';
import type { Clock } from './clock.ts';
import type { DbClient } from './db.ts';
import { AppError } from './errors.ts';
import type { TenantDb } from './tenant-db.ts';

// Business days (tab 3 business_days; PRD global rule "dates are property-local business
// dates"; T-054, T-073). A live property trades on one open business day at a time. Night
// audit closes it and opens the next (M4 rule 8 step 10); the day does not move with the
// clock. While the audit posts (from step 4 until the day closes) the day is AUDITING and
// postings from the desk wait (409 AUDIT_IN_PROGRESS).

type Client = DbClient | Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

export interface BusinessDayInfo {
  date: string;
  status: 'OPEN' | 'AUDITING' | 'CLOSED';
  /** Null for a property that is not live yet (it has no business days). */
  openedAt: Date | null;
}

/**
 * The property's current business day. A property not live yet has none: its local date is
 * used. A live property without one (just gone live) opens its local date. Raw SQL: the same
 * call on every kind of client.
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

  // The open (or auditing) day; else the last one, which is closed (postings then refused).
  const current = async () => {
    const days = await db.$queryRaw<
      { date: Date; status: BusinessDayInfo['status']; opened_at: Date }[]
    >`
      SELECT date, status, opened_at FROM business_days
      WHERE property_id = ${propertyId}::uuid
      ORDER BY (status <> 'CLOSED') DESC, date DESC LIMIT 1`;
    return days[0];
  };
  let day = await current();
  if (!day) {
    // The first day of a property that has just gone live: its local date.
    await db.$executeRaw`
      INSERT INTO business_days (property_id, date, status, opened_at)
      VALUES (${propertyId}::uuid, ${today}::date, 'OPEN', ${now})
      ON CONFLICT DO NOTHING`;
    day = await current();
  }
  if (!day) return { date: today, status: 'OPEN', openedAt: null };
  return { date: day.date.toISOString().slice(0, 10), status: day.status, openedAt: day.opened_at };
}

/** The property's business date (`YYYY-MM-DD`). */
export async function businessDate(db: Client, propertyId: string, clock: Clock): Promise<string> {
  return (await businessDay(db, propertyId, clock)).date;
}

/**
 * The business date a desk posting or payment goes on; refused while night audit posts
 * (409 AUDIT_IN_PROGRESS, tab 4 POST /folios/{id}/lines).
 */
export async function postingDate(db: Client, propertyId: string, clock: Clock): Promise<string> {
  const day = await businessDay(db, propertyId, clock);
  if (day.status === 'AUDITING') {
    throw new AppError(
      'AUDIT_IN_PROGRESS',
      `Night audit is posting ${day.date}; try again when the day has closed`,
      { businessDate: day.date },
    );
  }
  return day.date;
}
