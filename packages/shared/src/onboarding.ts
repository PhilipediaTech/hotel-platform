import { addDays, daysBetween } from './dates.ts';

// Onboarding (Strategy: "target go-live within 2 working days for a 30-room hotel"; T-171;
// Philip 2026-11-26: Monday to Friday in the property's time zone, from the day the property
// was created; public holidays are not taken out).

export const ONBOARDING_TARGET_WORKING_DAYS = 2;

/** 1 Monday … 7 Sunday for a YYYY-MM-DD date. */
function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * Working days taken from `from` to `to` (both YYYY-MM-DD, local): the Monday-to-Friday days
 * after the first one. Created Monday and live Wednesday is 2; created Friday and live Monday
 * is 1; the same day is 0.
 */
export function workingDaysTaken(from: string, to: string): number {
  const span = daysBetween(from, to);
  let count = 0;
  for (let i = 1; i <= span; i++) {
    if (isoWeekday(addDays(from, i)) <= 5) count++;
  }
  return count;
}
