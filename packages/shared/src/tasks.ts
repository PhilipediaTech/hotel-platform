// Task engine rules (PRD M6-01–M6-05, M6 rules 1–2, M5-07, M5 rule 3; tab 3 tasks; T-082).
// Shared by the API, which enforces them, and the web app, which offers only the actions a
// task allows.

export const TASK_TYPES = [
  'GUEST_REQUEST',
  'COMPLAINT',
  'FAULT',
  'INCIDENT',
  'CHECKLIST',
  'DISCREPANCY',
  'GENERAL',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = [
  'REPORTED',
  'TRIAGED',
  'ASSIGNED',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'ON_HOLD',
  'RESOLVED',
  'VERIFIED',
  'CLOSED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Not finished yet: still counts against its SLA and can be escalated. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = [
  'REPORTED',
  'TRIAGED',
  'ASSIGNED',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'ON_HOLD',
];

export const TASK_ACTIONS = [
  'assign',
  'acknowledge',
  'start',
  'hold',
  'resolve',
  'verify',
  'reopen',
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/**
 * M6 rule 1: REPORTED → TRIAGED → ASSIGNED → ACKNOWLEDGED → IN_PROGRESS ⇄ ON_HOLD → RESOLVED
 * → VERIFIED; a reopen returns a resolved task to ASSIGNED. The statuses each action starts
 * from; anything else is STATE_TRANSITION_INVALID. Assigning again (a new assignee, or a new
 * priority and deadline) is allowed until the task is resolved. CLOSED is in the schema for
 * tasks closed without work; nothing sets it in V1.
 */
export const TASK_ACTION_FROM: Readonly<Record<TaskAction, readonly TaskStatus[]>> = {
  assign: ['REPORTED', 'TRIAGED', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ON_HOLD'],
  acknowledge: ['ASSIGNED'],
  start: ['ACKNOWLEDGED', 'ON_HOLD'],
  hold: ['IN_PROGRESS'],
  resolve: ['IN_PROGRESS'],
  verify: ['RESOLVED'],
  reopen: ['RESOLVED'],
};

/** Where an action takes the task (assign without an assignee only triages it). */
export const TASK_ACTION_TO: Readonly<Record<TaskAction, TaskStatus>> = {
  assign: 'ASSIGNED',
  acknowledge: 'ACKNOWLEDGED',
  start: 'IN_PROGRESS',
  hold: 'ON_HOLD',
  resolve: 'RESOLVED',
  verify: 'VERIFIED',
  reopen: 'ASSIGNED',
};

export function taskActionAllowed(action: TaskAction, status: TaskStatus): boolean {
  return TASK_ACTION_FROM[action].includes(status);
}

/**
 * SLA escalation (M6-05, M6 AC "a task past SLA escalates once and only once per level").
 * Level 1 goes to the department's managers when the deadline passes; level 2 to the general
 * manager one SLA window later. The window is the template's SLA, or this when it has none.
 */
export const MAX_ESCALATION_LEVEL = 2;
export const DEFAULT_ESCALATION_WINDOW_MINUTES = 60;

/** When a task that is at `level` reaches the next level. */
export function nextEscalationAt(dueAt: Date, level: number, windowMinutes: number): Date {
  return new Date(dueAt.getTime() + level * windowMinutes * 60_000);
}

/** What a fault is about (M5-07). */
export const FAULT_CATEGORIES = [
  'PLUMBING',
  'ELECTRICAL',
  'AIR_CONDITIONING',
  'FURNITURE',
  'APPLIANCE',
  'DOOR_LOCK',
  'SAFETY',
  'OTHER',
] as const;
export type FaultCategory = (typeof FAULT_CATEGORIES)[number];

/** English names for task titles the server writes (titles are data, not UI strings). */
export const FAULT_CATEGORY_NAMES: Readonly<Record<FaultCategory, string>> = {
  PLUMBING: 'Plumbing',
  ELECTRICAL: 'Electrical',
  AIR_CONDITIONING: 'Air conditioning',
  FURNITURE: 'Furniture',
  APPLIANCE: 'Appliance',
  DOOR_LOCK: 'Door or lock',
  SAFETY: 'Safety',
  OTHER: 'Other',
};

/**
 * The templates every property starts with (M6-01: guest request, complaint, fault,
 * incident, checklist; M5 rule 6: discrepancy). Department codes are those of
 * DEPARTMENT_TEMPLATES; the owner edits them later.
 */
export const DEFAULT_TASK_TEMPLATES: readonly {
  type: TaskType;
  name: string;
  department: string;
  priority: Priority;
  slaMinutes: number;
}[] = [
  {
    type: 'GUEST_REQUEST',
    name: 'Guest request',
    department: 'FO',
    priority: 'NORMAL',
    slaMinutes: 30,
  },
  {
    type: 'COMPLAINT',
    name: 'Guest complaint',
    department: 'FO',
    priority: 'HIGH',
    slaMinutes: 30,
  },
  { type: 'FAULT', name: 'Fault', department: 'MNT', priority: 'NORMAL', slaMinutes: 240 },
  { type: 'INCIDENT', name: 'Incident', department: 'MGT', priority: 'HIGH', slaMinutes: 60 },
  { type: 'CHECKLIST', name: 'Checklist', department: 'HK', priority: 'NORMAL', slaMinutes: 480 },
  {
    type: 'DISCREPANCY',
    name: 'Room status discrepancy',
    department: 'FO',
    priority: 'HIGH',
    slaMinutes: 60,
  },
];
