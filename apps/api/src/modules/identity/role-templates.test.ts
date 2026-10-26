import { HOTEL_PERMISSION_CODES, HotelPermission } from '@hotel/shared';
import { describe, expect, it } from 'vitest';
import { OWNER_LOCKED_PERMISSIONS, roleTemplate, ROLE_TEMPLATES } from './role-templates.ts';

describe('role templates (Strategy §5)', () => {
  it('use only catalogue codes, each once', () => {
    for (const t of ROLE_TEMPLATES) {
      expect(new Set(t.permissions).size, t.name).toBe(t.permissions.length);
      for (const code of t.permissions)
        expect(HotelPermission.safeParse(code).success, `${t.name}: ${code}`).toBe(true);
    }
  });

  it('give the owner everything and the GM everything except owner-only codes', () => {
    expect(roleTemplate('owner').permissions).toEqual(HOTEL_PERMISSION_CODES);
    const gm = new Set(roleTemplate('gm').permissions);
    for (const code of [
      'role.manage',
      'subscription.read',
      'approval.policy.manage',
      'owner.read',
    ]) {
      expect(gm.has(code), code).toBe(false);
    }
    for (const code of [
      'role.assign',
      'user.invite',
      'approval.decide',
      'report.dashboard',
      'device.manage',
    ]) {
      expect(gm.has(code), code).toBe(true);
    }
    for (const code of OWNER_LOCKED_PERMISSIONS)
      expect(roleTemplate('owner').permissions).toContain(code);
  });

  it('require MFA for owner, GM and finance (M1-06)', () => {
    expect(ROLE_TEMPLATES.filter((t) => t.requiresMfa).map((t) => t.slug)).toEqual([
      'owner',
      'gm',
      'finance',
    ]);
  });

  it('keep the read-only auditor free of any write permission', () => {
    const writes =
      /\.(manage|create|modify|cancel|charge|capture|refund|assign|run|work|send|invite|decide)$/;
    expect(roleTemplate('auditor').permissions.filter((c) => writes.test(c))).toEqual([]);
  });

  it('let managers open shared devices, and nobody else', () => {
    const openers = ROLE_TEMPLATES.filter((t) => t.permissions.includes('device.manage')).map(
      (t) => t.slug,
    );
    expect(openers.sort()).toEqual(['dept-manager', 'gm', 'hk-supervisor', 'owner']);
  });
});
