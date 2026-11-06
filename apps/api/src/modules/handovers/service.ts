import {
  approvalAction,
  HANDOVER_LIST_LIMIT,
  OPEN_TASK_STATUSES,
  type HandoverNoteBody,
  type HandoverNoteItem,
  type HandoverSnapshot,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { businessDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { drawerCash } from '../shifts/service.ts';

// Shift handover notes (PRD M6-06; tab 3 handover_notes; tab 4 row "Handovers"; S20; T-083).
// The outgoing supervisor writes notes for a department; the handover keeps them with what was
// open at that moment (the department's open tasks, approvals waiting, cash in the drawers, VIP
// guests in house or arriving today), so the incoming supervisor reads the shift as it was
// left. A handover is never edited (a database trigger allows only the acknowledgement). Anyone
// with handover.manage other than its writer acknowledges it, once: a guarded update.

export interface HandoverDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;
type Snapshot = z.input<typeof HandoverSnapshot>;
type Item = z.input<typeof HandoverNoteItem>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const include = {
  department: true,
  writtenBy: { select: { id: true, name: true } },
  acknowledgedBy: { select: { id: true, name: true } },
} satisfies Prisma.HandoverNoteInclude;

type Row = Prisma.HandoverNoteGetPayload<{ include: typeof include }>;

interface Content {
  notes: string;
  snapshot: Snapshot;
}

function toItem(row: Row, tenant: TenantContext): Item {
  const content = row.content as unknown as Content;
  return {
    id: row.id,
    businessDate: day(row.businessDate),
    department: { id: row.department.id, code: row.department.code, name: row.department.name },
    writtenBy: row.writtenBy,
    createdAt: iso(row.createdAt),
    notes: content.notes,
    snapshot: content.snapshot,
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: row.acknowledgedAt ? iso(row.acknowledgedAt) : null,
    canAcknowledge: row.acknowledgedAt === null && row.writtenById !== tenant.userId,
  };
}

// ── What is open now ─────────────────────────────────────────────────────────────────────

async function openTasks(db: Client, departmentId: string, now: Date) {
  const where = { departmentId, status: { in: [...OPEN_TASK_STATUSES] } };
  const [total, rows] = await Promise.all([
    db.task.count({ where }),
    db.task.findMany({
      where,
      include: {
        assignee: { select: { name: true } },
        room: { select: { number: true } },
      },
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }],
      take: HANDOVER_LIST_LIMIT,
    }),
  ]);
  return {
    total,
    items: rows.map((t) => ({
      id: t.id,
      number: t.number,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueAt: t.dueAt ? iso(t.dueAt) : null,
      overdue: t.dueAt !== null && t.dueAt <= now,
      assignee: t.assignee?.name ?? null,
      room: t.room?.number ?? null,
    })),
  };
}

async function pendingApprovals(db: Client, now: Date) {
  const where = { status: 'PENDING' as const, expiresAt: { gt: now } };
  const [total, rows] = await Promise.all([
    db.approvalRequest.count({ where }),
    db.approvalRequest.findMany({
      where,
      include: { requestedBy: { select: { name: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: HANDOVER_LIST_LIMIT,
    }),
  ]);
  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      label: approvalAction(r.action)?.label ?? r.action,
      requestedBy: r.requestedBy.name,
      amountMinor: r.amountMinor?.toString() ?? null,
      createdAt: iso(r.createdAt),
    })),
  };
}

async function cashPosition(db: Client) {
  const drawers = await drawerCash(db);
  const totals = new Map<string, bigint>();
  for (const d of drawers) {
    for (const [currency, amount] of d.cash) {
      totals.set(currency, (totals.get(currency) ?? 0n) + amount);
    }
  }
  return {
    drawers: drawers.map((d) => ({
      shiftId: d.shiftId,
      cashier: d.cashier,
      status: d.status,
      openedAt: iso(d.openedAt),
      cash: d.cash.map(([currency, amount]) => ({ currency, amountMinor: amount.toString() })),
    })),
    totals: [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => ({ currency, amountMinor: amount.toString() })),
  };
}

/** VIP guests checked in, and those due to arrive on the business date. */
async function vips(db: Client, date: string) {
  const where = {
    guest: { vip: true },
    OR: [
      { status: 'CHECKED_IN' as const },
      { status: { in: ['TENTATIVE' as const, 'CONFIRMED' as const] }, arrival: dbDate(date) },
    ],
  } satisfies Prisma.StayWhereInput;
  const [total, rows] = await Promise.all([
    db.stay.count({ where }),
    db.stay.findMany({
      where,
      include: { guest: true, room: { select: { number: true } } },
      // In house (CHECKED_IN) before arriving (CONFIRMED, TENTATIVE).
      orderBy: [{ status: 'desc' }, { arrival: 'asc' }, { id: 'asc' }],
      take: HANDOVER_LIST_LIMIT,
    }),
  ]);
  const name = (s: (typeof rows)[number]) => `${s.guest.lastName} ${s.guest.firstName}`;
  const inHouse = (s: (typeof rows)[number]) => (s.status === 'CHECKED_IN' ? 0 : 1);
  rows.sort((a, b) => inHouse(a) - inHouse(b) || name(a).localeCompare(name(b)));
  return {
    total,
    items: rows.map((s) => ({
      guestId: s.guestId,
      name: `${s.guest.firstName} ${s.guest.lastName}`.trim(),
      room: s.room?.number ?? null,
      status: s.status === 'CHECKED_IN' ? ('IN_HOUSE' as const) : ('ARRIVING' as const),
      arrival: day(s.arrival),
      departure: day(s.departure),
    })),
  };
}

