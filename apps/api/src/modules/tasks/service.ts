import {
  DEFAULT_TASK_TEMPLATES,
  OPEN_TASK_STATUSES,
  TASK_ACTION_FROM,
  TASK_ACTION_TO,
  TASK_ACTIONS,
  taskActionAllowed,
  type AssignTaskBody,
  type CreateTaskBody,
  type Priority,
  type ReopenTaskBody,
  type TaskAction,
  type TaskCommentBody,
  type TaskDetail,
  type TaskItem,
  type TaskStatus,
  type TaskTemplateBody,
  type TaskTemplateItem,
  type TaskType,
  type WorkOrderItem,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { Clock } from '../../core/clock.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Task engine (PRD M6-01–M6-04, M6 rule 1; tab 3 tasks, task_templates, task_events; T-082).
// A task starts from a template (its type, department, priority and SLA). Managers (task.assign)
// triage and assign it; the assignee acknowledges, starts, holds and resolves it with evidence;
// a manager with task.verify verifies or reopens it. Every change adds a row to the task's
// timeline. A status change is a guarded update (the status and version it was read with), so
// two people acting at once cannot both move it. Escalation past the deadline is in jobs.ts.

export interface TaskDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;

const include = {
  department: true,
  template: { select: { id: true, name: true } },
  room: { select: { id: true, number: true } },
  asset: { select: { id: true, tag: true, name: true } },
  guest: { select: { id: true, firstName: true, lastName: true } },
  reportedBy: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  verifiedBy: { select: { id: true, name: true } },
} satisfies Prisma.TaskInclude;
const detailInclude = {
  ...include,
  events: { orderBy: { id: 'asc' }, include: { by: { select: { id: true, name: true } } } },
  workOrder: true,
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof include }>;
type TaskDetailRow = Prisma.TaskGetPayload<{ include: typeof detailInclude }>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoOrNull = (d: Date | null) => (d ? iso(d) : null);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

const forbidden = (message: string, permission: string | string[]) =>
  new AppError('FORBIDDEN', message, { permission });

/** Managers see and steer every task of the property. */
const isManager = (tenant: TenantContext) =>
  tenant.permissions.has('task.assign') || tenant.permissions.has('task.verify');

function taskItem(t: TaskRow, now: Date): z.input<typeof TaskItem> {
  const open = OPEN_TASK_STATUSES.includes(t.status);
  return {
    id: t.id,
    number: t.number,
    type: t.type,
    template: t.template,
    title: t.title,
    description: t.description,
    department: { id: t.department.id, code: t.department.code, name: t.department.name },
    priority: t.priority,
    status: t.status,
    room: t.room,
    asset: t.asset,
    stayId: t.stayId,
    guest: t.guest
      ? { id: t.guest.id, name: `${t.guest.firstName} ${t.guest.lastName}`.trim() }
      : null,
    reportedBy: t.reportedBy,
    assignee: t.assignee,
    dueAt: isoOrNull(t.dueAt),
    overdue: open && t.dueAt !== null && t.dueAt <= now,
    escalationLevel: t.escalationLevel,
    acknowledgedAt: isoOrNull(t.acknowledgedAt),
    resolvedAt: isoOrNull(t.resolvedAt),
    verifiedBy: t.verifiedBy,
    createdAt: iso(t.createdAt),
  };
}

/** Whether `tenant` may take `action` on the task now (status and who they are). */
function mayAct(
  tenant: TenantContext,
  t: { status: TaskStatus; assigneeId: string | null },
  action: TaskAction,
) {
  if (!taskActionAllowed(action, t.status)) return false;
  const p = tenant.permissions;
  switch (action) {
    case 'assign':
      return p.has('task.assign');
    case 'verify':
    case 'reopen':
      return p.has('task.verify');
    case 'acknowledge':
    case 'start':
    case 'hold':
    case 'resolve':
      // The assignee works the task; a manager may act for them.
      return p.has('task.assign') || (p.has('task.work') && t.assigneeId === tenant.userId);
  }
}

/** Parts, time and outside cost of a job (M5-08; T-130), as the API answers them. */
export function workOrderItem(w: {
  parts: Prisma.JsonValue;
  labourMinutes: number;
  vendorName: string | null;
  costMinor: bigint;
}): z.input<typeof WorkOrderItem> {
  const parts = (Array.isArray(w.parts) ? w.parts : []) as {
    name: string;
    quantity: number;
    costMinor: string;
  }[];
  const partsCost = parts.reduce((sum, p) => sum + BigInt(p.costMinor), 0n);
  return {
    parts,
    labourMinutes: w.labourMinutes,
    vendorName: w.vendorName,
    partsCostMinor: partsCost.toString(),
    vendorCostMinor: (w.costMinor - partsCost).toString(),
    costMinor: w.costMinor.toString(),
  };
}

/**
 * Whether `tenant` may log parts, time and cost on the job now (T-130): its assignee with
 * wo.work, or a manager with task.assign, until it is verified.
 */
export function mayLogWork(
  tenant: TenantContext,
  t: { status: TaskStatus; assigneeId: string | null },
) {
  if (t.status === 'VERIFIED' || t.status === 'CLOSED') return false;
  const p = tenant.permissions;
  return p.has('task.assign') || (p.has('wo.work') && t.assigneeId === tenant.userId);
}

function taskDetail(
  t: TaskDetailRow,
  tenant: TenantContext,
  now: Date,
): z.input<typeof TaskDetail> {
  return {
    ...taskItem(t, now),
    events: t.events.map((e) => ({
      id: e.id.toString(),
      kind: e.kind,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      fileIds: e.fileIds,
      by: e.by,
      at: iso(e.at),
    })),
    actions: TASK_ACTIONS.filter((a) => mayAct(tenant, t, a)),
    canComment: true,
    workOrder: t.workOrder ? workOrderItem(t.workOrder) : null,
    canLogWork: mayLogWork(tenant, t),
  };
}

/** The tasks `tenant` may see: all for managers, else those they reported or were given. */
function visibleTo(tenant: TenantContext): Prisma.TaskWhereInput {
  if (isManager(tenant)) return {};
  return { OR: [{ reportedById: tenant.userId }, { assigneeId: tenant.userId }] };
}

export async function loadVisible(db: Client, tenant: TenantContext, taskId: string) {
  const task = await db.task.findFirst({ where: { id: taskId, ...visibleTo(tenant) } });
  if (!task) throw new AppError('NOT_FOUND', 'Task not found.');
  return task;
}

export async function detailOf(db: Client, tenant: TenantContext, taskId: string, now: Date) {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId }, include: detailInclude });
  return taskDetail(task, tenant, now);
}

