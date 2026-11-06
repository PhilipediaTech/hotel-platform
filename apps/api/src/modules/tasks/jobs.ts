import {
  DEFAULT_ESCALATION_WINDOW_MINUTES,
  MAX_ESCALATION_LEVEL,
  nextEscalationAt,
  OPEN_TASK_STATUSES,
} from '@hotel/shared';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { defineJob } from '../../core/jobs.ts';
import { recordEvent } from '../../core/outbox.ts';

// SLA escalation (PRD M6-05, M6 AC "a task past SLA escalates once and only once per level";
// tab 2 "SLA escalation (every 5 minutes)"; T-082). An open task whose deadline has passed
// goes to level 1 (the department's managers); one SLA window later, to level 2 (the general
// manager). The step is a guarded update (escalationLevel as it was read), so overlapping runs
// cannot escalate a level twice; a run moves a task up at most one level. The deadline runs on
// the wall clock: department business hours (M6 rule 2) are not modelled yet.

const LEVEL_NOTES: Record<number, string> = {
  1: 'Past its deadline: escalated to the department managers',
  2: 'Still open: escalated to the general manager',
};

/** Escalates every task due for its next level; returns how many moved. */
export async function escalateTasks(db: Db, clock: Clock, batch = 500): Promise<number> {
  const now = clock();
  const candidates = await db.task.findMany({
    where: {
      status: { in: [...OPEN_TASK_STATUSES] },
      dueAt: { lte: now },
      escalationLevel: { lt: MAX_ESCALATION_LEVEL },
    },
    select: {
      id: true,
      organisationId: true,
      propertyId: true,
      number: true,
      dueAt: true,
      escalationLevel: true,
      template: { select: { slaMinutes: true } },
    },
    orderBy: { dueAt: 'asc' },
    take: batch,
  });
  let moved = 0;
  for (const task of candidates) {
    if (!task.dueAt) continue;
    const window = task.template?.slaMinutes ?? DEFAULT_ESCALATION_WINDOW_MINUTES;
    if (nextEscalationAt(task.dueAt, task.escalationLevel, window) > now) continue;
    const level = task.escalationLevel + 1;
    const done = await db.$transaction(async (tx) => {
      const step = await tx.task.updateMany({
        where: { id: task.id, escalationLevel: task.escalationLevel },
        data: { escalationLevel: level, version: { increment: 1 } },
      });
      if (step.count !== 1) return false;
      await tx.taskEvent.create({
        data: { taskId: task.id, kind: 'ESCALATE', note: LEVEL_NOTES[level] ?? null, fileIds: [] },
      });
      await recordEvent(tx, {
        type: 'task.escalated',
        organisationId: task.organisationId,
        propertyId: task.propertyId,
        payload: { taskId: task.id, number: task.number, level },
      });
      return true;
    });
    if (done) moved += 1;
  }
  return moved;
}

export const taskEscalationJob = defineJob({
  name: 'task-escalation',
  schedule: { cron: '*/5 * * * *' },
  async run(_data, { db, clock, logger }) {
    const moved = await escalateTasks(db, clock);
    if (moved > 0) logger.info({ moved }, 'Tasks escalated');
  },
});
