import {
  addDays,
  attendanceSettingsOf,
  localDate,
  monthRange,
  zonedInstant,
  type EmploymentType,
  type PayItem,
  type PayItemBody,
  type PayItemDecision,
  type PayItemStatus,
  type PayItemType,
  type PayrollExport,
  type TimesheetApproval,
  type TimesheetBody,
  type TimesheetItem,
  type TimesheetStatus,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { AppError } from '../../core/errors.ts';
import { csv, decimal, exportFile } from '../../core/exports.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Timesheets, pay items and the payroll file (PRD M7-06, M7-07, M7-08, M7 rules and
// acceptance; T-139). Tab 3 names timesheets and pay_items for V1.1 without columns: they are
// designed here.
// - A timesheet adds up a person's clocks for dates within one month: each clock-in paired
//   with the next clock-out (at most 16 hours later), counted on the property date it began.
//   A clock-in with no such clock-out is "open" and not counted. Minutes beyond the daily
//   threshold (attendance settings, 8 hours by default) are overtime. Approval adds the
//   clocks up again, records the overtime accepted, and needs a note when clocks are open.
//   Nobody approves their own timesheet.
// - Advances and deductions are recorded by one person and approved by another (a CHECK holds
//   it too).
// - The payroll file has one row for everyone employed in the month, salaried staff with no
//   rota or clocks included (M7 acceptance), with the recorded pay rate and approved figures
//   only. It computes no pay (M7 rule: no pay rule is configured). Each file is audited.

export interface PayrollDeps {
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const MAX_SHIFT_MS = 16 * 3_600_000;
const STAFF_REF = { select: { id: true, number: true, name: true } } as const;
const PERSON = { select: { id: true, name: true } } as const;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
  });

async function propertyOf(db: Client, propertyId: string) {
  const property = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  const settings = (property.settings ?? {}) as Record<string, unknown>;
  return { property, attendance: attendanceSettingsOf(settings['attendance']) };
}

/** Staff employed at some point between the two dates. */
const employedBetween = (from: string, to: string): Prisma.StaffProfileWhereInput => ({
  startDate: { lte: dbDate(to) },
  OR: [{ endDate: null }, { endDate: { gte: dbDate(from) } }],
});

// ── Adding up clocks ───────────────────────────────────────────────────────────────────

type Clocks = { kind: string; at: Date }[];

/** Worked minutes per property date, overtime per day, and open clock-ins (exported for tests). */
export function addUpClocks(
  events: Clocks,
  range: { from: string; to: string },
  timeZone: string,
  overtimeAfterMinutes: number,
) {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const perDay = new Map<string, number>();
  let openClocks = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const e = sorted[i];
    if (!e || e.kind !== 'IN') continue;
    const date = localDate(e.at, timeZone);
    if (date < range.from || date > range.to) continue;
    const next = sorted[i + 1];
    const span = next ? next.at.getTime() - e.at.getTime() : Infinity;
    if (!next || next.kind !== 'OUT' || span > MAX_SHIFT_MS) {
      openClocks += 1;
      continue;
    }
    perDay.set(date, (perDay.get(date) ?? 0) + Math.floor(span / 60_000));
  }
  const days = [...perDay.entries()]
    .filter(([, minutes]) => minutes > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, minutes]) => ({
      date,
      minutes,
      overtimeMinutes: Math.max(0, minutes - overtimeAfterMinutes),
    }));
  return {
    days,
    workedMinutes: days.reduce((sum, d) => sum + d.minutes, 0),
    overtimeMinutes: days.reduce((sum, d) => sum + d.overtimeMinutes, 0),
    daysWorked: days.length,
    openClocks,
  };
}

async function calculate(
  tx: Client,
  propertyId: string,
  staffId: string,
  from: string,
  to: string,
) {
  const { property, attendance } = await propertyOf(tx, propertyId);
  const start = zonedInstant(from, '00:00', property.timeZone);
  // A shift that starts on the last day may end the next morning.
  const end = new Date(
    zonedInstant(addDays(to, 1), '00:00', property.timeZone).getTime() + MAX_SHIFT_MS,
  );
  const events = await tx.attendanceEvent.findMany({
    where: { staffId, at: { gte: start, lt: end } },
    select: { kind: true, at: true },
  });
  return addUpClocks(events, { from, to }, property.timeZone, attendance.overtimeAfterMinutes);
}

