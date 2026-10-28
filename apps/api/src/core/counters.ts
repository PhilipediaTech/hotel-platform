import type { DbClient } from './db.ts';
import type { TenantDb } from './tenant-db.ts';

/** The plain client, a transaction, or a tenant-scoped transaction. */
type Client = DbClient | Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

export const COUNTER = {
  CONFIRMATION: 'confirmation',
  FOLIO: 'folio',
  TASK: 'task',
} as const;
export type CounterName = (typeof COUNTER)[keyof typeof COUNTER];

/**
 * Next value of a per-property sequence (1, 2, 3 …). One atomic statement, so concurrent
 * callers never get the same number. Call it with the transaction's `tx` so a rolled-back
 * booking does not consume a number.
 */
export async function nextPropertyCounter(
  db: Client,
  propertyId: string,
  name: CounterName,
): Promise<number> {
  const rows = await db.$queryRaw<{ value: number }[]>`
    INSERT INTO property_counters (property_id, name, value)
    VALUES (${propertyId}::uuid, ${name}, 1)
    ON CONFLICT (property_id, name) DO UPDATE SET value = property_counters.value + 1
    RETURNING value`;
  const row = rows[0];
  if (!row) throw new Error(`Counter ${name} returned no row for property ${propertyId}`);
  return row.value;
}
