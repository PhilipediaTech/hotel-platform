import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, PdfDocument, Uuid } from './primitives.ts';

// Business day and night audit (PRD M4 rule 8 and its acceptance criteria; tab 4 row "Night
// audit" and the POST /night-audits example; S15; T-054, T-073). A live property trades on one
// open business day. Night audit runs ten steps for it, each idempotent and resumable; a step
// with exceptions to resolve stops the run (FAILED, at that step) until it is resumed. The
// last step closes the day and opens the next.

export const DAY_STATUSES = ['OPEN', 'AUDITING', 'CLOSED'] as const;
export const RUN_STATUSES = ['RUNNING', 'FAILED', 'COMPLETED'] as const;
export const STEP_STATUSES = ['PENDING', 'DONE', 'BLOCKED', 'FAILED', 'SKIPPED'] as const;

/** The ten steps, in order (M4 rule 8). */
export const NIGHT_AUDIT_STEPS = [
  { step: 1, name: 'OPEN_SHIFTS', label: 'Check open shifts' },
  { step: 2, name: 'ARRIVALS_DEPARTURES', label: 'Review unarrived arrivals and due-outs' },
  { step: 3, name: 'ROOM_STATUS', label: 'Reconcile front office and housekeeping' },
  { step: 4, name: 'ROOM_AND_TAX', label: 'Post room and tax' },
  { step: 5, name: 'PACKAGES', label: 'Post package and fixed charges' },
  { step: 6, name: 'NO_SHOWS', label: 'Post no-show fees' },
  { step: 7, name: 'FX_LOCK', label: 'Lock exchange rates' },
  { step: 8, name: 'LEAKAGE', label: 'Run leakage rules' },
  { step: 9, name: 'REPORTS', label: 'Generate reports' },
  { step: 10, name: 'CLOSE_DAY', label: 'Close the day and open the next' },
] as const;
export type NightAuditStepName = (typeof NIGHT_AUDIT_STEPS)[number]['name'];

/** The reports step 9 keeps for the closed day (PRD M10 night auditor story). */
export const NIGHT_AUDIT_REPORTS = [
  'flash',
  'trial-balance',
  'cashier',
  'high-balance',
  'discrepancy',
] as const;
export type NightAuditReportName = (typeof NIGHT_AUDIT_REPORTS)[number];

export const BusinessDayItem = z
  .object({
    date: IsoDate,
    status: z.enum(DAY_STATUSES),
    /** Null while the property is not live (it has no business days yet). */
    openedAt: Instant.nullable(),
    /** The night audit run for this date, once started. */
    nightAuditId: Uuid.nullable(),
  })
  .meta({ id: 'BusinessDay' });

/** Something a step found: blocking ones stop the run until they are resolved. */
export const NightAuditException = z
  .object({
    type: z.string(),
    blocking: z.boolean(),
    message: z.string(),
    shiftId: Uuid.optional(),
    stayId: Uuid.optional(),
    reservationId: Uuid.optional(),
    folioId: Uuid.optional(),
    roomId: Uuid.optional(),
    /** Who or what it is about, for the list (a cashier, a guest, a room). */
    subject: z.string().optional(),
  })
  .meta({ id: 'NightAuditException' });

export const NightAuditStepItem = z
  .object({
    step: z.int(),
    name: z.string(),
    status: z.enum(STEP_STATUSES),
    exceptions: z.array(NightAuditException),
    /** Counts and totals the step produced (amounts in minor units, as strings). */
    result: z.record(z.string(), z.union([z.string(), z.number()])),
    startedAt: Instant.nullable(),
    finishedAt: Instant.nullable(),
  })
  .meta({ id: 'NightAuditStep' });

export const NightAuditItem = z
  .object({
    id: Uuid,
    businessDate: IsoDate,
    status: z.enum(RUN_STATUSES),
    currentStep: z.int(),
    startedBy: z.string().nullable(),
    startedAt: Instant,
    finishedAt: Instant.nullable(),
    /** Why the run stopped, when it is FAILED. */
    error: z.string().nullable(),
    steps: z.array(NightAuditStepItem),
    /** Reports ready to download (once step 9 has run). */
    reports: z.array(z.enum(NIGHT_AUDIT_REPORTS)),
  })
  .meta({ id: 'NightAudit' });

export const NightAuditBody = z.object({ businessDate: IsoDate });
const NightAuditParams = z.object({ nightAuditId: Uuid });

export const getBusinessDay = defineRoute({
  operationId: 'getBusinessDay',
  method: 'get',
  path: '/business-day',
  summary: 'The property’s current business day',
  tags: ['Night audit'],
  propertyScoped: true,
  permission: 'audit.run',
  response: BusinessDayItem,
});

export const startNightAudit = defineRoute({
  operationId: 'startNightAudit',
  method: 'post',
  path: '/night-audits',
  summary: 'Run night audit for the current business date',
  description:
    'Runs the ten steps in order. A step with blocking exceptions stops the run (FAILED at ' +
    'that step); resolve them and resume. 409 AUDIT_IN_PROGRESS when the date already has a ' +
    'run: use /resume.',
  tags: ['Night audit'],
  propertyScoped: true,
  permission: 'audit.run',
  idempotent: true,
  status: 202,
  body: NightAuditBody,
  response: NightAuditItem,
});

export const getNightAudit = defineRoute({
  operationId: 'getNightAudit',
  method: 'get',
  path: '/night-audits/{nightAuditId}',
  summary: 'A night audit run with its steps and exceptions',
  tags: ['Night audit'],
  propertyScoped: true,
  permission: 'audit.run',
  params: NightAuditParams,
  response: NightAuditItem,
});

export const resumeNightAudit = defineRoute({
  operationId: 'resumeNightAudit',
  method: 'post',
  path: '/night-audits/{nightAuditId}/resume',
  summary: 'Resume a stopped night audit at the step where it stopped',
  tags: ['Night audit'],
  propertyScoped: true,
  permission: 'audit.run',
  idempotent: true,
  status: 202,
  params: NightAuditParams,
  response: NightAuditItem,
});

export const getNightAuditReport = defineRoute({
  operationId: 'getNightAuditReport',
  method: 'get',
  path: '/night-audits/{nightAuditId}/reports/{report}.pdf',
  summary: 'A night audit report of the closed day, as PDF',
  description: 'Drawn from the figures step 9 kept: a closed day’s report never changes.',
  tags: ['Night audit'],
  propertyScoped: true,
  permission: 'report.audit',
  params: z.object({ nightAuditId: Uuid, report: z.enum(NIGHT_AUDIT_REPORTS) }),
  produces: 'application/pdf',
  response: PdfDocument,
});

export const NIGHT_AUDIT_ROUTES = {
  getBusinessDay,
  startNightAudit,
  getNightAudit,
  resumeNightAudit,
  getNightAuditReport,
} as const;
