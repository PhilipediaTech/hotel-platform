import {
  addDays,
  daysBetween,
  derivedAmount,
  localDate,
  MAX_BULK_DAYS,
  MAX_CALENDAR_DAYS,
  TAX_LINE_GROUPS,
  type CancellationPolicyBody,
  type CancellationPolicyItem,
  type PackageBody,
  type RateCalendarDay,
  type RateCalendarUpdateBody,
  type RatePlanBody,
  type RatePlanItem,
  type RatePlanPatchBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type {
  CancellationPolicy,
  PackageComponent,
  Prisma,
  RateDay,
  RatePlan,
} from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { TenantContext } from '../../core/tenancy.ts';

// Rate plans, the rate calendar, cancellation policies and packages (PRD M2-04–M2-08, M2
// rules 3 and 6; T-033). Derived prices and restrictions use @hotel/shared rates.ts, so the
// calendar, quotes (T-041) and the screen agree.

export interface RateDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type PlanOut = z.input<typeof RatePlanItem>;
type PlanRow = RatePlan & { components: PackageComponent[] };

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const str = (v: bigint | null) => (v === null ? null : v.toString());
const big = (v: string | null | undefined) => (v === null || v === undefined ? null : BigInt(v));

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

async function propertyOf(deps: RateDeps, tenant: TenantContext) {
  return deps.db.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
    select: { id: true, timeZone: true, baseCurrency: true },
  });
}

async function today(deps: RateDeps, tenant: TenantContext): Promise<string> {
  return localDate(deps.clock(), (await propertyOf(deps, tenant)).timeZone);
}

// ── Cancellation policies ──────────────────────────────────────────────────────────────

const policyItem = (p: CancellationPolicy) =>
  ({
    id: p.id,
    name: p.name,
    rules: p.rules,
    noShowFee: p.noShowFee,
  }) as z.input<typeof CancellationPolicyItem>;

export async function listCancellationPolicies(deps: RateDeps) {
  const rows = await deps.tenantDb.cancellationPolicy.findMany({ orderBy: { name: 'asc' } });
  return rows.map(policyItem);
}

export async function createCancellationPolicy(
  deps: RateDeps,
  body: z.output<typeof CancellationPolicyBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    // Longest notice first, so the fee for a cancellation is the first rule that applies.
    const rules = [...body.rules].sort((a, b) => b.daysBefore - a.daysBefore);
    const created = await tx.cancellationPolicy.create({
      // propertyId comes from the tenant client.
      data: {
        name: body.name,
        rules,
        noShowFee: body.noShowFee,
      } as unknown as Prisma.CancellationPolicyUncheckedCreateInput,
    });
    await recordAudit(tx, {
      action: 'cancellationpolicy.created',
      entityType: 'cancellation_policy',
      entityId: created.id,
      after: { name: created.name, rules, noShowFee: body.noShowFee },
    });
    return policyItem(created);
  });
}

// ── Rate plans ─────────────────────────────────────────────────────────────────────────

function planItem(p: PlanRow): PlanOut {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    kind: p.kind,
    parentRatePlanId: p.parentRatePlanId,
    derivationBps: p.derivationBps,
    derivationAmountMinor: str(p.derivationAmountMinor),
    roundingMinor: p.roundingMinor.toString(),
    floorMinor: str(p.floorMinor),
    mealPlan: p.mealPlan as PlanOut['mealPlan'],
    cancellationPolicyId: p.cancellationPolicyId,
    guarantee: p.guarantee,
    currency: p.currency,
    isPublic: p.isPublic,
    dayUseMaxMinutes: p.dayUseMaxMinutes,
    roomTypeIds: p.roomTypeIds,
    active: p.active,
    version: p.version,
    components: p.components.map((c) => ({
      id: c.id,
      name: c.name,
      revenueCodeId: c.revenueCodeId,
      amountMinor: c.amountMinor.toString(),
      perPerson: c.perPerson,
    })),
  };
}

const withComponents = { components: { orderBy: { name: 'asc' as const } } };

export async function listRatePlans(deps: RateDeps, kind?: 'PACKAGE'): Promise<PlanOut[]> {
  const plans = await deps.tenantDb.ratePlan.findMany({
    where: kind ? { kind } : {},
    include: withComponents,
    orderBy: [{ kind: 'asc' }, { code: 'asc' }],
  });
  return plans.map(planItem);
}

