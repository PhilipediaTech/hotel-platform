import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, localDate } from './dates.ts';

describe('localDate', () => {
  it('uses the property time zone, not UTC', () => {
    const lateEvening = new Date('2026-10-28T23:30:00Z');
    expect(localDate(lateEvening, 'Africa/Lagos')).toBe('2026-10-29'); // UTC+1
    expect(localDate(lateEvening, 'Africa/Accra')).toBe('2026-10-28'); // UTC
  });
});

describe('addDays and daysBetween', () => {
  it('cross month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(daysBetween('2026-11-05', '2026-11-01')).toBe(-4);
  });
});
