import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import type { Session, User } from '../generated/prisma/client.ts';
import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { hashToken, newToken } from './tokens.ts';

// Server-side sessions (spec tab 2; PRD M1 rule 5): an opaque `sid` cookie, its HMAC in
// `sessions`, revocable at any time. Middleware step 5 loads it on every request.

export const SESSION_COOKIE = 'sid';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** PRD M1 rule 5. Per-property overrides arrive with the settings screens (M1-02). */
export const SESSION_POLICY = {
  personal: { idleMs: 12 * HOUR, maxAgeMs: 30 * 24 * HOUR },
  shared: { idleMs: 30 * MINUTE, maxAgeMs: 12 * HOUR },
  /** `last_seen_at` is written at most this often, not on every request. */
  touchEveryMs: MINUTE,
} as const;

export interface AuthContext {
  session: Session;
  user: User;
}

type AuthState = { kind: 'none' } | { kind: 'expired' } | ({ kind: 'active' } & AuthContext);

const states = new WeakMap<Request, AuthState>();

function policyFor(session: Pick<Session, 'sharedDevice'>) {
  return session.sharedDevice ? SESSION_POLICY.shared : SESSION_POLICY.personal;
}

/** True when the session can no longer be used: revoked, past its idle or absolute limit. */
export function isSessionOver(session: Session, now: Date): boolean {
  if (session.revokedAt) return true;
  if (now >= session.expiresAt) return true;
  return now.getTime() - session.lastSeenAt.getTime() >= policyFor(session).idleMs;
}

/** Minimal Cookie header parser (we only read `sid`). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function cookieOptions(config: Config): CookieOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  };
}

export function setSessionCookie(res: Response, config: Config, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(config), expires: expiresAt });
}

export function clearSessionCookie(res: Response, config: Config) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(config));
}

export interface SessionDeps {
  db: Db;
  config: Config;
  clock: Clock;
}

export interface NewSession {
  userId: string;
  sharedDevice: boolean;
  deviceLabel?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/** Creates a session row and returns it with the raw token for the cookie. */
export async function createSession(
  { db, config, clock }: SessionDeps,
  input: NewSession,
): Promise<{ session: Session; token: string }> {
  const now = clock();
  const token = newToken();
  const session = await db.session.create({
    data: {
      tokenHash: hashToken(config.sessionSecret, token),
      userId: input.userId,
      sharedDevice: input.sharedDevice,
      deviceLabel: input.deviceLabel ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + policyFor(input).maxAgeMs),
    },
  });
  return { session, token };
}

/** Middleware step 5: cookie → `sessions` row → request auth state. */
export function sessionLoader(deps: SessionDeps): RequestHandler {
  return async (req, res, next) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) {
      states.set(req, { kind: 'none' });
      next();
      return;
    }
    const now = deps.clock();
    const found = await deps.db.session.findUnique({
      where: { tokenHash: hashToken(deps.config.sessionSecret, token) },
      include: { user: true },
    });
    if (!found || isSessionOver(found, now) || found.user.status !== 'ACTIVE') {
      states.set(req, { kind: 'expired' });
      clearSessionCookie(res, deps.config);
      next();
      return;
    }
    const { user, ...session } = found;
    if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_POLICY.touchEveryMs) {
      await deps.db.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
      session.lastSeenAt = now;
    }
    markSignedIn(req, { session, user });
    next();
  };
}

/** Records a signed-in request. Used by sessionLoader, and by tests of routes. */
export function markSignedIn(req: Request, auth: AuthContext): void {
  states.set(req, { kind: 'active', ...auth });
}

/** The signed-in user and session, or null. */
export function getAuth(req: Request): AuthContext | null {
  const state = states.get(req);
  return state?.kind === 'active' ? { session: state.session, user: state.user } : null;
}

/** For routes that need a session: UNAUTHENTICATED, or SESSION_EXPIRED when a cookie was stale. */
export function requireAuth(req: Request): AuthContext {
  const state = states.get(req);
  if (state?.kind === 'active') return { session: state.session, user: state.user };
  if (state?.kind === 'expired') {
    throw new AppError('SESSION_EXPIRED', 'Your session has ended. Sign in again.');
  }
  throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
}

/** Ends the request's session if it has one (sign-out). */
export async function revokeCurrentSession(db: Db, req: Request, now: Date): Promise<void> {
  const auth = getAuth(req);
  if (!auth) return;
  await db.session.updateMany({
    where: { id: auth.session.id, revokedAt: null },
    data: { revokedAt: now },
  });
}
