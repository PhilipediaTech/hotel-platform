import {
  addDays,
  leaveDays,
  MAX_ROTA_DAYS,
  rotaPeriodEnd,
  type DutyBody,
  type DutyItem,
  type DutyPatch,
  type LeaveBody,
  type LeaveDecision,
  type LeaveItem,
  type LeaveStatus,
  type LeaveType,
  type RotaPeriod,
  type RotaShiftBody,
  type RotaShiftPatch,
  type ShiftAssignmentItem,
  type RotaSlotStatus,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { propertyToday } from '../availability/inventory.ts';

// Duties, rotas and leave (PRD M7-02, M7-03, M7-05; T-137). Tab 3 names duties, rota_patterns,
// shift_assignments and leave_requests for V1.1 without columns: they are designed here.
// - A duty is standing work for one person, by weekday, with no rota (M7-02).
// - A department has a rota when it has active shifts (rota_patterns). Slots are drafts until
//   published for a week or a month (M7-03).
// - Staff ask for leave through the profile linked to their login; a holder of leave.approve
//   other than themselves decides. Approval takes them off every live slot on those dates
//   (REMOVED, kept with the leave request), and nobody is put on a shift during approved
//   leave (M7 acceptance criterion).

export interface WorkforceDeps {
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const STAFF_REF = { select: { id: true, number: true, name: true } } as const;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
  });

// ── Duties (M7-02) ─────────────────────────────────────────────────────────────────────

const DUTY_INCLUDE = {
  staff: { select: { id: true, number: true, name: true, jobTitle: true } },
} as const satisfies Prisma.DutyInclude;
type DutyRow = Prisma.DutyGetPayload<{ include: typeof DUTY_INCLUDE }>;

function dutyItem(d: DutyRow): z.input<typeof DutyItem> {
  return {
    id: d.id,
    staff: d.staff,
    title: d.title,
    notes: d.notes,
    weekdays: d.weekdays,
    startTime: d.startTime,
    endTime: d.endTime,
    active: d.active,
  };
}

async function activeStaff(tx: Client, staffId: string, path: string) {
  const s = await tx.staffProfile.findFirst({ where: { id: staffId } });
  if (!s) throw new AppError('NOT_FOUND', 'Staff member not found.');
  if (s.status !== 'ACTIVE') throw invalid(path, `ST-${s.number} ${s.name} has left`);
  return s;
}

export async function listDuties(deps: WorkforceDeps) {
  const [rows, staff] = await Promise.all([
    deps.tenantDb.duty.findMany({
      where: { staff: { status: 'ACTIVE' } },
      include: DUTY_INCLUDE,
      orderBy: [{ active: 'desc' }, { staff: { name: 'asc' } }, { title: 'asc' }],
    }),
    deps.tenantDb.staffProfile.findMany({
      where: { status: 'ACTIVE' },
      ...STAFF_REF,
      orderBy: { name: 'asc' },
    }),
  ]);
  return { data: rows.map(dutyItem), staff };
}

export async function createDuty(deps: WorkforceDeps, body: z.output<typeof DutyBody>) {
  return deps.tenantDb.$transaction(async (tx) => {
    await activeStaff(tx, body.staffId, 'body.staffId');
    const d = await tx.duty.create({
      data: {
        staffId: body.staffId,
        title: body.title,
        notes: body.notes,
        weekdays: body.weekdays,
        startTime: body.startTime,
        endTime: body.endTime,
      } as unknown as Prisma.DutyUncheckedCreateInput, // tenant IDs come from the client
      include: DUTY_INCLUDE,
    });
    await recordAudit(tx, {
      action: 'duty.created',
      entityType: 'duty',
      entityId: d.id,
      after: { staffId: d.staffId, title: d.title, weekdays: d.weekdays },
    });
    return dutyItem(d);
  });
}

export async function updateDuty(
  deps: WorkforceDeps,
  dutyId: string,
  body: z.output<typeof DutyPatch>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.duty.findFirst({ where: { id: dutyId } });
    if (!before) throw new AppError('NOT_FOUND', 'Duty not found.');
    if (body.active === true) await activeStaff(tx, before.staffId, 'body.active');
    const data = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const after = await tx.duty.update({ where: { id: dutyId }, data, include: DUTY_INCLUDE });
    const keys = Object.keys(data) as (keyof typeof before)[];
    await recordAudit(tx, {
      action: body.active === false && before.active ? 'duty.stopped' : 'duty.updated',
      entityType: 'duty',
      entityId: dutyId,
      before: Object.fromEntries(keys.map((k) => [k, before[k]])),
      after: Object.fromEntries(keys.map((k) => [k, after[k]])),
    });
    return dutyItem(after);
  });
}