// ── Timesheets (M7-06) ─────────────────────────────────────────────────────────────────

const TIMESHEET_INCLUDE = {
  staff: STAFF_REF,
  approvedBy: PERSON,
} as const satisfies Prisma.TimesheetInclude;
type TimesheetRow = Prisma.TimesheetGetPayload<{ include: typeof TIMESHEET_INCLUDE }>;

function timesheetItem(t: TimesheetRow): z.input<typeof TimesheetItem> {
  return {
    id: t.id,
    staff: t.staff,
    from: day(t.periodStart),
    to: day(t.periodEnd),
    status: t.status as TimesheetStatus,
    workedMinutes: t.workedMinutes,
    overtimeMinutes: t.overtimeMinutes,
    approvedOvertimeMinutes: t.approvedOvertimeMinutes,
    daysWorked: t.daysWorked,
    openClocks: t.openClocks,
    days: t.days as { date: string; minutes: number; overtimeMinutes: number }[],
    calculatedAt: iso(t.calculatedAt),
    note: t.note,
    approvedBy: t.approvedBy,
    approvedAt: t.approvedAt ? iso(t.approvedAt) : null,
  };
}

async function timesheetOf(tx: Client, timesheetId: string) {
  const t = await tx.timesheet.findFirst({
    where: { id: timesheetId },
    include: TIMESHEET_INCLUDE,
  });
  if (!t) throw new AppError('NOT_FOUND', 'Timesheet not found.');
  return t;
}

export async function listTimesheets(
  deps: PayrollDeps,
  tenant: TenantContext,
  query: { month: string },
) {
  const { from, to } = monthRange(query.month);
  const db = deps.tenantDb;
  const [rows, staff, { attendance }] = await Promise.all([
    db.timesheet.findMany({
      where: { periodStart: { gte: dbDate(from), lte: dbDate(to) } },
      include: TIMESHEET_INCLUDE,
      orderBy: [{ staff: { name: 'asc' } }, { periodStart: 'asc' }],
    }),
    db.staffProfile.findMany({
      where: employedBetween(from, to),
      ...STAFF_REF,
      orderBy: { name: 'asc' },
    }),
    propertyOf(db, tenant.propertyId),
  ]);
  return {
    month: query.month,
    data: rows.map(timesheetItem),
    staff,
    overtimeAfterMinutes: attendance.overtimeAfterMinutes,
  };
}

export async function createTimesheet(
  deps: PayrollDeps,
  tenant: TenantContext,
  body: z.output<typeof TimesheetBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const staff = await tx.staffProfile.findFirst({ where: { id: body.staffId } });
    if (!staff) throw new AppError('NOT_FOUND', 'Staff member not found.');
    await tx.$queryRaw`SELECT id FROM staff_profiles WHERE id = ${staff.id}::uuid FOR UPDATE`;
    const overlap = await tx.timesheet.findFirst({
      where: {
        staffId: staff.id,
        periodStart: { lte: dbDate(body.to) },
        periodEnd: { gte: dbDate(body.from) },
      },
    });
    if (overlap) {
      throw invalid(
        'body.from',
        `Overlaps their timesheet from ${day(overlap.periodStart)} to ${day(overlap.periodEnd)}`,
      );
    }
    const figures = await calculate(tx, tenant.propertyId, staff.id, body.from, body.to);
    const t = await tx.timesheet.create({
      data: {
        staffId: staff.id,
        periodStart: dbDate(body.from),
        periodEnd: dbDate(body.to),
        ...figures,
        calculatedAt: deps.clock(),
        createdById: tenant.userId,
      } as unknown as Prisma.TimesheetUncheckedCreateInput, // tenant IDs come from the client
      include: TIMESHEET_INCLUDE,
    });
    return timesheetItem(t);
  });
}

async function draftForUpdate(tx: Tx, timesheetId: string) {
  const found = await timesheetOf(tx, timesheetId);
  await tx.$queryRaw`SELECT id FROM timesheets WHERE id = ${found.id}::uuid FOR UPDATE`;
  const t = await timesheetOf(tx, timesheetId);
  if (t.status !== 'DRAFT') {
    throw new AppError('STATE_TRANSITION_INVALID', 'This timesheet is already approved.', {
      status: t.status,
    });
  }
  return t;
}

