import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { getAuth } from './auth.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';

// Middleware step 8 (spec tab 4, "Rate limits"): 20 requests/min per IP on auth routes,
// 300/min per signed-in user. Fixed one-minute windows counted in `rate_limit_hits`, so
// limits hold across API instances. Old windows are purged by the cleanup job (T-021).

export const RATE_LIMITS = {
  authPerIp: 20,
  perUser: 300,
} as const;

const WINDOW_MS = 60_000;
const AUTH_PREFIX = '/api/v1/auth/';

/** Counts one hit for `key` in the current window and returns the new count. */
export async function hit(db: Db, key: string, windowStart: Date): Promise<number> {
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limit_hits (key, window_start, count) VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_hits.count + 1
    RETURNING count`;
  return rows[0]?.count ?? 1;
}

export function rateLimiter(deps: { db: Db; clock: Clock; logger: Logger }): RequestHandler {
  return async (req, res, next) => {
    const checks: { key: string; limit: number }[] = [];
    if (req.path.startsWith(AUTH_PREFIX)) {
      checks.push({ key: `ip:auth:${req.ip ?? 'unknown'}`, limit: RATE_LIMITS.authPerIp });
    }
    const auth = getAuth(req);
    if (auth) checks.push({ key: `user:${auth.user.id}`, limit: RATE_LIMITS.perUser });
    if (checks.length === 0) return next();

    const now = deps.clock().getTime();
    const windowStart = new Date(now - (now % WINDOW_MS));
    try {
      for (const { key, limit } of checks) {
        if ((await hit(deps.db, key, windowStart)) > limit) {
          const retryAfter = Math.ceil((windowStart.getTime() + WINDOW_MS - now) / 1000);
          res.setHeader('Retry-After', String(retryAfter));
          throw new AppError('RATE_LIMITED', 'Too many requests. Wait a moment and try again.', {
            retryAfterSeconds: retryAfter,
          });
        }
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Fail open: a counting problem must not take the whole API down. Logged for alerting.
      deps.logger.error({ err }, 'Rate limiter unavailable; request allowed');
    }
    next();
  };
}
