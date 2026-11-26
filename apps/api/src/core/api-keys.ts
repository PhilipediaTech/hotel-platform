import { API_KEY_PREFIX } from '@hotel/shared';
import type { Request, RequestHandler } from 'express';
import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import type { TenantContext } from './tenancy.ts';
import { hashToken, newToken } from './tokens.ts';

// Partner API keys (T-166). An outside system sends `Authorization: Bearer hk_…` to the
// /partner routes; the key belongs to one property and holds scopes. Only the key's HMAC is
// stored (like session tokens), so a leaked table can't be replayed. A key is never a session:
// cookies are ignored on these routes, and a key is refused everywhere else.

export const PARTNER_PATH = '/api/v1/partner/';

/** `last_used_at` is written at most this often. */
const TOUCH_EVERY_MS = 60_000;
/** Characters of the key kept to tell keys apart (after "hk_"). */
const SHOWN = 8;

export interface ApiKeyContext {
  keyId: string;
  scopes: ReadonlySet<string>;
  /** The key's property as a tenant: no permissions, only the key's scopes. */
  tenant: TenantContext;
}

type KeyState = { kind: 'none' } | { kind: 'invalid' } | ({ kind: 'active' } & ApiKeyContext);
const states = new WeakMap<Request, KeyState>();

/** A new key: the token (shown once), its HMAC and the prefix kept to tell it apart. */
export function newApiKey(config: Pick<Config, 'sessionSecret'>) {
  const token = `${API_KEY_PREFIX}${newToken()}`;
  return {
    token,
    tokenHash: hashToken(config.sessionSecret, token),
    prefix: token.slice(0, API_KEY_PREFIX.length + SHOWN),
  };
}

function bearer(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Middleware step 5b: on /partner paths, `Authorization: Bearer` → a live key of a property
 * that isn't archived → the key's context for the route. Elsewhere it does nothing.
 */
export function apiKeyLoader(deps: { db: Db; config: Config; clock: Clock }): RequestHandler {
  return async (req, _res, next) => {
    if (!req.path.startsWith(PARTNER_PATH)) return next();
    const token = bearer(req);
    if (!token?.startsWith(API_KEY_PREFIX)) {
      states.set(req, { kind: token ? 'invalid' : 'none' });
      return next();
    }
    const key = await deps.db.apiKey.findUnique({
      where: { tokenHash: hashToken(deps.config.sessionSecret, token) },
      include: { property: { select: { organisationId: true, status: true } } },
    });
    if (!key || key.revokedAt || key.property.status === 'ARCHIVED') {
      states.set(req, { kind: 'invalid' });
      return next();
    }
    const [flags, subscription] = await Promise.all([
      deps.db.featureFlag.findMany({
        where: { organisationId: key.property.organisationId, enabled: false },
        select: { module: true },
      }),
      deps.db.subscription.findUnique({
        where: { organisationId: key.property.organisationId },
        select: { status: true },
      }),
    ]);
    const now = deps.clock();
    if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() >= TOUCH_EVERY_MS) {
      await deps.db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
    }
    states.set(req, {
      kind: 'active',
      keyId: key.id,
      scopes: new Set(key.scopes),
      tenant: {
        // Attributed to whoever made the key (the routes only read).
        userId: key.createdById,
        organisationId: key.property.organisationId,
        propertyId: key.propertyId,
        roles: [],
        permissions: new Set(),
        disabledModules: new Set(flags.map((f) => f.module)),
        suspended: subscription?.status === 'SUSPENDED',
      },
    });
    next();
  };
}

/** The request's live key, or null. */
export function getApiKey(req: Request): ApiKeyContext | null {
  const state = states.get(req);
  return state?.kind === 'active'
    ? { keyId: state.keyId, scopes: state.scopes, tenant: state.tenant }
    : null;
}

/** For `apiKey` routes: UNAUTHENTICATED without a live key; FORBIDDEN without the scope. */
export function requireApiKey(req: Request, scope?: string): ApiKeyContext {
  const key = getApiKey(req);
  if (!key) {
    throw new AppError(
      'UNAUTHENTICATED',
      'Send a live API key of the property: Authorization: Bearer hk_…',
    );
  }
  if (scope && !key.scopes.has(scope)) {
    throw new AppError('FORBIDDEN', 'This API key does not have the scope for this.', { scope });
  }
  return key;
}
