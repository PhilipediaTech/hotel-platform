import { describe, expect, it } from 'vitest';
import { LAGOS_EXAMPLE, TAX_FIXTURES } from './tax.fixtures.ts';
import { calculateTaxes, formatRate, versionsOn, type DatedTaxVersion } from './tax.ts';

describe('calculateTaxes: worked fixtures', () => {
  it.each(TAX_FIXTURES)('$name', (fixture) => {
    const result = calculateTaxes(fixture.amountMinor, fixture.versions);
    expect(result.netMinor).toBe(fixture.netMinor);
    expect(Object.fromEntries(result.taxes.map((t) => [t.taxRuleId, t.amountMinor]))).toEqual(
      fixture.taxes,
    );
    expect(result.totalMinor).toBe(fixture.totalMinor);
  });
});

describe('calculateTaxes: stacking', () => {
  it('applies VAT on net plus the service charge, not on the consumption tax after it', () => {
    const { taxes } = calculateTaxes(10_000_000n, LAGOS_EXAMPLE);
    expect(taxes.map((t) => [t.taxRuleId, t.baseMinor])).toEqual([
      ['SVC', 10_000_000n],
      ['VAT', 11_000_000n],
      ['LCT', 10_000_000n],
    ]);
  });

  it('follows the sequence, not the order given', () => {
    const shuffled = [...LAGOS_EXAMPLE].reverse();
    expect(calculateTaxes(10_000_000n, shuffled).taxes.map((t) => t.taxRuleId)).toEqual([
      'SVC',
      'VAT',
      'LCT',
    ]);
  });

  it('changes the result when the order changes (VAT before service)', () => {
    const vatFirst = LAGOS_EXAMPLE.map((v) =>
      v.taxRuleId === 'VAT'
        ? { ...v, sequence: 1 }
        : v.taxRuleId === 'SVC'
          ? { ...v, sequence: 2 }
          : v,
    );
    // VAT now sees no prior tax: 7.5% of ₦100,000.
    const vat = calculateTaxes(10_000_000n, vatFirst).taxes.find((t) => t.taxRuleId === 'VAT');
    expect(vat?.amountMinor).toBe(750_000n);
  });

  it('mixes an inclusive VAT with an exclusive service charge', () => {
    // ₦107,500 includes 7.5% VAT; the 10% service charge is added on top of the net.
    const versions = [
      { taxRuleId: 'VAT', rateBps: 750, basis: 'NET' as const, sequence: 1, inclusive: true },
      { taxRuleId: 'SVC', rateBps: 1000, basis: 'NET' as const, sequence: 2, inclusive: false },
    ];
    const result = calculateTaxes(10_750_000n, versions);
    expect(result.netMinor).toBe(10_000_000n);
    expect(result.totalMinor).toBe(11_750_000n);
  });

  it('keeps net + inclusive taxes equal to the amount whatever the rounding', () => {
    const inclusive = LAGOS_EXAMPLE.map((v) => ({ ...v, inclusive: true }));
    for (const amount of [1n, 99n, 12_345n, 987_654_321n]) {
      const r = calculateTaxes(amount, inclusive);
      expect(r.netMinor + r.taxes.reduce((s, t) => s + t.amountMinor, 0n)).toBe(amount);
      expect(r.totalMinor).toBe(amount);
    }
  });

  it('refuses rates outside 0–100%', () => {
    expect(() =>
      calculateTaxes(100n, [
        { taxRuleId: 'X', rateBps: 10_001, basis: 'NET', sequence: 1, inclusive: false },
      ]),
    ).toThrow(RangeError);
  });
});

describe('versionsOn', () => {
  const v = (from: string, to: string | null, rateBps: number): DatedTaxVersion => ({
    taxRuleId: 'VAT',
    rateBps,
    basis: 'NET',
    sequence: 1,
    inclusive: false,
    effectiveFrom: from,
    effectiveTo: to,
  });
  const history = [v('2020-02-01', '2027-01-01', 750), v('2027-01-01', null, 1000)];

  it('picks the version in force on the date, the end date being exclusive', () => {
    expect(versionsOn(history, '2026-12-31').map((x) => x.rateBps)).toEqual([750]);
    expect(versionsOn(history, '2027-01-01').map((x) => x.rateBps)).toEqual([1000]);
    expect(versionsOn(history, '2019-12-31')).toEqual([]);
  });
});

it('formats basis points as a percentage', () => {
  expect([formatRate(750), formatRate(1000), formatRate(1250), formatRate(0)]).toEqual([
    '7.5%',
    '10%',
    '12.5%',
    '0%',
  ]);
});
