import { describe, expect, it } from 'vitest';
import {
  derivedAmount,
  restrictionViolations,
  splitPackage,
  type DayRestrictions,
  type Derivation,
} from './rates.ts';

// Worked examples for rate derivation, restrictions and packages (PRD M2 rules and
// acceptance; test plan: "rate derivation" as pure functions). Amounts in kobo.

const TEN_OFF: Derivation = {
  derivationBps: -1000,
  derivationAmountMinor: null,
  roundingMinor: 10_000n,
  floorMinor: null,
};

describe('derivedAmount (M2-05, M2 rule 3)', () => {
  it('BAR −10% on ₦50,000 is ₦45,000; on ₦60,000 it is ₦54,000 (PRD acceptance)', () => {
    expect(derivedAmount(5_000_000n, TEN_OFF)).toBe(4_500_000n);
    expect(derivedAmount(6_000_000n, TEN_OFF)).toBe(5_400_000n);
  });

  it('rounds to the nearest ₦100 by default, halves up', () => {
    expect(derivedAmount(4_999_900n, TEN_OFF)).toBe(4_500_000n); // ₦44,999.10 → ₦45,000
    expect(derivedAmount(4_994_000n, TEN_OFF)).toBe(4_490_000n); // ₦44,946 → ₦44,900
    expect(derivedAmount(5_555_000n, TEN_OFF)).toBe(5_000_000n); // ₦49,995 → ₦50,000 (half up)
  });

  it('adds a fixed amount after the percentage, and can round to ₦1,000', () => {
    const plusBreakfast: Derivation = {
      derivationBps: null,
      derivationAmountMinor: 750_000n, // + ₦7,500
      roundingMinor: 100_000n, // ₦1,000
      floorMinor: null,
    };
    expect(derivedAmount(4_520_000n, plusBreakfast)).toBe(5_300_000n); // ₦52,700 → ₦53,000
    const both: Derivation = { ...TEN_OFF, derivationAmountMinor: -200_000n };
    expect(derivedAmount(5_000_000n, both)).toBe(4_300_000n); // ₦45,000 − ₦2,000
  });

  it('never goes below the floor or zero', () => {
    expect(derivedAmount(3_000_000n, { ...TEN_OFF, floorMinor: 3_000_000n })).toBe(3_000_000n);
    expect(derivedAmount(100_000n, { ...TEN_OFF, derivationAmountMinor: -500_000n })).toBe(0n);
  });
});

describe('restrictionViolations (M2-06)', () => {
  const day = (date: string, extra: Partial<DayRestrictions> = {}): DayRestrictions => ({
    date,
    minStay: null,
    maxStay: null,
    closedToArrival: false,
    closedToDeparture: false,
    stopSell: false,
    ...extra,
  });

  it('closed to arrival blocks arriving that date but not staying through it (PRD acceptance)', () => {
    const days = [
      day('2026-11-12'),
      day('2026-11-13', { closedToArrival: true }),
      day('2026-11-14'),
    ];
    expect(restrictionViolations(days, '2026-11-13', '2026-11-15')).toEqual([
      { rule: 'CLOSED_TO_ARRIVAL', date: '2026-11-13' },
    ]);
    expect(restrictionViolations(days, '2026-11-12', '2026-11-15')).toEqual([]);
  });

  it('closed to departure applies to the departure date only', () => {
    const days = [day('2026-11-14', { closedToDeparture: true })];
    expect(restrictionViolations(days, '2026-11-12', '2026-11-14')).toEqual([
      { rule: 'CLOSED_TO_DEPARTURE', date: '2026-11-14' },
    ]);
    expect(restrictionViolations(days, '2026-11-12', '2026-11-15')).toEqual([]);
  });

  it('stop-sell on any night blocks the stay', () => {
    const days = [day('2026-11-13', { stopSell: true })];
    expect(restrictionViolations(days, '2026-11-12', '2026-11-15')).toEqual([
      { rule: 'STOP_SELL', date: '2026-11-13' },
    ]);
    expect(restrictionViolations(days, '2026-11-14', '2026-11-15')).toEqual([]);
  });

  it('checks min and max stay as set on the arrival date', () => {
    const days = [day('2026-12-24', { minStay: 3, maxStay: 5 }), day('2026-12-25', { minStay: 7 })];
    expect(restrictionViolations(days, '2026-12-24', '2026-12-26')).toEqual([
      { rule: 'MIN_STAY', date: '2026-12-24', limit: 3 },
    ]);
    expect(restrictionViolations(days, '2026-12-24', '2026-12-27')).toEqual([]);
    expect(restrictionViolations(days, '2026-12-24', '2026-12-31')).toEqual([
      { rule: 'MAX_STAY', date: '2026-12-24', limit: 5 },
    ]);
  });
});

describe('splitPackage (M2-07)', () => {
  const BREAKFAST = {
    name: 'Breakfast',
    revenueCodeId: 'FNB',
    amountMinor: 500_000n,
    perPerson: true,
  };

  it('posts room and breakfast to two codes that add up to the package price (PRD acceptance)', () => {
    const split = splitPackage(6_000_000n, [BREAKFAST], 2);
    expect(split).toEqual({
      roomMinor: 5_000_000n,
      components: [{ name: 'Breakfast', revenueCodeId: 'FNB', amountMinor: 1_000_000n }],
    });
    expect(split.roomMinor + (split.components[0]?.amountMinor ?? 0n)).toBe(6_000_000n);
  });

  it('refuses components that cost more than the package', () => {
    expect(() => splitPackage(800_000n, [BREAKFAST], 2)).toThrow(RangeError);
  });
});
