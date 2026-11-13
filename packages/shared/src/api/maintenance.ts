import { z } from 'zod';
import { TASK_STATUSES } from '../tasks.ts';
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

export const MAINTENANCE_ROUTES = {
  listAssets,
  createAsset,
  getAsset,
  updateAsset,
  saveWorkOrder,
} as const;
