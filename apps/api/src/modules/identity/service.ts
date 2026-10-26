import { SIGN_UP_COUNTRIES, type SignUpCountry } from '@hotel/shared';
import type { Logger } from 'pino';
import type { AuthTokenPurpose, Session, User } from '../../generated/prisma/client.ts';
import { recordAudit, recordUserEvent } from '../../core/audit.ts';
import { createSession, isSessionOver, type AuthContext } from '../../core/auth.ts';
import type { Clock } from '../../core/clock.ts';
import type { Config } from '../../core/config.ts';
import { pgErrorInfo, type Db, type DbClient } from '../../core/db.ts';
import type { EmailProvider } from '../../core/email.ts';
import { AppError } from '../../core/errors.ts';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../core/passwords.ts';
import { hashToken, newToken } from '../../core/tokens.ts';
import { accountExistsMessage, passwordResetMessage, verifyEmailMessage } from './emails.ts';
import { DEPARTMENT_TEMPLATES, ROLE_TEMPLATES, roleTemplate } from './role-templates.ts';

export interface IdentityDeps {
  db: Db;
  config: Config;
  clock: Clock;
  email: EmailProvider;
  logger: Logger;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** PRD M1 rule 5: five failed logins lock the account for 15 minutes. */
export const LOCKOUT = { maxFailures: 5, durationMs: 15 * MINUTE } as const;

export const TOKEN_TTL_MS: Record<AuthTokenPurpose, number> = {
  EMAIL_VERIFY: 24 * HOUR,
  PASSWORD_RESET: HOUR,
};

const SIGN_IN_FAILED =
  'Email, phone or password is incorrect. After 5 failed attempts the account is locked for 15 minutes.';

// ---------------------------------------------------------------------------------------
// Link tokens (email verification, password reset)

/**
 * Issues a fresh single-use token, cancelling earlier unused ones for the same purpose.
 * `ttlMs` overrides the purpose's default (manager-issued reset links last 24 hours).
 */
export async function issueLinkToken(
  db: DbClient,
  deps: Pick<IdentityDeps, 'clock' | 'config'>,
  userId: string,
  purpose: AuthTokenPurpose,
  ttlMs: number = TOKEN_TTL_MS[purpose],
): Promise<string> {
  const now = deps.clock();
  await db.authToken.updateMany({
    where: { userId, purpose, usedAt: null },
    data: { usedAt: now },
  });
  const token = newToken();
  await db.authToken.create({
    data: {
      userId,
      purpose,
      tokenHash: hashToken(deps.config.sessionSecret, token),
      expiresAt: new Date(now.getTime() + ttlMs),
    },
  });
  return token;
}

/** Marks the token used and returns its user id, or throws if unknown, used or expired. */
async function consumeLinkToken(
  db: DbClient,
  deps: IdentityDeps,
  purpose: AuthTokenPurpose,
  token: string,
): Promise<string> {
  const now = deps.clock();
  const tokenHash = hashToken(deps.config.sessionSecret, token);
  const row = await db.authToken.findUnique({ where: { tokenHash } });
  // updateMany with the same conditions makes the check-and-use atomic under concurrency.
  const used =
    row && row.purpose === purpose
      ? await db.authToken.updateMany({
          where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        })
      : { count: 0 };
  if (!row || used.count !== 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      'This link is invalid or has expired. Ask for a new one.',
      {
        reason: 'TOKEN_INVALID',
      },
    );
  }
  return row.userId;
}

