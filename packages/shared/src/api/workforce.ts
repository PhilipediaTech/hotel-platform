import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';
import { TimeOfDay } from './properties.ts';

// Duties, rotas and leave (PRD M7-02 "As a manager, I assign standing duties to salaried staff
// without a rota", staff.duty; M7-03 "As a manager, I enable optional rotas per department and
// publish weekly or monthly schedules", rota.manage; M7-05 "As staff, I request leave; my
// manager approves or rejects", leave.request, leave.approve; M7 acceptance: "a leave approval
// removes the staff member from rota slots on those dates"; tab 3 duties, rota_patterns,
// shift_assignments, leave_requests; tab 4 /duties · /rotas · /leave-requests; S36; T-137).
// Rotas are optional: a department has one when it has shifts, and salaried staff can work
// from standing duties alone.

export const LEAVE_TYPES = ['ANNUAL', 'SICK', 'UNPAID', 'COMPASSIONATE', 'OTHER'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];
export const ROTA_SLOT_STATUSES = ['DRAFT', 'PUBLISHED', 'REMOVED'] as const;
export type RotaSlotStatus = (typeof ROTA_SLOT_STATUSES)[number];
export const ROTA_PERIODS = ['WEEKLY', 'MONTHLY'] as const;
export type RotaPeriod = (typeof ROTA_PERIODS)[number];
/** Longest stretch the rota or a leave request covers at once. */
export const MAX_ROTA_DAYS = 62;
export const MAX_LEAVE_DAYS = 366;

/** Calendar days from start to end, both included. */
export function leaveDays(startDate: string, endDate: string): number {
  const ms = Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** The last date a schedule published from `from` covers: 7 days, or one month. */
export function rotaPeriodEnd(from: string, period: RotaPeriod): string {
  const d = new Date(`${from}T00:00:00Z`);
  if (period === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 6);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    // The day before the same date next month; a date the month lacks ends on its last day.
    if (day > last) d.setUTCDate(last);
    else d.setUTCDate(day - 1);
  }
  return d.toISOString().slice(0, 10);
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
const Weekdays = z
  .array(z.number().int().min(1).max(7))
  .max(7)
  .transform((v) => [...new Set(v)].sort((a, b) => a - b));

// ── Duties (M7-02) ─────────────────────────────────────────────────────────────────────

export const DutyItem = z
  .object({
    id: Uuid,
    staff: StaffRef.extend({ jobTitle: z.string() }),
    title: z.string(),
    notes: z.string().nullable(),
    /** ISO weekdays, 1 Monday ... 7 Sunday; empty means every day. */
    weekdays: z.array(z.number().int()),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
    active: z.boolean(),
  })
  .meta({ id: 'Duty' });

export const DutyBody = z
  .object({
    staffId: Uuid,
    title: Text(1, 120),
    notes: Optional(500).default(null),
    weekdays: Weekdays.default([]),
    startTime: TimeOfDay.nullable().default(null),
    endTime: TimeOfDay.nullable().default(null),
  })
  .meta({ id: 'DutyBody' });

export const DutyPatch = z
  .object({
    title: Text(1, 120).optional(),
    notes: Optional(500).optional(),
    weekdays: Weekdays.optional(),
    startTime: TimeOfDay.nullable().optional(),
    endTime: TimeOfDay.nullable().optional(),
    /** false stops the duty; true starts it again. */
    active: z.boolean().optional(),
  })
  .meta({ id: 'DutyPatch' });

// ── Rotas (M7-03) ──────────────────────────────────────────────────────────────────────

export const RotaShift = z
  .object({
    id: Uuid,
    name: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    active: z.boolean(),
  })
  .meta({ id: 'RotaShift' });

export const ShiftAssignmentItem = z
  .object({
    id: Uuid,
    shiftId: Uuid,
    staff: StaffRef,
    date: IsoDate,
    status: z.enum(ROTA_SLOT_STATUSES),
    /** Set when approved leave took them off this slot. */
    leaveRequestId: Uuid.nullable(),
  })
  .meta({ id: 'ShiftAssignment' });

export const RotaShiftBody = z
  .object({ name: Text(1, 60), startTime: TimeOfDay, endTime: TimeOfDay })
  .refine((v) => v.startTime !== v.endTime, {
    path: ['endTime'],
    message: 'A shift must end at a different time',
  })
  .meta({ id: 'RotaShiftBody' });

export const RotaShiftPatch = z
  .object({
    name: Text(1, 60).optional(),
    startTime: TimeOfDay.optional(),
    endTime: TimeOfDay.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'RotaShiftPatch' });

export const Rota = z
  .object({
    /** Null when the property has no departments yet. */
    department: z.object({ id: Uuid, name: z.string() }).nullable(),
    from: IsoDate,
    to: IsoDate,
    /** No active shift means this department works without a rota. */
    shifts: z.array(RotaShift),
    assignments: z.array(ShiftAssignmentItem),
    /** Active staff who can be put on the rota (any department, for cover). */
    staff: z.array(StaffRef.extend({ departmentId: Uuid.nullable() })),
    /** Approved leave in the range, so nobody on leave is put on a shift. */
    leave: z.array(
      z.object({ staffId: Uuid, startDate: IsoDate, endDate: IsoDate, type: z.enum(LEAVE_TYPES) }),
    ),
    departments: z.array(z.object({ id: Uuid, name: z.string(), hasRota: z.boolean() })),
  })
  .meta({ id: 'Rota' });

// ── Leave (M7-05) ──────────────────────────────────────────────────────────────────────

export const LeaveItem = z
  .object({
    id: Uuid,
    staff: StaffRef.extend({ department: z.string().nullable() }),
    type: z.enum(LEAVE_TYPES),
    startDate: IsoDate,
    endDate: IsoDate,
    days: z.number().int(),
    reason: z.string().nullable(),
    status: z.enum(LEAVE_STATUSES),
    decidedBy: z.object({ id: Uuid, name: z.string() }).nullable(),
    decidedAt: Instant.nullable(),
    decisionNote: z.string().nullable(),
    /** Rota slots approval took them off. */
    shiftsRemoved: z.number().int(),
    createdAt: Instant,
  })
  .meta({ id: 'LeaveRequest' });

export const LeaveBody = z
  .object({
    type: z.enum(LEAVE_TYPES),
    startDate: IsoDate,
    endDate: IsoDate,
    reason: Optional(500).default(null),
  })
  .refine((v) => v.endDate >= v.startDate, {
    path: ['endDate'],
    message: 'Ends before it starts',
  })
  .refine((v) => v.endDate < v.startDate || leaveDays(v.startDate, v.endDate) <= MAX_LEAVE_DAYS, {
    path: ['endDate'],
    message: `At most ${MAX_LEAVE_DAYS} days at a time`,
  })
  .meta({ id: 'LeaveBody' });

export const LeaveDecision = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: Optional(500).default(null),
  })
  .refine((v) => v.decision === 'APPROVE' || v.note !== null, {
    path: ['note'],
    message: 'Say why it is rejected',
  })
  .meta({ id: 'LeaveDecision' });

