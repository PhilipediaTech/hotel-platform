import type { Session, User } from '../../generated/prisma/client.ts';
import { createSession, revokeSessionTree, type AuthContext } from '../../core/auth.ts';
import { AppError } from '../../core/errors.ts';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../core/passwords.ts';
import {
  allPermissions,
  DEVICE_PERMISSION,
  findByLogin,
  isLocked,
  mfaRequiredFor,
  recordFailure,
  type ClientInfo,
  type IdentityDeps,
} from './service.ts';

// PIN switch on shared devices (PRD M1-07, T-011). A manager signs the tablet in with
// "shared device"; staff then switch in with email/phone and a 6-digit PIN.

const PIN_FAILED =
  'Email, phone or PIN is incorrect. After 5 failed attempts the account is locked for 15 minutes.';

/** PUT /me/pin: needs the current password, which counts towards the lockout when wrong. */
export async function setMyPin(
  deps: IdentityDeps,
  auth: AuthContext,
  input: { pin: string; password: string },
): Promise<void> {
  const user = await deps.db.user.findUniqueOrThrow({ where: { id: auth.user.id } });
  const ok = user.passwordHash
    ? (await verifyPassword(input.password, user.passwordHash)).ok
    : false;
  if (!ok) {
    if (await recordFailure(deps, user.id)) {
      await revokeSessionTree(deps.db, auth.session.id, deps.clock());
      throw new AppError(
        'UNAUTHENTICATED',
        'Too many wrong passwords. The account is locked for 15 minutes.',
      );
    }
    throw new AppError('VALIDATION_ERROR', 'The password is incorrect.', {
      issues: [{ path: 'body.password', code: 'custom', message: 'The password is incorrect.' }],
    });
  }
  await deps.db.user.update({
    where: { id: user.id },
    data: { pinHash: await hashPassword(input.pin), failedLogins: 0 },
  });
}

/** A device session still counts while its user may manage devices. */
export async function deviceAllowed(deps: IdentityDeps, device: Session): Promise<boolean> {
  return (await allPermissions(deps.db, device.userId)).has(DEVICE_PERMISSION);
}

async function sharesOrganisation(deps: IdentityDeps, a: string, b: string): Promise<boolean> {
  const orgsOf = async (userId: string) =>
    new Set(
      (
        await deps.db.membership.findMany({
          where: { userId, active: true },
          select: { organisationId: true },
        })
      ).map((m) => m.organisationId),
    );
  const [first, second] = await Promise.all([orgsOf(a), orgsOf(b)]);
  return [...first].some((org) => second.has(org));
}

/**
 * POST /auth/pin: a session for the PIN user under the device session. Unknown logins,
 * other organisations' staff, missing PINs and locked accounts all get the same answer.
 */
export async function pinSwitch(
  deps: IdentityDeps,
  device: Session,
  input: { login: string; pin: string },
  client: ClientInfo,
): Promise<{ user: User; session: Session; token: string }> {
  const now = deps.clock();
  const user = await findByLogin(deps.db, input.login);
  const usable =
    user?.pinHash &&
    user.status === 'ACTIVE' &&
    !isLocked(user, now) &&
    (await sharesOrganisation(deps, user.id, device.userId));
  if (!user?.pinHash || !usable) {
    await burnPasswordCheck(input.pin);
    throw new AppError('UNAUTHENTICATED', PIN_FAILED);
  }

  if (!(await verifyPassword(input.pin, user.pinHash)).ok) {
    await recordFailure(deps, user.id);
    throw new AppError('UNAUTHENTICATED', PIN_FAILED);
  }
  // A PIN is a weaker secret than password + authenticator: MFA users can't use it.
  if (await mfaRequiredFor(deps.db, user)) {
    throw new AppError(
      'FORBIDDEN',
      'Your role needs two-step sign-in: sign in with your password.',
      {
        reason: 'MFA_USERS_SIGN_IN_WITH_PASSWORD',
      },
    );
  }
  if (user.email && !user.emailVerifiedAt) {
    throw new AppError('FORBIDDEN', 'Confirm your email address first.', {
      reason: 'EMAIL_NOT_VERIFIED',
    });
  }

  const updated = await deps.db.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now },
  });
  const { session, token } = await createSession(deps, {
    userId: user.id,
    // Shared-device behaviour comes from the parent; the CHECK keeps PIN sessions non-shared.
    sharedDevice: false,
    mfaPassed: true,
    parent: device,
    ip: client.ip,
    userAgent: client.userAgent,
  });
  return { user: updated, session, token };
}
