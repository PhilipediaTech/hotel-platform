import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';

// Housekeeping (PRD M5-01–M5-04, M5 rules 1–2 and the acceptance criteria "after night audit,
// the cleaning list contains every departure and stayover for the new business date" and "an
// attendant completing a room with inspection off sets it CLEAN and it becomes assignable
// immediately"; tab 4 row "Housekeeping"; S16 room board, S17 my rooms; T-080). Each business
// date has a cleaning list, one assignment per room: departures, stayovers, arrivals and a few
// deep cleans, made when night audit opens the day (or on first look at the board). A
// supervisor assigns rooms to attendants; the attendant starts, pauses and completes a room
// against its checklist. Inspection (M5-06) and the morning room-status report (T-081) follow.

export const HK_TASK_KINDS = ['DEPARTURE', 'STAYOVER', 'ARRIVAL', 'DEEP_CLEAN'] as const;
export const ASSIGNMENT_STATUSES = ['PENDING', 'IN_PROGRESS', 'PAUSED', 'DONE'] as const;
export const HK_PRIORITIES = ['HIGH', 'NORMAL', 'LOW'] as const;
export type HkTaskKind = (typeof HK_TASK_KINDS)[number];

/** What an attendant ticks off for each kind of clean. */
export const DEFAULT_CHECKLISTS: Record<HkTaskKind, readonly string[]> = {
  DEPARTURE: [
    'Strip and make the beds',
    'Clean the bathroom',
    'Fresh towels',
    'Restock amenities',
    'Check the minibar',
    'Dust and vacuum',
    'Empty the bins',
  ],
  STAYOVER: ['Make the beds', 'Tidy the bathroom', 'Fresh towels', 'Empty the bins'],
  ARRIVAL: ['Check the room is ready', 'Air the room', 'Check amenities'],
  DEEP_CLEAN: [
    'Turn the mattress',
    'Clean behind and under furniture',
    'Wash curtains',
    'Descale the bathroom',
    'Clean vents and fans',
  ],
};

const Person = z.object({ id: Uuid, name: z.string() });
const ChecklistItem = z.object({ item: z.string().trim().min(1).max(120), done: z.boolean() });
const MinibarEntry = z.object({
  item: z.string().trim().min(1).max(80),
  quantity: z.number().int().min(1).max(99),
});

export const HkAssignmentItem = z
  .object({
    id: Uuid,
    businessDate: IsoDate,
    roomId: Uuid,
    roomNumber: z.string(),
    floor: z.string().nullable(),
    kind: z.enum(HK_TASK_KINDS),
    status: z.enum(ASSIGNMENT_STATUSES),
    attendant: Person.nullable(),
    startedAt: Instant.nullable(),
    completedAt: Instant.nullable(),
    checklist: z.array(ChecklistItem),
    minibar: z.array(MinibarEntry),
    notes: z.string().nullable(),
    /** The room's housekeeping status now. */
    hkStatus: z.string(),
  })
  .meta({ id: 'HkAssignment' });

export const BoardRoom = z
  .object({
    roomId: Uuid,
    number: z.string(),
    floor: z.string().nullable(),
    roomType: z.string(),
    hkStatus: z.string(),
    /** Front office: a guest in house tonight, or not. */
    foStatus: z.enum(['OCCUPIED', 'VACANT']),
    dueOut: z.boolean(),
    arrival: z.boolean(),
    /** HIGH when a guest arrives today and the room is not ready yet. */
    priority: z.enum(HK_PRIORITIES),
    assignment: HkAssignmentItem.nullable(),
  })
  .meta({ id: 'BoardRoom' });

export const getHousekeepingBoard = defineRoute({
  operationId: 'getHousekeepingBoard',
  method: 'get',
  path: '/housekeeping/board',
  summary: 'The room board for the business date, with its cleaning list',
  tags: ['Housekeeping'],
  propertyScoped: true,
  permission: 'hk.read',
  query: z.object({ floor: z.string().trim().max(20).optional() }),
  response: z.object({
    businessDate: IsoDate,
    floors: z.array(z.string()),
    rooms: z.array(BoardRoom),
    /** Who can be given rooms (hk.work here). */
    attendants: z.array(Person),
  }),
});

export const AssignBody = z.object({
  roomIds: z.array(Uuid).min(1).max(200),
  /** Null takes the rooms off whoever had them. */
  attendantId: Uuid.nullable(),
});

export const assignRooms = defineRoute({
  operationId: 'assignRooms',
  method: 'post',
  path: '/housekeeping/assignments',
  summary: 'Give rooms to an attendant (adds rooms not on the list yet)',
  tags: ['Housekeeping'],
  propertyScoped: true,
  permission: 'hk.assign',
  idempotent: true,
  body: AssignBody,
  response: z.object({ data: z.array(HkAssignmentItem) }),
  errors: ['STATE_TRANSITION_INVALID'],
});

export const listMyAssignments = defineRoute({
  operationId: 'listMyAssignments',
  method: 'get',
  path: '/housekeeping/my-assignments',
  summary: 'The rooms given to me for the business date',
  description: 'Added beyond tab 4 (T-080): S17 for attendants, who do not see the board.',
  tags: ['Housekeeping'],
  propertyScoped: true,
  permission: 'hk.work',
  response: z.object({ businessDate: IsoDate, data: z.array(HkAssignmentItem) }),
});

export const AssignmentPatch = z
  .object({
    /** START (or resume), PAUSE, COMPLETE. */
    action: z.enum(['START', 'PAUSE', 'COMPLETE']).optional(),
    checklist: z.array(ChecklistItem).max(30).optional(),
    minibar: z.array(MinibarEntry).max(30).optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

export const updateAssignment = defineRoute({
  operationId: 'updateAssignment',
  method: 'patch',
  path: '/housekeeping/assignments/{assignmentId}',
  summary: 'Start, pause or complete a room; tick its checklist, note minibar use',
  description:
    'An attendant works only the rooms given to them (with hk.assign as well, any room). Completing ' +
    'needs every checklist item ticked and sets the room CLEAN (inspection comes with V1.1).',
  tags: ['Housekeeping'],
  propertyScoped: true,
  permission: 'hk.work',
  params: z.object({ assignmentId: Uuid }),
  body: AssignmentPatch,
  response: HkAssignmentItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const HOUSEKEEPING_ROUTES = {
  getHousekeepingBoard,
  assignRooms,
  listMyAssignments,
  updateAssignment,
} as const;