// ── Templates ──────────────────────────────────────────────────────────────────────────

function templateItem(
  t: Prisma.TaskTemplateGetPayload<{ include: { department: true } }>,
): z.input<typeof TaskTemplateItem> {
  return {
    id: t.id,
    type: t.type,
    name: t.name,
    department: { id: t.department.id, code: t.department.code, name: t.department.name },
    priority: t.priority,
    slaMinutes: t.slaMinutes,
    active: t.active,
  };
}

/**
 * Every property starts with the default templates (M6-01), made the first time anyone needs
 * them; a lock keeps two first requests from making them twice. Templates whose department
 * the property no longer has are skipped.
 */
export async function ensureTemplates(tx: Tx, propertyId: string): Promise<void> {
  if ((await tx.taskTemplate.count()) > 0) return;
  const lock = `task-templates:${propertyId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lock}))::text AS locked`;
  if ((await tx.taskTemplate.count()) > 0) return;
  const departments = await tx.department.findMany();
  const byCode = new Map(departments.map((d) => [d.code, d.id]));
  const rows = DEFAULT_TASK_TEMPLATES.flatMap((t) => {
    const departmentId = byCode.get(t.department);
    return departmentId
      ? [
          {
            type: t.type,
            name: t.name,
            departmentId,
            priority: t.priority,
            slaMinutes: t.slaMinutes,
          },
        ]
      : [];
  });
  // The tenant client sets the property.
  await tx.taskTemplate.createMany({
    data: rows as unknown as Prisma.TaskTemplateCreateManyInput[],
  });
}

