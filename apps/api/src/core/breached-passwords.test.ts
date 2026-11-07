import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import {
  createBreachedPasswordCheck,
  createFakeBreachCheck,
  createHibpCheck,
  HIBP_RANGE_URL,
  sha1Hex,
} from './breached-passwords.ts';

// Breached-password check (ASVS 6.2.12; T-102): Have I Been Pwned's range API.

const PASSWORD = 'correct horse battery staple';
const HASH = sha1Hex(PASSWORD);

function logs() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'warn' },
    { write: (l: string) => lines.push(JSON.parse(l) as Record<string, unknown>) },
  );
  return { logger, lines };
}

/** A fake fetch that answers `body` and records what was asked. */
function hibp(body: string, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('Have I Been Pwned range check', () => {
  it('sends only the first 5 characters of the SHA-1, with padding on', async () => {
    const { fetchImpl, calls } = hibp('');
    await createHibpCheck(logs().logger, fetchImpl)(PASSWORD);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${HIBP_RANGE_URL}${HASH.slice(0, 5)}`);
    expect(calls[0]?.url).not.toContain(HASH.slice(5));
    expect(calls[0]?.init?.headers).toMatchObject({ 'Add-Padding': 'true' });
  });

  it('finds the password when its suffix is listed with a count', async () => {
    const body = `0000000000000000000000000000000000A:3\r\n${HASH.slice(5)}:42\r\n`;
    expect(await createHibpCheck(logs().logger, hibp(body).fetchImpl)(PASSWORD)).toBe(true);
  });

  it('ignores padding lines (count 0) and other suffixes', async () => {
    const body = `${HASH.slice(5)}:0\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:9\r\n`;
    expect(await createHibpCheck(logs().logger, hibp(body).fetchImpl)(PASSWORD)).toBe(false);
  });

  it('allows the password and logs a warning when HIBP is down or errors', async () => {
    const down = logs();
    const failing = (() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as typeof fetch;
    expect(await createHibpCheck(down.logger, failing)(PASSWORD)).toBe(false);
    expect(down.lines[0]).toMatchObject({ reason: 'getaddrinfo ENOTFOUND' });
    expect(JSON.stringify(down.lines)).not.toContain(PASSWORD);

    const busy = logs();
    expect(await createHibpCheck(busy.logger, hibp('', 503).fetchImpl)(PASSWORD)).toBe(false);
    expect(busy.lines[0]).toMatchObject({ reason: 'HIBP answered 503' });
  });
});

describe('fake check (tests, offline work)', () => {
  it('knows a few common passwords and nothing else', async () => {
    const check = createFakeBreachCheck();
    expect(await check('password123')).toBe(true);
    expect(await check(PASSWORD)).toBe(false);
  });

  it('is what PASSWORD_BREACH_CHECK=fake builds', async () => {
    const check = createBreachedPasswordCheck({ passwordBreachCheck: 'fake' }, logs().logger);
    expect(await check('password123')).toBe(true);
  });
});
