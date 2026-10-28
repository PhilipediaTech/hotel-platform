// Rate rules shared by the API (calendar, quotes, night audit) and the web app (previews):
// derived prices, stay restrictions and package splits (PRD M2 rules 3, 6; M2-05–M2-07).
// Amounts are minor units (kobo) as bigint.

export interface Derivation {
  /** -1000 = 10% off the parent; null = no percentage. */
  derivationBps: number | null;
  /** Added after the percentage (negative = off); null = none. */
  derivationAmountMinor: bigint | null;
  /** Round to the nearest multiple: 10000 = NGN 100. */
  roundingMinor: bigint;
  /** Never priced below this (selling lower needs approval, M2 rule 3). */
  floorMinor: bigint | null;
}

/** a ÷ b rounded half up (amounts here are never negative). */
function divRoundHalfUp(a: bigint, b: bigint): bigint {
  return (2n * a + b) / (2n * b);
}

/**
 * A derived plan's price from its parent's: parent adjusted by the percentage, then the
 * amount, rounded to `roundingMinor` (half up), never below the floor or zero.
 * BAR −10% on ₦50,000 → ₦45,000 (PRD M2 acceptance).
 */
export function derivedAmount(parentMinor: bigint, d: Derivation): bigint {
  const scaled =
    parentMinor * BigInt(10_000 + (d.derivationBps ?? 0)) +
    (d.derivationAmountMinor ?? 0n) * 10_000n;
  const step = d.roundingMinor > 0n ? d.roundingMinor : 1n;
  let price = scaled <= 0n ? 0n : divRoundHalfUp(scaled, 10_000n * step) * step;
  if (d.floorMinor !== null && price < d.floorMinor) price = d.floorMinor;
  return price;
}

// ── Restrictions ───────────────────────────────────────────────────────────────────────

/** Restrictions of one plan, room type and date (rate_days). */
export interface DayRestrictions {
  date: string;
  minStay: number | null;
  maxStay: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
}

export type RestrictionRule =
  'STOP_SELL' | 'CLOSED_TO_ARRIVAL' | 'CLOSED_TO_DEPARTURE' | 'MIN_STAY' | 'MAX_STAY';

export interface RestrictionViolation {
  rule: RestrictionRule;
  date: string;
  /** The min or max stay that was broken. */
  limit?: number;
}

/**
 * What stops a stay from `arrival` to `departure` (exclusive) being sold (M2-06):
 * stop-sell on any night; closed to arrival on the arrival date; closed to departure on the
 * departure date; min/max stay as set on the arrival date. A date without a row has no
 * restrictions. Closed to arrival on a date never stops a stay that arrives earlier.
 */
export function restrictionViolations(
  days: readonly DayRestrictions[],
  arrival: string,
  departure: string,
): RestrictionViolation[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const nights = Math.round(
    (Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86_400_000,
  );
  const out: RestrictionViolation[] = [];
  for (let i = 0; i < nights; i++) {
    const d = new Date(`${arrival}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    if (byDate.get(date)?.stopSell) out.push({ rule: 'STOP_SELL', date });
  }
  const first = byDate.get(arrival);
  if (first?.closedToArrival) out.push({ rule: 'CLOSED_TO_ARRIVAL', date: arrival });
  if (byDate.get(departure)?.closedToDeparture) {
    out.push({ rule: 'CLOSED_TO_DEPARTURE', date: departure });
  }
  const minStay = first?.minStay ?? null;
  const maxStay = first?.maxStay ?? null;
  if (minStay !== null && nights < minStay) {
    out.push({ rule: 'MIN_STAY', date: arrival, limit: minStay });
  }
  if (maxStay !== null && nights > maxStay) {
    out.push({ rule: 'MAX_STAY', date: arrival, limit: maxStay });
  }
  return out;
}

// ── Packages ───────────────────────────────────────────────────────────────────────────

export interface PackagePart {
  name: string;
  revenueCodeId: string;
  /** Per night; per guest when perPerson. */
  amountMinor: bigint;
  perPerson: boolean;
}

export interface PackageSplit {
  /** Posted to room revenue: the package price less its components. */
  roomMinor: bigint;
  components: { name: string; revenueCodeId: string; amountMinor: bigint }[];
}

/**
 * One night of a package price split into the room line and one line per component, each to
 * its own revenue code; the lines add up to the package price (PRD M2 acceptance).
 */
export function splitPackage(
  priceMinor: bigint,
  parts: readonly PackagePart[],
  guests: number,
): PackageSplit {
  const components = parts.map((p) => ({
    name: p.name,
    revenueCodeId: p.revenueCodeId,
    amountMinor: p.perPerson ? p.amountMinor * BigInt(guests) : p.amountMinor,
  }));
  const roomMinor = components.reduce((rest, c) => rest - c.amountMinor, priceMinor);
  if (roomMinor < 0n) {
    throw new RangeError('The package components cost more than the package price');
  }
  return { roomMinor, components };
}
