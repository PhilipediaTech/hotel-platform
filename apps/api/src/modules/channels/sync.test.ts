import { describe, expect, it } from 'vitest';
import { fullSyncSlot, lastFullSyncSlot } from './sync.ts';

// The daily full send's time (T-154): off-peak, between 02:00 and 05:00 hotel time, fixed per
// property so properties are spread out (Channex certification test 13).

describe('daily full send slot', () => {
  it('falls between 02:00 and 04:59, the same for a property every day, spread across them', () => {
    const ids = Array.from(
      { length: 200 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const slots = ids.map(fullSyncSlot);
    expect(Math.min(...slots)).toBeGreaterThanOrEqual(120);
    expect(Math.max(...slots)).toBeLessThan(300);
    expect(fullSyncSlot(ids[0] ?? '')).toBe(slots[0]);
    expect(new Set(slots).size).toBeGreaterThan(100);
  });

  it('answers the latest time the slot came round, in the hotel’s time zone', () => {
    // 10:00 in Lagos (UTC+1): today's 03:00 slot was 02:00 UTC.
    expect(lastFullSyncSlot(new Date('2026-11-10T09:00:30Z'), 'Africa/Lagos', 180)).toEqual(
      new Date('2026-11-10T02:00:00Z'),
    );
    // 03:30 in Lagos, slot 04:00: not yet today, so yesterday's.
    expect(lastFullSyncSlot(new Date('2026-11-10T02:30:00Z'), 'Africa/Lagos', 240)).toEqual(
      new Date('2026-11-09T03:00:00Z'),
    );
    // The slot's own minute counts as come round.
    expect(lastFullSyncSlot(new Date('2026-11-10T03:00:10Z'), 'Africa/Lagos', 240)).toEqual(
      new Date('2026-11-10T03:00:00Z'),
    );
    // London in winter is UTC.
    expect(lastFullSyncSlot(new Date('2027-01-01T09:00:00Z'), 'Europe/London', 150)).toEqual(
      new Date('2027-01-01T02:30:00Z'),
    );
  });
});
