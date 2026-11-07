import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';

// Breached-password check (ASVS 5.0 6.2.12, level 2; T-102; Philip chose Have I Been Pwned,
// 2026-11-07). A new password is refused if it appears in a known data breach. Only the first
// 5 characters of its SHA-1 hash leave the server (HIBP's k-anonymity range API), and the
// response is padded so its size says nothing either. If HIBP can't be reached the check is
// skipped and a warning logged: an outage there must not stop sign-ups or resets.

/** Whether `password` is known from a breach. */
export type BreachedPasswordCheck = (password: string) => Promise<boolean>;

export const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 3000;

/** Uppercase hex SHA-1, the form HIBP lists. */
export function sha1Hex(password: string): string {
  return createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
}

export function createHibpCheck(
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): BreachedPasswordCheck {
  return async (password) => {
    const hash = sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    try {
      const res = await fetchImpl(`${HIBP_RANGE_URL}${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'hotel-platform' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HIBP answered ${res.status}`);
      for (const line of (await res.text()).split('\n')) {
        const [candidate, count] = line.trim().split(':');
        // Padding lines carry a count of 0.
        if (candidate === suffix && Number(count) > 0) return true;
      }
      return false;
    } catch (err) {
      logger.warn(
        { reason: (err as Error).message },
        'Breached-password check unavailable; password allowed',
      );
      return false;
    }
  };
}

/** Tests and offline development: a few passwords every breach list has, no network. */
export const FAKE_BREACHED_PASSWORDS = ['password123', 'Password123!', 'qwerty12345', '1234567890'];

export function createFakeBreachCheck(): BreachedPasswordCheck {
  const known = new Set(FAKE_BREACHED_PASSWORDS);
  return (password) => Promise.resolve(known.has(password));
}

export function createBreachedPasswordCheck(
  config: Pick<Config, 'passwordBreachCheck'>,
  logger: Logger,
): BreachedPasswordCheck {
  return config.passwordBreachCheck === 'hibp' ? createHibpCheck(logger) : createFakeBreachCheck();
}

/** Refuses a breached password as a validation error on `field` (e.g. `body.password`). */
export async function assertNotBreached(
  check: BreachedPasswordCheck,
  password: string,
  field = 'body.password',
): Promise<void> {
  if (await check(password)) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed.', {
      issues: [
        {
          path: field,
          code: 'breached_password',
          message: 'This password has appeared in a data breach elsewhere. Choose a different one.',
        },
      ],
    });
  }
}
