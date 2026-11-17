import { describe, expect, it } from 'vitest';
import { holdMinutes, opsFigures, percentile, type OpsTask } from './operations.ts';

// Operations metrics (PRD M6-12; T-135): the figures from tasks and their timelines.

const at = (hhmm: string, day = 10) => new Date(`2026-11-${day}T${hhmm}:00Z`);
const now = at('18:00');

function task(extra: Partial<OpsTask>): OpsTask {
  return {
    departmentId: 'd',
    assigneeId: 'u',
    priority: 'NORMAL',
    status: 'ASSIGNED',
    createdAt: at('08:00'),
    acknowledgedAt: null,
    resolvedAt: null,
    dueAt: null,
    events: [{ fromStatus: null, toStatus: 'ASSIGNED', at: at('08:00') }],
    ...extra,
  };
}

describe('percentile', () => {
  it('takes the nearest rank', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([30, 10, 20], 0.5)).toBe(20);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([5], 0.9)).toBe(5);
  });
});

describe('holdMinutes', () => {
  it('adds each spell on hold, and an open one up to now', () => {
    const t = task({
      status: 'ON_HOLD',
      events: [
        { fromStatus: 'IN_PROGRESS', toStatus: 'ON_HOLD', at: at('09:00') },
        { fromStatus: 'ON_HOLD', toStatus: 'IN_PROGRESS', at: at('09:30') },
        { fromStatus: 'IN_PROGRESS', toStatus: 'ON_HOLD', at: at('17:00') },
      ],
    });
    expect(holdMinutes(t, now)).toBe(30 + 60);
  });
});

describe('opsFigures', () => {
  it('counts acknowledge and resolve times, overdue, reopens, SLA and severity', () => {
    const quick = task({
      priority: 'HIGH',
      status: 'VERIFIED',
      acknowledgedAt: at('08:10'),
      resolvedAt: at('09:00'),
      dueAt: at('10:00'),
      events: [
        { fromStatus: null, toStatus: 'ASSIGNED', at: at('08:00') },
        { fromStatus: 'IN_PROGRESS', toStatus: 'RESOLVED', at: at('09:00') },
        { fromStatus: 'RESOLVED', toStatus: 'VERIFIED', at: at('09:05') },
      ],
    });
    // Reopened once, then resolved late.
    const reopened = task({
      status: 'RESOLVED',
      createdAt: at('08:00'),
      acknowledgedAt: at('08:40'),
      resolvedAt: at('14:00'),
      dueAt: at('12:00'),
      events: [
        { fromStatus: null, toStatus: 'REPORTED', at: at('08:00') },
        { fromStatus: 'REPORTED', toStatus: 'ASSIGNED', at: at('08:20') },
        { fromStatus: 'IN_PROGRESS', toStatus: 'RESOLVED', at: at('10:00') },
        { fromStatus: 'RESOLVED', toStatus: 'ASSIGNED', at: at('11:00') },
        { fromStatus: 'IN_PROGRESS', toStatus: 'RESOLVED', at: at('14:00') },
      ],
    });
    // Open and past its deadline.
    const late = task({ priority: 'CRITICAL', dueAt: at('12:00') });
    // Open, deadline still ahead: no SLA verdict yet.
    const fresh = task({ priority: 'LOW', dueAt: at('20:00') });

    expect(opsFigures([quick, reopened, late, fresh], now)).toEqual({
      created: 4,
      bySeverity: { LOW: 1, NORMAL: 1, HIGH: 1, CRITICAL: 1 },
      resolved: 2,
      open: 2,
      overdue: 1,
      // 10 min (from assigned at 08:00), 20 min (assigned at 08:20)
      ackMedianMinutes: 10,
      ackP90Minutes: 20,
      // 60 min, 360 min
      resolveMedianMinutes: 60,
      resolveP90Minutes: 360,
      reopenRateBps: 5000,
      // met: quick; missed: reopened (late) and late (open past due)
      slaMetBps: 3333,
      slaTasks: 3,
      holdMinutes: 0,
    });
  });

  it('has no rates for no tasks', () => {
    expect(opsFigures([], now)).toMatchObject({
      created: 0,
      ackMedianMinutes: null,
      reopenRateBps: null,
      slaMetBps: null,
    });
  });
});