interface PlanShape {
  kind: RatePlan['kind'];
  parentRatePlanId: string | null;
  derivationBps: number | null;
  derivationAmountMinor: string | null;
  dayUseMaxMinutes: number | null;
  cancellationPolicyId: string;
  roomTypeIds: string[];
}

/** The plan's references belong to this property and its fields fit its kind. */
async function checkPlan(tx: Tx, plan: PlanShape, selfId: string | null): Promise<void> {
  if (plan.kind === 'NEGOTIATED') {
    throw invalid('kind', 'Negotiated rates arrive with companies (V1.1)');
  }
  const derives = plan.derivationBps !== null || plan.derivationAmountMinor !== null;
  if (plan.kind === 'BAR' && (plan.parentRatePlanId || derives)) {
    throw invalid('parentRatePlanId', 'A BAR plan sets its own prices');
  }
  if (plan.kind === 'DERIVED' && (!plan.parentRatePlanId || !derives)) {
    throw invalid('derivationBps', 'A derived plan needs a parent and a percentage or amount');
  }
  if (derives && !plan.parentRatePlanId) {
    throw invalid('parentRatePlanId', 'Choose the BAR plan to derive from');
  }
  if (plan.parentRatePlanId) {
    const parent = await tx.ratePlan.findUnique({ where: { id: plan.parentRatePlanId } });
    if (!parent || parent.kind !== 'BAR' || parent.id === selfId) {
      throw invalid('parentRatePlanId', 'Choose a BAR plan of this property');
    }
  }
  if ((plan.kind === 'DAY_USE') !== (plan.dayUseMaxMinutes !== null)) {
    throw invalid(
      'dayUseMaxMinutes',
      plan.kind === 'DAY_USE' ? 'Set the longest day-use stay' : 'Only day-use plans have this',
    );
  }
  if (!(await tx.cancellationPolicy.findUnique({ where: { id: plan.cancellationPolicyId } }))) {
    throw invalid('cancellationPolicyId', 'Choose a cancellation policy of this property');
  }
  if (plan.roomTypeIds.length > 0) {
    const found = await tx.roomType.count({ where: { id: { in: plan.roomTypeIds } } });
    if (found !== plan.roomTypeIds.length) {
      throw invalid('roomTypeIds', 'Choose room types of this property');
    }
  }
}

const auditPlan = (p: RatePlan) => ({
  // `code` is a secret key name in audit rows (MFA codes), so it is spelled out.
  planCode: p.code,
  name: p.name,
  kind: p.kind,
  parentRatePlanId: p.parentRatePlanId,
  derivationBps: p.derivationBps,
  derivationAmountMinor: str(p.derivationAmountMinor),
  roundingMinor: p.roundingMinor.toString(),
  floorMinor: str(p.floorMinor),
  mealPlan: p.mealPlan,
  cancellationPolicyId: p.cancellationPolicyId,
  guarantee: p.guarantee,
  isPublic: p.isPublic,
  dayUseMaxMinutes: p.dayUseMaxMinutes,
  roomTypeIds: p.roomTypeIds,
  active: p.active,
});

export async function createRatePlan(
  deps: RateDeps,
  tenant: TenantContext,
  body: z.output<typeof RatePlanBody>,
): Promise<PlanOut> {
  const property = await propertyOf(deps, tenant);
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      await checkPlan(tx, body, null);
      const created = await tx.ratePlan.create({
        data: {
          ...body,
          derivationAmountMinor: big(body.derivationAmountMinor),
          roundingMinor: BigInt(body.roundingMinor),
          floorMinor: big(body.floorMinor),
          currency: property.baseCurrency,
        } as Prisma.RatePlanUncheckedCreateInput,
        include: withComponents,
      });
      await recordAudit(tx, {
        action: 'rateplan.created',
        entityType: 'rate_plan',
        entityId: created.id,
        after: auditPlan(created),
      });
      return planItem(created);
    });
  } catch (err) {
    const info = pgErrorInfo(err);
    if (info?.sqlState === '23505' && info.constraint === 'rate_plans_property_id_code_key') {
      throw invalid('code', 'Another rate plan uses this code');
    }
    throw err;
  }
}

/** `If-Match: "3"` (or `W/"3"`) → 3. */
function versionFrom(ifMatch: string): number | null {
  const m = /^(?:W\/)?"(\d+)"$/.exec(ifMatch.trim());
  return m ? Number(m[1]) : null;
}

