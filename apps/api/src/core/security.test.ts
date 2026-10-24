import { describe, expect, it } from 'vitest';
import { propertyCodeFor } from '../modules/identity/service.ts';
import { isSessionOver, readCookie, SESSION_POLICY } from './auth.ts';
import { hashPassword, SCRYPT_PARAMS, verifyPassword } from './passwords.ts';
import { hashToken, newToken } from './tokens.ts';
import type { Session } from '../generated/prisma/client.ts';

describe('passwords (scrypt)', () => {
  it('stores scheme, cost, salt and key, never the password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{86}$/);
    expect(stored).not.toContain('correct');
    expect(await hashPassword('correct horse battery')).not.toBe(stored); // salted
  });

  it('verifies the right password only', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toEqual({
      ok: true,
      needsRehash: false,
    });
    expect((await verifyPassword('correct horse batterz', stored)).ok).toBe(false);
  });

  it('treats Unicode look-alikes the same (NFKC)', async () => {
    const stored = await hashPassword('ｐａｓｓｗｏｒｄ-ﬁve');
    expect((await verifyPassword('password-five', stored)).ok).toBe(true);
  });

  it('flags hashes made with older cost settings for re-hashing', async () => {
    const old = await hashPassword('correct horse battery', { ...SCRYPT_PARAMS, N: 2 ** 14 });
    expect(await verifyPassword('correct horse battery', old)).toEqual({
      ok: true,
      needsRehash: true,
    });
  });

  it.each(['', 'bcrypt$x', 'scrypt$0$8$1$a$b', 'scrypt$32768$8$1$$'])(
    'rejects a malformed stored hash %j',
    async (stored) => {
      expect((await verifyPassword('anything', stored)).ok).toBe(false);
    },
  );
});

describe('tokens', () => {
  it('are 256-bit, URL-safe and unique', () => {
    const a = newToken();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(newToken()).not.toBe(a);
  });

  it('are stored as an HMAC that depends on the server secret', () => {
    const token = newToken();
    expect(hashToken('secret-one', token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('secret-one', token)).toBe(hashToken('secret-one', token));
    expect(hashToken('secret-two', token)).not.toBe(hashToken('secret-one', token));
  });
});

describe('readCookie', () => {
  it('finds the named cookie among others', () => {
    expect(readCookie('theme=dark; sid=abc123; x=1', 'sid')).toBe('abc123');
    expect(readCookie('sidx=1; sid=two', 'sid')).toBe('two');
    expect(readCookie('theme=dark', 'sid')).toBeUndefined();
    expect(readCookie(undefined, 'sid')).toBeUndefined();
    expect(readCookie('sid=%E0%A4%A', 'sid')).toBeUndefined(); // malformed escape
  });
});

describe('isSessionOver', () => {
  const t0 = new Date('2026-11-12T09:00:00Z');
  const session = (over: Partial<Session> = {}) =>
    ({
      revokedAt: null,
      sharedDevice: false,
      lastSeenAt: t0,
      expiresAt: new Date(t0.getTime() + SESSION_POLICY.personal.maxAgeMs),
      ...over,
    }) as Session;
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it('ends a personal session after 12 idle hours', () => {
    expect(isSessionOver(session(), at(SESSION_POLICY.personal.idleMs - 1))).toBe(false);
    expect(isSessionOver(session(), at(SESSION_POLICY.personal.idleMs))).toBe(true);
  });

  it('ends a shared-device session after 30 idle minutes', () => {
    const shared = session({ sharedDevice: true });
    expect(isSessionOver(shared, at(29 * 60_000))).toBe(false);
    expect(isSessionOver(shared, at(30 * 60_000))).toBe(true);
  });

  it('ends at the absolute limit and when revoked', () => {
    expect(isSessionOver(session({ expiresAt: at(1000), lastSeenAt: at(900) }), at(1000))).toBe(
      true,
    );
    expect(isSessionOver(session({ revokedAt: t0 }), t0)).toBe(true);
  });
});

describe('propertyCodeFor', () => {
  it.each([
    ['Demo Lagos Hotel', 'DLH'],
    ['Sheraton', 'SHE'],
    ['The Grand Abuja Suites & Spa', 'TGAS'],
    ['Ọ̀yọ́ Inn', 'YI'],
    ['9', 'HTL'],
  ])('%s → %s', (name, code) => {
    expect(propertyCodeFor(name)).toBe(code);
  });
});
