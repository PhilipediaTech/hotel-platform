import { z } from 'zod';
import { addDays } from '../dates.ts';
import { PRIORITIES, TASK_STATUSES } from '../tasks.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';

// Maintenance (PRD M5-08 "As maintenance, I work a work order through its states, log parts
// and time, and attach after photos", wo.work; M5-09 "As a manager, I keep an asset register
// with location, serial, warranty, vendor and service history", asset.manage; tab 3 assets,
// work_order_details; tab 4 row "Maintenance"; S34 /maintenance; T-130). A work order is a task
// (its states, assignee and after photos are the task engine's, T-082) with parts, time and
// outside cost logged against it, usually on an asset. An asset's service history is the
// tasks on it.

export const ASSET_STATUSES = ['IN_SERVICE', 'OUT_OF_SERVICE', 'RETIRED'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
/** Offered when adding an asset; any other category can be typed. */
export const ASSET_CATEGORIES = [
  'Air conditioning',
  'Generator',
  'Electrical',
  'Plumbing',
  'Kitchen',
  'Laundry',
  'Furniture',
  'Lift',
  'Vehicle',
  'IT and TV',
  'Security',
] as const;

const NonNegative = AmountMinor.refine((a) => !a.startsWith('-'), 'Cannot be negative');
const Optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();

export const AssetRef = z.object({ id: Uuid, tag: z.string(), name: z.string() });

export const AssetItem = z
  .object({
    id: Uuid,
    tag: z.string(),
    name: z.string(),
    category: z.string(),
    location: z.string().nullable(),
    room: z.object({ id: Uuid, number: z.string() }).nullable(),
    serial: z.string().nullable(),
    vendor: z.string().nullable(),
    warrantyUntil: IsoDate.nullable(),
    /** Under warranty on the property's date today. */
    underWarranty: z.boolean(),
    costMinor: AmountMinor.nullable(),
    status: z.enum(ASSET_STATUSES),
    /** Unfinished tasks on it. */
    openJobs: z.number().int(),
  })
  .meta({ id: 'Asset' });

export const ServiceRecord = z
  .object({
    taskId: Uuid,
    number: z.number().int(),
    title: z.string(),
    type: z.string(),
    status: z.enum(TASK_STATUSES),
    createdAt: Instant,
    resolvedAt: Instant.nullable(),
    assignee: z.object({ id: Uuid, name: z.string() }).nullable(),
    labourMinutes: z.number().int(),
    costMinor: AmountMinor,
  })
  .meta({ id: 'ServiceRecord' });

export const AssetDetail = AssetItem.extend({
  /** Its tasks, newest first. */
  history: z.array(ServiceRecord),
  totals: z.object({
    jobs: z.number().int(),
    labourMinutes: z.number().int(),
    costMinor: AmountMinor,
  }),
}).meta({ id: 'AssetDetail' });

export const AssetBody = z.object({
  /** The label stuck on it, unique in the property. */
  tag: z.string().trim().min(1).max(30),
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(40),
  location: Optional(120).default(null),
  roomId: Uuid.nullable().default(null),
  serial: Optional(80).default(null),
  vendor: Optional(120).default(null),
  warrantyUntil: IsoDate.nullable().default(null),
  costMinor: NonNegative.nullable().default(null),
  status: z.enum(ASSET_STATUSES).default('IN_SERVICE'),
});

export const AssetPatch = z
  .object({
    tag: z.string().trim().min(1).max(30).optional(),
    name: z.string().trim().min(2).max(120).optional(),
    category: z.string().trim().min(2).max(40).optional(),
    location: Optional(120).optional(),
    roomId: Uuid.nullable().optional(),
    serial: Optional(80).optional(),
    vendor: Optional(120).optional(),
    warrantyUntil: IsoDate.nullable().optional(),
    costMinor: NonNegative.nullable().optional(),
    status: z.enum(ASSET_STATUSES).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });

const COMMON = { tags: ['Maintenance'], propertyScoped: true as const };
const AssetParams = z.object({ assetId: Uuid });

export const listAssets = defineRoute({
  ...COMMON,
  operationId: 'listAssets',
  method: 'get',
  path: '/assets',
  summary: 'The asset register (M5-09)',
  description: 'Needs asset.manage, or wo.work to pick the asset a job is on.',
  query: z.object({
    q: z.string().trim().max(80).optional(),
    status: z.enum(ASSET_STATUSES).optional(),
    category: z.string().trim().max(40).optional(),
    roomId: Uuid.optional(),
  }),
  response: z.object({ data: z.array(AssetItem), categories: z.array(z.string()) }),
});

export const createAsset = defineRoute({
  ...COMMON,
  operationId: 'createAsset',
  method: 'post',
  path: '/assets',
  summary: 'Add an asset to the register (M5-09)',
  permission: 'asset.manage',
  idempotent: true,
  status: 201,
  body: AssetBody,
  response: AssetDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const getAsset = defineRoute({
  ...COMMON,
  operationId: 'getAsset',
  method: 'get',
  path: '/assets/{assetId}',
  summary: 'An asset with its service history (M5-09)',
  description: 'Added beyond tab 4 (T-130). Needs asset.manage or wo.work.',
  params: AssetParams,
  response: AssetDetail,
});

export const updateAsset = defineRoute({
  ...COMMON,
  operationId: 'updateAsset',
  method: 'patch',
  path: '/assets/{assetId}',
  summary: 'Change an asset: location, warranty, status… (M5-09)',
  description: 'Added beyond tab 4 (T-130).',
  permission: 'asset.manage',
  params: AssetParams,
  body: AssetPatch,
  response: AssetDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const WorkOrderPart = z.object({
  name: z.string().trim().min(1).max(80),
  quantity: z.number().int().min(1).max(999),
  /** The line total. */
  costMinor: NonNegative,
});

export const WorkOrderItem = z
  .object({
    parts: z.array(WorkOrderPart),
    labourMinutes: z.number().int(),
    vendorName: z.string().nullable(),
    partsCostMinor: AmountMinor,
    vendorCostMinor: AmountMinor,
    /** Parts plus the vendor's charge. */
    costMinor: AmountMinor,
  })
  .meta({ id: 'WorkOrder' });

export const WorkOrderBody = z
  .object({
    parts: z.array(WorkOrderPart).max(30),
    labourMinutes: z
      .number()
      .int()
      .min(0)
      .max(60 * 24 * 30),
    vendorName: Optional(120),
    vendorCostMinor: NonNegative,
    /** The asset the job is on; null takes it off. Left out, it stays. */
    assetId: Uuid.nullable().optional(),
  })
  .refine((b) => b.vendorName !== null || b.vendorCostMinor === '0', {
    path: ['vendorName'],
    message: 'Name the vendor you paid',
  });

export const saveWorkOrder = defineRoute({
  ...COMMON,
  operationId: 'saveWorkOrder',
  method: 'post',
  path: '/work-orders/{taskId}/detail',
  summary: 'Log the parts, time and outside cost of a job, and the asset it is on (M5-08)',
  description:
    'Replaces what was logged. The assignee (wo.work) or a manager with task.assign, until the ' +
    'task is verified. States and after photos are the task routes (start, hold, resolve with ' +
    'photos).',
  permission: 'wo.work',
  idempotent: true,
  params: z.object({ taskId: Uuid }),
  body: WorkOrderBody,
  // The task with its work order (TaskDetail); typed loosely here to keep the modules apart.
  response: z.object({ taskId: Uuid, workOrder: WorkOrderItem, asset: AssetRef.nullable() }),
  errors: ['STATE_TRANSITION_INVALID'],
});

// ── Preventive maintenance (M5-10 "As a manager, I schedule preventive maintenance by calendar
// or run hours", pm.manage; S34 PM calendar; T-131) ────────────────────────────────────────
// A plan comes due by the calendar (every N days from its due date) or by run hours (every N
// hours on its asset's hour meter). When it is due within its lead (days or hours ahead), the
// worker opens one maintenance task for it; verifying that task moves the plan on: the next
// date counts from the day it was done, the next service from the meter reading then.

export const PM_TRIGGERS = ['CALENDAR', 'RUN_HOURS'] as const;
export type PmTrigger = (typeof PM_TRIGGERS)[number];
export const PM_DUE_STATES = ['OK', 'DUE_SOON', 'OVERDUE'] as const;
export type PmDueState = (typeof PM_DUE_STATES)[number];

/** Where a plan stands today: OVERDUE past its date or hours, DUE_SOON within its lead. */
export function pmDueState(
  plan: {
    trigger: PmTrigger;
    nextDueOn: string | null;
    leadDays: number;
    hoursLeft: number | null;
    leadHours: number;
  },
  today: string,
): PmDueState {
  if (plan.trigger === 'CALENDAR') {
    if (!plan.nextDueOn) return 'OK';
    if (plan.nextDueOn < today) return 'OVERDUE';
    return plan.nextDueOn <= addDays(today, plan.leadDays) ? 'DUE_SOON' : 'OK';
  }
  if (plan.hoursLeft === null) return 'OK';
  if (plan.hoursLeft <= 0) return 'OVERDUE';
  return plan.hoursLeft <= plan.leadHours ? 'DUE_SOON' : 'OK';
}

/** The dates a calendar plan falls on from `from` to `to`: its next date, then every N days. */
export function pmOccurrences(
  nextDueOn: string,
  everyDays: number,
  from: string,
  to: string,
): string[] {
  const out: string[] = [];
  if (everyDays < 1) return out;
  for (let d = nextDueOn; d <= to && out.length < 400; d = addDays(d, everyDays)) {
    if (d >= from) out.push(d);
  }
  return out;
}

const Hours = z.number().int().min(0).max(1_000_000);

export const PreventivePlanItem = z
  .object({
    id: Uuid,
    title: z.string(),
    instructions: z.string().nullable(),
    asset: AssetRef.nullable(),
    trigger: z.enum(PM_TRIGGERS),
    everyDays: z.number().int().nullable(),
    everyHours: z.number().int().nullable(),
    leadDays: z.number().int(),
    leadHours: z.number().int(),
    /** Calendar plans: the next date it is due. */
    nextDueOn: IsoDate.nullable(),
    lastDoneOn: IsoDate.nullable(),
    /** Run-hours plans: the latest meter reading, and the reading at the last service. */
    meterHours: z.number().int().nullable(),
    meterReadAt: Instant.nullable(),
    lastServiceHours: z.number().int().nullable(),
    /** Run hours until the next service (negative when past it). */
    hoursLeft: z.number().int().nullable(),
    dueState: z.enum(PM_DUE_STATES),
    assignee: z.object({ id: Uuid, name: z.string() }).nullable(),
    priority: z.enum(PRIORITIES),
    active: z.boolean(),
    /** The job open for it now. */
    openTask: z
      .object({ id: Uuid, number: z.number().int(), status: z.enum(TASK_STATUSES) })
      .nullable(),
  })
  .meta({ id: 'PreventivePlan' });

export const PreventivePlanBody = z
  .object({
    title: z.string().trim().min(3).max(120),
    instructions: Optional(2000).default(null),
    assetId: Uuid.nullable().default(null),
    trigger: z.enum(PM_TRIGGERS),
    everyDays: z.number().int().min(1).max(3660).nullable().default(null),
    everyHours: z.number().int().min(1).max(100_000).nullable().default(null),
    /** Calendar: the first date it is due. */
    firstDueOn: IsoDate.nullable().default(null),
    /** Run hours: the meter reading at the last service, and now (defaults to the same). */
    lastServiceHours: Hours.nullable().default(null),
    meterHours: Hours.nullable().default(null),
    leadDays: z.number().int().min(0).max(90).default(3),
    leadHours: z.number().int().min(0).max(10_000).default(10),
    assigneeId: Uuid.nullable().default(null),
    priority: z.enum(PRIORITIES).default('NORMAL'),
  })
  .superRefine((b, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (b.trigger === 'CALENDAR') {
      need(b.everyDays !== null, 'everyDays', 'How many days between services?');
      need(b.firstDueOn !== null, 'firstDueOn', 'When is it first due?');
      need(b.everyHours === null, 'everyHours', 'A calendar plan has no run hours');
    } else {
      need(b.everyHours !== null, 'everyHours', 'How many run hours between services?');
      need(b.assetId !== null, 'assetId', 'Run hours are counted on an asset: choose one');
      need(b.lastServiceHours !== null, 'lastServiceHours', 'Enter the hours at the last service');
      need(b.everyDays === null, 'everyDays', 'A run-hours plan has no day interval');
      need(
        b.meterHours === null || b.lastServiceHours === null || b.meterHours >= b.lastServiceHours,
        'meterHours',
        'The meter cannot read less than at the last service',
      );
    }
  });

export const PreventivePlanPatch = z
  .object({
    title: z.string().trim().min(3).max(120).optional(),
    instructions: Optional(2000).optional(),
    everyDays: z.number().int().min(1).max(3660).optional(),
    everyHours: z.number().int().min(1).max(100_000).optional(),
    /** Calendar: move the next date. */
    nextDueOn: IsoDate.optional(),
    leadDays: z.number().int().min(0).max(90).optional(),
    leadHours: z.number().int().min(0).max(10_000).optional(),
    assigneeId: Uuid.nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    /** Paused plans open no jobs. */
    active: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });

export const PlanHoursBody = z.object({ hours: Hours });

const PlanParams = z.object({ planId: Uuid });

export const listPreventivePlans = defineRoute({
  ...COMMON,
  operationId: 'listPreventivePlans',
  method: 'get',
  path: '/preventive-plans',
  summary: 'Preventive maintenance plans and when each is due (M5-10)',
  permission: 'pm.manage',
  query: z.object({
    assetId: Uuid.optional(),
    trigger: z.enum(PM_TRIGGERS).optional(),
    active: z.enum(['true', 'false']).optional(),
  }),
  response: z.object({ data: z.array(PreventivePlanItem), today: IsoDate }),
});

export const createPreventivePlan = defineRoute({
  ...COMMON,
  operationId: 'createPreventivePlan',
  method: 'post',
  path: '/preventive-plans',
  summary: 'Plan preventive maintenance by calendar or run hours (M5-10)',
  description: 'A plan already due opens its job at once.',
  permission: 'pm.manage',
  idempotent: true,
  status: 201,
  body: PreventivePlanBody,
  response: PreventivePlanItem,
});

export const updatePreventivePlan = defineRoute({
  ...COMMON,
  operationId: 'updatePreventivePlan',
  method: 'patch',
  path: '/preventive-plans/{planId}',
  summary: 'Change, pause or resume a preventive plan (M5-10)',
  description: 'Added beyond tab 4 (T-131).',
  permission: 'pm.manage',
  params: PlanParams,
  body: PreventivePlanPatch,
  response: PreventivePlanItem,
});

export const recordPlanHours = defineRoute({
  ...COMMON,
  operationId: 'recordPlanHours',
  method: 'post',
  path: '/preventive-plans/{planId}/hours',
  summary: 'Record the hour-meter reading of a run-hours plan (M5-10)',
  description:
    'Added beyond tab 4 (T-131). A reading that brings the plan within its lead opens its job.',
  permission: 'pm.manage',
  idempotent: true,
  params: PlanParams,
  body: PlanHoursBody,
  response: PreventivePlanItem,
});

export const MAINTENANCE_ROUTES = {
  listAssets,
  createAsset,
  getAsset,
  updateAsset,
  saveWorkOrder,
  listPreventivePlans,
  createPreventivePlan,
  updatePreventivePlan,
  recordPlanHours,
} as const;