async function snapshotOf(
  db: Client,
  departmentId: string,
  date: string,
  now: Date,
): Promise<Snapshot> {
  const [tasks, approvals, cash, guests] = await Promise.all([
    openTasks(db, departmentId, now),
    pendingApprovals(db, now),
    cashPosition(db),
    vips(db, date),
  ]);
  return { openTasks: tasks, approvals, cash, vips: guests };
}

// ── Departments ──────────────────────────────────────────────────────────────────────────

/** The caller's own department here (from their membership), else the first one. */
async function defaultDepartment(
  deps: HandoverDeps,
  tenant: TenantContext,
  departments: { id: string }[],
): Promise<string> {
  const ids = new Set(departments.map((d) => d.id));
  const members = await deps.db.membership.findMany({
    where: {
      userId: tenant.userId,
      organisationId: tenant.organisationId,
      active: true,
      departmentId: { not: null },
      OR: [{ propertyId: tenant.propertyId }, { propertyId: null }],
    },
    orderBy: { createdAt: 'asc' },
    select: { departmentId: true },
  });
  const own = members.find((m) => m.departmentId && ids.has(m.departmentId))?.departmentId;
  const first = departments[0]?.id;
  if (own) return own;
  if (first) return first;
  throw new AppError('NOT_FOUND', 'This property has no departments yet.');
}

async function departmentOf(db: Client, departmentId: string) {
  const department = await db.department.findUnique({ where: { id: departmentId } });
  if (!department) {
    throw new AppError('VALIDATION_ERROR', 'Choose a department of this property', {
      issues: [
        {
          path: 'body.departmentId',
          code: 'custom',
          message: 'Choose a department of this property',
        },
      ],
    });
  }
  return department;
}

// ── Routes ───────────────────────────────────────────────────────────────────────────────

export async function getDraft(
  deps: HandoverDeps,
  tenant: TenantContext,
  query: { departmentId?: string | undefined },
) {
  const db = deps.tenantDb;
  const departments = await db.department.findMany({ orderBy: { name: 'asc' } });
  let departmentId: string;
  if (query.departmentId) {
    if (!departments.some((d) => d.id === query.departmentId)) {
      throw new AppError('NOT_FOUND', 'Department not found.');
    }
    departmentId = query.departmentId;
  } else {
    departmentId = await defaultDepartment(deps, tenant, departments);
  }
  const date = await businessDate(db, tenant.propertyId, deps.clock);
  return {
    businessDate: date,
    departments: departments.map((d) => ({ id: d.id, code: d.code, name: d.name })),
    departmentId,
    snapshot: await snapshotOf(db, departmentId, date, deps.clock()),
  };
}

export async function listHandovers(
  deps: HandoverDeps,
  tenant: TenantContext,
  query: {
    limit: number;
    cursor?: string | undefined;
    departmentId?: string | undefined;
    pending?: 'true' | undefined;
  },
) {
  const offset = decodeCursor(query.cursor);
  const rows = await deps.tenantDb.handoverNote.findMany({
    where: {
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.pending ? { acknowledgedAt: null } : {}),
    },
    include,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    skip: offset,
    take: query.limit + 1,
  });
  return {
    data: rows.slice(0, query.limit).map((r) => toItem(r, tenant)),
    nextCursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
  };
}

export async function writeHandover(
  deps: HandoverDeps,
  tenant: TenantContext,
  body: z.output<typeof HandoverNoteBody>,
) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    const department = await departmentOf(tx, body.departmentId);
    const date = await businessDate(tx, tenant.propertyId, deps.clock);
    const content: Content = {
      notes: body.notes,
      snapshot: await snapshotOf(tx, department.id, date, now),
    };
    const row = await tx.handoverNote.create({
      data: {
        departmentId: department.id,
        businessDate: dbDate(date),
        content: content as unknown as Prisma.InputJsonValue,
        writtenById: tenant.userId,
      } as unknown as Prisma.HandoverNoteUncheckedCreateInput, // the tenant client sets the property
      include,
    });
    await recordEvent(tx, {
      type: 'handover.written',
      payload: { handoverId: row.id, departmentId: department.id, businessDate: date },
    });
    return toItem(row, tenant);
  });
}

export async function acknowledgeHandover(
  deps: HandoverDeps,
  tenant: TenantContext,
  handoverId: string,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const note = await tx.handoverNote.findUnique({ where: { id: handoverId }, include });
    if (!note) throw new AppError('NOT_FOUND', 'Handover not found.');
    if (note.writtenById === tenant.userId) {
      throw new AppError('FORBIDDEN', 'The incoming supervisor acknowledges your handover.', {
        permission: 'handover.manage',
      });
    }
    const done = await tx.handoverNote.updateMany({
      where: { id: note.id, acknowledgedAt: null },
      data: { acknowledgedById: tenant.userId, acknowledgedAt: deps.clock() },
    });
    if (done.count === 0) {
      const by = (await tx.handoverNote.findUnique({ where: { id: note.id }, include }))
        ?.acknowledgedBy?.name;
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `This handover was already acknowledged${by ? ` by ${by}` : ''}.`,
      );
    }
    await recordEvent(tx, {
      type: 'handover.acknowledged',
      payload: { handoverId: note.id, writtenById: note.writtenById },
    });
    const row = await tx.handoverNote.findUniqueOrThrow({ where: { id: note.id }, include });
    return toItem(row, tenant);
  });
}

const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