/** Reporting, creating or managing tasks: what a member needs to use the task screens. */
function mayUseTasks(tenant: TenantContext) {
  const p = tenant.permissions;
  if (!['task.report', 'task.create', 'task.work', 'task.assign'].some((c) => p.has(c))) {
    throw forbidden('You do not have permission to use tasks.', ['task.report', 'task.create']);
  }
}

export async function listTemplates(deps: TaskDeps, tenant: TenantContext) {
  mayUseTasks(tenant);
  return deps.tenantDb.$transaction(async (tx) => {
    await ensureTemplates(tx, tenant.propertyId);
    const rows = await tx.taskTemplate.findMany({
      include: { department: true },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    return { data: rows.map(templateItem) };
  });
}

export async function createTemplate(deps: TaskDeps, body: z.output<typeof TaskTemplateBody>) {
  return deps.tenantDb.$transaction(async (tx) => {
    const department = await tx.department.findUnique({ where: { id: body.departmentId } });
    if (!department) throw invalid('departmentId', 'Choose a department of this property');
    const row = await tx.taskTemplate.create({
      data: {
        type: body.type,
        name: body.name,
        departmentId: department.id,
        priority: body.priority,
        slaMinutes: body.slaMinutes,
      } as unknown as Prisma.TaskTemplateUncheckedCreateInput, // tenant IDs come from the client
      include: { department: true },
    });
    return templateItem(row);
  });
}

// ── Form options ───────────────────────────────────────────────────────────────────────

/** Active members of this property who work tasks (task.work), with their department. */
export async function workersOf(db: Db, tenant: TenantContext) {
  const members = await db.membership.findMany({
    where: {
      active: true,
      organisationId: tenant.organisationId,
      OR: [{ propertyId: tenant.propertyId }, { propertyId: null }],
      user: { status: 'ACTIVE' },
    },
    include: { user: true, role: true, department: true },
  });
  const people = new Map<string, { id: string; name: string; department: string | null }>();
  for (const m of members) {
    if (!m.role.permissions.includes('task.work')) continue;
    const known = people.get(m.userId);
    people.set(m.userId, {
      id: m.userId,
      name: m.user.name,
      department: known?.department ?? m.department?.name ?? null,
    });
  }
  return [...people.values()].sort((x, y) => x.name.localeCompare(y.name));
}

export async function formOptions(deps: TaskDeps, tenant: TenantContext) {
  mayUseTasks(tenant);
  const [departments, rooms, assignees] = await Promise.all([
    deps.tenantDb.department.findMany({ orderBy: { name: 'asc' } }),
    deps.tenantDb.room.findMany({
      where: { active: true },
      orderBy: [{ floor: 'asc' }, { number: 'asc' }],
    }),
    tenant.permissions.has('task.assign') ? workersOf(deps.db, tenant) : Promise.resolve([]),
  ]);
  return {
    departments: departments.map((d) => ({ id: d.id, code: d.code, name: d.name })),
    rooms: rooms.map((r) => ({ id: r.id, number: r.number, floor: r.floor })),
    assignees,
  };
}

// ── Files ──────────────────────────────────────────────────────────────────────────────

/**
 * Photos must be Task files of this property, not blocked by the scan and not yet on
 * another task. They are linked to the task (files.entity_id).
 */
async function linkFiles(tx: Tx, taskId: string, ids: string[] | undefined, path: string) {
  if (!ids?.length) return [];
  const unique = [...new Set(ids)];
  const files = await tx.fileObject.findMany({
    where: {
      id: { in: unique },
      entityType: 'Task',
      scan: { not: 'INFECTED' },
      OR: [{ entityId: null }, { entityId: taskId }],
    },
    select: { id: true },
  });
  if (files.length !== unique.length) {
    throw invalid(path, 'A photo is missing, of another kind, or was blocked by the scan');
  }
  await tx.fileObject.updateMany({ where: { id: { in: unique } }, data: { entityId: taskId } });
  return unique;
}

// ── Create ─────────────────────────────────────────────────────────────────────────────

export interface NewTask {
  type: TaskType;
  templateId: string | null;
  departmentId: string;
  title: string;
  description?: string | null;
  priority: Priority;
  roomId?: string | null;
  assetId?: string | null;
  stayId?: string | null;
  guestId?: string | null;
  assigneeId?: string | null;
  dueAt: Date | null;
  fileIds?: string[];
  /** The reporter, or null for the system (e.g. a discrepancy from the morning report). */
  reportedById: string | null;
}

/** Makes a task and its first timeline row inside the caller's transaction. */
export async function insertTask(tx: Tx, propertyId: string, input: NewTask) {
  const number = await nextPropertyCounter(tx, propertyId, COUNTER.TASK);
  const status: TaskStatus = input.assigneeId ? 'ASSIGNED' : 'REPORTED';
  const task = await tx.task.create({
    data: {
      number,
      type: input.type,
      templateId: input.templateId,
      title: input.title,
      description: input.description ?? null,
      departmentId: input.departmentId,
      priority: input.priority,
      status,
      roomId: input.roomId ?? null,
      assetId: input.assetId ?? null,
      stayId: input.stayId ?? null,
      guestId: input.guestId ?? null,
      reportedById: input.reportedById,
      assigneeId: input.assigneeId ?? null,
      dueAt: input.dueAt,
    } as unknown as Prisma.TaskUncheckedCreateInput, // tenant IDs come from the client
  });
  const fileIds = await linkFiles(tx, task.id, input.fileIds, 'fileIds');
  await tx.task.update({
    where: { id: task.id },
    data: {
      events: {
        create: {
          kind: 'STATUS',
          toStatus: status,
          note: input.description ?? null,
          fileIds,
          byUserId: input.reportedById,
        },
      },
    },
  });
  await recordEvent(tx, {
    type: 'task.created',
    payload: {
      taskId: task.id,
      number,
      type: input.type,
      priority: input.priority,
      departmentId: input.departmentId,
      assigneeId: input.assigneeId ?? null,
    },
  });
  return task;
}

/** The template of a type (the first active one), for tasks the system makes. */
export async function templateOfType(tx: Tx, propertyId: string, type: TaskType) {
  await ensureTemplates(tx, propertyId);
  return tx.taskTemplate.findFirst({ where: { type, active: true }, orderBy: { name: 'asc' } });
}

export const dueFrom = (now: Date, slaMinutes: number | null | undefined) =>
  slaMinutes ? new Date(now.getTime() + slaMinutes * 60_000) : null;

/** An assignee must be an active member of the property who works tasks. */
export async function checkAssignee(
  deps: TaskDeps,
  tenant: TenantContext,
  userId: string,
  path: string,
) {
  const workers = await workersOf(deps.db, tenant);
  if (!workers.some((w) => w.id === userId)) {
    throw invalid(path, 'Choose a member of this property who works on tasks');
  }
}

export async function createTask(
  deps: TaskDeps,
  tenant: TenantContext,
  body: z.output<typeof CreateTaskBody>,
) {
  const p = tenant.permissions;
  if (!p.has('task.create') && !p.has('task.report')) {
    throw forbidden('You do not have permission to create tasks.', ['task.create', 'task.report']);
  }
  if ((body.assigneeId || body.dueAt) && !p.has('task.assign')) {
    throw forbidden('Only managers choose who does a task and by when.', 'task.assign');
  }
  if (body.assigneeId) await checkAssignee(deps, tenant, body.assigneeId, 'assigneeId');
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    await ensureTemplates(tx, tenant.propertyId);
    const template = body.templateId
      ? await tx.taskTemplate.findFirst({ where: { id: body.templateId, active: true } })
      : null;
    if (body.templateId && !template) throw invalid('templateId', 'Choose an active template');
    const departmentId = body.departmentId ?? template?.departmentId;
    if (!departmentId || !(await tx.department.findUnique({ where: { id: departmentId } }))) {
      throw invalid('departmentId', 'Choose a department of this property');
    }
    const room = body.roomId ? await tx.room.findUnique({ where: { id: body.roomId } }) : null;
    if (body.roomId && !room) throw invalid('roomId', 'Choose a room of this property');
    const asset = body.assetId
      ? await tx.asset.findFirst({ where: { id: body.assetId, status: { not: 'RETIRED' } } })
      : null;
    if (body.assetId && !asset) throw invalid('assetId', 'Choose an asset of this property');
    if (body.stayId && !(await tx.stay.findUnique({ where: { id: body.stayId } }))) {
      throw invalid('stayId', 'Choose a stay of this property');
    }
    if (body.guestId && !(await tx.guest.findUnique({ where: { id: body.guestId } }))) {
      throw invalid('guestId', 'Choose a guest of this organisation');
    }
    const name = body.title ?? template?.name ?? '';
    const task = await insertTask(tx, tenant.propertyId, {
      type: body.type ?? template?.type ?? 'GENERAL',
      templateId: template?.id ?? null,
      departmentId,
      title:
        !body.title && room
          ? `${name}: room ${room.number}`
          : !body.title && asset
            ? `${name}: ${asset.name}`
            : name,
      description: body.description ?? null,
      priority: body.priority ?? template?.priority ?? 'NORMAL',
      roomId: room?.id ?? asset?.roomId ?? null,
      assetId: asset?.id ?? null,
      stayId: body.stayId ?? null,
      guestId: body.guestId ?? null,
      assigneeId: body.assigneeId ?? null,
      dueAt: body.dueAt ? new Date(body.dueAt) : dueFrom(now, template?.slaMinutes),
      ...(body.fileIds ? { fileIds: body.fileIds } : {}),
      reportedById: tenant.userId,
    });
    return detailOf(tx, tenant, task.id, now);
  });
}