export async function recalculateTimesheet(
  deps: PayrollDeps,
  tenant: TenantContext,
  timesheetId: string,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const t = await draftForUpdate(tx, timesheetId);
    const figures = await calculate(
      tx,
      tenant.propertyId,
      t.staffId,
      day(t.periodStart),
      day(t.periodEnd),
    );
    const after = await tx.timesheet.update({
      where: { id: t.id },
      data: { ...figures, calculatedAt: deps.clock() },
      include: TIMESHEET_INCLUDE,
    });
    return timesheetItem(after);
  });
}

export async function approveTimesheet(
  deps: PayrollDeps,
  tenant: TenantContext,
  timesheetId: string,
  body: z.output<typeof TimesheetApproval>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const t = await draftForUpdate(tx, timesheetId);
    const staff = await tx.staffProfile.findFirstOrThrow({ where: { id: t.staffId } });
    if (staff.userId === tenant.userId) {
      throw new AppError('FORBIDDEN', 'You cannot approve your own timesheet.');
    }
    // Approve what the clocks say now.
    const figures = await calculate(
      tx,
      tenant.propertyId,
      t.staffId,
      day(t.periodStart),
      day(t.periodEnd),
    );
    if (body.approvedOvertimeMinutes > figures.overtimeMinutes) {
      throw invalid(
        'body.approvedOvertimeMinutes',
        `At most the ${figures.overtimeMinutes} minutes of overtime calculated`,
      );
    }
    if (figures.openClocks > 0 && body.note === null) {
      throw invalid(
        'body.note',
        `${figures.openClocks} clock-in(s) have no clock-out and are not counted: say why you approve`,
      );
    }
    const after = await tx.timesheet.update({
      where: { id: t.id },
      data: {
        ...figures,
        calculatedAt: deps.clock(),
        status: 'APPROVED',
        approvedOvertimeMinutes: body.approvedOvertimeMinutes,
        approvedById: tenant.userId,
        approvedAt: deps.clock(),
        note: body.note,
      },
      include: TIMESHEET_INCLUDE,
    });
    await recordAudit(tx, {
      action: 'timesheet.approved',
      entityType: 'timesheet',
      entityId: t.id,
      after: {
        staffId: t.staffId,
        from: day(t.periodStart),
        to: day(t.periodEnd),
        workedMinutes: figures.workedMinutes,
        overtimeMinutes: figures.overtimeMinutes,
        approvedOvertimeMinutes: body.approvedOvertimeMinutes,
        openClocks: figures.openClocks,
        note: body.note,
      },
    });
    return timesheetItem(after);
  });
}

export async function deleteTimesheet(deps: PayrollDeps, timesheetId: string) {
  return deps.tenantDb.$transaction(async (tx) => {
    const t = await draftForUpdate(tx, timesheetId);
    await tx.timesheet.delete({ where: { id: t.id } });
    return { removed: true as const };
  });
}

// ── Pay items (M7-07) ──────────────────────────────────────────────────────────────────

const PAY_ITEM_INCLUDE = {
  staff: STAFF_REF,
  requestedBy: PERSON,
  decidedBy: PERSON,
} as const satisfies Prisma.PayItemInclude;
type PayItemRow = Prisma.PayItemGetPayload<{ include: typeof PAY_ITEM_INCLUDE }>;

function payItem(p: PayItemRow): z.input<typeof PayItem> {
  return {
    id: p.id,
    staff: p.staff,
    type: p.type as PayItemType,
    amountMinor: p.amountMinor.toString(),
    currency: p.currency,
    month: day(p.payMonth).slice(0, 7),
    description: p.description,
    status: p.status as PayItemStatus,
    requestedBy: p.requestedBy,
    decidedBy: p.decidedBy,
    decidedAt: p.decidedAt ? iso(p.decidedAt) : null,
    decisionNote: p.decisionNote,
    createdAt: iso(p.createdAt),
  };
}

