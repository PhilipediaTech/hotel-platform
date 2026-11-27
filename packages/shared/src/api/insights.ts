import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, Uuid } from './primitives.ts';

// Maintenance insights (Versions V3 "maintenance anomaly insights"; T-180; Philip approved the
// story and rules for the figures, 2026-11-27). What is out of pattern before it becomes a big
// repair or a loss: repeat and reopened faults, meter use per occupied room night, and diesel
// per generator run-hour. Each comes from clear rules over the hotel's own records; staff
// create a task from it or dismiss it with a reason, which is kept.

export const INSIGHT_KINDS = [
  'REPEAT_FAULTS',
  'REOPENED_FAULT',
  'METER_USE',
  'GENERATOR_FUEL',
] as const;
/** Faults on one room or asset within this many days make a repeat. */
export const REPEAT_FAULT_DAYS = 30;
export const REPEAT_FAULT_COUNT = 3;
/** Use above this many times its usual (median) counts as out of pattern … */
export const INSIGHT_FACTOR_BPS = 15_000;
/** … for this many readings (meters) in a row. */
export const METER_RUN = 3;
/** How far back the usual is taken from. */
export const INSIGHT_USUAL_DAYS = 56;

export const MaintenanceInsight = z
  .object({
    /** Names the insight: kind and subject. */
    key: z.string(),
    /** Its evidence now: dismissing hides it until this changes. */
    fingerprint: z.string(),
    kind: z.enum(INSIGHT_KINDS),
    severity: z.enum(['HIGH', 'NORMAL']),
    subject: z.object({
      type: z.enum(['ROOM', 'ASSET', 'METER', 'GENERATOR']),
      id: Uuid.nullable(),
      label: z.string(),
    }),
    /** The room a task from it would be for. */
    roomId: Uuid.nullable(),
    /**
     * REPEAT_FAULTS and REOPENED_FAULT: faults (or reopenings) in the window. METER_USE: use
     * per occupied room night (hundredths of a unit). GENERATOR_FUEL: litres per run-hour
     * (thousandths).
     */
    value: z.number().int(),
    /** The usual, in the same units as `value` (null for faults). */
    usual: z.number().int().nullable(),
    /** The faults behind it, newest first. */
    taskIds: z.array(Uuid),
    /** Preventive jobs on the asset (or the room's assets) past their due date. */
    overduePlans: z.number().int(),
    since: Instant,
  })
  .meta({ id: 'MaintenanceInsight' });

const COMMON = {
  tags: ['Maintenance'],
  propertyScoped: true as const,
  permission: 'asset.manage',
};

export const listMaintenanceInsights = defineRoute({
  ...COMMON,
  operationId: 'listMaintenanceInsights',
  method: 'get',
  path: '/maintenance/insights',
  summary: 'What is out of pattern: repeat faults, meter use, generator fuel (T-180)',
  description:
    'Worked out each time from the records, by rules (no AI). Overdue preventive jobs on the same equipment put an insight first. Dismissed insights are left out until their evidence changes.',
  response: z.object({ data: z.array(MaintenanceInsight), dismissed: z.number().int() }),
});

export const dismissMaintenanceInsight = defineRoute({
  ...COMMON,
  operationId: 'dismissMaintenanceInsight',
  method: 'post',
  path: '/maintenance/insights/dismiss',
  summary: 'Dismiss an insight, with the reason (kept and audited)',
  description:
    '404 NOT_FOUND when no current insight has this key and fingerprint (it changed or was already dismissed).',
  status: 201,
  body: z.object({
    key: z.string().min(1).max(200),
    fingerprint: z.string().min(1).max(200),
    reason: z.string().trim().min(3).max(500),
  }),
  response: z.object({ dismissed: z.literal(true) }),
});

export const INSIGHT_ROUTES = { listMaintenanceInsights, dismissMaintenanceInsight } as const;
