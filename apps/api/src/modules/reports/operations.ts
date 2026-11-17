import {
  addDays,
  localDate,
  MAX_OPS_DAYS,
  OPEN_TASK_STATUSES,
  PRIORITIES,
  zonedInstant,
  type OperationsReport,
  type OpsFigures,
  type Priority,
  type TaskStatus,
} from '@hotel/shared';
import type { z } from 'zod';
import type { TenantContext } from '../../core/tenancy.ts';
import { AppError } from '../../core/errors.ts';
import { csv, exportFile, type ExportFile } from '../../core/exports.ts';
import { issued, property, type ReportDeps } from './service.ts';

// Operations report (PRD M6-12, report.ops; tab 4 GET /reports/operations; M6 rule 5: task
// count with severity, time on hold and working pattern beside every person's figures, and no
// single-number staff ranking; T-135). It covers tasks reported in a period of property dates,
// as they stand now, from the tasks and their timelines (task_events).

type Figures = z.infer<typeof OpsFigures>;
type Report = z.infer<typeof OperationsReport>;

export const OPS_DEFINITIONS =
  'Tasks reported from the first to the last date (property time), as they stand now. ' +
  'Acknowledge time: from a task first being given to someone to its being acknowledged. ' +
  'Resolve time: from being reported to being resolved (the last time, if reopened). ' +
  'Median: half took less; 90th percentile: 9 in 10 took less. Overdue: still open past its ' +
  'deadline now. Reopen rate: reopened at least once, of those resolved at least once. SLA ' +
  'met: resolved by the deadline, of tasks with a deadline that were resolved or are open past ' +
  'it. Hold: time spent on hold. People are listed by name, never ranked: read each figure ' +
  'beside their task count, severity, time on hold and working pattern (when they acted on ' +
  'tasks: night 00–06, morning 06–12, afternoon 12–18, evening 18–24).';

/** What the figures need of one task. */
export interface OpsTask {
  departmentId: string;
  assigneeId: string | null;
  priority: Priority;
  status: TaskStatus;
  createdAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  dueAt: Date | null;
  events: { fromStatus: TaskStatus | null; toStatus: TaskStatus | null; at: Date }[];
}

const OPEN = new Set<string>(OPEN_TASK_STATUSES);
const minutes = (from: Date, to: Date) =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

/** The value below which the given share of sorted values fall (nearest rank). */
export function percentile(values: number[], share: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(share * sorted.length));
  return sorted[rank - 1] ?? null;
}

const bps = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part * 10_000) / whole);

/** Minutes a task spent ON_HOLD by now, from its timeline. */
export function holdMinutes(task: OpsTask, now: Date): number {
  let total = 0;
  let since: Date | null = null;
  for (const e of [...task.events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    if (e.toStatus === 'ON_HOLD' && since === null) since = e.at;
    else if (since && e.fromStatus === 'ON_HOLD' && e.toStatus !== 'ON_HOLD') {
      total += minutes(since, e.at);
      since = null;
    }
  }
  if (since) total += minutes(since, now);
  return total;
}

/** The figures for a set of tasks, now. */
export function opsFigures(tasks: OpsTask[], now: Date): Figures {
  const bySeverity = Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as Record<Priority, number>;
  const ack: number[] = [];
  const resolve: number[] = [];
  let resolved = 0;
  let open = 0;
  let overdue = 0;
  let everResolved = 0;
  let reopened = 0;
  let slaMet = 0;
  let slaTasks = 0;
  let hold = 0;
  for (const t of tasks) {
    bySeverity[t.priority] += 1;
    const isOpen = OPEN.has(t.status);
    if (isOpen) open += 1;
    else resolved += 1;
    const events = [...t.events].sort((a, b) => a.at.getTime() - b.at.getTime());
    if (t.acknowledgedAt) {
      const given = events.find((e) => e.toStatus === 'ASSIGNED')?.at ?? t.createdAt;
      ack.push(minutes(given, t.acknowledgedAt));
    }
    const resolvedAt =
      t.resolvedAt ??
      (isOpen ? null : ([...events].reverse().find((e) => e.toStatus === 'RESOLVED')?.at ?? null));
    if (resolvedAt && !isOpen) resolve.push(minutes(t.createdAt, resolvedAt));
    const wasResolved = events.some((e) => e.toStatus === 'RESOLVED') || resolvedAt !== null;
    if (wasResolved) everResolved += 1;
    if (
      events.some(
        (e) =>
          (e.fromStatus === 'RESOLVED' || e.fromStatus === 'VERIFIED') && e.toStatus === 'ASSIGNED',
      )
    ) {
      reopened += 1;
    }
    if (t.dueAt) {
      if (!isOpen && resolvedAt) {
        slaTasks += 1;
        if (resolvedAt <= t.dueAt) slaMet += 1;
      } else if (isOpen && t.dueAt < now) {
        slaTasks += 1;
      }
    }
    if (isOpen && t.dueAt && t.dueAt < now) overdue += 1;
    hold += holdMinutes(t, now);
  }
  return {
    created: tasks.length,
    bySeverity,
    resolved,
    open,
    overdue,
    ackMedianMinutes: percentile(ack, 0.5),
    ackP90Minutes: percentile(ack, 0.9),
    resolveMedianMinutes: percentile(resolve, 0.5),
    resolveP90Minutes: percentile(resolve, 0.9),
    reopenRateBps: bps(reopened, everResolved),
    slaMetBps: bps(slaMet, slaTasks),
    slaTasks,
    holdMinutes: hold,
  };
}

/** Part of the property's day an instant falls in. */
function dayPart(at: Date, timeZone: string): 'NIGHT' | 'MORNING' | 'AFTERNOON' | 'EVENING' {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(at),
  );
  if (hour < 6) return 'NIGHT';
  if (hour < 12) return 'MORNING';
  if (hour < 18) return 'AFTERNOON';
  return 'EVENING';
}