export async function updateRatePlan(
  deps: RateDeps,
  ratePlanId: string,
  ifMatch: string,
  body: z.output<typeof RatePlanPatchBody>,
): Promise<PlanOut> {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.ratePlan.findUnique({ where: { id: ratePlanId } });
    if (!before) throw new AppError('NOT_FOUND', 'Rate plan not found');
    if (versionFrom(ifMatch) !== before.version) {
      throw new AppError('VERSION_CONFLICT', 'Someone changed this plan; reload and try again', {
        version: before.version,
      });
    }
    await checkPlan(
      tx,
      {
        kind: before.kind,
        parentRatePlanId: before.parentRatePlanId,
        derivationBps: body.derivationBps !== undefined ? body.derivationBps : before.derivationBps,
        derivationAmountMinor:
          body.derivationAmountMinor !== undefined
            ? body.derivationAmountMinor
            : str(before.derivationAmountMinor),
        dayUseMaxMinutes:
          body.dayUseMaxMinutes !== undefined ? body.dayUseMaxMinutes : before.dayUseMaxMinutes,
        cancellationPolicyId: body.cancellationPolicyId ?? before.cancellationPolicyId,
        roomTypeIds: body.roomTypeIds ?? before.roomTypeIds,
      },
      before.id,
    );
    if (body.active === false && before.active && before.kind === 'BAR') {
      const children = await tx.ratePlan.count({
        where: { parentRatePlanId: before.id, active: true },
      });
      if (children > 0) {
        throw new AppError(
          'STATE_TRANSITION_INVALID',
          'Deactivate the plans that follow this one first',
          { activeChildren: children },
        );
      }
    }
    const { derivationAmountMinor, roundingMinor, floorMinor, ...rest } = body;
    const claimed = await tx.ratePlan.updateMany({
      where: { id: before.id, version: before.version },
      data: {
        ...rest,
        ...(derivationAmountMinor !== undefined
          ? { derivationAmountMinor: big(derivationAmountMinor) }
          : {}),
        ...(roundingMinor !== undefined ? { roundingMinor: BigInt(roundingMinor) } : {}),
        ...(floorMinor !== undefined ? { floorMinor: big(floorMinor) } : {}),
        version: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      throw new AppError('VERSION_CONFLICT', 'Someone changed this plan; reload and try again');
    }
    const after = await tx.ratePlan.findUniqueOrThrow({
      where: { id: before.id },
      include: withComponents,
    });
    const was = auditPlan(before);
    const now = auditPlan(after);
    const changed = (Object.keys(now) as (keyof typeof now)[]).filter(
      (k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]),
    );
    if (changed.length > 0) {
      await recordAudit(tx, {
        action: 'rateplan.updated',
        entityType: 'rate_plan',
        entityId: before.id,
        before: Object.fromEntries(changed.map((k) => [k, was[k]])),
        after: Object.fromEntries(changed.map((k) => [k, now[k]])),
      });
    }
    return planItem(after);
  });
}

// ── Calendar ───────────────────────────────────────────────────────────────────────────

/** Room types a plan sells: its list, or every active type of the property. */
async function planRoomTypes(db: TenantDb | Tx, plan: RatePlan): Promise<string[]> {
  const types = await db.roomType.findMany({
    where: plan.roomTypeIds.length > 0 ? { id: { in: plan.roomTypeIds } } : { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true },
  });
  return types.map((t) => t.id);
}

const key = (roomTypeId: string, date: string) => `${roomTypeId}|${date}`;

