import { describe, expect, it } from 'vitest';
import {
  AttendanceSettings,
  attendanceSettingsOf,
  DEFAULT_ATTENDANCE_SETTINGS,
  distanceMeters,
} from './attendance.ts';

describe('distanceMeters', () => {
  it('measures short distances on the ground', () => {
    const hotel = { latitude: 6.4281, longitude: 3.4219 };
    expect(distanceMeters(hotel, hotel)).toBe(0);
    const d = distanceMeters(hotel, { latitude: 6.4285, longitude: 3.4222 });
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(60);
    // One degree of latitude is about 111 km.
    expect(
      distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 }),
    ).toBeCloseTo(111_195, -2);
  });
});

describe('attendance settings', () => {
  it('falls back to the defaults: everyone clocks, phones allowed, no checks', () => {
    expect(attendanceSettingsOf(undefined)).toEqual(DEFAULT_ATTENDANCE_SETTINGS);
    expect(attendanceSettingsOf({ phoneAllowed: 'yes' })).toEqual(DEFAULT_ATTENDANCE_SETTINGS);
  });

  it('needs an address for the network check and a position for the location check', () => {
    const base = DEFAULT_ATTENDANCE_SETTINGS;
    expect(
      AttendanceSettings.safeParse({ ...base, network: { enabled: true, addresses: [] } }).success,
    ).toBe(false);
    expect(
      AttendanceSettings.safeParse({ ...base, location: { ...base.location, enabled: true } })
        .success,
    ).toBe(false);
    expect(
      AttendanceSettings.safeParse({
        ...base,
        network: { enabled: true, addresses: ['102.89.4.0/24'] },
        location: { enabled: true, latitude: 6.4, longitude: 3.4, radiusMeters: 200 },
      }).success,
    ).toBe(true);
  });
});
