import {
  daysBetween,
  localDate,
  MAX_BULK_DAYS,
  type GroupRateChangeBody,
  type GroupRateChangeResult,
} from '@hotel/shared';
import type { z } from 'zod';
import { recordAudit } from '../../core/audit.ts';
import type { Db } from '../../core/db.ts';
import { pgErrorInfo } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { withoutTenant, type TenantContext } from '../../core/tenancy.ts';
import { propertiesWith } from '../reports/group.ts';
import { writeRateDays, type RateDeps } from './service.ts';

// Rate changes across properties (PRD M2-13 "As a group revenue manager, I push rate changes to
// several properties at once"; T-162). One rate plan, named by its code (BAR, say), in each
// chosen property: its prices moved by a share or an amount, or set to one price, and its
// restrictions set, over a date range and weekdays. Every property is checked before anything
// is written; any problem refuses the whole change, naming each one. Then every property
// changes in one transaction, so the group never ends up half changed. The same days and
// rules as the property's own calendar edit (T-041): from the property's today, at most a
// year, a derived plan follows its parent's prices.

type Body = z.output<typeof GroupRateChangeBody>;
type Out = z.input<typeof GroupRateChangeResult>;
type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

/** Thrown inside the transaction to roll back a dry run once it has counted. */
class DryRun extends Error {
  readonly result: Out;
  constructor(result: Out) {
    super('dry run');
    this.result = result;
  }
}

interface Target {
  propertyId: string;
  index: number;
  name: string;
  currency: string;
  organisationId: string;
  planId: string;
  roomTypeIds: string[];
  roomTypeCodes: string[];
}

const issue = (index: number, message: string) => ({
  path: `body.propertyIds.${index}`,
  code: 'custom',
  message,
});

