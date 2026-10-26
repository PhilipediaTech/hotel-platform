import type { Session, User } from '../../generated/prisma/client.ts';
import { revokeSessionTree, rotateSession, type AuthContext } from '../../core/auth.ts';
import { recordUserEvent } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import {
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  totpUri,
  verifyTotp,
} from '../../core/mfa.ts';
import { isLocked, recordFailure, type IdentityDeps } from './service.ts';

// TOTP MFA (PRD M1-06, T-011): enrol → confirm (turns it on, gives recovery codes) → verify
// at each sign-in. Wrong codes count towards the sign-in lockout.

const LOCKED_MESSAGE =
  'Too many wrong codes. The account is locked for 15 minutes; sign in again after that.';

function codeRejected(field: 'code' | 'recoveryCode'): AppError {
  return new AppError('VALIDATION_ERROR', 'That code is not right.', {
    reason: 'MFA_CODE_INVALID',
    issues: [
      {
        path: `body.${field}`,
        code: 'custom',
        message: 'That code is not right. Try the newest one.',
      },
    ],
  });
}

async function freshUser(deps: IdentityDeps, auth: AuthContext): Promise<User> {
  return deps.db.user.findUniqueOrThrow({ where: { id: auth.user.id } });
}

/** Starts (or restarts) set-up: a new secret, stored encrypted, not active until confirmed. */
export async function enrolMfa(deps: IdentityDeps, auth: AuthContext) {
  const user = await freshUser(deps, auth);
  if (user.mfaEnabled) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'Two-step sign-in is already on for this account.',
    );
  }
  const secret = newTotpSecret();
  await deps.db.user.update({
    where: { id: user.id },
    data: { mfaSecretEnc: encryptSecret(deps.config.mfaKey, secret), mfaLastUsedStep: null },
  });
  return { secret, otpauthUri: totpUri(secret, user.email ?? user.phone ?? user.name) };
}

/**
 * Proves the app is set up: turns MFA on, passes it for this session (new token) and returns
 * recovery codes, which exist only in this response.
 */
export async function confirmMfa(
  deps: IdentityDeps,
  auth: AuthContext,
  code: string,
): Promise<{ recoveryCodes: string[]; session: Session; token: string }> {
  const user = await freshUser(deps, auth);
  if (user.mfaEnabled) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'Two-step sign-in is already on for this account.',
    );
  }
  if (!user.mfaSecretEnc) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Start two-step sign-in set-up first.');
  }
  const result = await verifyTotp(
    decryptSecret(deps.config.mfaKey, user.mfaSecretEnc),
    code,
    deps.clock(),
    null,
  );
  // A typo during set-up isn't an attack on the account: not counted towards the lockout.
  if (!result.ok) throw codeRejected('code');

  const recoveryCodes = newRecoveryCodes();
  await deps.db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { mfaEnabled: true, mfaLastUsedStep: result.step },
    });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.mfaRecoveryCode.createMany({
      data: recoveryCodes.map((c) => ({
        userId: user.id,
        codeHash: hashRecoveryCode(deps.config.sessionSecret, c),
      })),
    });
    await recordUserEvent(tx, user.id, {
      action: 'user.mfa_enabled',
      before: { mfaEnabled: false },
      after: { mfaEnabled: true },
    });
  });
  const { session, token } = await rotateSession(deps, auth.session, { mfaPassed: true });
  return { recoveryCodes, session, token };
}

/** Accepts the code only for a time step after the last accepted one (atomic). */
async function acceptTotp(deps: IdentityDeps, user: User, code: string): Promise<boolean> {
  if (!user.mfaSecretEnc) return false;
  const secret = decryptSecret(deps.config.mfaKey, user.mfaSecretEnc);
  const result = await verifyTotp(secret, code, deps.clock(), user.mfaLastUsedStep);
  if (!result.ok) return false;
  const claimed = await deps.db.user.updateMany({
    where: {
      id: user.id,
      OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: result.step } }],
    },
    data: { mfaLastUsedStep: result.step },
  });
  return claimed.count === 1;
}

async function acceptRecoveryCode(deps: IdentityDeps, user: User, code: string): Promise<boolean> {
  const used = await deps.db.mfaRecoveryCode.updateMany({
    where: {
      userId: user.id,
      codeHash: hashRecoveryCode(deps.config.sessionSecret, code),
      usedAt: null,
    },
    data: { usedAt: deps.clock() },
  });
  return used.count === 1;
}

/** Passes MFA for the session (new token). Wrong codes count; the fifth locks the account. */
export async function verifyMfa(
  deps: IdentityDeps,
  auth: AuthContext,
  body: { code: string } | { recoveryCode: string },
): Promise<{ user: User; session: Session; token: string }> {
  const now = deps.clock();
  const user = await freshUser(deps, auth);
  if (!user.mfaEnabled) {
    throw new AppError('STATE_TRANSITION_INVALID', 'Set up two-step sign-in first.');
  }
  if (isLocked(user, now)) {
    await revokeSessionTree(deps.db, auth.session.id, now);
    throw new AppError('UNAUTHENTICATED', LOCKED_MESSAGE);
  }

  const ok =
    'code' in body
      ? await acceptTotp(deps, user, body.code)
      : await acceptRecoveryCode(deps, user, body.recoveryCode);
  if (!ok) {
    if (await recordFailure(deps, user.id)) {
      await revokeSessionTree(deps.db, auth.session.id, now);
      throw new AppError('UNAUTHENTICATED', LOCKED_MESSAGE);
    }
    throw codeRejected('code' in body ? 'code' : 'recoveryCode');
  }

  const updated = await deps.db.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null },
  });
  const { session, token } = await rotateSession(deps, auth.session, { mfaPassed: true });
  await recordUserEvent(deps.db, user.id, {
    action: 'auth.mfa_passed',
    entityType: 'session',
    entityId: session.id,
    after: { method: 'code' in body ? 'TOTP' : 'RECOVERY_CODE' },
  });
  return { user: updated, session, token };
}
