import {
  ASSET_CATEGORIES,
  OPEN_TASK_STATUSES,
  type AssetBody,
  type AssetDetail,
  type AssetItem,
  type AssetPatch,
  type AssetStatus,
  type WorkOrderBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { propertyToday } from '../availability/inventory.ts';
import { loadVisible, mayLogWork, workOrderItem } from '../tasks/service.ts';

// Maintenance (PRD M5-08, M5-09; tab 3 assets, work_order_details; tab 4 row "Maintenance";
// S34; T-130). The asset register: equipment with location (a room, or a place), serial,
// vendor, warranty and cost; its service history is the tasks on it. A work order is a task
// (states, assignee and after photos stay with the task engine) with the parts, labour time
// and outside cost logged against it.

export interface MaintenanceDeps {
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;
type AssetRow = Prisma.AssetGetPayload<{
  include: { room: { select: { id: true; number: true } } };
}>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const WITH_ROOM = { room: { select: { id: true, number: true } } } as const;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

/** Reading the register: asset.manage, or wo.work to pick the asset a job is on. */
function mayRead(tenant: TenantContext) {
  if (!tenant.permissions.has('asset.manage') && !tenant.permissions.has('wo.work')) {
    throw new AppError('FORBIDDEN', 'You do not have permission to see assets.', {
      permission: ['asset.manage', 'wo.work'],
    });
  }
}

function assetItem(a: AssetRow, today: string, openJobs: number): z.input<typeof AssetItem> {
  const warranty = a.warrantyUntil ? day(a.warrantyUntil) : null;
  return {
    id: a.id,
    tag: a.tag,
    name: a.name,
    category: a.category,
    location: a.location,
    room: a.room,
    serial: a.serial,
    vendor: a.vendor,
    warrantyUntil: warranty,
    underWarranty: warranty !== null && warranty >= today,
    costMinor: a.costMinor?.toString() ?? null,
    status: a.status as AssetStatus,
    openJobs,
  };
}

async function openJobsOf(db: Client, assetIds: string[]) {
  if (assetIds.length === 0) return new Map<string, number>();
  const rows = await db.task.groupBy({
    by: ['assetId'],
    where: { assetId: { in: assetIds }, status: { in: [...OPEN_TASK_STATUSES] } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.assetId ?? '', r._count._all]));
}

export async function listAssets(
  deps: MaintenanceDeps,
  tenant: TenantContext,
  query: {
    q?: string | undefined;
    status?: AssetStatus | undefined;
    category?: string | undefined;
    roomId?: string | undefined;
  },
) {
  mayRead(tenant);
  const q = query.q?.trim();
  const rows = await deps.tenantDb.asset.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.roomId ? { roomId: query.roomId } : {}),
      ...(q
        ? {
            OR: [
              { tag: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
              { serial: { contains: q, mode: 'insensitive' } },
              { location: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: WITH_ROOM,
    orderBy: [{ category: 'asc' }, { tag: 'asc' }],
  });
  const [today, open, used] = await Promise.all([
    propertyToday(deps.tenantDb, tenant.propertyId, deps.clock),
    openJobsOf(
      deps.tenantDb,
      rows.map((r) => r.id),
    ),
    deps.tenantDb.asset.findMany({ distinct: ['category'], select: { category: true } }),
  ]);
  const categories = [...new Set([...ASSET_CATEGORIES, ...used.map((u) => u.category)])].sort();
  return { data: rows.map((r) => assetItem(r, today, open.get(r.id) ?? 0)), categories };
}

async function detailOf(
  db: Client,
  tenant: TenantContext,
  clock: Clock,
  assetId: string,
): Promise<z.input<typeof AssetDetail>> {
  const asset = await db.asset.findFirst({ where: { id: assetId }, include: WITH_ROOM });
  if (!asset) throw new AppError('NOT_FOUND', 'Asset not found.');
  const tasks = await db.task.findMany({
    where: { assetId },
    include: { workOrder: true, assignee: { select: { id: true, name: true } } },
    orderBy: { number: 'desc' },
  });
  const today = await propertyToday(db, tenant.propertyId, clock);
  const open = tasks.filter((t) => OPEN_TASK_STATUSES.includes(t.status)).length;
  const history = tasks.map((t) => ({
    taskId: t.id,
    number: t.number,
    title: t.title,
    type: t.type,
    status: t.status,
    createdAt: iso(t.createdAt),
    resolvedAt: t.resolvedAt ? iso(t.resolvedAt) : null,
    assignee: t.assignee,
    labourMinutes: t.workOrder?.labourMinutes ?? 0,
    costMinor: (t.workOrder?.costMinor ?? 0n).toString(),
  }));
  return {
    ...assetItem(asset, today, open),
    history,
    totals: {
      jobs: tasks.length,
      labourMinutes: history.reduce((s, h) => s + h.labourMinutes, 0),
      costMinor: tasks.reduce((s, t) => s + (t.workOrder?.costMinor ?? 0n), 0n).toString(),
    },
  };
}

export async function getAsset(deps: MaintenanceDeps, tenant: TenantContext, assetId: string) {
  mayRead(tenant);
  return detailOf(deps.tenantDb, tenant, deps.clock, assetId);
}

async function checkRoom(tx: Tx, roomId: string | null | undefined) {
  if (!roomId) return;
  if (!(await tx.room.findFirst({ where: { id: roomId } }))) {
    throw invalid('roomId', 'Choose a room of this property');
  }
}

/** The tag is unique in the property: a clash is a field error, not a 500. */
async function guardTag<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      throw invalid('tag', 'Another asset already has this tag');
    }
    throw e;
  }
}

type AssetData = {
  tag?: string;
  name?: string;
  category?: string;
  location?: string | null;
  roomId?: string | null;
  serial?: string | null;
  vendor?: string | null;
  warrantyUntil?: string | null;
  costMinor?: string | null;
  status?: AssetStatus;
};

function columns(b: AssetData): Prisma.AssetUncheckedUpdateInput {
  const out: Prisma.AssetUncheckedUpdateInput = {};
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (k === 'warrantyUntil') out.warrantyUntil = v === null ? null : dbDate(v);
    else if (k === 'costMinor') out.costMinor = v === null ? null : BigInt(v);
    else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function snapshot(a: Prisma.AssetGetPayload<object>) {
  return {
    tag: a.tag,
    name: a.name,
    category: a.category,
    location: a.location,
    roomId: a.roomId,
    serial: a.serial,
    vendor: a.vendor,
    warrantyUntil: a.warrantyUntil ? day(a.warrantyUntil) : null,
    costMinor: a.costMinor?.toString() ?? null,
    status: a.status,
  };
}

export async function createAsset(
  deps: MaintenanceDeps,
  tenant: TenantContext,
  body: z.output<typeof AssetBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    await checkRoom(tx, body.roomId);
    const asset = await guardTag(() =>
      tx.asset.create({
        data: columns(body) as unknown as Prisma.AssetUncheckedCreateInput, // tenant IDs come from the client
      }),
    );
    await recordAudit(tx, {
      action: 'asset.created',
      entityType: 'asset',
      entityId: asset.id,
      after: snapshot(asset),
    });
    return detailOf(tx, tenant, deps.clock, asset.id);
  });
}