// ── Read ───────────────────────────────────────────────────────────────────────────────

export async function listTasks(
  deps: TaskDeps,
  tenant: TenantContext,
  query: {
    limit: number;
    cursor?: string | undefined;
    status?: 'open' | TaskStatus | undefined;
    assignee?: 'me' | undefined;
    departmentId?: string | undefined;
    type?: TaskType | undefined;
    roomId?: string | undefined;
    assetId?: string | undefined;
    overdue?: 'true' | undefined;
  },
) {
  const now = deps.clock();
  const before = query.cursor ? Number(query.cursor) : null;
  if (before !== null && !Number.isInteger(before)) {
    throw new AppError('VALIDATION_ERROR', 'Invalid cursor.', {
      issues: [{ path: 'query.cursor', code: 'custom', message: 'Invalid cursor' }],
    });
  }
  const where: Prisma.TaskWhereInput = {
    AND: [
      visibleTo(tenant),
      query.status === 'open'
        ? { status: { in: [...OPEN_TASK_STATUSES] } }
        : query.status
          ? { status: query.status }
          : {},
      query.assignee === 'me' ? { assigneeId: tenant.userId } : {},
      query.departmentId ? { departmentId: query.departmentId } : {},
      query.type ? { type: query.type } : {},
      query.roomId ? { roomId: query.roomId } : {},
      query.assetId ? { assetId: query.assetId } : {},
      query.overdue ? { status: { in: [...OPEN_TASK_STATUSES] }, dueAt: { lte: now } } : {},
      before !== null ? { number: { lt: before } } : {},
    ],
  };
  const rows = await deps.tenantDb.task.findMany({
    where,
    include,
    orderBy: { number: 'desc' },
    take: query.limit + 1,
  });
  const more = rows.length > query.limit;
  const data = rows.slice(0, query.limit);
  return {
    data: data.map((t) => taskItem(t, now)),
    nextCursor: more && data.length ? String(data[data.length - 1]?.number) : null,
  };
}