export const MyWork = z
  .object({
    /** Null when no staff profile is linked to this login yet. */
    staff: StaffRef.nullable(),
    today: IsoDate,
    duties: z.array(DutyItem),
    /** Published shifts from today, four weeks ahead. */
    shifts: z.array(
      z.object({
        id: Uuid,
        date: IsoDate,
        shift: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        department: z.string(),
      }),
    ),
    leave: z.array(LeaveItem),
  })
  .meta({ id: 'MyWork' });

const ADDED = 'Tab 4 lists the path; the request and response are designed in T-137.';
const DUTY = { tags: ['Staff'], propertyScoped: true as const, permission: 'staff.duty' };
const ROTA = { tags: ['Staff'], propertyScoped: true as const, permission: 'rota.manage' };
const LEAVE = { tags: ['Staff'], propertyScoped: true as const, permission: 'leave.approve' };
const OWN = { tags: ['Staff'], propertyScoped: true as const, permission: 'leave.request' };

export const listDuties = defineRoute({
  ...DUTY,
  operationId: 'listDuties',
  method: 'get',
  path: '/duties',
  summary: 'Standing duties of active staff (M7-02)',
  description: `${ADDED} Stopped duties too, after the active ones.`,
  response: z.object({ data: z.array(DutyItem), staff: z.array(StaffRef) }),
});

export const createDuty = defineRoute({
  ...DUTY,
  operationId: 'createDuty',
  method: 'post',
  path: '/duties',
  summary: 'Give a member of staff a standing duty, with no rota (M7-02)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: DutyBody,
  response: DutyItem,
});

export const updateDuty = defineRoute({
  ...DUTY,
  operationId: 'updateDuty',
  method: 'patch',
  path: '/duties/{dutyId}',
  summary: 'Change, stop or restart a duty (M7-02)',
  description: ADDED,
  params: z.object({ dutyId: Uuid }),
  body: DutyPatch,
  response: DutyItem,
});

export const getRota = defineRoute({
  ...ROTA,
  operationId: 'getRota',
  method: 'get',
  path: '/rotas',
  summary: "A department's rota for a range of dates (M7-03)",
  description: `${ADDED} Up to ${MAX_ROTA_DAYS} days; drafts, published and removed slots. Without a department, the first one with a rota (or the first one).`,
  query: z.object({ departmentId: Uuid.optional(), from: IsoDate, to: IsoDate }),
  response: Rota,
});