/** Checks every property and finds its plan and room types; refuses with each problem. */
async function targetsOf(deps: RateDeps, tenant: TenantContext, body: Body): Promise<Target[]> {
  const allowed = new Map(
    (await propertiesWith(deps, tenant, 'rate.group.manage')).map((p) => [p.id, p]),
  );
  const issues: ReturnType<typeof issue>[] = [];
  const targets: Target[] = [];
  const now = deps.clock();
  for (const [index, propertyId] of body.propertyIds.entries()) {
    const p = allowed.get(propertyId);
    if (!p) {
      issues.push(issue(index, 'You can’t change group rates in this property'));
      continue;
    }
    const today = localDate(now, p.timeZone);
    if (body.from < today) {
      issues.push(issue(index, `${p.name}: prices and restrictions change from ${today} on`));
      continue;
    }
    const plan = await deps.db.ratePlan.findFirst({
      where: { propertyId, code: body.ratePlanCode, active: true },
    });
    if (!plan) {
      issues.push(issue(index, `${p.name} has no active rate plan ${body.ratePlanCode}`));
      continue;
    }
    if (plan.kind === 'DERIVED' && body.price) {
      issues.push(issue(index, `${p.name}: ${plan.code} follows its parent’s prices`));
      continue;
    }
    const sells = await deps.db.roomType.findMany({
      where: {
        propertyId,
        ...(plan.roomTypeIds.length > 0 ? { id: { in: plan.roomTypeIds } } : { active: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, code: true },
    });
    const chosen = body.roomTypeCodes
      ? sells.filter((t) => body.roomTypeCodes?.includes(t.code))
      : sells;
    const missing = (body.roomTypeCodes ?? []).filter((c) => !sells.some((t) => t.code === c));
    if (missing.length > 0) {
      issues.push(
        issue(index, `${p.name}: ${plan.code} doesn’t sell room type ${missing.join(', ')}`),
      );
      continue;
    }
    targets.push({
      propertyId,
      index,
      name: p.name,
      currency: p.baseCurrency,
      organisationId: p.organisationId,
      planId: plan.id,
      roomTypeIds: chosen.map((t) => t.id),
      roomTypeCodes: chosen.map((t) => t.code),
    });
  }
  if (issues.length === 0 && body.price?.mode === 'SET') {
    const currencies = new Set(targets.map((t) => t.currency));
    if (currencies.size > 1) {
      issues.push({
        path: 'body.price',
        code: 'custom',
        message: 'One price for all needs properties in one currency: use a percentage instead',
      });
    }
  }
  if (issues.length > 0) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed.', { issues });
  }
  return targets;
}

/** Moves each day's own price by a share or an amount; days without a price stay so. */
function adjustPrices(tx: Tx, t: Target, body: Body, price: NonNullable<Body['price']>) {
  const percent = price.mode === 'PERCENT' ? price.bps : 0;
  const delta = price.mode === 'AMOUNT' ? BigInt(price.amountMinor) : 0n;
  return tx.$executeRaw`
    UPDATE rate_days AS r SET
      amount_minor = n.amount, rule_version = r.rule_version + 1, updated_at = now()
    FROM (
      SELECT rate_plan_id, room_type_id, date, GREATEST(0,
        CASE WHEN ${price.mode === 'PERCENT'}
          THEN round(amount_minor * (10000 + ${percent}::int) / 10000.0)::bigint
          ELSE amount_minor + ${delta}::bigint END) AS amount
      FROM rate_days
      WHERE property_id = ${t.propertyId}::uuid AND rate_plan_id = ${t.planId}::uuid
        AND room_type_id = ANY(${t.roomTypeIds}::uuid[])
        AND date BETWEEN ${body.from}::date AND ${body.to}::date
        AND extract(isodow FROM date)::int = ANY(${body.weekdays}::int[])
        AND amount_minor IS NOT NULL
    ) AS n
    WHERE r.rate_plan_id = n.rate_plan_id AND r.room_type_id = n.room_type_id
      AND r.date = n.date AND r.amount_minor IS DISTINCT FROM n.amount`;
}

/** Room-type days of the plan this transaction changed (now() is the transaction's start). */
async function changedIn(tx: Tx, t: Target, body: Body): Promise<number> {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM rate_days
    WHERE property_id = ${t.propertyId}::uuid AND rate_plan_id = ${t.planId}::uuid
      AND date BETWEEN ${body.from}::date AND ${body.to}::date AND updated_at = now()`;
  return Number(row?.n ?? 0n);
}

export async function changeGroupRates(
  deps: RateDeps,
  tenant: TenantContext,
  body: Body,
): Promise<Out> {
  if (daysBetween(body.from, body.to) + 1 > MAX_BULK_DAYS) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed.', {
      issues: [
        {
          path: 'body.to',
          code: 'custom',
          message: `Change at most ${MAX_BULK_DAYS} days at once`,
        },
      ],
    });
  }
  // Other properties than this request's: read outside its row-level security, each query
  // naming a property the caller holds rate.group.manage for.
  const targets = await withoutTenant(() => targetsOf(deps, tenant, body));
  const restrictions = body.restrictions ?? {};
  const set = {
    ...restrictions,
    ...(body.price?.mode === 'SET' ? { amountMinor: body.price.amountMinor } : {}),
  };
  // Several properties in one transaction: outside this request's property (row-level security
  // would allow only it), each write naming its own property.
  try {
    return await withoutTenant(() =>
      deps.db.$transaction(async (tx) => {
        const properties: Out['properties'] = [];
        for (const t of targets) {
          if (Object.keys(set).length > 0) {
            await writeRateDays(tx as never, t.propertyId, t.planId, {
              roomTypeIds: t.roomTypeIds,
              from: body.from,
              to: body.to,
              weekdays: body.weekdays,
              set,
            });
          }
          if (body.price && body.price.mode !== 'SET') {
            await adjustPrices(tx, t, body, body.price);
          }
          const changedDays = await changedIn(tx, t, body);
          properties.push({
            propertyId: t.propertyId,
            name: t.name,
            currency: t.currency,
            roomTypeCodes: t.roomTypeCodes,
            changedDays,
          });
          if (!body.dryRun && changedDays > 0) {
            await recordAudit(tx, {
              organisationId: t.organisationId,
              propertyId: t.propertyId,
              actorUserId: tenant.userId,
              action: 'rates.updated',
              entityType: 'rate_plan',
              entityId: t.planId,
              after: {
                group: true,
                roomTypeCodes: t.roomTypeCodes,
                from: body.from,
                to: body.to,
                weekdays: body.weekdays,
                price: body.price ?? null,
                restrictions,
                changedDays,
              },
            });
          }
        }
        const result: Out = {
          dryRun: body.dryRun,
          properties,
          changedDays: properties.reduce((a, p) => a + p.changedDays, 0),
        };
        if (body.dryRun) throw new DryRun(result);
        return result;
      }),
    );
  } catch (err) {
    if (err instanceof DryRun) return err.result;
    // A max stay below an existing min stay (or the reverse) on some day.
    if (pgErrorInfo(err)?.constraint === 'rate_days_stay_check') {
      throw new AppError('VALIDATION_ERROR', 'Request validation failed.', {
        issues: [
          {
            path: 'body.restrictions.maxStay',
            code: 'custom',
            message: 'On some days the maximum stay would be below the minimum',
          },
        ],
      });
    }
    throw err;
  }
}
