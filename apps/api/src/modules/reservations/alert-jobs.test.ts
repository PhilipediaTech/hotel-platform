import { describe, expect, it } from 'vitest';
import { stayAlertDetail } from './alert-jobs.ts';

// The WhatsApp "detail" sentence of each stay alert kind (T-055), in the property's time zone.

const base = {
  stayId: '00000000-0000-4000-8000-000000000001',
  reservationId: '00000000-0000-4000-8000-000000000002',
  confirmationNo: 'P1-000123',
  guestName: 'Ada Obi',
  roomNumber: '204',
  arrival: '2026-11-11',
  departure: '2026-11-12',
  at: '2026-11-12T11:00:00Z',
  depositDueMinor: '0',
  lateFeePosted: false,
  version: 3,
};
const lagos = { timeZone: 'Africa/Lagos', baseCurrency: 'NGN' };

describe('stayAlertDetail', () => {
  it('says what each kind is about', () => {
    expect(stayAlertDetail({ ...base, kind: 'LATE_CHECK_OUT' }, lagos)).toBe(
      'Room 204, Ada Obi (P1-000123): check-out was due at 12:00.',
    );
    expect(stayAlertDetail({ ...base, kind: 'DUE_OUT_SOON' }, lagos)).toBe(
      'Room 204, Ada Obi (P1-000123) checks out at 12:00.',
    );
    expect(
      stayAlertDetail(
        { ...base, kind: 'HOLD_EXPIRING', roomNumber: null, at: '2026-11-10T15:30:00Z' },
        lagos,
      ),
    ).toBe('Ada Obi (P1-000123): the tentative hold ends at 16:30 and its rooms go back on sale.');
    expect(
      stayAlertDetail(
        { ...base, kind: 'DEPOSIT_MISSING', at: null, depositDueMinor: '4500000' },
        lagos,
      ),
    ).toBe(
      'Ada Obi (P1-000123) arrives 11 Nov 2026 and the deposit of NGN 45,000.00 has not come in.',
    );
  });
});