export const addRotaShift = defineRoute({
  ...ROTA,
  operationId: 'addRotaShift',
  method: 'post',
  path: '/rotas/{departmentId}/shifts',
  summary: "Add a shift to a department's rota, which turns the rota on (M7-03)",
  description: ADDED,
  idempotent: true,
  status: 201,
  params: z.object({ departmentId: Uuid }),
  body: RotaShiftBody,
  response: RotaShift,
});

export const updateRotaShift = defineRoute({
  ...ROTA,
  operationId: 'updateRotaShift',
  method: 'patch',
  path: '/rotas/shifts/{shiftId}',
  summary: 'Rename, retime or stop a rota shift (M7-03)',
  description: `${ADDED} Stopping every shift turns the department's rota off.`,
  params: z.object({ shiftId: Uuid }),
  body: RotaShiftPatch,
  response: RotaShift,
});

export const assignShift = defineRoute({
  ...ROTA,
  operationId: 'assignShift',
  method: 'post',
  path: '/rotas/assignments',
  summary: 'Put a member of staff on a shift on a date, as a draft (M7-03)',
  description: `${ADDED} Refused on a date of their approved leave.`,
  idempotent: true,
  status: 201,
  body: z.object({ shiftId: Uuid, staffId: Uuid, date: IsoDate }),
  response: ShiftAssignmentItem,
});

export const unassignShift = defineRoute({
  ...ROTA,
  operationId: 'unassignShift',
  method: 'delete',
  path: '/rotas/assignments/{assignmentId}',
  summary: 'Take someone off a shift (M7-03)',
  description: `${ADDED} Audited when the slot was published.`,
  params: z.object({ assignmentId: Uuid }),
  errors: ['STATE_TRANSITION_INVALID'],
  response: z.object({ removed: z.literal(true) }),
});

export const publishRota = defineRoute({
  ...ROTA,
  operationId: 'publishRota',
  method: 'post',
  path: '/rotas/{departmentId}/publish',
  summary: 'Publish the drafts for a week or a month (M7-03)',
  description: `${ADDED} WEEKLY covers 7 days from the date, MONTHLY up to the same date next month.`,
  params: z.object({ departmentId: Uuid }),
  body: z.object({ from: IsoDate, period: z.enum(ROTA_PERIODS) }),
  response: z.object({ from: IsoDate, to: IsoDate, published: z.number().int() }),
});

export const getMyWork = defineRoute({
  ...OWN,
  operationId: 'getMyWork',
  method: 'get',
  path: '/leave-requests/mine',
  summary: 'My leave requests, standing duties and published shifts (M7-02, M7-03, M7-05)',
  description: `${ADDED} Found through the staff profile linked to this login.`,
  response: MyWork,
});

export const requestLeave = defineRoute({
  ...OWN,
  operationId: 'requestLeave',
  method: 'post',
  path: '/leave-requests',
  summary: 'Ask for leave (M7-05)',
  description: `${ADDED} Refused when it overlaps leave already asked for or approved.`,
  idempotent: true,
  status: 201,
  body: LeaveBody,
  response: LeaveItem,
});

export const cancelLeave = defineRoute({
  ...OWN,
  operationId: 'cancelLeave',
  method: 'post',
  path: '/leave-requests/{leaveId}/cancel',
  summary: 'Withdraw my leave request before it is decided (M7-05)',
  description: ADDED,
  params: z.object({ leaveId: Uuid }),
  errors: ['STATE_TRANSITION_INVALID'],
  response: LeaveItem,
});

export const listLeave = defineRoute({
  ...LEAVE,
  operationId: 'listLeave',
  method: 'get',
  path: '/leave-requests',
  summary: 'Leave requests to decide, or decided (M7-05)',
  description: `${ADDED} Pending by default, oldest first.`,
  query: z.object({ status: z.enum(LEAVE_STATUSES).optional() }),
  response: z.object({ data: z.array(LeaveItem) }),
});

export const decideLeave = defineRoute({
  ...LEAVE,
  operationId: 'decideLeave',
  method: 'post',
  path: '/leave-requests/{leaveId}/decision',
  summary: 'Approve or reject leave; approval takes them off the rota on those dates (M7-05)',
  description: `${ADDED} Nobody decides their own leave.`,
  params: z.object({ leaveId: Uuid }),
  errors: ['STATE_TRANSITION_INVALID'],
  body: LeaveDecision,
  response: LeaveItem,
});

export const WORKFORCE_ROUTES = {
  listDuties,
  createDuty,
  updateDuty,
  getRota,
  addRotaShift,
  updateRotaShift,
  assignShift,
  unassignShift,
  publishRota,
  getMyWork,
  requestLeave,
  cancelLeave,
  listLeave,
  decideLeave,
} as const;