// ── Rotas (M7-03) ──────────────────────────────────────────────────────────────────────

const ASSIGNMENT_INCLUDE = { staff: STAFF_REF } as const satisfies Prisma.ShiftAssignmentInclude;
type AssignmentRow = Prisma.ShiftAssignmentGetPayload<{ include: typeof ASSIGNMENT_INCLUDE }>;

function assignmentItem(a: AssignmentRow): z.input<typeof ShiftAssignmentItem> {
  return {
    id: a.id,
    shiftId: a.patternId,
    staff: a.staff,
    date: day(a.date),
    status: a.status as RotaSlotStatus,
    leaveRequestId: a.leaveRequestId,
  };
}

const shiftItem = (p: {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  active: boolean;
}) => ({ id: p.id, name: p.name, startTime: p.startTime, endTime: p.endTime, active: p.active });

async function departmentOf(tx: Client, departmentId: string) {
  const d = await tx.department.findFirst({ where: { id: departmentId } });
  if (!d) throw new AppError('NOT_FOUND', 'Department not found.');
  return d;
}

export async function getRota(
  deps: WorkforceDeps,
  query: { departmentId?: string | undefined; from: string; to: string },
) {
  const { from, to } = query;
  if (to < from) throw invalid('query.to', 'Ends before it starts');
  if (leaveDays(from, to) > MAX_ROTA_DAYS) {
    throw invalid('query.to', `At most ${MAX_ROTA_DAYS} days at a time`);
  }
  const db = deps.tenantDb;
  const department = query.departmentId
    ? await departmentOf(db, query.departmentId)
    : ((await db.department.findFirst({
        where: { rotaPatterns: { some: { active: true } } },
        orderBy: { name: 'asc' },
      })) ?? (await db.department.findFirst({ orderBy: { name: 'asc' } })));
  if (!department) {
    return {
      department: null,
      from,
      to,
      shifts: [],
      assignments: [],
      staff: [],
      leave: [],
      departments: [],
    };
  }
  const [shifts, assignments, staff, leave, departments] = await Promise.all([
    db.rotaPattern.findMany({
      where: { departmentId: department.id },
      orderBy: [{ active: 'desc' }, { startTime: 'asc' }],
    }),
    db.shiftAssignment.findMany({
      where: {
        pattern: { departmentId: department.id },
        date: { gte: dbDate(from), lte: dbDate(to) },
      },
      include: ASSIGNMENT_INCLUDE,
      orderBy: [{ date: 'asc' }, { staff: { name: 'asc' } }],
    }),
    db.staffProfile.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, number: true, name: true, departmentId: true },
      orderBy: { name: 'asc' },
    }),
    db.leaveRequest.findMany({
      where: { status: 'APPROVED', startDate: { lte: dbDate(to) }, endDate: { gte: dbDate(from) } },
    }),
    db.department.findMany({
      orderBy: { name: 'asc' },
      include: { rotaPatterns: { where: { active: true }, select: { id: true } } },
    }),
  ]);
  return {
    department: { id: department.id, name: department.name },
    from,
    to,
    shifts: shifts.map(shiftItem),
    assignments: assignments.map(assignmentItem),
    staff,
    leave: leave.map((l) => ({
      staffId: l.staffId,
      startDate: day(l.startDate),
      endDate: day(l.endDate),
      type: l.type as LeaveType,
    })),
    departments: departments.map((d) => ({
      id: d.id,
      name: d.name,
      hasRota: d.rotaPatterns.length > 0,
    })),
  };
}

async function sameShiftName(tx: Tx, departmentId: string, name: string, except: string | null) {
  const taken = await tx.rotaPattern.findFirst({
    where: {
      departmentId,
      name: { equals: name, mode: 'insensitive' },
      ...(except ? { id: { not: except } } : {}),
    },
  });
  if (taken) throw invalid('body.name', 'This department already has a shift by that name');
}

export async function addRotaShift(
  deps: WorkforceDeps,
  departmentId: string,
  body: z.output<typeof RotaShiftBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    await departmentOf(tx, departmentId);
    await sameShiftName(tx, departmentId, body.name, null);
    const p = await tx.rotaPattern.create({
      data: {
        departmentId,
        name: body.name,
        startTime: body.startTime,
        endTime: body.endTime,
      } as unknown as Prisma.RotaPatternUncheckedCreateInput, // tenant IDs come from the client
    });
    await recordAudit(tx, {
      action: 'rota.shift_added',
      entityType: 'rota_pattern',
      entityId: p.id,
      after: { departmentId, ...shiftItem(p) },
    });
    return shiftItem(p);
  });
}

