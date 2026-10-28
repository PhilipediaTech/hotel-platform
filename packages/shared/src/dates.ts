// Calendar dates (`YYYY-MM-DD`, no time zone) as the API sends them (tab 4 "Conventions").
// The PRD rule: dates are property-local business dates; timestamps are UTC.

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar date at `instant` in `timeZone`, e.g. 23:30 UTC in Lagos is the next day. */
export function localDate(instant: Date, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (!f) {
    // en-CA formats dates as YYYY-MM-DD.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f.format(instant);
}

/** `date` moved by `days` (negative goes back). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
