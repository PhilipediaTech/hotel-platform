import type { RequestHandler } from 'express';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Paths called by servers, not browsers; they authenticate with signatures instead.
 * Payment and channel webhooks (T-062 onward) live here.
 */
export const ORIGIN_CHECK_EXEMPT = ['/api/v1/webhooks/'];

/**
 * Middleware step 6, CSRF defence: every state-changing request must carry an `Origin` from
 * the allow-list (the staff app or the booking site). SameSite=Lax cookies already stop most
 * cross-site posts; this closes the rest, including same-site subdomains.
 */
export function originCheck(config: Config): RequestHandler {
  const allowed = new Set([config.appOrigin, config.siteOrigin]);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (ORIGIN_CHECK_EXEMPT.some((prefix) => req.path.startsWith(prefix))) return next();
    const origin = req.get('origin');
    if (origin === undefined || !allowed.has(origin)) {
      throw new AppError('FORBIDDEN', 'This request must come from the hotel app.', {
        reason: 'ORIGIN_NOT_ALLOWED',
      });
    }
    next();
  };
}
