import { daysBetween } from './dates.ts';

// Reservation rules shared by the API and the web app (PRD M3 rule 1, M3-02, M3-04; T-042):
// the fixed state machine, which inventory count a status takes, cancellation reasons and the
// cancellation fee. Amounts are minor units (kobo) as bigint.

export const RESERVATION_STATUSES = [
  'ENQUIRY',
  'TENTATIVE',
  'CONFIRMED',
  'CHECKED_IN',
  'CHECKED_OUT',
  'NO_SHOW',
  'CANCELLED',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const BOOKING_SOURCES = [
  'WALK_IN',
  'PHONE',
  'EMAIL',
  'WHATSAPP',
  'DIRECT',
  'OTA_MANUAL',
  'OTA_CHANNEL',
  'CORPORATE',
  'TRAVEL_AGENT',
] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

/**
 * M3 rule 1: the only transitions there are. Anything else is STATE_TRANSITION_INVALID.
 * CANCELLED and NO_SHOW go back to CONFIRMED by reinstating (M3-04).
 */
export const RESERVATION_TRANSITIONS: Readonly<
  Record<ReservationStatus, readonly ReservationStatus[]>
> = {
  ENQUIRY: ['TENTATIVE', 'CONFIRMED', 'CANCELLED'],
  TENTATIVE: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CHECKED_IN', 'NO_SHOW', 'CANCELLED'],
  CHECKED_IN: ['CHECKED_OUT'],
  CHECKED_OUT: [],
  NO_SHOW: ['CONFIRMED'],
  CANCELLED: ['CONFIRMED'],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}

/**
 * Which inventory count a stay in this status takes (M2 rule 1): tentative holds count as
 * held, confirmed and in-house stays as sold; the rest take nothing.
 */
export function inventoryFieldOf(status: ReservationStatus): 'sold' | 'held' | null {
  if (status === 'TENTATIVE') return 'held';
  if (status === 'CONFIRMED' || status === 'CHECKED_IN') return 'sold';
  return null;
}

/** Statuses whose stays can still be changed (dates, room type, plan, guests). */
export const MODIFIABLE_STATUSES: readonly ReservationStatus[] = [
  'ENQUIRY',
  'TENTATIVE',
  'CONFIRMED',
];

/** Why a reservation was cancelled (M3-04). HOLD_EXPIRED is set only by the expiry job. */
export const CANCEL_REASONS = [
  'GUEST_REQUEST',
  'CHANGE_OF_PLANS',
  'DUPLICATE',
  'NO_DEPOSIT',
  'HOTEL_REQUEST',
  'OTHER',
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number] | 'HOLD_EXPIRED';

export interface FeeRule {
  daysBefore: number;
  feeType: 'NIGHTS' | 'PERCENT';
  value: number;
}

/** a × b ÷ 100 rounded half up (never negative here). */
function percentOf(amount: bigint, percent: number): bigint {
  return (amount * BigInt(percent) * 2n + 100n) / 200n;
}

/** A fee of `rule` on nightly prices: the first N nights, or a share of all of them. */
export function feeFor(rule: Omit<FeeRule, 'daysBefore'>, nightsMinor: readonly bigint[]): bigint {
  if (rule.feeType === 'NIGHTS') {
    return nightsMinor.slice(0, rule.value).reduce((s, n) => s + n, 0n);
  }
  return percentOf(
    nightsMinor.reduce((s, n) => s + n, 0n),
    rule.value,
  );
}

/**
 * Cancellation fee (M3-04) for cancelling on `today` a stay arriving `arrival`. A rule
 * `{daysBefore: 2}` applies to cancellations 2 days or fewer before arrival; when several
 * apply, the one closest to arrival wins. No rule applies → no fee. The fee is worked out on
 * the quoted nightly prices (taxes on it are posted with the folio, T-060).
 */
export function cancellationFee(
  rules: readonly FeeRule[],
  nightsMinor: readonly bigint[],
  today: string,
  arrival: string,
): { feeMinor: bigint; rule: FeeRule | null } {
  const before = Math.max(0, daysBetween(today, arrival));
  const rule =
    [...rules]
      .filter((r) => r.daysBefore >= before)
      .sort((a, b) => a.daysBefore - b.daysBefore)[0] ?? null;
  return { feeMinor: rule ? feeFor(rule, nightsMinor) : 0n, rule };
}