export async function updateRotaShift(
  deps: WorkforceDeps,
  shiftId: string,
  body: z.output<typeof RotaShiftPatch>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.rotaPattern.findFirst({ where: { id: shiftId } });
    if (!before) throw new AppError('NOT_FOUND', 'Shift not found.');
    if (body.name) await sameShiftName(tx, before.departmentId, body.name, shiftId);
    const startTime = body.startTime ?? before.startTime;
    const endTime = body.endTime ?? before.endTime;
    if (startTime === endTime)
      throw invalid('body.endTime', 'A shift must end at a different time');
    const data = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const after = await tx.rotaPattern.update({ where: { id: shiftId }, data });
    await recordAudit(tx, {
      action: 'rota.shift_updated',
      entityType: 'rota_pattern',
      entityId: shiftId,
      before: shiftItem(before),
      after: shiftItem(after),
    });
    return shiftItem(after);
  });
}

/** Approved leave of this person covering the date, if any. */
async function leaveOn(tx: Client, staffId: string, date: string) {
  return tx.leaveRequest.findFirst({
    where: {
      staffId,
      status: 'APPROVED',
      startDate: { lte: dbDate(date) },
      endDate: { gte: dbDate(date) },
    },
  });
}

export async function assignShift(
  deps: WorkforceDeps,
  body: { shiftId: string; staffId: string; date: string },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const pattern = await tx.rotaPattern.findFirst({ where: { id: body.shiftId } });
    if (!pattern) throw new AppError('NOT_FOUND', 'Shift not found.');
    if (!pattern.active) throw invalid('body.shiftId', 'This shift is stopped');
    const s = await activeStaff(tx, body.staffId, 'body.staffId');
    if (body.date < day(s.startDate)) throw invalid('body.date', 'Before they started');
    // One person, one date at a time: the leave check and the insert are not raced.
    await tx.$queryRaw`SELECT id FROM staff_profiles WHERE id = ${s.id}::uuid FOR UPDATE`;
    const leave = await leaveOn(tx, s.id, body.date);
    if (leave) {
      throw invalid(
        'body.date',
        `${s.name} is on approved leave from ${day(leave.startDate)} to ${day(leave.endDate)}`,
      );
    }
    const taken = await tx.shiftAssignment.findFirst({
      where: {
        patternId: pattern.id,
        staffId: s.id,
        date: dbDate(body.date),
        status: { not: 'REMOVED' },
      },
    });
    if (taken) throw invalid('body.staffId', `${s.name} is already on this shift that day`);
    const a = await tx.shiftAssignment.create({
      data: {
        patternId: pattern.id,
        staffId: s.id,
        date: dbDate(body.date),
      } as unknown as Prisma.ShiftAssignmentUncheckedCreateInput, // tenant IDs come from the client
      include: ASSIGNMENT_INCLUDE,
    });
    return assignmentItem(a);
  });
}

export async function unassignShift(deps: WorkforceDeps, assignmentId: string) {
  return deps.tenantDb.$transaction(async (tx) => {
    const a = await tx.shiftAssignment.findFirst({
      where: { id: assignmentId },
      include: { pattern: true },
    });
    if (!a) throw new AppError('NOT_FOUND', 'Rota slot not found.');
    if (a.status === 'REMOVED') {
      throw new AppError('STATE_TRANSITION_INVALID', 'Already taken off by approved leave.', {
        status: a.status,
      });
    }
    await tx.shiftAssignment.delete({ where: { id: a.id } });
    if (a.status === 'PUBLISHED') {
      await recordAudit(tx, {
        action: 'rota.slot_removed',
        entityType: 'rota_pattern',
        entityId: a.patternId,
        before: { staffId: a.staffId, date: day(a.date), shift: a.pattern.name },
      });
    }
    return { removed: true as const };
  });
}

export async function publishRota(
  deps: WorkforceDeps,
  departmentId: string,
  body: { from: string; period: RotaPeriod },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    await departmentOf(tx, departmentId);
    const to = rotaPeriodEnd(body.from, body.period);
    const { count } = await tx.shiftAssignment.updateMany({
      where: {
        status: 'DRAFT',
        pattern: { departmentId },
        date: { gte: dbDate(body.from), lte: dbDate(to) },
      },
      data: { status: 'PUBLISHED', publishedAt: deps.clock() },
    });
    await recordAudit(tx, {
      action: 'rota.published',
      entityType: 'department',
      entityId: departmentId,
      after: { from: body.from, to, period: body.period, published: count },
    });
    return { from: body.from, to, published: count };
  });
}

