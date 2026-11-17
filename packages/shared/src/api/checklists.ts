import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';

// Recurring checklists (PRD M6-13 "As a manager, I create recurring checklists (opening checks,
// fire equipment, pool) with schedule and assignee", checklist.manage; tab 3 lists checklists
// and checklist_runs for V1.1 without columns; no tab 4 row or screen; T-134). A checklist
// comes due every day, on one weekday or on one day of the month, by a local time. Each day it
// is due it gets a run: a copy of its checks for that day, given to its assignee or, with none,
// open to anyone who works tasks. The run is done by answering every check OK or a problem
// (with a note); problems open one task for the checklist's department. A run not done by the
// end of its day is MISSED and stays so.

export const CHECKLIST_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type ChecklistFrequency = (typeof CHECKLIST_FREQUENCIES)[number];
export const CHECKLIST_RUN_STATUSES = ['PENDING', 'DONE', 'MISSED'] as const;
export type ChecklistRunStatus = (typeof CHECKLIST_RUN_STATUSES)[number];
export const MAX_CHECKLIST_ITEMS = 50;

/** ISO weekday of a YYYY-MM-DD date: 1 Monday … 7 Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Whether a checklist with this schedule is due on a date. */
export function checklistDueOn(
  schedule: { frequency: ChecklistFrequency; weekday: number | null; monthDay: number | null },
  date: string,
): boolean {
  if (schedule.frequency === 'DAILY') return true;
  if (schedule.frequency === 'WEEKLY') return isoWeekday(date) === schedule.weekday;
  return Number(date.slice(8, 10)) === schedule.monthDay;
}

const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
const Person = z.object({ id: Uuid, name: z.string() });
const Time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 07:30')
  .meta({ example: '07:30' });
const Items = z
  .array(Text(1, 200))
  .min(1, 'Add at least one check')
  .max(MAX_CHECKLIST_ITEMS, `At most ${MAX_CHECKLIST_ITEMS} checks`);

export const ChecklistItem = z
  .object({
    id: Uuid,
    name: z.string(),
    department: z.object({ id: Uuid, name: z.string() }),
    items: z.array(z.string()),
    frequency: z.enum(CHECKLIST_FREQUENCIES),
    weekday: z.number().int().nullable(),
    monthDay: z.number().int().nullable(),
    dueTime: z.string(),
    assignee: Person.nullable(),
    active: z.boolean(),
    /** The last run, if any. */
    lastRun: z
      .object({
        dueOn: IsoDate,
        status: z.enum(CHECKLIST_RUN_STATUSES),
        problems: z.number().int(),
      })
      .nullable(),
    /** Runs missed in the last 30 days. */
    missed30: z.number().int(),
  })
  .meta({ id: 'Checklist' });

const Schedule = {
  frequency: z.enum(CHECKLIST_FREQUENCIES),
  /** 1 Monday … 7 Sunday, for WEEKLY. */
  weekday: z.number().int().min(1).max(7).nullable().default(null),
  /** 1 to 28, for MONTHLY (every month has these days). */
  monthDay: z.number().int().min(1).max(28).nullable().default(null),
  dueTime: Time.default('23:59'),
};

function scheduleIssues(
  v: { frequency?: ChecklistFrequency; weekday?: number | null; monthDay?: number | null },
  ctx: z.RefinementCtx,
) {
  if (v.frequency === 'WEEKLY' && (v.weekday ?? null) === null) {
    ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'Choose the day of the week' });
  }
  if (v.frequency === 'MONTHLY' && (v.monthDay ?? null) === null) {
    ctx.addIssue({ code: 'custom', path: ['monthDay'], message: 'Choose the day of the month' });
  }
}

export const ChecklistBody = z
  .object({
    name: Text(1, 120),
    departmentId: Uuid,
    items: Items,
    ...Schedule,
    assigneeId: Uuid.nullable().default(null),
  })
  .superRefine(scheduleIssues)
  .meta({ id: 'ChecklistBody' });

export const ChecklistPatch = z
  .object({
    name: Text(1, 120).optional(),
    departmentId: Uuid.optional(),
    items: Items.optional(),
    frequency: z.enum(CHECKLIST_FREQUENCIES).optional(),
    weekday: z.number().int().min(1).max(7).nullable().optional(),
    monthDay: z.number().int().min(1).max(28).nullable().optional(),
    dueTime: Time.optional(),
    assigneeId: Uuid.nullable().optional(),
    active: z.boolean().optional(),
  })
  .superRefine(scheduleIssues)
  .meta({ id: 'ChecklistPatch' });