export async function getTask(deps: TaskDeps, tenant: TenantContext, taskId: string) {
  await loadVisible(deps.tenantDb, tenant, taskId);
  return detailOf(deps.tenantDb, tenant, taskId, deps.clock());
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────────────

const DONE: Record<TaskAction, string> = {
  assign: 'assigned',
  acknowledge: 'acknowledged',
  start: 'started',
  hold: 'put on hold',
  resolve: 'resolved',
  verify: 'verified',
  reopen: 'reopened',
};

function refused(action: TaskAction, status: TaskStatus): AppError {
  const now = status.toLowerCase().replace('_', ' ');
  return new AppError(
    'STATE_TRANSITION_INVALID',
    `This task is ${now}; it cannot be ${DONE[action]}.`,
    {
      status,
      allowedFrom: TASK_ACTION_FROM[action],
    },
  );
}

interface Change {
  to: TaskStatus;
  data?: Prisma.TaskUncheckedUpdateManyInput;
  event: { kind: string; note?: string | null; fileIds?: string[] };
  fileIdsToLink?: string[] | undefined;
}

/**
 * Applies one action: checks status and actor, moves the task if it is still as it was read,
 * and adds the timeline row.
 */
async function act(
  deps: TaskDeps,
  tenant: TenantContext,
  taskId: string,
  action: TaskAction,
  change: (task: Prisma.TaskGetPayload<object>, now: Date) => Change | Promise<Change>,
) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    const task = await loadVisible(tx, tenant, taskId);
    if (!taskActionAllowed(action, task.status)) throw refused(action, task.status);
    if (!mayAct(tenant, task, action)) {
      throw forbidden('Only the assignee or a manager can do this.', ['task.work', 'task.assign']);
    }
    const c = await change(task, now);
    const moved = await tx.task.updateMany({
      where: { id: task.id, status: task.status, version: task.version },
      data: { ...c.data, status: c.to, version: { increment: 1 } },
    });
    if (moved.count !== 1) {
      throw new AppError('STATE_TRANSITION_INVALID', 'The task was changed meanwhile. Reload it.');
    }
    const fileIds = await linkFiles(tx, task.id, c.fileIdsToLink, 'fileIds');
    await tx.task.update({
      where: { id: task.id },
      data: {
        events: {
          create: {
            kind: c.event.kind,
            fromStatus: task.status,
            toStatus: c.to,
            note: c.event.note ?? null,
            fileIds,
            byUserId: tenant.userId,
          },
        },
      },
    });
    if (c.to !== task.status || action === 'assign') {
      await recordEvent(tx, {
        type: `task.${action === 'assign' ? 'assigned' : c.to.toLowerCase()}`,
        payload: { taskId: task.id, number: task.number, from: task.status, to: c.to },
      });
    }
    return detailOf(tx, tenant, task.id, now);
  });
}

