import type { Prisma } from '../../generated/prisma/client.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Leakage rules at night audit (step 8; PRD M6 "I run leakage rules continuously and at night
// audit and raise alerts with evidence", core rule "void/reversal pattern"; T-073b). Each rule
// looks at the audited day and raises at most one alert per subject (the dedupe key), so a
// rerun raises nothing new. The rules engine, its settings and the other core rules are T-090.

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

/** Core rule "void/reversal pattern": more than 3 reversals, or more than ₦50,000, per user per shift. */
export const REVERSAL_LIMITS = { count: 3, amountMinor: 5_000_000n };

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const abs = (n: bigint) => (n < 0n ? -n : n);

/** Raises the day's reversal-pattern alerts; answers how many were new. */
export async function reversalPattern(tx: Tx, date: string): Promise<number> {
  // Reversals of charges (their tax reversals go with them) posted on the day.
  const reversals = await tx.folioLine.findMany({
    where: {
      businessDate: dbDate(date),
      kind: 'REVERSAL',
      reverses: { kind: 'CHARGE' },
    },
    select: { id: true, amountMinor: true, postedById: true, shiftId: true, folioId: true },
  });
  const groups = new Map<string, typeof reversals>();
  for (const r of reversals) {
    if (!r.postedById) continue;
    const key = `${r.postedById}:${r.shiftId ?? 'no-shift'}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  let raised = 0;
  for (const [key, lines] of groups) {
    const total = lines.reduce((sum, l) => sum + abs(l.amountMinor), 0n);
    if (lines.length <= REVERSAL_LIMITS.count && total <= REVERSAL_LIMITS.amountMinor) continue;
    const [userId = '', shiftId] = key.split(':');
    const dedupeKey = `REVERSAL_PATTERN:${date}:${key}`;
    const exists = await tx.leakageAlert.findFirst({ where: { dedupeKey } });
    if (exists) continue;
    const alert = await tx.leakageAlert.create({
      data: {
        ruleCode: 'REVERSAL_PATTERN',
        businessDate: dbDate(date),
        severity:
          lines.length > REVERSAL_LIMITS.count * 2 || total > REVERSAL_LIMITS.amountMinor * 2n
            ? 'HIGH'
            : 'NORMAL',
        entityType: shiftId && shiftId !== 'no-shift' ? 'cashier_shift' : 'user',
        entityId: shiftId && shiftId !== 'no-shift' ? shiftId : userId,
        subjectUserId: userId,
        evidence: {
          reversals: lines.length,
          totalMinor: total.toString(),
          lineIds: lines.map((l) => l.id),
          folioIds: [...new Set(lines.map((l) => l.folioId))],
          limits: {
            count: REVERSAL_LIMITS.count,
            amountMinor: REVERSAL_LIMITS.amountMinor.toString(),
          },
        },
        dedupeKey,
      } as unknown as Prisma.LeakageAlertUncheckedCreateInput, // tenant IDs come from the client
    });
    await recordEvent(tx, {
      type: 'leakage.alert_raised',
      payload: { alertId: alert.id, ruleCode: 'REVERSAL_PATTERN' },
    });
    raised += 1;
  }
  return raised;
}