// ── Leave (M7-05) ──────────────────────────────────────────────────────────────────────

const LEAVE_INCLUDE = {
  staff: {
    select: { id: true, number: true, name: true, department: { select: { name: true } } },
  },
  decidedBy: { select: { id: true, name: true } },
  _count: { select: { shifts: true } },
} as const satisfies Prisma.LeaveRequestInclude;
type LeaveRow = Prisma.LeaveRequestGetPayload<{ include: typeof LEAVE_INCLUDE }>;

function leaveItem(l: LeaveRow): z.input<typeof LeaveItem> {
  const startDate = day(l.startDate);
  const endDate = day(l.endDate);
  return {
    id: l.id,
    staff: {
      id: l.staff.id,
      number: l.staff.number,
      name: l.staff.name,
      department: l.staff.department?.name ?? null,
    },
    type: l.type as LeaveType,
    startDate,
    endDate,
    days: leaveDays(startDate, endDate),
    reason: l.reason,
    status: l.status as LeaveStatus,
    decidedBy: l.decidedBy,
    decidedAt: l.decidedAt ? iso(l.decidedAt) : null,
    decisionNote: l.decisionNote,
    shiftsRemoved: l._count.shifts,
    createdAt: iso(l.createdAt),
  };
}

async function leaveOf(tx: Client, leaveId: string) {
  const l = await tx.leaveRequest.findFirst({ where: { id: leaveId }, include: LEAVE_INCLUDE });
  if (!l) throw new AppError('NOT_FOUND', 'Leave request not found.');
  return l;
}

/** The staff profile linked to the signed-in login at this property, if any. */
async function ownProfile(tx: Client, tenant: TenantContext) {
  return tx.staffProfile.findFirst({ where: { userId: tenant.userId, status: 'ACTIVE' } });
}

export async function getMyWork(deps: WorkforceDeps, tenant: TenantContext) {
  const db = deps.tenantDb;
  const today = await propertyToday(db, tenant.propertyId, deps.clock);
  const me = await ownProfile(db, tenant);
  if (!me) return { staff: null, today, duties: [], shifts: [], leave: [] };
  const [duties, shifts, leave] = await Promise.all([
    db.duty.findMany({
      where: { staffId: me.id, active: true },
      include: DUTY_INCLUDE,
      orderBy: { title: 'asc' },
    }),
    db.shiftAssignment.findMany({
      where: {
        staffId: me.id,
        status: 'PUBLISHED',
        date: { gte: dbDate(today), lte: dbDate(addDays(today, 27)) },
      },
      include: { pattern: { include: { department: { select: { name: true } } } } },
      orderBy: [{ date: 'asc' }, { pattern: { startTime: 'asc' } }],
    }),
    db.leaveRequest.findMany({
      where: { staffId: me.id },
      include: LEAVE_INCLUDE,
      orderBy: { startDate: 'desc' },
      take: 50,
    }),
  ]);
  return {
    staff: { id: me.id, number: me.number, name: me.name },
    today,
    duties: duties.map(dutyItem),
    shifts: shifts.map((s) => ({
      id: s.id,
      date: day(s.date),
      shift: s.pattern.name,
      startTime: s.pattern.startTime,
      endTime: s.pattern.endTime,
      department: s.pattern.department.name,
    })),
    leave: leave.map(leaveItem),
  };
}

export async function requestLeave(
  deps: WorkforceDeps,
  tenant: TenantContext,
  body: z.output<typeof LeaveBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const me = await ownProfile(tx, tenant);
    if (!me) {
      throw invalid('body', 'Your login is not linked to a staff profile here. Ask your manager.');
    }
    await tx.$queryRaw`SELECT id FROM staff_profiles WHERE id = ${me.id}::uuid FOR UPDATE`;
    const overlap = await tx.leaveRequest.findFirst({
      where: {
        staffId: me.id,
        status: { in: ['PENDING', 'APPROVED'] },
        startDate: { lte: dbDate(body.endDate) },
        endDate: { gte: dbDate(body.startDate) },
      },
    });
    if (overlap) {
      throw invalid(
        'body.startDate',
        `Overlaps your ${overlap.status.toLowerCase()} leave from ${day(overlap.startDate)} to ${day(overlap.endDate)}`,
      );
    }
    const l = await tx.leaveRequest.create({
      data: {
        staffId: me.id,
        type: body.type,
        startDate: dbDate(body.startDate),
        endDate: dbDate(body.endDate),
        reason: body.reason,
      } as unknown as Prisma.LeaveRequestUncheckedCreateInput, // tenant IDs come from the client
      include: LEAVE_INCLUDE,
    });
    await recordAudit(tx, {
      action: 'leave.requested',
      entityType: 'leave_request',
      entityId: l.id,
      after: { staffId: me.id, type: body.type, startDate: body.startDate, endDate: body.endDate },
    });
    return leaveItem(l);
  });
}

