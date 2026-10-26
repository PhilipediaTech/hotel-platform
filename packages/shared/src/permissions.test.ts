import { describe, expect, it } from 'vitest';
import {
  HOTEL_PERMISSION_CODES,
  HotelPermission,
  PERMISSIONS,
  permissionDef,
  RoleLimits,
} from './permissions.ts';

describe('permission catalogue', () => {
  it('has unique resource.action codes with labels', () => {
    const codes = PERMISSIONS.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const def of PERMISSIONS) {
      expect(def.code).toMatch(/^[a-z]+(\.[a-z]+){1,2}$/);
      expect(def.label.length).toBeGreaterThan(3);
    }
  });

  it('keeps platform codes out of hotel roles', () => {
    expect(HOTEL_PERMISSION_CODES.some((c) => c.startsWith('platform.'))).toBe(false);
    expect(HotelPermission.safeParse('platform.admin').success).toBe(false);
    expect(HotelPermission.safeParse('made.up').success).toBe(false);
    expect(HotelPermission.safeParse('folio.refund').success).toBe(false); // PRD example, not a story code
    expect(HotelPermission.safeParse('payment.refund').success).toBe(true);
  });

  it('marks the Strategy §5 sensitive actions as limitable', () => {
    expect(permissionDef('folio.discount')?.limits).toEqual(['percent', 'amount']);
    expect(permissionDef('payment.refund')?.limits).toEqual(['amount']);
    expect(permissionDef('folio.read')?.limits).toBeUndefined();
  });
});

describe('RoleLimits', () => {
  it('accepts limits of the kinds a code supports', () => {
    expect(
      RoleLimits.safeParse({
        'folio.discount': { maxBps: 1500, maxAmountMinor: '5000000' },
        'room.move': { maxCount: 2 },
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ 'folio.read': { maxBps: 1 } }, 'takes no limits'],
    [{ 'payment.refund': { maxBps: 1 } }, 'takes no maxBps'],
    [{ 'folio.discount': {} }, 'Set at least one limit'],
    [{ 'folio.discount': { maxBps: 10_001 } }, ''],
    [{ 'payment.refund': { maxAmountMinor: '-5' } }, ''],
  ])('refuses %j', (limits, message) => {
    const result = RoleLimits.safeParse(limits);
    expect(result.success).toBe(false);
    if (message) expect(JSON.stringify(result.error?.issues)).toContain(message);
  });
});