export async function operations(
  deps: ReportDeps,
  tenant: TenantContext,
  q: { from?: string | undefined; to?: string | undefined; format: 'json' | 'csv' },
): Promise<Report | ExportFile> {
  const p = await property(deps, tenant);
  const now = deps.clock();
  const today = localDate(now, p.timeZone);
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, -29);
  if (to < from) {
    throw new AppError('VALIDATION_ERROR', 'The period ends before it starts', { field: 'to' });
  }
  if (addDays(from, MAX_OPS_DAYS) <= to) {
    throw new AppError(
      'VALIDATION_ERROR',
      `An operations report covers at most ${MAX_OPS_DAYS} days`,
      { field: 'to' },
    );
  }
  const rows = await deps.tenantDb.task.findMany({
    where: {
      createdAt: {
        gte: zonedInstant(from, '00:00', p.timeZone),
        lt: zonedInstant(addDays(to, 1), '00:00', p.timeZone),
      },
    },
    include: {
      department: { select: { id: true, name: true } },
      assignee: { select: { id: true, name: true } },
      events: { select: { fromStatus: true, toStatus: true, at: true, byUserId: true } },
    },
  });
  const tasks = rows;

  const departments = new Map<string, { name: string; tasks: OpsTask[] }>();
  const people = new Map<string, { name: string; tasks: OpsTask[] }>();
  for (const t of tasks) {
    const d = departments.get(t.department.id) ?? { name: t.department.name, tasks: [] };
    d.tasks.push(t);
    departments.set(t.department.id, d);
    if (t.assignee) {
      const person = people.get(t.assignee.id) ?? { name: t.assignee.name, tasks: [] };
      person.tasks.push(t);
      people.set(t.assignee.id, person);
    }
  }
  // Working pattern: every timeline row a person wrote on these tasks.
  const acts = tasks.flatMap((t) => t.events);
  const report: Report = {
    from,
    to,
    totals: opsFigures(tasks, now),
    departments: [...departments.entries()]
      .map(([departmentId, d]) => ({
        departmentId,
        name: d.name,
        figures: opsFigures(d.tasks, now),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    people: [...people.entries()]
      .map(([userId, person]) => {
        const mine = acts.filter((e) => e.byUserId === userId);
        const pattern = { NIGHT: 0, MORNING: 0, AFTERNOON: 0, EVENING: 0 };
        for (const e of mine) pattern[dayPart(e.at, p.timeZone)] += 1;
        return {
          userId,
          name: person.name,
          figures: opsFigures(person.tasks, now),
          pattern: {
            ...pattern,
            daysActive: new Set(mine.map((e) => localDate(e.at, p.timeZone))).size,
          },
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    unassigned: tasks.filter((t) => !t.assigneeId).length,
    definitions: OPS_DEFINITIONS,
  };
  if (q.format === 'json') return report;
  await issued(deps, 'operations', q.format, { from, to });
  return exportFile(`operations-${p.code}-${from}-to-${to}.csv`, 'text/csv', operationsCsv(report));
}

const cell = (v: number | null) => (v === null ? null : v);
const pct = (v: number | null) => (v === null ? null : (v / 100).toFixed(2));

export function operationsCsv(r: Report): Uint8Array {
  const head = [
    'Created',
    'Low',
    'Normal',
    'High',
    'Critical',
    'Resolved',
    'Open',
    'Overdue',
    'Ack median min',
    'Ack p90 min',
    'Resolve median min',
    'Resolve p90 min',
    'Reopen %',
    'SLA met %',
    'SLA tasks',
    'Hold min',
  ];
  const figures = (f: Figures) => [
    f.created,
    f.bySeverity.LOW,
    f.bySeverity.NORMAL,
    f.bySeverity.HIGH,
    f.bySeverity.CRITICAL,
    f.resolved,
    f.open,
    f.overdue,
    cell(f.ackMedianMinutes),
    cell(f.ackP90Minutes),
    cell(f.resolveMedianMinutes),
    cell(f.resolveP90Minutes),
    pct(f.reopenRateBps),
    pct(f.slaMetBps),
    f.slaTasks,
    f.holdMinutes,
  ];
  return csv([
    ['Operations report', r.from, r.to],
    [],
    ['Scope', ...head],
    ['All tasks', ...figures(r.totals)],
    ...r.departments.map((d) => [d.name, ...figures(d.figures)]),
    [],
    ['Person', ...head, 'Night', 'Morning', 'Afternoon', 'Evening', 'Days active'],
    ...r.people.map((p) => [
      p.name,
      ...figures(p.figures),
      p.pattern.NIGHT,
      p.pattern.MORNING,
      p.pattern.AFTERNOON,
      p.pattern.EVENING,
      p.pattern.daysActive,
    ]),
    ['Not given to anyone', r.unassigned],
    [],
    ['Definitions', r.definitions],
  ]);
}
