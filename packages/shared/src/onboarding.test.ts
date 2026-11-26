import { describe, expect, it } from 'vitest';
import { workingDaysTaken } from './onboarding.ts';

// Go-live within 2 working days (Strategy; T-171).

describe('workingDaysTaken', () => {
  it('counts Monday to Friday after the first day', () => {
    // 2026-11-09 is a Monday.
    expect(workingDaysTaken('2026-11-09', '2026-11-09')).toBe(0);
    expect(workingDaysTaken('2026-11-09', '2026-11-11')).toBe(2);
    expect(workingDaysTaken('2026-11-13', '2026-11-16')).toBe(1); // Friday to Monday
    expect(workingDaysTaken('2026-11-14', '2026-11-16')).toBe(1); // Saturday to Monday
    expect(workingDaysTaken('2026-11-09', '2026-11-23')).toBe(10);
  });

  it('is 0 when the end is not after the start', () => {
    expect(workingDaysTaken('2026-11-11', '2026-11-09')).toBe(0);
  });
});