export function appLink(deps: Pick<IdentityDeps, 'config'>, path: string, token?: string): string {
  const url = new URL(path, deps.config.appOrigin);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

// ---------------------------------------------------------------------------------------
// Sign-up and email verification (M1-01)

export interface SignUpInput {
  name: string;
  email: string;
  password: string;
  organisationName: string;
  country: SignUpCountry;
  propertyName: string;
}

/** "Demo Lagos Hotel" → "DLH", "Sheraton" → "SHE". Unique per organisation; editable later. */
export function propertyCodeFor(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const code =
    words.length >= 2
      ? words
          .map((w) => w[0])
          .join('')
          .slice(0, 4)
      : (words[0] ?? '').slice(0, 3);
  return code.length >= 2 ? code : 'HTL';
}

/**
 * Creates the owner, organisation, role and department templates, first property and the
 * owner's organisation-wide membership in one transaction, then emails a verification link.
 * An email that already has an account gets a notice instead; the response is the same.
 */
export async function signUp(deps: IdentityDeps, input: SignUpInput): Promise<void> {
  const existing = await deps.db.user.findUnique({ where: { email: input.email } });
  if (existing) {
    await notifyExistingAccount(deps, existing);
    return;
  }

  const passwordHash = await hashPassword(input.password);
  const defaults = SIGN_UP_COUNTRIES[input.country];
  let verifyToken: string;
  try {
    verifyToken = await deps.db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: input.email, name: input.name, passwordHash, status: 'ACTIVE' },
      });
      const organisation = await tx.organisation.create({
        data: { name: input.organisationName, country: input.country },
      });
      const property = await tx.property.create({
        data: {
          organisationId: organisation.id,
          code: propertyCodeFor(input.propertyName),
          name: input.propertyName,
          timeZone: defaults.timeZone,
          baseCurrency: defaults.currency,
          locale: defaults.locale,
          address: { country: input.country },
          email: input.email,
        },
      });
      await tx.department.createMany({
        data: DEPARTMENT_TEMPLATES.map((d) => ({
          organisationId: organisation.id,
          propertyId: property.id,
          ...d,
        })),
      });
      await tx.role.createMany({
        data: ROLE_TEMPLATES.map((r) => ({
          organisationId: organisation.id,
          name: r.name,
          isSystem: true,
          requiresMfa: r.requiresMfa,
          permissions: [...r.permissions],
        })),
      });
      const ownerRole = await tx.role.findUniqueOrThrow({
        where: {
          organisationId_name: {
            organisationId: organisation.id,
            name: roleTemplate('owner').name,
          },
        },
      });
      await tx.membership.create({
        data: {
          userId: user.id,
          organisationId: organisation.id,
          propertyId: null,
          roleId: ownerRole.id,
        },
      });
      await recordAudit(tx, {
        action: 'organisation.created',
        entityType: 'organisation',
        entityId: organisation.id,
        organisationId: organisation.id,
        propertyId: null,
        actorUserId: user.id,
        after: {
          name: organisation.name,
          country: organisation.country,
          property: { id: property.id, name: property.name, code: property.code },
          owner: { id: user.id, name: user.name, email: user.email },
        },
      });
      return issueLinkToken(tx, deps, user.id, 'EMAIL_VERIFY');
    });
  } catch (err) {
    // Two sign-ups racing for one email: the loser behaves like "already registered".
    if (pgErrorInfo(err)?.sqlState === '23505') {
      const winner = await deps.db.user.findUnique({ where: { email: input.email } });
      if (winner) await notifyExistingAccount(deps, winner);
      return;
    }
    throw err;
  }

  await deps.email.send(
    verifyEmailMessage(input.email, input.name, appLink(deps, '/verify-email', verifyToken)),
  );
}

async function notifyExistingAccount(deps: IdentityDeps, user: User): Promise<void> {
  if (!user.email) return;
  if (!user.emailVerifiedAt && user.passwordHash) {
    // An earlier sign-up that was never confirmed: send the confirmation again.
    const token = await issueLinkToken(deps.db, deps, user.id, 'EMAIL_VERIFY');
    await deps.email.send(
      verifyEmailMessage(user.email, user.name, appLink(deps, '/verify-email', token)),
    );
    return;
  }
  await deps.email.send(
    accountExistsMessage(user.email, appLink(deps, '/sign-in'), appLink(deps, '/forgot-password')),
  );
}

export async function verifyEmail(deps: IdentityDeps, token: string): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    const userId = await consumeLinkToken(tx, deps, 'EMAIL_VERIFY', token);
    const verified = await tx.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: deps.clock() },
    });
    if (verified.count > 0) {
      await recordUserEvent(tx, userId, { action: 'user.email_verified', actorUserId: userId });
    }
  });
}

/** Always succeeds from the caller's view; sends only to unverified accounts. */
export async function resendVerification(deps: IdentityDeps, email: string): Promise<void> {
  const user = await deps.db.user.findUnique({ where: { email } });
  if (!user?.email || user.emailVerifiedAt || user.status !== 'ACTIVE') return;
  const token = await issueLinkToken(deps.db, deps, user.id, 'EMAIL_VERIFY');
  await deps.email.send(
    verifyEmailMessage(user.email, user.name, appLink(deps, '/verify-email', token)),
  );
}

// ---------------------------------------------------------------------------------------
// Sign-in (M1-06) with lockout

export interface SignInInput {
  login: string;
  password: string;
  sharedDevice: boolean;
  deviceLabel?: string | undefined;
}

