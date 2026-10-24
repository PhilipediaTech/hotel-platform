import { isWeakPin, Pin } from '@hotel/shared';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  normaliseRecoveryCode,
  totpCode,
  verifyTotp,
} from './mfa.ts';

const KEY = Buffer.alloc(32, 1);
const OTHER_KEY = Buffer.alloc(32, 2);

describe('MFA secret encryption (AES-256-GCM)', () => {
  it('round-trips, with a fresh IV each time', () => {
    const secret = newTotpSecret();
    const a = encryptSecret(KEY, secret);
    expect(decryptSecret(KEY, a)).toBe(secret);
    expect(Buffer.from(encryptSecret(KEY, secret)).equals(Buffer.from(a))).toBe(false);
  });

  it('refuses the wrong key and tampered data', () => {
    const data = encryptSecret(KEY, newTotpSecret());
    expect(() => decryptSecret(OTHER_KEY, data)).toThrow();
    const tampered = Uint8Array.from(data);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => decryptSecret(KEY, tampered)).toThrow();
    expect(() => decryptSecret(KEY, new Uint8Array([9, 1, 2]))).toThrow(
      'Unknown MFA secret format',
    );
  });
});

describe('verifyTotp', () => {
  const secret = newTotpSecret();
  const t = new Date('2026-11-12T09:00:10Z');
  const step = BigInt(Math.floor(t.getTime() / 1000 / 30));

  it('accepts the current code and one step of clock drift either way', async () => {
    expect(await verifyTotp(secret, await totpCode(secret, t), t, null)).toEqual({
      ok: true,
      step,
    });
    const earlier = await totpCode(secret, new Date(t.getTime() - 30_000));
    expect((await verifyTotp(secret, earlier, t, null)).ok).toBe(true);
    const later = await totpCode(secret, new Date(t.getTime() + 30_000));
    expect((await verifyTotp(secret, later, t, null)).ok).toBe(true);
  });

  it('rejects older codes, replays and malformed input', async () => {
    const old = await totpCode(secret, new Date(t.getTime() - 90_000));
    expect((await verifyTotp(secret, old, t, null)).ok).toBe(false);
    const code = await totpCode(secret, t);
    expect((await verifyTotp(secret, code, t, step)).ok).toBe(false);
    for (const bad of ['', '12345', '1234567', 'abcdef']) {
      expect((await verifyTotp(secret, bad, t, null)).ok).toBe(false);
    }
  });
});

describe('recovery codes', () => {
  it('are unique, readable XXXX-XXXX codes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  });

  it('match however they are typed, and hash with the server secret', () => {
    expect(normaliseRecoveryCode(' ab2c-d3ef ')).toBe('AB2CD3EF');
    expect(hashRecoveryCode('s', 'ab2c d3ef')).toBe(hashRecoveryCode('s', 'AB2C-D3EF'));
    expect(hashRecoveryCode('s', 'AB2C-D3EF')).not.toBe(hashRecoveryCode('t', 'AB2C-D3EF'));
  });
});

describe('PIN rules', () => {
  it.each(['000000', '111111', '123456', '234567', '987654', '654321'])('%s is too easy', (pin) => {
    expect(isWeakPin(pin)).toBe(true);
    expect(Pin.safeParse(pin).success).toBe(false);
  });

  it.each(['482916', '730158', '112233', '135791'])('%s is accepted', (pin) => {
    expect(Pin.safeParse(pin).success).toBe(true);
  });

  it('needs exactly six digits', () => {
    for (const pin of ['12345', '1234567', '12a456'])
      expect(Pin.safeParse(pin).success).toBe(false);
  });
});
