import {
  addDays,
  pmDueState,
  zonedInstant,
  type MeterReadingBody,
  type PmTrigger,
  type PreventivePlanBody,
  type PreventivePlanItem,
  type PreventivePlanPatch,
  type Priority,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { defineJob } from '../../core/jobs.ts';
import { runAsTenant, type TenantContext } from '../../core/tenancy.ts';
import { createTenantDb, type TenantDb } from '../../core/tenant-db.ts';
import { propertyToday } from '../availability/inventory.ts';
import { checkAssignee, insertTask } from '../tasks/service.ts';
import type { MaintenanceDeps } from './service.ts';

// Preventive maintenance (PRD M5-10 "As a manager, I schedule preventive maintenance by
// calendar or run hours", pm.manage; S34 PM calendar; T-131). preventive_plans is not in tab 3;
// its columns are designed here. A plan comes due by the calendar (every N days) or by run
// hours (every N hours on its asset's hour meter). Within its lead (days or hours ahead of
// due) it opens one maintenance task: at once when a change brings it there, otherwise on the
// hourly worker run. Verifying the task moves the plan on: the next date counts from the day
// it was done, the next service from the meter reading then. A paused plan, or one on a
// retired asset, opens no jobs.

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;

const PLAN_INCLUDE = {
  asset: { select: { id: true, tag: true, name: true } },
  assignee: { select: { id: true, name: true } },
  openTask: { select: { id: true, number: true, status: true } },
} as const;
type PlanRow = Prisma.PreventivePlanGetPayload<{ include: typeof PLAN_INCLUDE }>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const DONE = ['VERIFIED', 'CLOSED'];

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

function hoursLeft(p: {
  everyHours: number | null;
  meterHours: number | null;
  lastServiceHours: number | null;
}) {
  return p.everyHours !== null && p.meterHours !== null && p.lastServiceHours !== null
    ? p.lastServiceHours + p.everyHours - p.meterHours
    : null;
}

function planItem(p: PlanRow, today: string): z.input<typeof PreventivePlanItem> {
  const trigger = p.trigger as PmTrigger;
  const left = hoursLeft(p);
  const nextDueOn = p.nextDueOn ? day(p.nextDueOn) : null;
  return {
    id: p.id,
    title: p.title,
    instructions: p.instructions,
    asset: p.asset,
    trigger,
    everyDays: p.everyDays,
    everyHours: p.everyHours,
    leadDays: p.leadDays,
    leadHours: p.leadHours,
    nextDueOn,
    lastDoneOn: p.lastDoneOn ? day(p.lastDoneOn) : null,
    meterHours: p.meterHours,
    meterReadAt: p.meterReadAt ? iso(p.meterReadAt) : null,
    lastServiceHours: p.lastServiceHours,
    hoursLeft: left,
    dueState: pmDueState(
      { trigger, nextDueOn, leadDays: p.leadDays, hoursLeft: left, leadHours: p.leadHours },
      today,
    ),
    assignee: p.assignee,
    priority: p.priority as Priority,
    active: p.active,
    openTask: p.openTask,
  };
}

async function itemOf(db: Client, propertyId: string, clock: Clock, planId: string) {
  const plan = await db.preventivePlan.findFirst({ where: { id: planId }, include: PLAN_INCLUDE });
  if (!plan) throw new AppError('NOT_FOUND', 'Plan not found.');
  return planItem(plan, await propertyToday(db, propertyId, clock));
}

function snapshot(p: Prisma.PreventivePlanGetPayload<object>) {
  return {
    title: p.title,
    instructions: p.instructions,
    assetId: p.assetId,
    trigger: p.trigger,
    everyDays: p.everyDays,
    everyHours: p.everyHours,
    leadDays: p.leadDays,
    leadHours: p.leadHours,
    nextDueOn: p.nextDueOn ? day(p.nextDueOn) : null,
    meterHours: p.meterHours,
    lastServiceHours: p.lastServiceHours,
    assigneeId: p.assigneeId,
    priority: p.priority,
    active: p.active,
  };
}

// ── Coming due ─────────────────────────────────────────────────────────────────────────

/**
 * Brings one plan up to date inside the caller's transaction: a verified job moves it on, and
 * a plan within its lead with no job open gets one. Returns what happened.
 */
export async function syncPlan(
  tx: Tx,
  propertyId: string,
  planId: string,
  clock: Clock,
): Promise<'advanced' | 'opened' | 'advanced+opened' | null> {
  await tx.$queryRaw`SELECT id FROM preventive_plans WHERE id = ${planId}::uuid FOR UPDATE`;
  let plan = await tx.preventivePlan.findFirst({
    where: { id: planId },
    include: {
      openTask: { select: { id: true, number: true, status: true } },
      asset: { select: { id: true, name: true, tag: true, status: true, roomId: true } },
    },
  });
  if (!plan) return null;
  const zone = await tx.$queryRaw<{ time_zone: string }[]>`
    SELECT time_zone FROM properties WHERE id = ${propertyId}::uuid`;
  const timeZone = zone[0]?.time_zone ?? 'Africa/Lagos';
  const today = await propertyToday(tx, propertyId, clock);
  let advanced = false;

  if (plan.openTask && DONE.includes(plan.openTask.status)) {
    const data =
      plan.trigger === 'CALENDAR'
        ? {
            lastDoneOn: dbDate(today),
            nextDueOn: dbDate(addDays(today, plan.everyDays ?? 1)),
            openTaskId: null,
          }
        : { lastDoneOn: dbDate(today), lastServiceHours: plan.meterHours, openTaskId: null };
    await tx.preventivePlan.update({ where: { id: plan.id }, data });
    await recordAudit(tx, {
      action: 'preventive_plan.serviced',
      entityType: 'preventive_plan',
      entityId: plan.id,
      before: { nextDueOn: plan.nextDueOn ? day(plan.nextDueOn) : null },
      after: {
        taskId: plan.openTask.id,
        doneOn: today,
        ...(plan.trigger === 'CALENDAR'
          ? { nextDueOn: addDays(today, plan.everyDays ?? 1) }
          : { lastServiceHours: plan.meterHours }),
      },
    });
    plan = { ...plan, ...data, openTask: null };
    advanced = true;
  }

  if (!plan.active || plan.openTaskId || plan.asset?.status === 'RETIRED') {
    return advanced ? 'advanced' : null;
  }
  const left = hoursLeft(plan);
  const nextDueOn = plan.nextDueOn ? day(plan.nextDueOn) : null;
  const due =
    plan.trigger === 'CALENDAR'
      ? nextDueOn !== null && nextDueOn <= addDays(today, plan.leadDays)
      : left !== null && left <= plan.leadHours;
  if (!due) return advanced ? 'advanced' : null;

  const department = await tx.department.findFirst({ where: { code: 'MNT' } });
  if (!department) return advanced ? 'advanced' : null;
  const when =
    plan.trigger === 'CALENDAR'
      ? `Due ${nextDueOn ?? ''}.`
      : `Due at ${((plan.lastServiceHours ?? 0) + (plan.everyHours ?? 0)).toLocaleString('en-GB')} run hours (meter reads ${(plan.meterHours ?? 0).toLocaleString('en-GB')}).`;
  const task = await insertTask(tx, propertyId, {
    type: 'GENERAL',
    templateId: null,
    departmentId: department.id,
    title: `Preventive: ${plan.title}${plan.asset ? ` (${plan.asset.tag})` : ''}`.slice(0, 200),
    description: [when, plan.instructions].filter(Boolean).join('\n\n'),
    priority: plan.priority as Priority,
    roomId: plan.asset?.roomId ?? null,
    assetId: plan.asset?.id ?? null,
    assigneeId: plan.assigneeId,
    dueAt:
      plan.trigger === 'CALENDAR' && nextDueOn ? zonedInstant(nextDueOn, '23:59', timeZone) : null,
    reportedById: null,
  });
  await tx.preventivePlan.update({ where: { id: plan.id }, data: { openTaskId: task.id } });
  await recordAudit(tx, {
    action: 'preventive_plan.job_opened',
    entityType: 'preventive_plan',
    entityId: plan.id,
    after: { taskId: task.id, number: task.number, nextDueOn, hoursLeft: left },
  });
  return advanced ? 'advanced+opened' : 'opened';
}

/** Every plan of the current tenant's property that may need moving on or a job. */
export async function syncProperty(tenantDb: TenantDb, propertyId: string, clock: Clock) {
  const plans = await tenantDb.preventivePlan.findMany({
    where: { OR: [{ active: true }, { openTaskId: { not: null } }] },
    select: { id: true },
  });
  let changed = 0;
  for (const p of plans) {
    const r = await tenantDb.$transaction((tx) => syncPlan(tx, propertyId, p.id, clock));
    if (r) changed += 1;
  }
  return changed;
}

/** The system acting for one property (no user): jobs only. */
function systemTenant(property: { id: string; organisationId: string }): TenantContext {
  return {
    userId: null as unknown as string,
    organisationId: property.organisationId,
    propertyId: property.id,
    roles: [],
    permissions: new Set(),
  };
}

/** Moves plans on and opens the jobs that came due, across every property. */
export async function runPreventivePlans(db: Db, clock: Clock): Promise<number> {
  const properties = await db.property.findMany({
    where: {
      preventivePlans: { some: { OR: [{ active: true }, { openTaskId: { not: null } }] } },
    },
    select: { id: true, organisationId: true },
  });
  const tenantDb = createTenantDb(db);
  let changed = 0;
  for (const property of properties) {
    changed += await runAsTenant(systemTenant(property), () =>
      syncProperty(tenantDb, property.id, clock),
    );
  }
  return changed;
}

export const preventiveMaintenanceJob = defineJob({
  name: 'preventive-maintenance',
  // Hourly: calendar plans come due on the property's date; readings arrive any time.
  schedule: { cron: '20 * * * *' },
  async run(_data, { db, clock, logger }) {
    const changed = await runPreventivePlans(db, clock);
    if (changed > 0) logger.info({ changed }, 'Preventive plans moved on or opened jobs');
  },
});

// ── Routes ─────────────────────────────────────────────────────────────────────────────

export async function listPlans(
  deps: MaintenanceDeps,
  tenant: TenantContext,
  query: { assetId?: string | undefined; trigger?: PmTrigger | undefined; active?: string },
) {
  const rows = await deps.tenantDb.preventivePlan.findMany({
    where: {
      ...(query.assetId ? { assetId: query.assetId } : {}),
      ...(query.trigger ? { trigger: query.trigger } : {}),
      ...(query.active ? { active: query.active === 'true' } : {}),
    },
    include: PLAN_INCLUDE,
    orderBy: [{ active: 'desc' }, { nextDueOn: 'asc' }, { title: 'asc' }],
  });
  const today = await propertyToday(deps.tenantDb, tenant.propertyId, deps.clock);
  return { data: rows.map((r) => planItem(r, today)), today };
}

async function checkAsset(tx: Tx, assetId: string) {
  const asset = await tx.asset.findFirst({ where: { id: assetId } });
  if (!asset) throw invalid('assetId', 'Choose an asset of this property');
  if (asset.status === 'RETIRED') throw invalid('assetId', 'This asset is retired');
}

export async function createPlan(
  deps: MaintenanceDeps,
  tenant: TenantContext,
  body: z.output<typeof PreventivePlanBody>,
) {
  if (body.assigneeId) await checkAssignee(deps, tenant, body.assigneeId, 'assigneeId');
  return deps.tenantDb.$transaction(async (tx) => {
    if (body.assetId) await checkAsset(tx, body.assetId);
    const calendar = body.trigger === 'CALENDAR';
    const plan = await tx.preventivePlan.create({
      data: {
        title: body.title,
        instructions: body.instructions,
        assetId: body.assetId,
        trigger: body.trigger,
        everyDays: calendar ? body.everyDays : null,
        everyHours: calendar ? null : body.everyHours,
        leadDays: body.leadDays,
        leadHours: body.leadHours,
        nextDueOn: calendar && body.firstDueOn ? dbDate(body.firstDueOn) : null,
        meterHours: calendar ? null : (body.meterHours ?? body.lastServiceHours),
        meterReadAt: calendar ? null : deps.clock(),
        lastServiceHours: calendar ? null : body.lastServiceHours,
        assigneeId: body.assigneeId,
        priority: body.priority,
      } as unknown as Prisma.PreventivePlanUncheckedCreateInput, // tenant IDs come from the client
    });
    await recordAudit(tx, {
      action: 'preventive_plan.created',
      entityType: 'preventive_plan',
      entityId: plan.id,
      after: snapshot(plan),
    });
    await syncPlan(tx, tenant.propertyId, plan.id, deps.clock);
    return itemOf(tx, tenant.propertyId, deps.clock, plan.id);
  });
}

export async function updatePlan(
  deps: MaintenanceDeps,
  tenant: TenantContext,
  planId: string,
  body: z.output<typeof PreventivePlanPatch>,
) {
  if (body.assigneeId) await checkAssignee(deps, tenant, body.assigneeId, 'assigneeId');
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM preventive_plans WHERE id = ${planId}::uuid FOR UPDATE`;
    const before = await tx.preventivePlan.findFirst({ where: { id: planId } });
    if (!before) throw new AppError('NOT_FOUND', 'Plan not found.');
    const calendar = before.trigger === 'CALENDAR';
    if (calendar && body.everyHours !== undefined) {
      throw invalid('everyHours', 'A calendar plan has no run hours');
    }
    if (!calendar && body.everyDays !== undefined) {
      throw invalid('everyDays', 'A run-hours plan has no day interval');
    }
    if (!calendar && body.nextDueOn !== undefined) {
      throw invalid('nextDueOn', 'A run-hours plan comes due by its meter, not a date');
    }
    const { nextDueOn, ...rest } = body;
    const data: Prisma.PreventivePlanUncheckedUpdateInput = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    if (nextDueOn !== undefined) data.nextDueOn = dbDate(nextDueOn);
    const after = await tx.preventivePlan.update({ where: { id: planId }, data });
    const was = snapshot(before);
    const now = snapshot(after);
    const changed = (Object.keys(now) as (keyof typeof now)[]).filter((k) => was[k] !== now[k]);
    if (changed.length > 0) {
      await recordAudit(tx, {
        action: 'preventive_plan.updated',
        entityType: 'preventive_plan',
        entityId: planId,
        before: Object.fromEntries(changed.map((k) => [k, was[k]])),
        after: Object.fromEntries(changed.map((k) => [k, now[k]])),
      });
    }
    await syncPlan(tx, tenant.propertyId, planId, deps.clock);
    return itemOf(tx, tenant.propertyId, deps.clock, planId);
  });
}

export async function recordHours(
  deps: MaintenanceDeps,
  tenant: TenantContext,
  planId: string,
  body: z.output<typeof MeterReadingBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM preventive_plans WHERE id = ${planId}::uuid FOR UPDATE`;
    const plan = await tx.preventivePlan.findFirst({ where: { id: planId } });
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found.');
    if (plan.trigger !== 'RUN_HOURS') {
      throw new AppError('STATE_TRANSITION_INVALID', 'Only run-hours plans take meter readings.');
    }
    if (plan.meterHours !== null && body.hours < plan.meterHours) {
      throw new AppError(
        'VALIDATION_ERROR',
        `The meter last read ${plan.meterHours} hours; a reading cannot go back`,
        {
          issues: [{ path: 'body.hours', code: 'custom', message: 'The meter only goes up' }],
        },
      );
    }
    await tx.preventivePlan.update({
      where: { id: planId },
      data: { meterHours: body.hours, meterReadAt: deps.clock() },
    });
    await recordAudit(tx, {
      action: 'preventive_plan.hours_read',
      entityType: 'preventive_plan',
      entityId: planId,
      before: { meterHours: plan.meterHours },
      after: { meterHours: body.hours },
    });
    await syncPlan(tx, tenant.propertyId, planId, deps.clock);
    return itemOf(tx, tenant.propertyId, deps.clock, planId);
  });
}