export async function listPayItems(deps: PayrollDeps, query: { month: string }) {
  const { from, to } = monthRange(query.month);
  const [rows, staff] = await Promise.all([
    deps.tenantDb.payItem.findMany({
      where: { payMonth: dbDate(from) },
      include: PAY_ITEM_INCLUDE,
      orderBy: [{ createdAt: 'asc' }],
    }),
    deps.tenantDb.staffProfile.findMany({
      where: employedBetween(from, to),
      ...STAFF_REF,
      orderBy: { name: 'asc' },
    }),
  ]);
  return { month: query.month, data: rows.map(payItem), staff };
}

export async function createPayItem(
  deps: PayrollDeps,
  tenant: TenantContext,
  body: z.output<typeof PayItemBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const staff = await tx.staffProfile.findFirst({ where: { id: body.staffId } });
    if (!staff) throw new AppError('NOT_FOUND', 'Staff member not found.');
    const { from, to } = monthRange(body.month);
    const employed =
      day(staff.startDate) <= to && (staff.endDate === null || day(staff.endDate) >= from);
    if (!employed) throw invalid('body.month', `ST-${staff.number} was not employed that month`);
    const { property } = await propertyOf(tx, tenant.propertyId);
    const p = await tx.payItem.create({
      data: {
        staffId: staff.id,
        type: body.type,
        amountMinor: BigInt(body.amountMinor),
        currency: property.baseCurrency,
        payMonth: dbDate(from),
        description: body.description,
        requestedById: tenant.userId,
      } as unknown as Prisma.PayItemUncheckedCreateInput, // tenant IDs come from the client
      include: PAY_ITEM_INCLUDE,
    });
    await recordAudit(tx, {
      action: 'pay_item.recorded',
      entityType: 'pay_item',
      entityId: p.id,
      after: {
        staffId: staff.id,
        type: body.type,
        amountMinor: body.amountMinor,
        month: body.month,
      },
    });
    return payItem(p);
  });
}

async function pendingForUpdate(tx: Tx, payItemId: string) {
  const found = await tx.payItem.findFirst({ where: { id: payItemId } });
  if (!found) throw new AppError('NOT_FOUND', 'Advance or deduction not found.');
  await tx.$queryRaw`SELECT id FROM pay_items WHERE id = ${found.id}::uuid FOR UPDATE`;
  const p = await tx.payItem.findFirstOrThrow({ where: { id: payItemId } });
  if (p.status !== 'PENDING') {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      `This item is already ${p.status.toLowerCase()}.`,
      { status: p.status },
    );
  }
  return p;
}

export async function decidePayItem(
  deps: PayrollDeps,
  tenant: TenantContext,
  payItemId: string,
  body: z.output<typeof PayItemDecision>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const p = await pendingForUpdate(tx, payItemId);
    if (p.requestedById === tenant.userId) {
      throw new AppError('FORBIDDEN', 'Someone else must approve what you recorded.');
    }
    const staff = await tx.staffProfile.findFirstOrThrow({ where: { id: p.staffId } });
    if (staff.userId === tenant.userId) {
      throw new AppError('FORBIDDEN', 'You cannot decide an item on your own pay.');
    }
    const approve = body.decision === 'APPROVE';
    const after = await tx.payItem.update({
      where: { id: p.id },
      data: {
        status: approve ? 'APPROVED' : 'REJECTED',
        decidedById: tenant.userId,
        decidedAt: deps.clock(),
        decisionNote: body.note,
      },
      include: PAY_ITEM_INCLUDE,
    });
    await recordAudit(tx, {
      action: approve ? 'pay_item.approved' : 'pay_item.rejected',
      entityType: 'pay_item',
      entityId: p.id,
      before: { status: 'PENDING' },
      after: { status: after.status, note: body.note, amountMinor: p.amountMinor.toString() },
    });
    return payItem(after);
  });
}

export async function cancelPayItem(deps: PayrollDeps, payItemId: string) {
  return deps.tenantDb.$transaction(async (tx) => {
    const p = await pendingForUpdate(tx, payItemId);
    const after = await tx.payItem.update({
      where: { id: p.id },
      data: { status: 'CANCELLED' },
      include: PAY_ITEM_INCLUDE,
    });
    await recordAudit(tx, {
      action: 'pay_item.cancelled',
      entityType: 'pay_item',
      entityId: p.id,
      before: { status: 'PENDING' },
      after: { status: 'CANCELLED' },
    });
    return payItem(after);
  });
}

