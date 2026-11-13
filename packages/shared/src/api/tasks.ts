import { z } from 'zod';
import { FAULT_CATEGORIES, PRIORITIES, TASK_ACTIONS, TASK_STATUSES, TASK_TYPES } from '../tasks.ts';
import { defineRoute } from './contract.ts';
import { AssetRef, WorkOrderItem } from './maintenance.ts';
import { Instant, IsoDate, page, PageQuery, Uuid } from './primitives.ts';

// Tasks (PRD M6-01–M6-05, M6 rules 1–2, M5-07, M5 rule 3; tab 4 row "Tasks"; S18 tasks queue
// and detail, S19 QR fault report; T-082). A task starts from a template, is triaged and
// assigned by a manager, worked by its assignee (acknowledge, start, hold, resolve with
// evidence) and verified or reopened by a manager. A worker job escalates tasks past their
// deadline, once per level. Any member reports a fault by scanning the room's QR code.

const Person = z.object({ id: Uuid, name: z.string() });
const Department = z.object({ id: Uuid, code: z.string(), name: z.string() });
const FileIds = z.array(Uuid).max(5);

export const TaskTemplateItem = z
  .object({
    id: Uuid,
    type: z.enum(TASK_TYPES),
    name: z.string(),
    department: Department,
    priority: z.enum(PRIORITIES),
    slaMinutes: z.number().int().nullable(),
    active: z.boolean(),
  })
  .meta({ id: 'TaskTemplate' });

export const TaskItem = z
  .object({
    id: Uuid,
    number: z.number().int(),
    type: z.enum(TASK_TYPES),
    template: z.object({ id: Uuid, name: z.string() }).nullable(),
    title: z.string(),
    description: z.string().nullable(),
    department: Department,
    priority: z.enum(PRIORITIES),
    status: z.enum(TASK_STATUSES),
    room: z.object({ id: Uuid, number: z.string() }).nullable(),
    /** The asset the job is on (T-130). */
    asset: AssetRef.nullable(),
    stayId: Uuid.nullable(),
    guest: Person.nullable(),
    reportedBy: Person.nullable(),
    assignee: Person.nullable(),
    dueAt: Instant.nullable(),
    /** Open and past its deadline. */
    overdue: z.boolean(),
    escalationLevel: z.number().int(),
    acknowledgedAt: Instant.nullable(),
    resolvedAt: Instant.nullable(),
    verifiedBy: Person.nullable(),
    createdAt: Instant,
  })
  .meta({ id: 'Task' });

export const TaskEventItem = z
  .object({
    id: z.string(),
    /** STATUS | COMMENT | ASSIGN | ESCALATE | ATTACH */
    kind: z.string(),
    fromStatus: z.enum(TASK_STATUSES).nullable(),
    toStatus: z.enum(TASK_STATUSES).nullable(),
    note: z.string().nullable(),
    fileIds: z.array(Uuid),
    by: Person.nullable(),
    at: Instant,
  })
  .meta({ id: 'TaskEvent' });

export const TaskDetail = TaskItem.extend({
  events: z.array(TaskEventItem),
  /** What the signed-in user may do with the task now. */
  actions: z.array(z.enum(TASK_ACTIONS)),
  /** Whether the signed-in user may comment. */
  canComment: z.boolean(),
  /** Parts, time and outside cost logged on the job (M5-08; T-130), if any. */
  workOrder: WorkOrderItem.nullable(),
  /** Whether the signed-in user may log parts, time and cost now (T-130). */
  canLogWork: z.boolean(),
}).meta({ id: 'TaskDetail' });

export const listTasks = defineRoute({
  operationId: 'listTasks',
  method: 'get',
  path: '/tasks',
  summary: 'The task queue, newest first',
  description:
    'Managers (task.assign or task.verify) see every task of the property; everyone else sees ' +
    'the tasks they reported or were given. `status=open` lists unfinished tasks.',
  tags: ['Tasks'],
  propertyScoped: true,
  query: PageQuery.extend({
    status: z.enum(['open', ...TASK_STATUSES]).optional(),
    assignee: z.enum(['me']).optional(),
    departmentId: Uuid.optional(),
    type: z.enum(TASK_TYPES).optional(),
    roomId: Uuid.optional(),
    assetId: Uuid.optional(),
    overdue: z.enum(['true']).optional(),
  }),
  response: page(TaskItem),
});

export const CreateTaskBody = z
  .object({
    templateId: Uuid.optional(),
    /** Without a template: the type and department are needed. */
    type: z.enum(TASK_TYPES).optional(),
    departmentId: Uuid.optional(),
    /** Defaults to the template's name (and the room). */
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).optional(),
    priority: z.enum(PRIORITIES).optional(),
    roomId: Uuid.optional(),
    /** The asset the job is on (T-130). */
    assetId: Uuid.optional(),
    stayId: Uuid.optional(),
    guestId: Uuid.optional(),
    /** Managers only (task.assign): who does it and by when. */
    assigneeId: Uuid.optional(),
    dueAt: Instant.optional(),
    fileIds: FileIds.optional(),
  })
  .refine((b) => b.templateId || (b.type && b.departmentId && b.title), {
    message: 'Choose a template, or give a type, department and title',
  });

