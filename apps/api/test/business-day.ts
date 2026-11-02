import type { Db } from '../src/core/db.ts';

/**
 * Closes the property's open business day and opens `date` (default: the day after), as
 * night audit would (T-073). For tests that need a later business date without running one.
 */
export async function moveBusinessDay(db: Db, propertyId: string, date?: string) {
  const open = await db.businessDay.findFirst({
    where: { propertyId, status: { not: 'CLOSED' } },
  });
  const next =
    date ??
    (open ? new Date(open.date.getTime() + 86_400_000).toISOString().slice(0, 10) : undefined);
  if (!next) throw new Error('No open business day to move from');
  await db.businessDay.updateMany({
    where: { propertyId, status: { not: 'CLOSED' } },
    data: { status: 'CLOSED', closedAt: new Date() },
  });
  await db.businessDay.create({
    data: { propertyId, date: new Date(`${next}T00:00:00Z`), status: 'OPEN' },
  });
}

/**
 * Moves the property's business day forward to the local date of `instant` (Lagos), as if
 * night audit had run every night in between; a day already there is left alone.
 */
export async function catchUpBusinessDay(db: Db, propertyId: string, instant: Date) {
  const local = new Date(instant.getTime() + 3_600_000).toISOString().slice(0, 10);
  const open = await db.businessDay.findFirst({
    where: { propertyId, status: { not: 'CLOSED' } },
  });
  if (open && open.date.toISOString().slice(0, 10) < local) {
    await moveBusinessDay(db, propertyId, local);
  }
}
