import { describe, expect, it } from 'vitest';
import { suggestChange } from './suggestions.ts';

// The price suggestion rule table (PRD M14-13; T-149).

const ly = (soldThen: number, soldFinal: number, capacity = 20) => ({
  soldThen,
  soldFinal,
  capacity,
});

describe('suggestChange', () => {
  it('raises the price when the date is nearly full or selling strongly', () => {
    expect(suggestChange({ sold: 18, capacity: 20, daysOut: 20, lastYear: null })).toEqual({
      bps: 1500,
      reasons: ['Nearly full: 90% sold (18 of 20) 20 days out'],
    });
    expect(suggestChange({ sold: 15, capacity: 20, daysOut: 1, lastYear: ly(9, 16) })).toEqual({
      bps: 1000,
      reasons: [
        'Strong demand: 75% sold (15 of 20) 1 day out',
        'last year: 45% at this point, 80% in the end',
      ],
    });
  });

  it('raises a little when bookings run ahead of last year at the same point', () => {
    expect(suggestChange({ sold: 10, capacity: 20, daysOut: 30, lastYear: ly(5, 14) })).toEqual({
      bps: 500,
      reasons: [
        'Booking faster than last year: 50% sold (10 of 20) 30 days out',
        'last year: 25% at this point, 70% in the end',
      ],
    });
    // Ahead, but on a single booking: not enough to go on.
    expect(suggestChange({ sold: 1, capacity: 4, daysOut: 30, lastYear: ly(0, 2, 4) }).bps).toBe(0);
  });

  it('lowers it close in when the date is weak and behind last year', () => {
    expect(suggestChange({ sold: 2, capacity: 20, daysOut: 5, lastYear: ly(8, 10) })).toEqual({
      bps: -1000,
      reasons: [
        'Slow close in: 10% sold (2 of 20) 5 days out',
        'last year: 40% at this point, 50% in the end',
      ],
    });
    expect(suggestChange({ sold: 0, capacity: 10, daysOut: 3, lastYear: null }).bps).toBe(-1000);
  });

  it('holds the price when last year filled late, when it is far out, or when nothing stands out', () => {
    // Weak now, but last year this date finished at 75%.
    expect(suggestChange({ sold: 2, capacity: 20, daysOut: 5, lastYear: ly(6, 15) })).toEqual({
      bps: 0,
      reasons: [],
    });
    // Weak but a month away: too early to cut.
    expect(suggestChange({ sold: 0, capacity: 10, daysOut: 30, lastYear: null }).bps).toBe(0);
    expect(suggestChange({ sold: 10, capacity: 20, daysOut: 10, lastYear: ly(9, 15) }).bps).toBe(0);
  });
});
