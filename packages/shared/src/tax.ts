// Tax calculator shared by the API (folio posting, quotes, night audit) and the web app
// (previews). PRD M4 rules 1–2: taxes are worked out per line from each rule's version in
// force on the line's business date, stacked in an explicit order, and rounded per line to
// the currency's minor unit, half-up. The result is stored on the line and never redone.
//
// Basis: NET = rate × net; NET_PLUS_PRIOR = rate × (net + every tax with a lower sequence).
// Exclusive taxes are added on top of the amount; inclusive taxes are inside it, so the net
// is worked back from the amount first. Worked examples: tax.fixtures.ts.

export type TaxBasis = 'NET' | 'NET_PLUS_PRIOR';

/** One tax rule's version in force on the line's date. */
export interface TaxVersion {
  taxRuleId: string;
  /** Basis points: 750 = 7.5%. */
  rateBps: number;
  basis: TaxBasis;
  /** Lower runs first; equal sequences don't see each other. */
  sequence: number;
  inclusive: boolean;
}

export interface TaxLine {
  taxRuleId: string;
  /** What the rate was applied to. */
  baseMinor: bigint;
  amountMinor: bigint;
  inclusive: boolean;
}

export interface TaxResult {
  /** The line before any tax. */
  netMinor: bigint;
  taxes: TaxLine[];
  /** net + every tax: what the guest pays for the line. */
  totalMinor: bigint;
}

const BPS = 10_000n;

/** a ÷ b rounded half away from zero (half-up for positive amounts; refunds mirror charges). */
function divRound(a: bigint, b: bigint): bigint {
  const negative = a < 0n !== b < 0n;
  const [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  const q = (2n * x + y) / (2n * y);
  return negative ? -q : q;
}

const ordered = (versions: readonly TaxVersion[]) =>
  [...versions].sort((a, b) => a.sequence - b.sequence || a.taxRuleId.localeCompare(b.taxRuleId));

function check(versions: readonly TaxVersion[]): void {
  for (const v of versions) {
    if (!Number.isInteger(v.rateBps) || v.rateBps < 0 || v.rateBps > 10_000) {
      throw new RangeError(`Tax rate out of range: ${v.rateBps} bps`);
    }
  }
}

/** Taxes on a known net, each rounded, priors as rounded amounts. */
function taxesOnNet(netMinor: bigint, versions: readonly TaxVersion[]): TaxLine[] {
  const lines: (TaxLine & { sequence: number })[] = [];
  for (const v of ordered(versions)) {
    const prior =
      v.basis === 'NET_PLUS_PRIOR'
        ? lines.filter((l) => l.sequence < v.sequence).reduce((sum, l) => sum + l.amountMinor, 0n)
        : 0n;
    const baseMinor = netMinor + prior;
    lines.push({
      taxRuleId: v.taxRuleId,
      baseMinor,
      amountMinor: divRound(baseMinor * BigInt(v.rateBps), BPS),
      inclusive: v.inclusive,
      sequence: v.sequence,
    });
  }
  return lines.map(({ sequence: _sequence, ...line }) => line);
}

/**
 * How much each tax adds per unit of net, as an exact fraction over 10000^depth: lets the
 * net be worked back from an amount that includes taxes.
 */
function inclusiveFactor(versions: readonly TaxVersion[]): { num: bigint; den: bigint } {
  const sorted = ordered(versions);
  // Every factor over the same denominator, 10000^n.
  const den = BPS ** BigInt(sorted.length);
  const factors: { sequence: number; num: bigint }[] = [];
  for (const v of sorted) {
    const prior =
      v.basis === 'NET_PLUS_PRIOR'
        ? factors.filter((f) => f.sequence < v.sequence).reduce((sum, f) => sum + f.num, 0n)
        : 0n;
    // rate × (1 + prior factors), kept over den.
    factors.push({ sequence: v.sequence, num: (BigInt(v.rateBps) * (den + prior)) / BPS });
  }
  const inclusive = sorted
    .map((v, i) => (v.inclusive ? (factors[i]?.num ?? 0n) : 0n))
    .reduce((a, b) => a + b, 0n);
  return { num: den + inclusive, den };
}

/**
 * Taxes for one line of `amountMinor` (exclusive taxes on top; inclusive ones inside it).
 * With inclusive taxes, the net is worked back and then set so net + inclusive taxes equals
 * the amount exactly; any rounding difference stays in the net.
 */
export function calculateTaxes(amountMinor: bigint, versions: readonly TaxVersion[]): TaxResult {
  check(versions);
  if (versions.some((v) => v.inclusive)) {
    const { num, den } = inclusiveFactor(versions);
    const estimate = divRound(amountMinor * den, num);
    const taxes = taxesOnNet(estimate, versions);
    const inside = taxes.filter((t) => t.inclusive).reduce((s, t) => s + t.amountMinor, 0n);
    const netMinor = amountMinor - inside;
    const outside = taxes.filter((t) => !t.inclusive).reduce((s, t) => s + t.amountMinor, 0n);
    return { netMinor, taxes, totalMinor: amountMinor + outside };
  }
  const taxes = taxesOnNet(amountMinor, versions);
  return {
    netMinor: amountMinor,
    taxes,
    totalMinor: amountMinor + taxes.reduce((s, t) => s + t.amountMinor, 0n),
  };
}

/** A dated version as stored (dates `YYYY-MM-DD`, `effectiveTo` exclusive, null = open). */
export interface DatedTaxVersion extends TaxVersion {
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** The versions in force on `date`: at most one per rule. */
export function versionsOn<V extends DatedTaxVersion>(versions: readonly V[], date: string): V[] {
  return versions.filter(
    (v) => v.effectiveFrom <= date && (v.effectiveTo === null || date < v.effectiveTo),
  );
}

/** "750" → "7.5%". */
export function formatRate(rateBps: number): string {
  return `${(rateBps / 100).toLocaleString('en', { maximumFractionDigits: 2 })}%`;
}
