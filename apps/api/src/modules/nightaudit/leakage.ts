import type { TenantDb } from '../../core/tenant-db.ts';
import { requireTenant } from '../../core/tenancy.ts';
import { amountParam, numberParam, raiseAlert, ruleSettings } from '../leakage/engine.ts';

// Leakage rules at night audit (step 8; PRD M6-07 "I run leakage rules continuously and at
// night audit and raise alerts with evidence"; T-073b, T-090). Each rule looks at the audited
// day and raises at most one alert per subject (the dedupe key), so a rerun raises nothing new.
// The rules' settings (on or off, thresholds) come from `leakage_rules` (S22).

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);
const abs = (n: bigint) => (n < 0n ? -n : n);

/**
 * Core rule "void/reversal pattern": more than 3 charge reversals, or more than ₦50,000 of
 * them, per user per shift on the day (thresholds per property). Answers how many were new.
 */
export async function reversalPattern(tx: Tx, date: string): Promise<number> {
  const { propertyId } = requireTenant();
  const settings = await ruleSettings(tx, propertyId, 'REVERSAL_PATTERN');
  if (!settings.enabled) return 0;
  const maxCount = numberParam(settings, 'maxCount');
  const maxAmount = amountParam(settings, 'maxAmountMinor');
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
    if (lines.length <= maxCount && total <= maxAmount) continue;
    const [userId = '', shiftId] = key.split(':');
    const onShift = shiftId !== undefined && shiftId !== 'no-shift';
    const id = await raiseAlert(tx, {
      propertyId,
      settings,
      ruleCode: 'REVERSAL_PATTERN',
      businessDate: date,
      severity: lines.length > maxCount * 2 || total > maxAmount * 2n ? 'HIGH' : 'NORMAL',
      entityType: onShift ? 'cashier_shift' : 'user',
      entityId: onShift ? shiftId : userId,
      subjectUserId: userId,
      evidence: {
        reversals: lines.length,
        totalMinor: total.toString(),
        lineIds: lines.map((l) => l.id),
        folioIds: [...new Set(lines.map((l) => l.folioId))],
        limits: { count: maxCount, amountMinor: maxAmount.toString() },
      },
      dedupeKey: `REVERSAL_PATTERN:${date}:${key}`,
    });
    if (id) raised += 1;
  }
  return raised;
}

/**
 * Core rule "rate override": a room night posted on the day below its rate plan's floor,
 * with no approved `rate.below_floor` request for the stay. Answers how many were new.
 */
export async function rateOverride(tx: Tx, date: string): Promise<number> {
  const { propertyId } = requireTenant();
  const settings = await ruleSettings(tx, propertyId, 'RATE_OVERRIDE');
  if (!settings.enabled) return 0;
  const postings = await tx.roomChargePosting.findMany({
    where: { businessDate: dbDate(date) },
    include: {
      folioLine: { select: { id: true, approvalRequestId: true, folioId: true } },
      stay: {
        include: {
          // Nights have no property column: read through the (scoped) stay.
          nights: true,
          room: { select: { number: true } },
          reservation: { select: { confirmationNo: true, createdById: true } },
        },
      },
    },
  });
  const planIds = [...new Set(postings.flatMap((p) => p.stay.nights.map((n) => n.ratePlanId)))];
  const plans = new Map(
    (
      await tx.ratePlan.findMany({
        where: { id: { in: planIds }, floorMinor: { not: null } },
        select: { id: true, code: true, floorMinor: true },
      })
    ).map((p) => [p.id, p]),
  );
  let raised = 0;
  for (const p of postings) {
    const night = p.stay.nights.find((n) => day(n.date) === day(p.night));
    const plan = night ? plans.get(night.ratePlanId) : undefined;
    if (!night || !plan?.floorMinor || night.amountMinor >= plan.floorMinor) continue;
    if (p.folioLine.approvalRequestId) continue;
    const approved = await tx.approvalRequest.findFirst({
      where: {
        action: 'rate.below_floor',
        status: { in: ['APPROVED', 'EXECUTED'] },
        payload: { path: ['stayId'], equals: p.stayId },
      },
      select: { id: true },
    });
    if (approved) continue;
    const nightDate = day(p.night);
    const id = await raiseAlert(tx, {
      propertyId,
      settings,
      ruleCode: 'RATE_OVERRIDE',
      businessDate: date,
      severity: night.amountMinor * 2n < plan.floorMinor ? 'HIGH' : 'NORMAL',
      entityType: 'stay',
      entityId: p.stayId,
      subjectUserId: p.stay.reservation.createdById,
      evidence: {
        room: p.stay.room?.number ?? null,
        reservation: p.stay.reservation.confirmationNo,
        night: nightDate,
        ratePlan: plan.code,
        amountMinor: night.amountMinor.toString(),
        floorMinor: plan.floorMinor.toString(),
        folioId: p.folioLine.folioId,
        lineId: p.folioLine.id,
      },
      dedupeKey: `RATE_OVERRIDE:${p.stayId}:${nightDate}`,
      event: { stayId: p.stayId },
    });
    if (id) raised += 1;
  }
  return raised;
}