export async function getRateCalendar(
  deps: RateDeps,
  query: { ratePlanId: string; from: string; to: string },
) {
  const span = daysBetween(query.from, query.to) + 1;
  if (span < 1 || span > MAX_CALENDAR_DAYS) {
    throw new AppError('VALIDATION_ERROR', `Ask for 1 to ${MAX_CALENDAR_DAYS} days`, {
      issues: [{ path: 'query.to', code: 'custom', message: `1 to ${MAX_CALENDAR_DAYS} days` }],
    });
  }
  const plan = await deps.tenantDb.ratePlan.findUnique({ where: { id: query.ratePlanId } });
  if (!plan) throw new AppError('NOT_FOUND', 'Rate plan not found');
  const roomTypeIds = await planRoomTypes(deps.tenantDb, plan);
  const range = { gte: dbDate(query.from), lte: dbDate(query.to) };
  const own = await deps.tenantDb.rateDay.findMany({
    where: { ratePlanId: plan.id, date: range },
  });
  const parentDays = plan.parentRatePlanId
    ? await deps.tenantDb.rateDay.findMany({
        where: { ratePlanId: plan.parentRatePlanId, date: range },
      })
    : [];
  const ownBy = new Map(own.map((d) => [key(d.roomTypeId, day(d.date)), d]));
  const parentBy = new Map(parentDays.map((d) => [key(d.roomTypeId, day(d.date)), d]));

  const days: z.input<typeof RateCalendarDay>[] = [];
  for (const roomTypeId of roomTypeIds) {
    for (let i = 0; i < span; i++) {
      const date = addDays(query.from, i);
      const row = ownBy.get(key(roomTypeId, date));
      days.push({
        roomTypeId,
        date,
        amountMinor: str(sellingPrice(plan, row, parentBy.get(key(roomTypeId, date)))),
        ownAmountMinor: str(row?.amountMinor ?? null),
        minStay: row?.minStay ?? null,
        maxStay: row?.maxStay ?? null,
        closedToArrival: row?.closedToArrival ?? false,
        closedToDeparture: row?.closedToDeparture ?? false,
        stopSell: row?.stopSell ?? false,
        ruleVersion: row?.ruleVersion ?? null,
      });
    }
  }
  return { ratePlanId: plan.id, days };
}

/**
 * The price a plan sells at on one day: its own price when set (never on DERIVED plans),
 * else the parent's price put through the derivation (M2 rule 3).
 */
export function sellingPrice(
  plan: RatePlan,
  own: RateDay | undefined,
  parent: RateDay | undefined,
): bigint | null {
  const ownAmount = own?.amountMinor ?? null;
  if (plan.kind !== 'DERIVED' && ownAmount !== null) return ownAmount;
  const parentAmount = parent?.amountMinor ?? null;
  if (!plan.parentRatePlanId || parentAmount === null) return null;
  return derivedAmount(parentAmount, {
    derivationBps: plan.derivationBps,
    derivationAmountMinor: plan.derivationAmountMinor,
    roundingMinor: plan.roundingMinor,
    floorMinor: plan.floorMinor,
  });
}