export interface ClientInfo {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

const E164 = /^\+[1-9]\d{6,14}$/;

/** Email (any case) or E.164 phone. */
export function findByLogin(db: Db, login: string): Promise<User | null> {
  const value = login.trim();
  if (value.includes('@')) return db.user.findUnique({ where: { email: value.toLowerCase() } });
  if (E164.test(value)) return db.user.findUnique({ where: { phone: value } });
  return Promise.resolve(null);
}

export function isLocked(user: User, now: Date): boolean {
  return user.lockedUntil !== null && user.lockedUntil > now;
}

/**
 * Counts a wrong password, PIN or MFA code; the fifth locks the account for 15 minutes.
 * Returns true when this failure locked it.
 */
export async function recordFailure(deps: IdentityDeps, userId: string): Promise<boolean> {
  // Atomic increment, so parallel guesses can't slip past the limit.
  const rows = await deps.db.$queryRaw<{ failed_logins: number }[]>`
    UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ${userId}::uuid
    RETURNING failed_logins`;
  if ((rows[0]?.failed_logins ?? 0) < LOCKOUT.maxFailures) return false;
  const lockedUntil = new Date(deps.clock().getTime() + LOCKOUT.durationMs);
  await deps.db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { failedLogins: 0, lockedUntil } });
    await recordUserEvent(tx, userId, {
      action: 'auth.locked',
      actorType: 'SYSTEM',
      actorUserId: null,
      after: { lockedUntil, failedAttempts: LOCKOUT.maxFailures },
    });
  });
  return true;
}

/** Every permission code the user holds through active memberships, in any property. */
export async function allPermissions(db: Db, userId: string): Promise<Set<string>> {
  const memberships = await db.membership.findMany({
    where: { userId, active: true },
    include: { role: true },
  });
  return new Set(memberships.flatMap((m) => m.role.permissions));
}

/** M1-06: MFA is mandatory once enabled, or when any of the user's roles requires it. */
export async function mfaRequiredFor(db: Db, user: User): Promise<boolean> {
  if (user.mfaEnabled) return true;
  const count = await db.membership.count({
    where: { userId: user.id, active: true, role: { requiresMfa: true } },
  });
  return count > 0;
}

/** M1-07: only managers may open a shared device that others PIN into. */
export const DEVICE_PERMISSION = 'device.manage';

export async function signIn(
  deps: IdentityDeps,
  input: SignInInput,
  client: ClientInfo,
): Promise<{ user: User; session: Session; token: string; opensDevice: boolean }> {
  const now = deps.clock();
  const user = await findByLogin(deps.db, input.login);
  const usable = user?.passwordHash && user.status === 'ACTIVE' && !isLocked(user, now);
  if (!user?.passwordHash || !usable) {
    await burnPasswordCheck(input.password);
    throw new AppError('UNAUTHENTICATED', SIGN_IN_FAILED);
  }

  const { ok, needsRehash } = await verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    await recordFailure(deps, user.id);
    throw new AppError('UNAUTHENTICATED', SIGN_IN_FAILED);
  }
  // Only after a correct password, so this never reveals that an address is registered.
  if (user.email && !user.emailVerifiedAt) {
    throw new AppError(
      'FORBIDDEN',
      'Confirm your email address first. We can send the link again.',
      {
        reason: 'EMAIL_NOT_VERIFIED',
      },
    );
  }

  const updated = await deps.db.user.update({
    where: { id: user.id },
    data: {
      failedLogins: 0,
      lockedUntil: null,
      lastLoginAt: now,
      ...(needsRehash ? { passwordHash: await hashPassword(input.password) } : {}),
    },
  });
  // MFA is checked at every sign-in, so a role that starts requiring it applies from the next
  // sign-in (M1 acceptance). Until the code is entered the session can only reach MFA routes.
  const mfaRequired = await mfaRequiredFor(deps.db, updated);
  const { session, token } = await createSession(deps, {
    userId: user.id,
    sharedDevice: input.sharedDevice,
    mfaPassed: !mfaRequired,
    deviceLabel: input.deviceLabel,
    ip: client.ip,
    userAgent: client.userAgent,
  });
  // Security events are written right after the session they describe (not in its
  // transaction): createSession owns its own write.
  await recordUserEvent(deps.db, user.id, {
    action: 'auth.signed_in',
    entityType: 'session',
    entityId: session.id,
    after: { method: 'PASSWORD', sharedDevice: input.sharedDevice, mfaPending: mfaRequired },
  });
  const opensDevice =
    input.sharedDevice && (await allPermissions(deps.db, user.id)).has(DEVICE_PERMISSION);
  return { user: updated, session, token, opensDevice };
}

