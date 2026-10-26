import { describe, expect, it } from 'vitest';
import { auditValue } from './audit.ts';

describe('auditValue', () => {
  it('drops secrets at any depth and keeps flags about them', () => {
    expect(
      auditValue({
        name: 'Ada',
        password: 'x',
        passwordHash: 'x',
        pin: '123456',
        pinHash: 'x',
        hasPin: true,
        mfaSecretEnc: 'x',
        nested: { tokenHash: 'x', sessionToken: 'x', code: '123456', keep: 1 },
        list: [{ otp: '1', ok: 2 }],
      }),
    ).toEqual({ name: 'Ada', hasPin: true, nested: { keep: 1 }, list: [{ ok: 2 }] });
  });

  it('makes dates, bigints and bytes JSON-safe', () => {
    const at = new Date('2026-10-26T10:00:00Z');
    expect(auditValue({ at, n: 12n, bytes: new Uint8Array([1]), none: null })).toEqual({
      at: '2026-10-26T10:00:00.000Z',
      n: '12',
    });
    expect(auditValue(undefined)).toBeUndefined();
    expect(auditValue([undefined, 1])).toEqual([null, 1]);
  });
});