export async function cancelLeave(deps: WorkforceDeps, tenant: TenantContext, leaveId: string) {
  return deps.tenantDb.$transaction(async (tx) => {
    const me = await ownProfile(tx, tenant);
    const l = await tx.leaveRequest.findFirst({ where: { id: leaveId } });
    // Someone else's request is not found, as if it did not exist.
    if (!l || !me || l.staffId !== me.id) {
      throw new AppError('NOT_FOUND', 'Leave request not found.');
    }
    if (l.status !== 'PENDING') {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'Only a request still waiting for a decision can be withdrawn.',
        { status: l.status },
      );
    }
    await tx.leaveRequest.update({ where: { id: l.id }, data: { status: 'CANCELLED' } });
    await recordAudit(tx, {
      action: 'leave.cancelled',
      entityType: 'leave_request',
      entityId: l.id,
      before: { status: 'PENDING' },
      after: { status: 'CANCELLED' },
    });
    return leaveItem(await leaveOf(tx, l.id));
  });
}

export async function listLeave(deps: WorkforceDeps, query: { status?: LeaveStatus | undefined }) {
  const status = query.status ?? 'PENDING';
  const rows = await deps.tenantDb.leaveRequest.findMany({
    where: { status },
    include: LEAVE_INCLUDE,
    orderBy: status === 'PENDING' ? { startDate: 'asc' } : { decidedAt: 'desc' },
    take: 200,
  });
  return { data: rows.map(leaveItem) };
}

export async function decideLeave(
  deps: WorkforceDeps,
  tenant: TenantContext,
  leaveId: string,
  body: z.output<typeof LeaveDecision>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const found = await tx.leaveRequest.findFirst({ where: { id: leaveId } });
    if (!found) throw new AppError('NOT_FOUND', 'Leave request not found.');
    // Same lock as a new rota slot: nobody is put on a shift while this approval lands.
    await tx.$queryRaw`SELECT id FROM staff_profiles WHERE id = ${found.staffId}::uuid FOR UPDATE`;
    const l = await tx.leaveRequest.findFirst({ where: { id: leaveId }, include: { staff: true } });
    if (!l) throw new AppError('NOT_FOUND', 'Leave request not found.');
    if (l.staff.userId === tenant.userId) {
      throw new AppError('FORBIDDEN', 'You cannot decide your own leave.');
    }
    if (l.status !== 'PENDING') {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `This request is already ${l.status.toLowerCase()}.`,
        { status: l.status },
      );
    }
    const approve = body.decision === 'APPROVE';
    await tx.leaveRequest.update({
      where: { id: l.id },
      data: {
        status: approve ? 'APPROVED' : 'REJECTED',
        decidedById: tenant.userId,
        decidedAt: deps.clock(),
        decisionNote: body.note,
      },
    });
    let removed: { date: string; shift: string; status: string }[] = [];
    if (approve) {
      const slots = await tx.shiftAssignment.findMany({
        where: {
          staffId: l.staffId,
          status: { in: ['DRAFT', 'PUBLISHED'] },
          date: { gte: l.startDate, lte: l.endDate },
        },
        include: { pattern: { select: { name: true } } },
      });
      if (slots.length > 0) {
        await tx.shiftAssignment.updateMany({
          where: { id: { in: slots.map((s) => s.id) } },
          data: { status: 'REMOVED', leaveRequestId: l.id },
        });
      }
      removed = slots.map((s) => ({ date: day(s.date), shift: s.pattern.name, status: s.status }));
    }
    await recordAudit(tx, {
      action: approve ? 'leave.approved' : 'leave.rejected',
      entityType: 'leave_request',
      entityId: l.id,
      before: { status: 'PENDING' },
      after: {
        status: approve ? 'APPROVED' : 'REJECTED',
        note: body.note,
        ...(approve ? { shiftsRemoved: removed } : {}),
      },
    });
    return leaveItem(await leaveOf(tx, l.id));
  });
}
