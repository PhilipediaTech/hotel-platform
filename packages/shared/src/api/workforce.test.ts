import { describe, expect, it } from 'vitest';
import { LeaveBody, LeaveDecision, leaveDays, rotaPeriodEnd } from './workforce.ts';

describe('leaveDays', () => {
  it('counts both ends', () => {
    expect(leaveDays('2026-11-17', '2026-11-17')).toBe(1);
    expect(leaveDays('2026-11-17', '2026-11-18')).toBe(2);
    expect(leaveDays('2026-12-30', '2027-01-02')).toBe(4);
  });
});

describe('rotaPeriodEnd', () => {
  it('covers 7 days for a week', () => {
    expect(rotaPeriodEnd('2026-11-16', 'WEEKLY')).toBe('2026-11-22');
    expect(rotaPeriodEnd('2026-12-28', 'WEEKLY')).toBe('2027-01-03');
  });

  it('covers up to the same date next month', () => {
    expect(rotaPeriodEnd('2026-11-01', 'MONTHLY')).toBe('2026-11-30');
    expect(rotaPeriodEnd('2026-11-16', 'MONTHLY')).toBe('2026-12-15');
    // No 31 February: to the last day of February.
    expect(rotaPeriodEnd('2027-01-31', 'MONTHLY')).toBe('2027-02-28');
    expect(rotaPeriodEnd('2027-01-28', 'MONTHLY')).toBe('2027-02-27');
    expect(rotaPeriodEnd('2026-12-01', 'MONTHLY')).toBe('2026-12-31');
  });
});

describe('leave bodies', () => {
  it('refuses an end before the start and a very long stretch', () => {
    const base = { type: 'ANNUAL', reason: '' };
    expect(
      LeaveBody.safeParse({ ...base, startDate: '2026-11-18', endDate: '2026-11-17' }).success,
    ).toBe(false);
    expect(
      LeaveBody.safeParse({ ...base, startDate: '2026-01-01', endDate: '2027-01-02' }).success,
    ).toBe(false);
    expect(
      LeaveBody.parse({ ...base, startDate: '2026-11-17', endDate: '2026-11-17' }).reason,
    ).toBeNull();
  });

  it('asks why a rejection was made', () => {
    expect(LeaveDecision.safeParse({ decision: 'REJECT' }).success).toBe(false);
    expect(LeaveDecision.safeParse({ decision: 'REJECT', note: 'Busy week' }).success).toBe(true);
    expect(LeaveDecision.safeParse({ decision: 'APPROVE' }).success).toBe(true);
  });
});