export async function updateRateCalendar(
  deps: RateDeps,
  tenant: TenantContext,
  body: z.output<typeof RateCalendarUpdateBody>,
) {
  const now = await today(deps, tenant);
  if (body.from < now) throw invalid('from', 'Prices and restrictions change from today on');
  if (daysBetween(body.from, body.to) + 1 > MAX_BULK_DAYS) {
    throw invalid('to', `Change at most ${MAX_BULK_DAYS} days at once`);
  }
  return deps.tenantDb
    .$transaction(async (tx) => {
      const plan = await tx.ratePlan.findUnique({ where: { id: body.ratePlanId } });
      if (!plan?.active) throw invalid('ratePlanId', 'Choose an active rate plan of this property');
      if (plan.kind === 'DERIVED' && body.set.amountMinor !== undefined) {
        throw invalid('set.amountMinor', 'A derived plan follows its parent’s prices');
      }
      const allowed = new Set(await planRoomTypes(tx, plan));
      if (body.roomTypeIds.some((id) => !allowed.has(id))) {
        throw invalid('roomTypeIds', 'Choose room types this plan sells');
      }
      const s = body.set;
      const has = (field: keyof typeof s) => s[field] !== undefined;
      // One statement for the whole range: new days are inserted, existing days change only the
      // fields in `set`, and only days whose values really change get a new rule version.
      const changedDays = await tx.$executeRaw`
      INSERT INTO rate_days AS r (property_id, rate_plan_id, room_type_id, date, amount_minor,
        min_stay, max_stay, closed_to_arrival, closed_to_departure, stop_sell, rule_version, updated_at)
      SELECT ${tenant.propertyId}::uuid, ${plan.id}::uuid, rt, d::date,
        ${big(s.amountMinor)}::bigint, ${s.minStay ?? null}::int, ${s.maxStay ?? null}::int,
        ${s.closedToArrival ?? false}, ${s.closedToDeparture ?? false}, ${s.stopSell ?? false},
        1, now()
      FROM unnest(${body.roomTypeIds}::uuid[]) AS rt,
        generate_series(${body.from}::date, ${body.to}::date, interval '1 day') AS d
      WHERE extract(isodow FROM d)::int = ANY(${body.weekdays}::int[])
      ON CONFLICT (rate_plan_id, room_type_id, date) DO UPDATE SET
        amount_minor = CASE WHEN ${has('amountMinor')} THEN EXCLUDED.amount_minor ELSE r.amount_minor END,
        min_stay = CASE WHEN ${has('minStay')} THEN EXCLUDED.min_stay ELSE r.min_stay END,
        max_stay = CASE WHEN ${has('maxStay')} THEN EXCLUDED.max_stay ELSE r.max_stay END,
        closed_to_arrival = CASE WHEN ${has('closedToArrival')} THEN EXCLUDED.closed_to_arrival ELSE r.closed_to_arrival END,
        closed_to_departure = CASE WHEN ${has('closedToDeparture')} THEN EXCLUDED.closed_to_departure ELSE r.closed_to_departure END,
        stop_sell = CASE WHEN ${has('stopSell')} THEN EXCLUDED.stop_sell ELSE r.stop_sell END,
        rule_version = r.rule_version + 1,
        updated_at = now()
      WHERE (
        CASE WHEN ${has('amountMinor')} THEN EXCLUDED.amount_minor ELSE r.amount_minor END,
        CASE WHEN ${has('minStay')} THEN EXCLUDED.min_stay ELSE r.min_stay END,
        CASE WHEN ${has('maxStay')} THEN EXCLUDED.max_stay ELSE r.max_stay END,
        CASE WHEN ${has('closedToArrival')} THEN EXCLUDED.closed_to_arrival ELSE r.closed_to_arrival END,
        CASE WHEN ${has('closedToDeparture')} THEN EXCLUDED.closed_to_departure ELSE r.closed_to_departure END,
        CASE WHEN ${has('stopSell')} THEN EXCLUDED.stop_sell ELSE r.stop_sell END
      ) IS DISTINCT FROM (r.amount_minor, r.min_stay, r.max_stay, r.closed_to_arrival,
        r.closed_to_departure, r.stop_sell)`;
      if (changedDays > 0) {
        await recordAudit(tx, {
          action: 'rates.updated',
          entityType: 'rate_plan',
          entityId: plan.id,
          after: {
            roomTypeIds: body.roomTypeIds,
            from: body.from,
            to: body.to,
            weekdays: body.weekdays,
            set: { ...s, ...(s.amountMinor !== undefined ? { amountMinor: s.amountMinor } : {}) },
            changedDays,
          },
        });
      }
      return { changedDays };
    })
    .catch((err: unknown) => {
      // A max stay below an existing min stay (or the reverse) on some day.
      if (pgErrorInfo(err)?.constraint === 'rate_days_stay_check') {
        throw invalid('set.maxStay', 'On some days the maximum stay would be below the minimum');
      }
      throw err;
    });
}

// ── Packages ───────────────────────────────────────────────────────────────────────────

export async function setPackageComponents(deps: RateDeps, body: z.output<typeof PackageBody>) {
  return deps.tenantDb.$transaction(async (tx) => {
    const plan = await tx.ratePlan.findUnique({
      where: { id: body.ratePlanId },
      include: withComponents,
    });
    if (plan?.kind !== 'PACKAGE') throw invalid('ratePlanId', 'Choose a package plan');
    const codeIds = [...new Set(body.components.map((c) => c.revenueCodeId))];
    const codes = await tx.revenueCode.findMany({ where: { id: { in: codeIds }, active: true } });
    if (
      codes.length !== codeIds.length ||
      codes.some((c) => (TAX_LINE_GROUPS as readonly string[]).includes(c.group))
    ) {
      throw invalid('components', 'Post components to active income codes of this property');
    }
    // Components are reached through their (scoped) plan.
    const after = await tx.ratePlan.update({
      where: { id: plan.id },
      data: {
        version: { increment: 1 },
        components: {
          deleteMany: {},
          create: body.components.map((c) => ({ ...c, amountMinor: BigInt(c.amountMinor) })),
        },
      },
      include: withComponents,
    });
    await recordAudit(tx, {
      action: 'package.updated',
      entityType: 'rate_plan',
      entityId: plan.id,
      before: { components: planItem(plan).components.map(({ id: _id, ...c }) => c) },
      after: { components: planItem(after).components.map(({ id: _id, ...c }) => c) },
    });
    return planItem(after);
  });
}