// ── Payroll file (M7-08) ───────────────────────────────────────────────────────────────

type Payroll = z.input<typeof PayrollExport>;

export async function getPayrollExport(
  deps: PayrollDeps,
  tenant: TenantContext,
  query: { month: string; format: 'json' | 'csv' },
) {
  const db = deps.tenantDb;
  const { from, to } = monthRange(query.month);
  const { property } = await propertyOf(db, tenant.propertyId);
  const [staff, timesheets, items, draftTimesheets, pendingPayItems] = await Promise.all([
    db.staffProfile.findMany({
      where: employedBetween(from, to),
      include: { department: { select: { name: true } } },
      orderBy: { number: 'asc' },
    }),
    db.timesheet.findMany({
      where: {
        status: 'APPROVED',
        periodStart: { gte: dbDate(from) },
        periodEnd: { lte: dbDate(to) },
      },
    }),
    db.payItem.findMany({ where: { status: 'APPROVED', payMonth: dbDate(from) } }),
    db.timesheet.count({
      where: {
        status: 'DRAFT',
        periodStart: { gte: dbDate(from) },
        periodEnd: { lte: dbDate(to) },
      },
    }),
    db.payItem.count({ where: { status: 'PENDING', payMonth: dbDate(from) } }),
  ]);
  const sum = (type: PayItemType, staffId: string) =>
    items
      .filter((i) => i.staffId === staffId && i.type === type)
      .reduce((total, i) => total + i.amountMinor, 0n)
      .toString();
  const report: Payroll = {
    month: query.month,
    from,
    to,
    currency: property.baseCurrency,
    rows: staff.map((s) => {
      const mine = timesheets.filter((t) => t.staffId === s.id);
      return {
        staff: { id: s.id, number: s.number, name: s.name },
        department: s.department?.name ?? null,
        jobTitle: s.jobTitle,
        employmentType: s.employmentType as EmploymentType,
        startDate: day(s.startDate),
        endDate: s.endDate ? day(s.endDate) : null,
        payRateMinor: s.payRateMinor === null ? null : s.payRateMinor.toString(),
        timesheets: mine.length,
        daysWorked: mine.reduce((n, t) => n + t.daysWorked, 0),
        workedMinutes: mine.reduce((n, t) => n + t.workedMinutes, 0),
        approvedOvertimeMinutes: mine.reduce((n, t) => n + (t.approvedOvertimeMinutes ?? 0), 0),
        advancesMinor: sum('ADVANCE', s.id),
        deductionsMinor: sum('DEDUCTION', s.id),
      };
    }),
    waiting: { draftTimesheets, pendingPayItems },
  };
  if (query.format === 'json') return report;
  await recordAudit(db, {
    action: 'payroll.exported',
    entityType: 'property',
    entityId: tenant.propertyId,
    after: { month: query.month, rows: report.rows.length, ...report.waiting },
  });
  return exportFile(`payroll-${property.code}-${query.month}.csv`, 'text/csv', payrollCsv(report));
}

const hours = (minutes: number) => (minutes / 60).toFixed(2);

export function payrollCsv(r: Payroll): Uint8Array {
  return csv([
    [
      'Staff number',
      'Name',
      'Department',
      'Job title',
      'Employment type',
      'Start date',
      'End date',
      `Pay rate (${r.currency})`,
      'Approved timesheets',
      'Days worked',
      'Hours worked',
      'Approved overtime hours',
      `Advances (${r.currency})`,
      `Deductions (${r.currency})`,
    ],
    ...r.rows.map((row) => [
      `ST-${row.staff.number}`,
      row.staff.name,
      row.department,
      row.jobTitle,
      row.employmentType,
      row.startDate,
      row.endDate,
      row.payRateMinor === null ? null : decimal(row.payRateMinor),
      row.timesheets,
      row.daysWorked,
      hours(row.workedMinutes),
      hours(row.approvedOvertimeMinutes),
      decimal(row.advancesMinor),
      decimal(row.deductionsMinor),
    ]),
  ]);
}