export const ChecklistResult = z.object({
  item: z.string(),
  ok: z.boolean(),
  note: z.string().nullable(),
});

export const ChecklistRunItem = z
  .object({
    id: Uuid,
    checklist: z.object({ id: Uuid, name: z.string(), department: z.string() }),
    dueOn: IsoDate,
    dueAt: Instant,
    items: z.array(z.string()),
    assignee: Person.nullable(),
    status: z.enum(CHECKLIST_RUN_STATUSES),
    results: z.array(ChecklistResult),
    problems: z.number().int(),
    task: z.object({ id: Uuid, number: z.number().int() }).nullable(),
    completedBy: Person.nullable(),
    completedAt: Instant.nullable(),
    /** Still to do after its due time. */
    overdue: z.boolean(),
    /** Whether the caller may do this run. */
    canComplete: z.boolean(),
  })
  .meta({ id: 'ChecklistRun' });

export const CompleteRunBody = z
  .object({
    /** One answer per check, in order. */
    results: z
      .array(
        z.object({
          ok: z.boolean(),
          note: z
            .string()
            .trim()
            .max(500)
            .transform((v) => (v === '' ? null : v))
            .nullable()
            .default(null),
        }),
      )
      .min(1)
      .max(MAX_CHECKLIST_ITEMS),
  })
  .superRefine((v, ctx) => {
    v.results.forEach((r, i) => {
      if (!r.ok && !r.note) {
        ctx.addIssue({
          code: 'custom',
          path: ['results', i, 'note'],
          message: 'Say what is wrong',
        });
      }
    });
  })
  .meta({ id: 'CompleteRunBody' });

const ADDED = 'Added beyond tab 4 (T-134).';
const MANAGE = {
  tags: ['Checklists'],
  propertyScoped: true as const,
  permission: 'checklist.manage',
};
const WORK = { tags: ['Checklists'], propertyScoped: true as const };

export const listChecklists = defineRoute({
  ...MANAGE,
  operationId: 'listChecklists',
  method: 'get',
  path: '/checklists',
  summary: 'Recurring checklists (M6-13)',
  description: ADDED,
  response: z.object({
    data: z.array(ChecklistItem),
    departments: z.array(z.object({ id: Uuid, name: z.string() })),
    /** People a checklist can be given to (they work tasks). */
    assignees: z.array(Person),
    today: IsoDate,
  }),
});

export const createChecklist = defineRoute({
  ...MANAGE,
  operationId: 'createChecklist',
  method: 'post',
  path: '/checklists',
  summary: 'Create a recurring checklist with schedule and assignee (M6-13)',
  description: `${ADDED} If it is due today, today's run is made at once.`,
  idempotent: true,
  status: 201,
  body: ChecklistBody,
  response: ChecklistItem,
});

export const updateChecklist = defineRoute({
  ...MANAGE,
  operationId: 'updateChecklist',
  method: 'patch',
  path: '/checklists/{checklistId}',
  summary: 'Change, pause or resume a checklist (M6-13)',
  description: `${ADDED} Runs already made keep their checks and assignee.`,
  params: z.object({ checklistId: Uuid }),
  body: ChecklistPatch,
  response: ChecklistItem,
});

export const listChecklistRuns = defineRoute({
  ...WORK,
  operationId: 'listChecklistRuns',
  method: 'get',
  path: '/checklist-runs',
  summary: "A day's checklist runs (M6-13)",
  description:
    `${ADDED} Managers (checklist.manage) see every run; people who work tasks see runs ` +
    'given to them and runs given to no one. Defaults to today.',
  query: z.object({ date: IsoDate.optional() }),
  response: z.object({ data: z.array(ChecklistRunItem), date: IsoDate, today: IsoDate }),
});

export const completeChecklistRun = defineRoute({
  ...WORK,
  operationId: 'completeChecklistRun',
  method: 'post',
  path: '/checklist-runs/{runId}/complete',
  summary: 'Answer every check of a run; problems open a task (M6-13)',
  description:
    `${ADDED} Its assignee, anyone who works tasks when it has none, or a manager. ` +
    'A missed run cannot be done late.',
  idempotent: true,
  params: z.object({ runId: Uuid }),
  body: CompleteRunBody,
  response: ChecklistRunItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const CHECKLISTS_ROUTES = {
  listChecklists,
  createChecklist,
  updateChecklist,
  listChecklistRuns,
  completeChecklistRun,
} as const;