export async function updateAsset(
  deps: MaintenanceDeps,
  tenant: TenantContext,
  assetId: string,
  body: z.output<typeof AssetPatch>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM assets WHERE id = ${assetId}::uuid FOR UPDATE`;
    const before = await tx.asset.findFirst({ where: { id: assetId } });
    if (!before) throw new AppError('NOT_FOUND', 'Asset not found.');
    await checkRoom(tx, body.roomId);
    if (body.status === 'RETIRED' && before.status !== 'RETIRED') {
      const open = await tx.task.count({
        where: { assetId, status: { in: [...OPEN_TASK_STATUSES] } },
      });
      if (open > 0) {
        throw new AppError(
          'STATE_TRANSITION_INVALID',
          `Finish the ${open} open job${open === 1 ? '' : 's'} on this asset before retiring it`,
          { openJobs: open },
        );
      }
    }
    const after = await guardTag(() =>
      tx.asset.update({ where: { id: assetId }, data: columns(body) }),
    );
    const was = snapshot(before);
    const now = snapshot(after);
    const changed = (Object.keys(now) as (keyof typeof now)[]).filter((k) => was[k] !== now[k]);
    if (changed.length > 0) {
      await recordAudit(tx, {
        action: 'asset.updated',
        entityType: 'asset',
        entityId: assetId,
        before: Object.fromEntries(changed.map((k) => [k, was[k]])),
        after: Object.fromEntries(changed.map((k) => [k, now[k]])),
      });
    }
    return detailOf(tx, tenant, deps.clock, assetId);
  });
}

export async function saveWorkOrder(
  deps: MaintenanceDeps,
  tenant: TenantContext,
  taskId: string,
  body: z.output<typeof WorkOrderBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
    const task = await loadVisible(tx, tenant, taskId);
    if (task.status === 'VERIFIED' || task.status === 'CLOSED') {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'This job is verified; its parts and time can no longer change.',
        { status: task.status },
      );
    }
    if (!mayLogWork(tenant, task)) {
      throw new AppError('FORBIDDEN', 'Only the assignee or a manager can log work on this job.', {
        permission: ['wo.work', 'task.assign'],
      });
    }
    if (body.assetId) {
      const asset = await tx.asset.findFirst({ where: { id: body.assetId } });
      if (!asset) throw invalid('assetId', 'Choose an asset of this property');
      if (asset.status === 'RETIRED' && asset.id !== task.assetId) {
        throw invalid('assetId', 'This asset is retired');
      }
    }
    const partsCost = body.parts.reduce((s, p) => s + BigInt(p.costMinor), 0n);
    const detail = {
      parts: body.parts,
      labourMinutes: body.labourMinutes,
      vendorName: body.vendorName,
      costMinor: partsCost + BigInt(body.vendorCostMinor),
    };
    const previous = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { workOrder: true, assetId: true },
    });
    await tx.task.update({
      where: { id: taskId },
      data: {
        ...(body.assetId !== undefined
          ? body.assetId
            ? { asset: { connect: { id: body.assetId } } }
            : { asset: { disconnect: true } }
          : {}),
        workOrder: { upsert: { create: detail, update: detail } },
      },
    });
    const saved = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      include: { workOrder: true, asset: { select: { id: true, tag: true, name: true } } },
    });
    const item = workOrderItem(saved.workOrder ?? { ...detail, parts: [] });
    await recordAudit(tx, {
      action: 'work_order.logged',
      entityType: 'task',
      entityId: taskId,
      before: previous.workOrder
        ? {
            ...workOrderItem(previous.workOrder),
            assetId: previous.assetId,
          }
        : null,
      after: { ...item, assetId: saved.assetId },
    });
    return { taskId, workOrder: item, asset: saved.asset };
  });
}
