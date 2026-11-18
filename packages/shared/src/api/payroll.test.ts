import { describe, expect, it } from 'vitest';
import { monthRange, PayItemBody, PayMonth, TimesheetBody } from './payroll.ts';

describe('payroll months', () => {
  it('gives the first and last date of a month', () => {
    expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthRange('2027-02')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(PayMonth.safeParse('2026-13').success).toBe(false);
  });

  it('keeps a timesheet within one month, and pay items above zero', () => {
    const staffId = '99999999-0000-4000-8000-000000000001';
    expect(TimesheetBody.safeParse({ staffId, from: '2026-11-28', to: '2026-12-02' }).success).toBe(
      false,
    );
    expect(TimesheetBody.safeParse({ staffId, from: '2026-11-01', to: '2026-11-07' }).success).toBe(
      true,
    );
    const item = { staffId, type: 'ADVANCE', month: '2026-11', description: 'x' };
    expect(PayItemBody.safeParse({ ...item, amountMinor: '0' }).success).toBe(false);
    expect(PayItemBody.safeParse({ ...item, amountMinor: '-5' }).success).toBe(false);
    expect(PayItemBody.safeParse({ ...item, amountMinor: '100' }).success).toBe(true);
  });
});