export async function assignTask(
  deps: TaskDeps,
  tenant: TenantContext,
  taskId: string,
  body: z.output<typeof AssignTaskBody>,
) {
  if (body.assigneeId) await checkAssignee(deps, tenant, body.assigneeId, 'assigneeId');
  return act(deps, tenant, taskId, 'assign', (task) => {
    const sameAssignee = body.assigneeId === task.assigneeId;
    // A new assignee starts over (ASSIGNED, or TRIAGED with nobody); the same one keeps going.
    const to: TaskStatus =
      body.assigneeId === null ? 'TRIAGED' : sameAssignee ? task.status : 'ASSIGNED';
    const dueAt = body.dueAt === undefined ? task.dueAt : body.dueAt ? new Date(body.dueAt) : null;
    const newDeadline = (dueAt?.getTime() ?? null) !== (task.dueAt?.getTime() ?? null);
    const notes = [
      body.priority && body.priority !== task.priority ? `Priority ${body.priority}` : null,
      newDeadline ? (dueAt ? `Due ${iso(dueAt)}` : 'No deadline') : null,
    ].filter(Boolean);
    return {
      to,
      data: {
        assigneeId: body.assigneeId,
        ...(body.priority ? { priority: body.priority } : {}),
        dueAt,
        // A new deadline starts escalation over (M6-05: once per level per deadline).
        ...(newDeadline ? { escalationLevel: 0 } : {}),
        ...(sameAssignee ? {} : { acknowledgedAt: null }),
      },
      event: { kind: 'ASSIGN', note: notes.length ? notes.join('; ') : null },
    };
  });
}

