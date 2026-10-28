import type { TaxVersion } from './tax.ts';

// Worked tax examples (PRD M4 acceptance: "A ₦100,000 room line with 10% service, 7.5% VAT
// and 5% consumption tax in the configured order produces stored tax lines that match the
// worked example in the test fixture"). The order is the spec's fixture order; the real
// order and rates are set per property after tax advice.
//
// Amounts in kobo (₦1 = 100 kobo).

/** Service charge 10% on net → VAT 7.5% on net + service → consumption tax 5% on net. */
export const LAGOS_EXAMPLE: readonly TaxVersion[] = [
  { taxRuleId: 'SVC', rateBps: 1000, basis: 'NET', sequence: 1, inclusive: false },
  { taxRuleId: 'VAT', rateBps: 750, basis: 'NET_PLUS_PRIOR', sequence: 2, inclusive: false },
  { taxRuleId: 'LCT', rateBps: 500, basis: 'NET', sequence: 3, inclusive: false },
];

export interface TaxFixture {
  name: string;
  amountMinor: bigint;
  versions: readonly TaxVersion[];
  netMinor: bigint;
  /** Tax amounts by rule. */
  taxes: Record<string, bigint>;
  totalMinor: bigint;
}

const inclusive = LAGOS_EXAMPLE.map((v) => ({ ...v, inclusive: true }));

export const TAX_FIXTURES: readonly TaxFixture[] = [
  {
    // ₦100,000 + ₦10,000 service + 7.5% × ₦110,000 VAT + 5% × ₦100,000 consumption tax.
    name: '₦100,000 room line, all exclusive (PRD M4 worked example)',
    amountMinor: 10_000_000n,
    versions: LAGOS_EXAMPLE,
    netMinor: 10_000_000n,
    taxes: { SVC: 1_000_000n, VAT: 825_000n, LCT: 500_000n },
    totalMinor: 12_325_000n,
  },
  {
    // Tab 4 quote example: two nights at ₦45,000.
    name: '₦90,000 two-night quote (tab 4 example)',
    amountMinor: 9_000_000n,
    versions: LAGOS_EXAMPLE,
    netMinor: 9_000_000n,
    taxes: { SVC: 900_000n, VAT: 742_500n, LCT: 450_000n },
    totalMinor: 11_092_500n,
  },
  {
    // ₦123,250 with every tax inside it is the same ₦100,000 room line.
    name: '₦123,250 with all taxes included',
    amountMinor: 12_325_000n,
    versions: inclusive,
    netMinor: 10_000_000n,
    taxes: { SVC: 1_000_000n, VAT: 825_000n, LCT: 500_000n },
    totalMinor: 12_325_000n,
  },
  {
    // ₦1,234.57 laundry: VAT 7.5% = 92.59275 → ₦92.59 (rounded per line, half-up).
    name: '₦1,234.57 laundry with VAT only, rounded per line',
    amountMinor: 123_457n,
    versions: [{ taxRuleId: 'VAT', rateBps: 750, basis: 'NET', sequence: 1, inclusive: false }],
    netMinor: 123_457n,
    taxes: { VAT: 9_259n },
    totalMinor: 132_716n,
  },
  {
    // Exactly half a kobo rounds up: 5% of ₦0.10 + ₦0.00 = 0.5 kobo → 1 kobo.
    name: 'half a kobo rounds up',
    amountMinor: 10n,
    versions: [{ taxRuleId: 'LCT', rateBps: 500, basis: 'NET', sequence: 1, inclusive: false }],
    netMinor: 10n,
    taxes: { LCT: 1n },
    totalMinor: 11n,
  },
  {
    // A reversal mirrors its charge exactly.
    name: '−₦100,000 reversal mirrors the charge',
    amountMinor: -10_000_000n,
    versions: LAGOS_EXAMPLE,
    netMinor: -10_000_000n,
    taxes: { SVC: -1_000_000n, VAT: -825_000n, LCT: -500_000n },
    totalMinor: -12_325_000n,
  },
  {
    name: 'no taxes',
    amountMinor: 500_000n,
    versions: [],
    netMinor: 500_000n,
    taxes: {},
    totalMinor: 500_000n,
  },
];