// ---------------------------------------------------------------------------------------
// Password reset

/** Always succeeds from the caller's view; sends only to active accounts with that email. */
export async function requestPasswordReset(deps: IdentityDeps, email: string): Promise<void> {
  const user = await deps.db.user.findUnique({ where: { email } });
  if (!user?.email || user.status !== 'ACTIVE') return;
  const token = await issueLinkToken(deps.db, deps, user.id, 'PASSWORD_RESET');
  await deps.email.send(
    passwordResetMessage(user.email, user.name, appLink(deps, '/reset-password', token)),
  );
}

/**
 * Sets the new password, ends every session of the user, clears any lockout, and counts as
 * proof of the email address (the link went there).
 */
export async function resetPassword(
  deps: IdentityDeps,
  token: string,
  password: string,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  const now = deps.clock();
  await deps.db.$transaction(async (tx) => {
    const userId = await consumeLinkToken(tx, deps, 'PASSWORD_RESET', token);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        failedLogins: 0,
        lockedUntil: null,
        ...(user.email && !user.emailVerifiedAt ? { emailVerifiedAt: now } : {}),
      },
    });
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await recordUserEvent(tx, userId, { action: 'auth.password_reset', actorUserId: userId });
  });
}

// ---------------------------------------------------------------------------------------
// Me and my sessions

/** GET /me and the answer to sign-in, MFA and PIN switch. */
export async function buildMe(
  db: Db,
  user: User,
  session: Session,
  options: { pinSwitchAvailable: boolean },
) {
  const memberships = await db.membership.findMany({
    where: { userId: user.id, active: true },
    include: { role: true, organisation: true },
    orderBy: { createdAt: 'asc' },
  });
  const orgWide = memberships.filter((m) => m.propertyId === null).map((m) => m.organisationId);
  const propertyIds = memberships.flatMap((m) => (m.propertyId ? [m.propertyId] : []));
  const properties = await db.property.findMany({
    where: {
      status: { not: 'ARCHIVED' },
      OR: [{ id: { in: propertyIds } }, { organisationId: { in: orgWide } }],
    },
    orderBy: { name: 'asc' },
  });
  const organisations = new Map(memberships.map((m) => [m.organisation.id, m.organisation]));

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      mfaEnabled: user.mfaEnabled,
    },
    session: {
      id: session.id,
      sharedDevice: session.sharedDevice,
      mfaPassed: session.mfaPassed,
      pinSwitchAvailable: options.pinSwitchAvailable,
      expiresAt: session.expiresAt.toISOString(),
    },
    organisations: [...organisations.values()].map((o) => ({ id: o.id, name: o.name })),
    properties: properties.map((p) => ({
      id: p.id,
      organisationId: p.organisationId,
      code: p.code,
      name: p.name,
      status: p.status,
      timeZone: p.timeZone,
      baseCurrency: p.baseCurrency,
      locale: p.locale,
    })),
    memberships: memberships.map((m) => ({
      organisationId: m.organisationId,
      propertyId: m.propertyId,
      role: {
        id: m.role.id,
        name: m.role.name,
        requiresMfa: m.role.requiresMfa,
        permissions: m.role.permissions,
      },
    })),
  };
}

export async function listMySessions(deps: IdentityDeps, auth: AuthContext) {
  const now = deps.clock();
  const rows = await deps.db.session.findMany({
    where: { userId: auth.user.id, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { lastSeenAt: 'desc' },
  });
  return rows
    .filter((s) => !isSessionOver(s, now))
    .map((s) => ({
      id: s.id,
      current: s.id === auth.session.id,
      sharedDevice: s.sharedDevice,
      deviceLabel: s.deviceLabel,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
    }));
}

/** Another user's session id answers NOT_FOUND, never FORBIDDEN. */
export async function revokeMySession(
  deps: IdentityDeps,
  auth: AuthContext,
  sessionId: string,
): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    const result = await tx.session.updateMany({
      where: { id: sessionId, userId: auth.user.id, revokedAt: null },
      data: { revokedAt: deps.clock() },
    });
    if (result.count === 0) throw new AppError('NOT_FOUND', 'Session not found.');
    await recordUserEvent(tx, auth.user.id, {
      action: 'session.revoked',
      entityType: 'session',
      entityId: sessionId,
      actorUserId: auth.user.id,
    });
  });
}