export const acknowledgeTask = (deps: TaskDeps, tenant: TenantContext, taskId: string) =>
  act(deps, tenant, taskId, 'acknowledge', (_t, now) => ({
    to: TASK_ACTION_TO.acknowledge,
    data: { acknowledgedAt: now },
    event: { kind: 'STATUS' },
  }));

export const startTask = (deps: TaskDeps, tenant: TenantContext, taskId: string) =>
  act(deps, tenant, taskId, 'start', () => ({
    to: TASK_ACTION_TO.start,
    event: { kind: 'STATUS' },
  }));

export const holdTask = (deps: TaskDeps, tenant: TenantContext, taskId: string, reason: string) =>
  act(deps, tenant, taskId, 'hold', () => ({
    to: TASK_ACTION_TO.hold,
    event: { kind: 'STATUS', note: reason },
  }));

export const resolveTask = (
  deps: TaskDeps,
  tenant: TenantContext,
  taskId: string,
  body: { note: string; fileIds?: string[] | undefined },
) =>
  act(deps, tenant, taskId, 'resolve', (_t, now) => ({
    to: TASK_ACTION_TO.resolve,
    data: { resolvedAt: now },
    event: { kind: 'STATUS', note: body.note },
    fileIdsToLink: body.fileIds,
  }));

export const verifyTask = (
  deps: TaskDeps,
  tenant: TenantContext,
  taskId: string,
  note: string | undefined,
) =>
  act(deps, tenant, taskId, 'verify', () => ({
    to: TASK_ACTION_TO.verify,
    data: { verifiedById: tenant.userId },
    event: { kind: 'STATUS', note: note ?? null },
  }));

export const reopenTask = (
  deps: TaskDeps,
  tenant: TenantContext,
  taskId: string,
  body: z.output<typeof ReopenTaskBody>,
) =>
  act(deps, tenant, taskId, 'reopen', () => ({
    to: TASK_ACTION_TO.reopen,
    data: {
      acknowledgedAt: null,
      resolvedAt: null,
      ...(body.dueAt ? { dueAt: new Date(body.dueAt), escalationLevel: 0 } : {}),
    },
    event: { kind: 'STATUS', note: body.reason },
  }));

export async function addComment(
  deps: TaskDeps,
  tenant: TenantContext,
  taskId: string,
  body: z.output<typeof TaskCommentBody>,
) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    const task = await loadVisible(tx, tenant, taskId);
    const fileIds = await linkFiles(tx, task.id, body.fileIds, 'fileIds');
    await tx.task.update({
      where: { id: task.id },
      data: {
        events: {
          create: {
            kind: body.note ? 'COMMENT' : 'ATTACH',
            note: body.note ?? null,
            fileIds,
            byUserId: tenant.userId,
          },
        },
      },
    });
    return detailOf(tx, tenant, task.id, now);
  });
}