export const createTask = defineRoute({
  operationId: 'createTask',
  method: 'post',
  path: '/tasks',
  summary: 'Create a task, usually from a template (M6-01)',
  description:
    'Needs task.create or task.report (any staff). Choosing the assignee or deadline needs ' +
    'task.assign; otherwise the deadline is the template SLA from now.',
  tags: ['Tasks'],
  propertyScoped: true,
  idempotent: true,
  status: 201,
  body: CreateTaskBody,
  response: TaskDetail,
});

export const getTask = defineRoute({
  operationId: 'getTask',
  method: 'get',
  path: '/tasks/{taskId}',
  summary: 'A task with its timeline and the actions open to you',
  tags: ['Tasks'],
  propertyScoped: true,
  params: z.object({ taskId: Uuid }),
  response: TaskDetail,
});

const TaskParams = z.object({ taskId: Uuid });
const Reason = z.string().trim().min(3).max(1000);

export const AssignTaskBody = z
  .object({
    /** Null triages the task without an assignee. */
    assigneeId: Uuid.nullable(),
    priority: z.enum(PRIORITIES).optional(),
    dueAt: Instant.nullable().optional(),
  })
  .meta({ id: 'AssignTaskBody' });

export const assignTask = defineRoute({
  operationId: 'assignTask',
  method: 'post',
  path: '/tasks/{taskId}/assign',
  summary: 'Triage and assign a task: assignee, priority, deadline (M6-02)',
  tags: ['Tasks'],
  propertyScoped: true,
  permission: 'task.assign',
  idempotent: true,
  params: TaskParams,
  body: AssignTaskBody,
  response: TaskDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const acknowledgeTask = defineRoute({
  operationId: 'acknowledgeTask',
  method: 'post',
  path: '/tasks/{taskId}/acknowledge',
  summary: 'Accept an assigned task (M6-03)',
  description: 'The assignee (task.work), or a manager with task.assign.',
  tags: ['Tasks'],
  propertyScoped: true,
  permission: 'task.work',
  idempotent: true,
  params: TaskParams,
  response: TaskDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const startTask = defineRoute({
  operationId: 'startTask',
  method: 'post',
  path: '/tasks/{taskId}/start',
  summary: 'Start (or resume) work on a task (M6-03)',
  description: 'The assignee (task.work), or a manager with task.assign.',
  tags: ['Tasks'],
  propertyScoped: true,
  permission: 'task.work',
  idempotent: true,
  params: TaskParams,
  response: TaskDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const HoldTaskBody = z.object({ reason: Reason });

export const holdTask = defineRoute({
  operationId: 'holdTask',
  method: 'post',
  path: '/tasks/{taskId}/hold',
  summary: 'Put a task on hold, with the reason (M6-03)',
  description: 'The assignee (task.work), or a manager with task.assign.',
  tags: ['Tasks'],
  propertyScoped: true,
  permission: 'task.work',
  idempotent: true,
  params: TaskParams,
  body: HoldTaskBody,
  response: TaskDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const ResolveTaskBody = z.object({
  /** The evidence: what was done. */
  note: Reason,
  /** Photos of the fix. */
  fileIds: FileIds.optional(),
});

export const resolveTask = defineRoute({
  operationId: 'resolveTask',
  method: 'post',
  path: '/tasks/{taskId}/resolve',
  summary: 'Resolve a task with evidence: what was done, and photos (M6-03)',
  description: 'The assignee (task.work), or a manager with task.assign.',
  tags: ['Tasks'],
  propertyScoped: true,
  permission: 'task.work',
  idempotent: true,
  params: TaskParams,
  body: ResolveTaskBody,
  response: TaskDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const verifyTask = defineRoute({
  operationId: 'verifyTask',
  method: 'post',
  path: '/tasks/{taskId}/verify',
  summary: 'Confirm a resolved task is done (M6-04)',
  tags: ['Tasks'],
  propertyScoped: true,
  permission: 'task.verify',
  idempotent: true,
  params: TaskParams,
  body: z.object({ note: z.string().trim().max(1000).optional() }),
  response: TaskDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const ReopenTaskBody = z.object({
  reason: Reason,
  /** A new deadline; the old one stays otherwise. */
  dueAt: Instant.optional(),
});

export const reopenTask = defineRoute({
  operationId: 'reopenTask',
  method: 'post',
  path: '/tasks/{taskId}/reopen',
  summary: 'Send a resolved task back to its assignee, with the reason (M6-04)',
  tags: ['Tasks'],
  propertyScoped: true,
  permission: 'task.verify',
  idempotent: true,
  params: TaskParams,
  body: ReopenTaskBody,
  response: TaskDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const TaskCommentBody = z
  .object({
    note: z.string().trim().max(2000).optional(),
    fileIds: FileIds.optional(),
  })
  .refine((b) => Boolean(b.note) || Boolean(b.fileIds?.length), {
    message: 'Write a comment or add a photo',
  });

export const addTaskComment = defineRoute({
  operationId: 'addTaskComment',
  method: 'post',
  path: '/tasks/{taskId}/comments',
  summary: 'Comment on a task or add photos (M6-03)',
  description: 'Anyone who can see the task.',
  tags: ['Tasks'],
  propertyScoped: true,
  idempotent: true,
  status: 201,
  params: TaskParams,
  body: TaskCommentBody,
  response: TaskDetail,
});

export const getTaskFormOptions = defineRoute({
  operationId: 'getTaskFormOptions',
  method: 'get',
  path: '/tasks/form-options',
  summary: 'Departments, rooms and assignees for the task forms',
  description:
    'Added beyond tab 4 (T-082): what the S18 forms choose from. Assignees (members with ' +
    'task.work) are listed only for task.assign.',
  tags: ['Tasks'],
  propertyScoped: true,
  response: z.object({
    departments: z.array(Department),
    rooms: z.array(z.object({ id: Uuid, number: z.string(), floor: z.string().nullable() })),
    assignees: z.array(Person.extend({ department: z.string().nullable() })),
  }),
});

export const listTaskTemplates = defineRoute({
  operationId: 'listTaskTemplates',
  method: 'get',
  path: '/task-templates',
  summary: 'Task templates of the property (M6-01)',
  description: 'Every property starts with the default set (guest request, complaint, fault, …).',
  tags: ['Tasks'],
  propertyScoped: true,
  response: z.object({ data: z.array(TaskTemplateItem) }),
});

export const TaskTemplateBody = z.object({
  type: z.enum(TASK_TYPES),
  name: z.string().trim().min(1).max(80),
  departmentId: Uuid,
  priority: z.enum(PRIORITIES).default('NORMAL'),
  slaMinutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 14)
    .nullable()
    .default(null),
});

export const createTaskTemplate = defineRoute({
  operationId: 'createTaskTemplate',
  method: 'post',
  path: '/task-templates',
  summary: 'Add a task template',
  tags: ['Tasks'],
  propertyScoped: true,
  permission: 'task.assign',
  idempotent: true,
  status: 201,
  body: TaskTemplateBody,
  response: TaskTemplateItem,
});

const QrParams = z.object({ token: z.string().trim().min(8).max(64) });

export const getQrRoom = defineRoute({
  operationId: 'getQrRoom',
  method: 'get',
  path: '/qr/{token}',
  summary: 'The room behind a QR sticker, to pre-fill the fault report (S19)',
  description: 'Added beyond tab 4 (T-082): S19 shows the location before the report is sent.',
  tags: ['Tasks'],
  propertyScoped: true,
  permission: 'task.report',
  params: QrParams,
  response: z.object({
    roomId: Uuid,
    number: z.string(),
    floor: z.string().nullable(),
    roomType: z.string(),
    hkStatus: z.string(),
    /** Property date: the first night a new out-of-order block can start. */
    today: IsoDate,
  }),
});

export const QrFaultBody = z.object({
  category: z.enum(FAULT_CATEGORIES),
  severity: z.enum(PRIORITIES),
  description: z.string().trim().max(2000).optional(),
  fileIds: FileIds.optional(),
  /**
   * CRITICAL only (M5 rule 3): take the room out of order from today until this date
   * (exclusive), in the same request.
   */
  outOfOrderUntil: IsoDate.optional(),
});

export const reportQrFault = defineRoute({
  operationId: 'reportQrFault',
  method: 'post',
  path: '/qr/{token}/report',
  summary: 'Report a fault in the room behind a QR sticker (M5-07)',
  description:
    'Any member (task.report). Makes a FAULT task for maintenance. A CRITICAL fault may take ' +
    'the room out of order at once (M5 rule 3; it leaves availability in the same request) and ' +
    'tells the general manager. If the room cannot be blocked (a guest is in it), the task is ' +
    'still made and `outOfOrder.blocked` is false with the reason.',
  tags: ['Tasks'],
  propertyScoped: true,
  permission: 'task.report',
  idempotent: true,
  status: 201,
  params: QrParams,
  body: QrFaultBody,
  response: z.object({
    task: TaskDetail,
    outOfOrder: z
      .object({ blocked: z.boolean(), until: IsoDate, reason: z.string().nullable() })
      .nullable(),
  }),
});

export const TASK_ROUTES = {
  listTasks,
  createTask,
  getTaskFormOptions,
  getTask,
  assignTask,
  acknowledgeTask,
  startTask,
  holdTask,
  resolveTask,
  verifyTask,
  reopenTask,
  addTaskComment,
  listTaskTemplates,
  createTaskTemplate,
  getQrRoom,
  reportQrFault,
} as const;
