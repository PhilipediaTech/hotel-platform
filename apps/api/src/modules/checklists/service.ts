import {
  addDays,
  checklistDueOn,
  zonedInstant,
  type ChecklistBody,
  type ChecklistFrequency,
  type ChecklistItem,
  type ChecklistPatch,
  type ChecklistRunItem,
  type CompleteRunBody,
  type ChecklistRunStatus,
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
import { checkAssignee, dueFrom, insertTask, templateOfType, workersOf } from '../tasks/service.ts';

// Recurring checklists (PRD M6-13; T-134). checklists and checklist_runs are listed for V1.1 in
// tab 3 without columns: they are designed here. Each day a checklist is due (daily, one weekday
// or one day of the month, on the property's calendar) it gets one run, a copy of its checks
// and assignee as they were that day. Runs are made when the day is first looked at, when a
// checklist is created or changed, and by the hourly worker. A run still PENDING once its day
// has passed becomes MISSED and cannot be done late. Doing a run answers every check; any
// problem opens one CHECKLIST task for the checklist's department, with the problems listed.

export interface ChecklistDeps {
  /** For the assignee list (members are read across the organisation). */
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

const PERSON = { select: { id: true, name: true } } as const;
const CHECKLIST_INCLUDE = {
  department: { select: { id: true, name: true } },
  assignee: PERSON,
} as const satisfies Prisma.ChecklistInclude;
type ChecklistRow = Prisma.ChecklistGetPayload<{ include: typeof CHECKLIST_INCLUDE }>;

const RUN_INCLUDE = {
  checklist: { select: { id: true, name: true, department: { select: { name: true } } } },
  assignee: PERSON,
  completedBy: PERSON,
  task: { select: { id: true, number: true } },
} as const satisfies Prisma.ChecklistRunInclude;
type RunRow = Prisma.ChecklistRunGetPayload<{ include: typeof RUN_INCLUDE }>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

const isManager = (tenant: TenantContext) => tenant.permissions.has('checklist.manage');

/** Managers see every run; people who work tasks see their own and unassigned ones. */
function runsVisibleTo(tenant: TenantContext): Prisma.ChecklistRunWhereInput {
  if (isManager(tenant)) return {};
  return { OR: [{ assigneeId: tenant.userId }, { assigneeId: null }] };
}

function mayUseRuns(tenant: TenantContext) {
  if (!isManager(tenant) && !tenant.permissions.has('task.work')) {
    throw new AppError('FORBIDDEN', 'You do not have permission to do checklists.', {
      permission: ['task.work', 'checklist.manage'],
    });
  }
}

interface Result {
  item: string;
  ok: boolean;
  note: string | null;
}

function runItem(r: RunRow, tenant: TenantContext, now: Date): z.input<typeof ChecklistRunItem> {
  return {
    id: r.id,
    checklist: {
      id: r.checklist.id,
      name: r.checklist.name,
      department: r.checklist.department.name,
    },
    dueOn: day(r.dueOn),
    dueAt: iso(r.dueAt),
    items: r.items,
    assignee: r.assignee,
    status: r.status as ChecklistRunStatus,
    results: r.results as unknown as Result[],
    problems: r.problems,
    task: r.task,
    completedBy: r.completedBy,
    completedAt: r.completedAt ? iso(r.completedAt) : null,
    overdue: r.status === 'PENDING' && now > r.dueAt,
    canComplete:
      r.status === 'PENDING' &&
      (isManager(tenant) ||
        (tenant.permissions.has('task.work') &&
          (r.assigneeId === null || r.assigneeId === tenant.userId))),
  };
}

function checklistItem(
  c: ChecklistRow,
  lastRun: { dueOn: Date; status: string; problems: number } | undefined,
  missed30: number,
): z.input<typeof ChecklistItem> {
  return {
    id: c.id,
    name: c.name,
    department: c.department,
    items: c.items,
    frequency: c.frequency as ChecklistFrequency,
    weekday: c.weekday,
    monthDay: c.monthDay,
    dueTime: c.dueTime,
    assignee: c.assignee,
    active: c.active,
    lastRun: lastRun
      ? {
          dueOn: day(lastRun.dueOn),
          status: lastRun.status as ChecklistRunStatus,
          problems: lastRun.problems,
        }
      : null,
    missed30,
  };
}

function snapshot(c: Prisma.ChecklistGetPayload<object>) {
  return {
    name: c.name,
    departmentId: c.departmentId,
    items: c.items.join(' | '),
    frequency: c.frequency,
    weekday: c.weekday,
    monthDay: c.monthDay,
    dueTime: c.dueTime,
    assigneeId: c.assigneeId,
    active: c.active,
  };
}

// ── Making runs ────────────────────────────────────────────────────────────────────────

async function timeZoneOf(tx: Tx, propertyId: string) {
  const rows = await tx.$queryRaw<{ time_zone: string }[]>`
    SELECT time_zone FROM properties WHERE id = ${propertyId}::uuid`;
  return rows[0]?.time_zone ?? 'Africa/Lagos';
}

/**
 * Brings the property's runs up to today inside the caller's transaction: runs of earlier days
 * still pending become MISSED, and each active checklist due today without a run gets one.
 * Returns how many runs were made or marked missed.
 */
export async function syncRuns(tx: Tx, propertyId: string, clock: Clock): Promise<number> {
  // One sync at a time per property, so a run is never made twice.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`checklists:${propertyId}`}))::text AS locked`;
  const today = await propertyToday(tx, propertyId, clock);
  const missed = await tx.checklistRun.updateMany({
    where: { status: 'PENDING', dueOn: { lt: dbDate(today) } },
    data: { status: 'MISSED' },
  });
  const due = (
    await tx.checklist.findMany({
      where: { active: true, runs: { none: { dueOn: dbDate(today) } } },
    })
  ).filter((c) =>
    checklistDueOn(
      { frequency: c.frequency as ChecklistFrequency, weekday: c.weekday, monthDay: c.monthDay },
      today,
    ),
  );
  if (due.length === 0) return missed.count;
  const timeZone = await timeZoneOf(tx, propertyId);
  for (const c of due) {
    await tx.checklistRun.create({
      data: {
        checklistId: c.id,
        dueOn: dbDate(today),
        dueAt: zonedInstant(today, c.dueTime, timeZone),
        items: c.items,
        assigneeId: c.assigneeId,
      } as unknown as Prisma.ChecklistRunUncheckedCreateInput, // tenant IDs come from the client
    });
  }
  return missed.count + due.length;
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

/** Makes today's runs and marks missed ones, across every property with checklists. */
export async function runChecklists(db: Db, clock: Clock): Promise<number> {
  const properties = await db.property.findMany({
    where: {
      OR: [
        { checklists: { some: { active: true } } },
        { checklistRuns: { some: { status: 'PENDING' } } },
      ],
    },
    select: { id: true, organisationId: true },
  });
  const tenantDb = createTenantDb(db);
  let changed = 0;
  for (const property of properties) {
    changed += await runAsTenant(systemTenant(property), () =>
      tenantDb.$transaction((tx) => syncRuns(tx, property.id, clock)),
    );
  }
  return changed;
}

export const checklistsJob = defineJob({
  name: 'checklist-runs',
  // Hourly: a property's day starts at its own midnight.
  schedule: { cron: '5 * * * *' },
  async run(_data, { db, clock, logger }) {
    const changed = await runChecklists(db, clock);
    if (changed > 0) logger.info({ changed }, 'Checklist runs made or marked missed');
  },
});

// ── Checklists (managers) ──────────────────────────────────────────────────────────────

async function itemOf(tx: Tx, checklistId: string, today: string) {
  const c = await tx.checklist.findFirst({
    where: { id: checklistId },
    include: CHECKLIST_INCLUDE,
  });
  if (!c) throw new AppError('NOT_FOUND', 'Checklist not found.');
  const [last, missed30] = await Promise.all([
    tx.checklistRun.findFirst({ where: { checklistId }, orderBy: { dueOn: 'desc' } }),
    tx.checklistRun.count({
      where: { checklistId, status: 'MISSED', dueOn: { gte: dbDate(addDays(today, -30)) } },
    }),
  ]);
  return checklistItem(c, last ?? undefined, missed30);
}

export async function listChecklists(deps: ChecklistDeps, tenant: TenantContext) {
  const [departments, assignees] = await Promise.all([
    deps.tenantDb.department.findMany({ orderBy: { name: 'asc' } }),
    workersOf(deps.db, tenant),
  ]);
  return deps.tenantDb.$transaction(async (tx) => {
    await syncRuns(tx, tenant.propertyId, deps.clock);
    const today = await propertyToday(tx, tenant.propertyId, deps.clock);
    const rows = await tx.checklist.findMany({
      include: CHECKLIST_INCLUDE,
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    const ids = rows.map((r) => r.id);
    const [lastRuns, missed] = await Promise.all([
      tx.checklistRun.findMany({
        where: { checklistId: { in: ids } },
        orderBy: { dueOn: 'desc' },
        distinct: ['checklistId'],
      }),
      tx.checklistRun.groupBy({
        by: ['checklistId'],
        where: {
          checklistId: { in: ids },
          status: 'MISSED',
          dueOn: { gte: dbDate(addDays(today, -30)) },
        },
        _count: { _all: true },
      }),
    ]);
    const last = new Map(lastRuns.map((r) => [r.checklistId, r]));
    const missedBy = new Map(missed.map((m) => [m.checklistId, m._count._all]));
    return {
      data: rows.map((r) => checklistItem(r, last.get(r.id), missedBy.get(r.id) ?? 0)),
      departments: departments.map((d) => ({ id: d.id, name: d.name })),
      assignees: assignees.map((a) => ({ id: a.id, name: a.name })),
      today,
    };
  });
}

async function checkDepartment(tx: Tx, departmentId: string) {
  const department = await tx.department.findFirst({ where: { id: departmentId } });
  if (!department) throw invalid('departmentId', 'Choose a department of this property');
}

export async function createChecklist(
  deps: ChecklistDeps,
  tenant: TenantContext,
  body: z.output<typeof ChecklistBody>,
) {
  if (body.assigneeId) await checkAssignee(deps, tenant, body.assigneeId, 'assigneeId');
  return deps.tenantDb.$transaction(async (tx) => {
    await checkDepartment(tx, body.departmentId);
    const c = await tx.checklist.create({
      data: {
        name: body.name,
        departmentId: body.departmentId,
        items: body.items,
        frequency: body.frequency,
        weekday: body.frequency === 'WEEKLY' ? body.weekday : null,
        monthDay: body.frequency === 'MONTHLY' ? body.monthDay : null,
        dueTime: body.dueTime,
        assigneeId: body.assigneeId,
        createdById: tenant.userId,
      } as unknown as Prisma.ChecklistUncheckedCreateInput, // tenant IDs come from the client
    });
    await recordAudit(tx, {
      action: 'checklist.created',
      entityType: 'checklist',
      entityId: c.id,
      after: snapshot(c),
    });
    await syncRuns(tx, tenant.propertyId, deps.clock);
    return itemOf(tx, c.id, await propertyToday(tx, tenant.propertyId, deps.clock));
  });
}

export async function updateChecklist(
  deps: ChecklistDeps,
  tenant: TenantContext,
  checklistId: string,
  body: z.output<typeof ChecklistPatch>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM checklists WHERE id = ${checklistId}::uuid FOR UPDATE`;
    const before = await tx.checklist.findFirst({ where: { id: checklistId } });
    if (!before) throw new AppError('NOT_FOUND', 'Checklist not found.');
    if (body.assigneeId) await checkAssignee(deps, tenant, body.assigneeId, 'assigneeId');
    if (body.departmentId) await checkDepartment(tx, body.departmentId);
    const frequency = body.frequency ?? (before.frequency as ChecklistFrequency);
    const weekday = frequency === 'WEEKLY' ? (body.weekday ?? before.weekday) : null;
    const monthDay = frequency === 'MONTHLY' ? (body.monthDay ?? before.monthDay) : null;
    if (frequency === 'WEEKLY' && weekday === null) {
      throw invalid('weekday', 'Choose the day of the week');
    }
    if (frequency === 'MONTHLY' && monthDay === null) {
      throw invalid('monthDay', 'Choose the day of the month');
    }
    const after = await tx.checklist.update({
      where: { id: checklistId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.departmentId !== undefined ? { departmentId: body.departmentId } : {}),
        ...(body.items !== undefined ? { items: body.items } : {}),
        ...(body.dueTime !== undefined ? { dueTime: body.dueTime } : {}),
        ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        frequency,
        weekday,
        monthDay,
      },
    });
    const was = snapshot(before);
    const now = snapshot(after);
    const changed = (Object.keys(now) as (keyof typeof now)[]).filter((k) => was[k] !== now[k]);
    if (changed.length > 0) {
      await recordAudit(tx, {
        action: 'checklist.updated',
        entityType: 'checklist',
        entityId: checklistId,
        before: Object.fromEntries(changed.map((k) => [k, was[k]])),
        after: Object.fromEntries(changed.map((k) => [k, now[k]])),
      });
    }
    await syncRuns(tx, tenant.propertyId, deps.clock);
    return itemOf(tx, checklistId, await propertyToday(tx, tenant.propertyId, deps.clock));
  });
}

// ── Runs (whoever does them) ───────────────────────────────────────────────────────────

export async function listRuns(
  deps: ChecklistDeps,
  tenant: TenantContext,
  query: { date?: string | undefined },
) {
  mayUseRuns(tenant);
  return deps.tenantDb.$transaction(async (tx) => {
    await syncRuns(tx, tenant.propertyId, deps.clock);
    const today = await propertyToday(tx, tenant.propertyId, deps.clock);
    const date = query.date ?? today;
    const rows = await tx.checklistRun.findMany({
      where: { dueOn: dbDate(date), ...runsVisibleTo(tenant) },
      include: RUN_INCLUDE,
      orderBy: [{ dueAt: 'asc' }, { checklist: { name: 'asc' } }],
    });
    return { data: rows.map((r) => runItem(r, tenant, deps.clock())), date, today };
  });
}

export async function completeRun(
  deps: ChecklistDeps,
  tenant: TenantContext,
  runId: string,
  body: z.output<typeof CompleteRunBody>,
) {
  mayUseRuns(tenant);
  return deps.tenantDb.$transaction(async (tx) => {
    // A run whose day has passed is marked missed first.
    await syncRuns(tx, tenant.propertyId, deps.clock);
    await tx.$queryRaw`SELECT id FROM checklist_runs WHERE id = ${runId}::uuid FOR UPDATE`;
    const run = await tx.checklistRun.findFirst({
      where: { id: runId, ...runsVisibleTo(tenant) },
      include: { checklist: true },
    });
    if (!run) throw new AppError('NOT_FOUND', 'Checklist run not found.');
    if (run.status !== 'PENDING') {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        run.status === 'DONE' ? 'This checklist is already done.' : 'This checklist was missed.',
        { status: run.status },
      );
    }
    if (body.results.length !== run.items.length) {
      throw invalid('results', `Answer all ${run.items.length} checks`);
    }
    const results: Result[] = run.items.map((item, i) => ({
      item,
      ok: body.results[i]?.ok ?? false,
      note: body.results[i]?.note ?? null,
    }));
    const problems = results.filter((r) => !r.ok);
    const now = deps.clock();

    let taskId: string | null = null;
    if (problems.length > 0) {
      const template = await templateOfType(tx, tenant.propertyId, 'CHECKLIST');
      const task = await insertTask(tx, tenant.propertyId, {
        type: 'CHECKLIST',
        templateId: template?.id ?? null,
        departmentId: run.checklist.departmentId,
        title:
          `${run.checklist.name}: ${problems.length} problem${problems.length === 1 ? '' : 's'}`.slice(
            0,
            200,
          ),
        description: problems.map((p) => `• ${p.item}: ${p.note ?? ''}`).join('\n'),
        priority: template?.priority ?? 'NORMAL',
        dueAt: dueFrom(now, template?.slaMinutes),
        reportedById: tenant.userId,
      });
      taskId = task.id;
    }
    await tx.checklistRun.update({
      where: { id: runId },
      data: {
        status: 'DONE',
        results: results as unknown as Prisma.InputJsonValue,
        problems: problems.length,
        taskId,
        completedById: tenant.userId,
        completedAt: now,
      },
    });
    await recordAudit(tx, {
      action: 'checklist_run.completed',
      entityType: 'checklist_run',
      entityId: runId,
      after: {
        checklistId: run.checklistId,
        dueOn: day(run.dueOn),
        problems: problems.length,
        taskId,
        late: now > run.dueAt,
      },
    });
    const row = await tx.checklistRun.findFirst({ where: { id: runId }, include: RUN_INCLUDE });
    if (!row) throw new AppError('NOT_FOUND', 'Checklist run not found.');
    return runItem(row, tenant, now);
  });
}
