import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import type { Session, User } from '../generated/prisma/client.ts';
import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { hashToken, newToken } from './tokens.ts';

// Server-side sessions (spec tab 2; PRD M1 rule 5): an opaque `sid` cookie, its HMAC in
// `sessions`, revocable at any time. Middleware step 5 loads it on every request.
//
// Shared devices (M1-07): a manager's sign-in with "shared device" opens a device session,
// remembered in a second cookie `did`. Staff then switch in with a PIN, which creates a
// child session (`parent_session_id` = the device session) in `sid`. A child ends when its
// device session ends.

export const SESSION_COOKIE = 'sid';
export const DEVICE_COOKIE = 'did';

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

/** Shared-device and PIN (child) sessions get the short policy. */
function policyFor(session: Pick<Session, 'sharedDevice' | 'parentSessionId'>) {
  return session.sharedDevice || session.parentSessionId
    ? SESSION_POLICY.shared
    : SESSION_POLICY.personal;
}

/** True when the session can no longer be used: revoked, past its idle or absolute limit. */
export function isSessionOver(session: Session, now: Date): boolean {
  if (session.revokedAt) return true;
  if (now >= session.expiresAt) return true;
  return now.getTime() - session.lastSeenAt.getTime() >= policyFor(session).idleMs;
}

/** Minimal Cookie header parser (we only read `sid` and `did`). */
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

export function setDeviceCookie(res: Response, config: Config, token: string, expiresAt: Date) {
  res.cookie(DEVICE_COOKIE, token, { ...cookieOptions(config), expires: expiresAt });
}

export function clearDeviceCookie(res: Response, config: Config) {
  res.clearCookie(DEVICE_COOKIE, cookieOptions(config));
}

export interface SessionDeps {
  db: Db;
  config: Config;
  clock: Clock;
}

export interface NewSession {
  userId: string;
  sharedDevice: boolean;
  /** False until the user passes MFA when their roles require it. */
  mfaPassed: boolean;
  /** Set for a PIN session: the device session it runs under. */
  parent?: Session | undefined;
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
  const policy = policyFor({
    sharedDevice: input.sharedDevice,
    parentSessionId: input.parent?.id ?? null,
  });
  let expiresAt = new Date(now.getTime() + policy.maxAgeMs);
  // A PIN session never outlives its device.
  if (input.parent && input.parent.expiresAt < expiresAt) expiresAt = input.parent.expiresAt;
  const session = await db.session.create({
    data: {
      tokenHash: hashToken(config.sessionSecret, token),
      userId: input.userId,
      parentSessionId: input.parent?.id ?? null,
      sharedDevice: input.sharedDevice,
      mfaPassed: input.mfaPassed,
      deviceLabel: input.deviceLabel ?? input.parent?.deviceLabel ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      lastSeenAt: now,
      expiresAt,
    },
  });
  return { session, token };
}

/**
 * Gives the session a new token (and optionally marks MFA passed), so a token seen before a
 * privilege change can't be used after it (tab 2: "rotate on privilege change").
 */
export async function rotateSession(
  { db, config }: SessionDeps,
  session: Session,
  changes: { mfaPassed?: boolean } = {},
): Promise<{ session: Session; token: string }> {
  const token = newToken();
  const updated = await db.session.update({
    where: { id: session.id },
    data: { tokenHash: hashToken(config.sessionSecret, token), ...changes },
  });
  return { session: updated, token };
}

/** Middleware step 5: cookie → `sessions` row (and its device session) → request auth state. */
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
      include: { user: true, parentSession: true },
    });
    const over =
      !found ||
      isSessionOver(found, now) ||
      found.user.status !== 'ACTIVE' ||
      (found.parentSession !== null && isSessionOver(found.parentSession, now));
    if (over) {
      states.set(req, { kind: 'expired' });
      clearSessionCookie(res, deps.config);
      next();
      return;
    }
    const { user, parentSession, ...session } = found;
    if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_POLICY.touchEveryMs) {
      // Using a PIN session keeps its device session alive too.
      const ids = parentSession ? [session.id, parentSession.id] : [session.id];
      await deps.db.session.updateMany({ where: { id: { in: ids } }, data: { lastSeenAt: now } });
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

/** The signed-in user and session (MFA passed or not), or null. */
export function getAuth(req: Request): AuthContext | null {
  const state = states.get(req);
  return state?.kind === 'active' ? { session: state.session, user: state.user } : null;
}

/**
 * For routes that need a session: UNAUTHENTICATED, SESSION_EXPIRED when a cookie was stale,
 * or MFA_REQUIRED until the user passes MFA (except on the routes that get them through it).
 */
export function requireAuth(
  req: Request,
  options: { allowPendingMfa?: boolean } = {},
): AuthContext {
  const state = states.get(req);
  if (state?.kind === 'active') {
    if (!state.session.mfaPassed && !options.allowPendingMfa) {
      throw new AppError('MFA_REQUIRED', 'Enter the code from your authenticator app to continue.');
    }
    return { session: state.session, user: state.user };
  }
  if (state?.kind === 'expired') {
    throw new AppError('SESSION_EXPIRED', 'Your session has ended. Sign in again.');
  }
  throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
}

/**
 * The browser's device session (from `did`) if it is still usable as a shared device:
 * a live, MFA-passed, shared-device session of an active user.
 */
export async function loadDeviceSession(
  deps: SessionDeps,
  req: Request,
): Promise<(Session & { user: User }) | null> {
  const token = readCookie(req.headers.cookie, DEVICE_COOKIE);
  if (!token) return null;
  const device = await deps.db.session.findUnique({
    where: { tokenHash: hashToken(deps.config.sessionSecret, token) },
    include: { user: true },
  });
  if (
    !device ||
    !device.sharedDevice ||
    !device.mfaPassed ||
    device.parentSessionId !== null ||
    device.user.status !== 'ACTIVE' ||
    isSessionOver(device, deps.clock())
  ) {
    return null;
  }
  return device;
}

/** Ends a session and, for a device session, every PIN session under it. */
export async function revokeSessionTree(db: Db, sessionId: string, now: Date): Promise<void> {
  await db.session.updateMany({
    where: { OR: [{ id: sessionId }, { parentSessionId: sessionId }], revokedAt: null },
    data: { revokedAt: now },
  });
}

/** Ends the request's session if it has one (sign-out, or before a new sign-in). */
export async function revokeCurrentSession(db: Db, req: Request, now: Date): Promise<void> {
  const auth = getAuth(req);
  if (auth) await revokeSessionTree(db, auth.session.id, now);
}
