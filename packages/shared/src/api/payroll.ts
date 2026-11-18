import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';
import { EMPLOYMENT_TYPES } from './staff.ts';

// Timesheets, advances and deductions, payroll export (PRD M7-06 "As a manager, I approve
// timesheets and overtime", timesheet.approve; M7-07 "As HR, I record advances and deductions
// with approval", staff.payitem; M7-08 "As HR, I export a payroll file for the period",
// payroll.export; M7 rules "no pay amount is computed from attendance unless a pay rule is
// configured" and "payroll export contains approved items only"; acceptance "a
// monthly-salaried staff member with no rota ... appears in payroll export"; tab 3 timesheets,
// pay_items; tab 4 /timesheets, /payroll-exports; S36; T-139).
// - A timesheet covers dates within one month and adds up the person's clocks: each clock-in
//   paired with the next clock-out, counted on the day it started. Minutes beyond the daily
//   threshold (attendance settings) are overtime; the approver accepts all or part of it.
// - Pay items are recorded by one person and approved by another.
// - The payroll file lists everyone employed in the month, with their recorded pay rate,
//   approved timesheet totals and approved items. It computes no pay: no pay rule exists yet.

export const TIMESHEET_STATUSES = ['DRAFT', 'APPROVED'] as const;
export type TimesheetStatus = (typeof TIMESHEET_STATUSES)[number];
export const PAY_ITEM_TYPES = ['ADVANCE', 'DEDUCTION'] as const;
export type PayItemType = (typeof PAY_ITEM_TYPES)[number];
export const PAY_ITEM_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type PayItemStatus = (typeof PAY_ITEM_STATUSES)[number];

/** A pay month, YYYY-MM. */
export const PayMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-11')
  .meta({ id: 'PayMonth', example: '2026-11' });

/** The first and last date of a YYYY-MM month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
const Optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();
const StaffRef = z.object({ id: Uuid, number: z.number().int(), name: z.string() });
const Person = z.object({ id: Uuid, name: z.string() });
const Positive = AmountMinor.refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, 'More than zero');

// ── Timesheets (M7-06) ─────────────────────────────────────────────────────────────────

export const TimesheetDay = z.object({
  date: IsoDate,
  minutes: z.number().int(),
  overtimeMinutes: z.number().int(),
});

export const TimesheetItem = z
  .object({
    id: Uuid,
    staff: StaffRef,
    from: IsoDate,
    to: IsoDate,
    status: z.enum(TIMESHEET_STATUSES),
    workedMinutes: z.number().int(),
    overtimeMinutes: z.number().int(),
    approvedOvertimeMinutes: z.number().int().nullable(),
    daysWorked: z.number().int(),
    /** Clock-ins with no clock-out, not counted: fix before approving. */
    openClocks: z.number().int(),
    days: z.array(TimesheetDay),
    calculatedAt: Instant,
    note: z.string().nullable(),
    approvedBy: Person.nullable(),
    approvedAt: Instant.nullable(),
  })
  .meta({ id: 'Timesheet' });

export const TimesheetBody = z
  .object({ staffId: Uuid, from: IsoDate, to: IsoDate })
  .refine((v) => v.to >= v.from, { path: ['to'], message: 'Ends before it starts' })
  .refine((v) => v.from.slice(0, 7) === v.to.slice(0, 7), {
    path: ['to'],
    message: 'A timesheet stays within one month',
  })
  .meta({ id: 'TimesheetBody' });

export const TimesheetApproval = z
  .object({
    /** Overtime accepted, at most what was calculated. */
    approvedOvertimeMinutes: z.number().int().min(0),
    note: Optional(500).default(null),
  })
  .meta({ id: 'TimesheetApproval' });

// ── Pay items (M7-07) ──────────────────────────────────────────────────────────────────

export const PayItem = z
  .object({
    id: Uuid,
    staff: StaffRef,
    type: z.enum(PAY_ITEM_TYPES),
    amountMinor: AmountMinor,
    currency: z.string(),
    month: PayMonth,
    description: z.string(),
    status: z.enum(PAY_ITEM_STATUSES),
    requestedBy: Person,
    decidedBy: Person.nullable(),
    decidedAt: Instant.nullable(),
    decisionNote: z.string().nullable(),
    createdAt: Instant,
  })
  .meta({ id: 'PayItem' });

export const PayItemBody = z
  .object({
    staffId: Uuid,
    type: z.enum(PAY_ITEM_TYPES),
    amountMinor: Positive,
    month: PayMonth,
    description: Text(1, 300),
  })
  .meta({ id: 'PayItemBody' });

export const PayItemDecision = z
  .object({ decision: z.enum(['APPROVE', 'REJECT']), note: Optional(500).default(null) })
  .refine((v) => v.decision === 'APPROVE' || v.note !== null, {
    path: ['note'],
    message: 'Say why it is rejected',
  })
  .meta({ id: 'PayItemDecision' });

// ── Payroll export (M7-08) ─────────────────────────────────────────────────────────────

export const PayrollRow = z
  .object({
    staff: StaffRef,
    department: z.string().nullable(),
    jobTitle: z.string(),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    startDate: IsoDate,
    endDate: IsoDate.nullable(),
    /** As recorded on the profile, per its period; null when not recorded. No pay is computed. */
    payRateMinor: AmountMinor.nullable(),
    timesheets: z.number().int(),
    daysWorked: z.number().int(),
    workedMinutes: z.number().int(),
    approvedOvertimeMinutes: z.number().int(),
    advancesMinor: AmountMinor,
    deductionsMinor: AmountMinor,
  })
  .meta({ id: 'PayrollRow' });

