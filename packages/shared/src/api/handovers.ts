import { z } from 'zod';
import { PRIORITIES, TASK_STATUSES } from '../tasks.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, page, PageQuery, Uuid } from './primitives.ts';

// Shift handover notes (PRD M6-06; tab 3 handover_notes; tab 4 row "Handovers"; S20; T-083).
// A supervisor writes a handover for a department: their own notes plus what was open when it
// was written (the department's open tasks, approvals waiting, cash in the drawers, VIP
// guests in house or arriving). It is never edited. Another supervisor acknowledges it, once.

const Person = z.object({ id: Uuid, name: z.string() });
const Department = z.object({ id: Uuid, code: z.string(), name: z.string() });

/** How many rows of each list a handover keeps (the totals count them all). */
export const HANDOVER_LIST_LIMIT = 50;

const HandoverTask = z.object({
  id: Uuid,
  number: z.number().int(),
  title: z.string(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(PRIORITIES),
  dueAt: Instant.nullable(),
  overdue: z.boolean(),
  assignee: z.string().nullable(),
  room: z.string().nullable(),
});

const HandoverApproval = z.object({
  id: Uuid,
  action: z.string(),
  label: z.string(),
  requestedBy: z.string(),
  amountMinor: AmountMinor.nullable(),
  createdAt: Instant,
});

const HandoverDrawer = z.object({
  shiftId: Uuid,
  cashier: z.string(),
  /** OPEN, or CLOSING (counted, waiting for sign-off). */
  status: z.string(),
  openedAt: Instant,
  /** Cash the drawer should hold, per currency. */
  cash: z.array(z.object({ currency: z.string(), amountMinor: AmountMinor })),
});

const HandoverVip = z.object({
  guestId: Uuid,
  name: z.string(),
  room: z.string().nullable(),
  /** In house now, or arriving on the business date. */
  status: z.enum(['IN_HOUSE', 'ARRIVING']),
  arrival: IsoDate,
  departure: IsoDate,
});

/** What was open when the handover was written. */
export const HandoverSnapshot = z
  .object({
    openTasks: z.object({ total: z.number().int(), items: z.array(HandoverTask) }),
    approvals: z.object({ total: z.number().int(), items: z.array(HandoverApproval) }),
    cash: z.object({
      drawers: z.array(HandoverDrawer),
      /** Cash across all drawers, per currency. */
      totals: z.array(z.object({ currency: z.string(), amountMinor: AmountMinor })),
    }),
    vips: z.object({ total: z.number().int(), items: z.array(HandoverVip) }),
  })
  .meta({ id: 'HandoverSnapshot' });

export const HandoverNoteItem = z
  .object({
    id: Uuid,
    businessDate: IsoDate,
    department: Department,
    writtenBy: Person,
    createdAt: Instant,
    notes: z.string(),
    snapshot: HandoverSnapshot,
    acknowledgedBy: Person.nullable(),
    acknowledgedAt: Instant.nullable(),
    /** Whether the signed-in user may acknowledge it now (not its writer, not yet done). */
    canAcknowledge: z.boolean(),
  })
  .meta({ id: 'HandoverNote' });

export const listHandoverNotes = defineRoute({
  operationId: 'listHandoverNotes',
  method: 'get',
  path: '/handovers',
  summary: 'Shift handovers of the property, newest first',
  description: '`pending=true` lists the handovers nobody has acknowledged yet.',
  tags: ['Handovers'],
  propertyScoped: true,
  permission: 'handover.manage',
  query: PageQuery.extend({
    departmentId: Uuid.optional(),
    pending: z.enum(['true']).optional(),
  }),
  response: page(HandoverNoteItem),
});

export const getHandoverDraft = defineRoute({
  operationId: 'getHandoverDraft',
  method: 'get',
  path: '/handovers/draft',
  summary: 'What a handover written now would carry',
  description:
    'Added beyond tab 4 (T-083): S20 shows the open tasks, approvals, cash and VIPs before ' +
    'the supervisor writes. The department defaults to the caller’s own.',
  tags: ['Handovers'],
  propertyScoped: true,
  permission: 'handover.manage',
  query: z.object({ departmentId: Uuid.optional() }),
  response: z.object({
    businessDate: IsoDate,
    departments: z.array(Department),
    departmentId: Uuid,
    snapshot: HandoverSnapshot,
  }),
});

export const HandoverNoteBody = z.object({
  departmentId: Uuid,
  notes: z.string().trim().min(1).max(4000),
});

export const writeHandoverNote = defineRoute({
  operationId: 'writeHandoverNote',
  method: 'post',
  path: '/handovers',
  summary: 'Write a shift handover (M6-06)',
  description:
    'Keeps the notes with what is open now: the department’s open tasks, approvals waiting, ' +
    'cash in the drawers and VIP guests in house or arriving. A handover is never edited.',
  tags: ['Handovers'],
  propertyScoped: true,
  permission: 'handover.manage',
  idempotent: true,
  status: 201,
  body: HandoverNoteBody,
  response: HandoverNoteItem,
});

export const acknowledgeHandoverNote = defineRoute({
  operationId: 'acknowledgeHandoverNote',
  method: 'post',
  path: '/handovers/{handoverId}/acknowledge',
  summary: 'Acknowledge a handover as the incoming supervisor',
  description: 'Someone other than its writer acknowledges a handover, once.',
  tags: ['Handovers'],
  propertyScoped: true,
  permission: 'handover.manage',
  params: z.object({ handoverId: Uuid }),
  response: HandoverNoteItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const HANDOVER_ROUTES = {
  listHandoverNotes,
  getHandoverDraft,
  writeHandoverNote,
  acknowledgeHandoverNote,
} as const;
