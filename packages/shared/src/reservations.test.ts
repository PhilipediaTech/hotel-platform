import { describe, expect, it } from 'vitest';
import {
  canTransition,
  cancellationFee,
  feeFor,
  inventoryFieldOf,
  RESERVATION_STATUSES,
  RESERVATION_TRANSITIONS,
} from './reservations.ts';

// The reservation state machine and cancellation fees (PRD M3 rule 1, M3-04). Amounts in kobo.

describe('state machine (M3 rule 1)', () => {
  it('follows the main path and its side states', () => {
    expect(canTransition('ENQUIRY', 'TENTATIVE')).toBe(true);
    expect(canTransition('TENTATIVE', 'CONFIRMED')).toBe(true);
    expect(canTransition('CONFIRMED', 'CHECKED_IN')).toBe(true);
    expect(canTransition('CHECKED_IN', 'CHECKED_OUT')).toBe(true);
    expect(canTransition('CONFIRMED', 'NO_SHOW')).toBe(true);
    expect(canTransition('TENTATIVE', 'CANCELLED')).toBe(true);
    expect(canTransition('CANCELLED', 'CONFIRMED')).toBe(true);
  });

  it('refuses everything else', () => {
    expect(canTransition('CHECKED_OUT', 'CHECKED_IN')).toBe(false);
    expect(canTransition('CHECKED_IN', 'CANCELLED')).toBe(false);
    expect(canTransition('TENTATIVE', 'CHECKED_IN')).toBe(false);
    expect(canTransition('CONFIRMED', 'CONFIRMED')).toBe(false);
    expect(canTransition('CANCELLED', 'CHECKED_IN')).toBe(false);
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_TRANSITIONS[from]) expect(to).not.toBe(from);
    }
  });

  it('holds count as held, confirmed and in-house stays as sold', () => {
    expect(inventoryFieldOf('TENTATIVE')).toBe('held');
    expect(inventoryFieldOf('CONFIRMED')).toBe('sold');
    expect(inventoryFieldOf('CHECKED_IN')).toBe('sold');
    for (const s of ['ENQUIRY', 'CHECKED_OUT', 'NO_SHOW', 'CANCELLED'] as const) {
      expect(inventoryFieldOf(s)).toBeNull();
    }
  });
});

describe('cancellation fee (M3-04)', () => {
  const nights = [4_500_000n, 5_000_000n, 5_000_000n];
  const rules = [
    { daysBefore: 7, feeType: 'PERCENT' as const, value: 25 },
    { daysBefore: 2, feeType: 'NIGHTS' as const, value: 1 },
  ];

  it('charges by the rule closest to arrival that applies', () => {
    expect(cancellationFee(rules, nights, '2026-11-10', '2026-11-12')).toMatchObject({
      feeMinor: 4_500_000n,
      rule: rules[1],
    });
    expect(cancellationFee(rules, nights, '2026-11-10', '2026-11-15').feeMinor).toBe(3_625_000n);
    expect(cancellationFee(rules, nights, '2026-11-10', '2026-11-18')).toEqual({
      feeMinor: 0n,
      rule: null,
    });
    // On or after the arrival day counts as zero days before.
    expect(cancellationFee(rules, nights, '2026-11-13', '2026-11-12').feeMinor).toBe(4_500_000n);
  });

  it('nights fees never exceed the stay; percentages round half up', () => {
    expect(feeFor({ feeType: 'NIGHTS', value: 5 }, nights)).toBe(14_500_000n);
    expect(feeFor({ feeType: 'PERCENT', value: 33 }, [101n])).toBe(33n); // 33.33 → 33
    expect(feeFor({ feeType: 'PERCENT', value: 50 }, [101n])).toBe(51n); // 50.5 → 51
    expect(feeFor({ feeType: 'PERCENT', value: 100 }, nights)).toBe(14_500_000n);
  });

  it('no rules, no fee', () => {
    expect(cancellationFee([], nights, '2026-11-12', '2026-11-12').feeMinor).toBe(0n);
  });
});