export const PayrollExport = z
  .object({
    month: PayMonth,
    from: IsoDate,
    to: IsoDate,
    currency: z.string(),
    rows: z.array(PayrollRow),
    /** Left out because not approved: shown so nothing is missed. */
    waiting: z.object({ draftTimesheets: z.number().int(), pendingPayItems: z.number().int() }),
  })
  .meta({ id: 'PayrollExport' });

const ADDED = 'Tab 4 lists the path; the request and response are designed in T-139.';
const TS = { tags: ['Staff'], propertyScoped: true as const, permission: 'timesheet.approve' };
const PAY = { tags: ['Staff'], propertyScoped: true as const, permission: 'staff.payitem' };

export const listTimesheets = defineRoute({
  ...TS,
  operationId: 'listTimesheets',
  method: 'get',
  path: '/timesheets',
  summary: "A month's timesheets, and the staff employed then (M7-06)",
  description: ADDED,
  query: z.object({ month: PayMonth }),
  response: z.object({
    month: PayMonth,
    data: z.array(TimesheetItem),
    staff: z.array(StaffRef),
    overtimeAfterMinutes: z.number().int(),
  }),
});

export const createTimesheet = defineRoute({
  ...TS,
  operationId: 'createTimesheet',
  method: 'post',
  path: '/timesheets',
  summary: "Add up a member's clocks for dates within one month, as a draft (M7-06)",
  description: `${ADDED} Refused when it overlaps another of their timesheets.`,
  idempotent: true,
  status: 201,
  body: TimesheetBody,
  response: TimesheetItem,
});

export const recalculateTimesheet = defineRoute({
  ...TS,
  operationId: 'recalculateTimesheet',
  method: 'post',
  path: '/timesheets/{timesheetId}/recalculate',
  summary: 'Add up a draft timesheet again from the clocks (M7-06)',
  description: ADDED,
  params: z.object({ timesheetId: Uuid }),
  response: TimesheetItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const approveTimesheet = defineRoute({
  ...TS,
  operationId: 'approveTimesheet',
  method: 'post',
  path: '/timesheets/{timesheetId}/approve',
  summary: 'Approve a timesheet and the overtime accepted (M7-06)',
  description: `${ADDED} Added up again first; refused with open clocks, and for your own timesheet.`,
  params: z.object({ timesheetId: Uuid }),
  body: TimesheetApproval,
  response: TimesheetItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const deleteTimesheet = defineRoute({
  ...TS,
  operationId: 'deleteTimesheet',
  method: 'delete',
  path: '/timesheets/{timesheetId}',
  summary: 'Remove a draft timesheet (M7-06)',
  description: ADDED,
  params: z.object({ timesheetId: Uuid }),
  response: z.object({ removed: z.literal(true) }),
  errors: ['STATE_TRANSITION_INVALID'],
});

export const listPayItems = defineRoute({
  ...PAY,
  operationId: 'listPayItems',
  method: 'get',
  path: '/pay-items',
  summary: "A month's advances and deductions (M7-07)",
  description: ADDED,
  query: z.object({ month: PayMonth }),
  response: z.object({ month: PayMonth, data: z.array(PayItem), staff: z.array(StaffRef) }),
});

export const createPayItem = defineRoute({
  ...PAY,
  operationId: 'createPayItem',
  method: 'post',
  path: '/pay-items',
  summary: 'Record an advance or a deduction, waiting for approval (M7-07)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: PayItemBody,
  response: PayItem,
});

export const decidePayItem = defineRoute({
  ...PAY,
  operationId: 'decidePayItem',
  method: 'post',
  path: '/pay-items/{payItemId}/decision',
  summary: 'Approve or reject an advance or deduction (M7-07)',
  description: `${ADDED} Never by the person who recorded it.`,
  params: z.object({ payItemId: Uuid }),
  body: PayItemDecision,
  response: PayItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const cancelPayItem = defineRoute({
  ...PAY,
  operationId: 'cancelPayItem',
  method: 'post',
  path: '/pay-items/{payItemId}/cancel',
  summary: 'Withdraw an advance or deduction still waiting (M7-07)',
  description: ADDED,
  params: z.object({ payItemId: Uuid }),
  response: PayItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const getPayrollExport = defineRoute({
  tags: ['Staff'],
  propertyScoped: true,
  permission: 'payroll.export',
  operationId: 'getPayrollExport',
  method: 'get',
  path: '/payroll-exports',
  summary: 'The payroll file for a month: approved items only (M7-08)',
  description: `${ADDED} \`?format=csv\` answers the file (payroll.export is enough) and is audited.`,
  exports: true,
  exportPermission: 'payroll.export',
  query: z.object({ month: PayMonth, format: z.enum(['json', 'csv']).default('json') }),
  response: PayrollExport,
});

export const PAYROLL_ROUTES = {
  listTimesheets,
  createTimesheet,
  recalculateTimesheet,
  approveTimesheet,
  deleteTimesheet,
  listPayItems,
  createPayItem,
  decidePayItem,
  cancelPayItem,
  getPayrollExport,
} as const;
