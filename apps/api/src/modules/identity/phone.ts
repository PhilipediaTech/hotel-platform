import { randomInt, timingSafeEqual } from 'node:crypto';
import { DEFAULT_MESSAGE_LANGUAGE, messageTemplateDef } from '@hotel/shared';
import { revokeSessionTree, type AuthContext } from '../../core/auth.ts';
import { recordUserEvent } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { MessageSendError, type MessageProvider } from '../../core/messaging.ts';
import { verifyPassword } from '../../core/passwords.ts';
import { hashToken } from '../../core/tokens.ts';
import { recordFailure, type IdentityDeps } from './service.ts';

// My phone (T-091b). Codes, instant alerts and the flash report reach staff by WhatsApp
// (T-024, T-091), and phone-only staff sign in with their number, so a change needs the
// current password and a code sent by WhatsApp to the new number. Stateless: the challenge
// is the user, the number and the expiry signed together with the code, so nothing is stored
// until the code comes back; the code itself is never stored or logged.

export interface PhoneDeps extends IdentityDeps {
  messages: MessageProvider;
}

export const PHONE_CODE_MINUTES = 10;
export const PHONE_CODES_PER_HOUR = 5;
const PURPOSE = 'phone_verify';

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function signature(secret: string, userId: string, phone: string, expires: number, code: string) {
  return hashToken(secret, `${PURPOSE}|${userId}|${phone}|${expires}|${code}`);
}

const WRONG_PASSWORD = 'The password is incorrect.';
const TAKEN = 'This number belongs to another account.';

async function lockoutFailure(deps: PhoneDeps, auth: AuthContext, message: string, field: string) {
  if (await recordFailure(deps, auth.user.id)) {
    await revokeSessionTree(deps.db, auth.session.id, deps.clock());
    throw new AppError(
      'UNAUTHENTICATED',
      'Too many wrong attempts. The account is locked for 15 minutes.',
    );
  }
  throw new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${field}`, code: 'custom', message }],
  });
}

async function checkFree(deps: PhoneDeps, userId: string, phone: string): Promise<void> {
  const holder = await deps.db.user.findUnique({ where: { phone }, select: { id: true } });
  if (holder && holder.id !== userId) {
    throw new AppError('VALIDATION_ERROR', TAKEN, {
      issues: [{ path: 'body.phone', code: 'custom', message: TAKEN }],
    });
  }
}

/** POST /me/phone: checks the password, sends a code to the new number, returns a challenge. */
export async function requestPhoneChange(
  deps: PhoneDeps,
  auth: AuthContext,
  input: { phone: string; password: string },
): Promise<{ challenge: string; expiresAt: string }> {
  const user = await deps.db.user.findUniqueOrThrow({ where: { id: auth.user.id } });
  const ok = user.passwordHash
    ? (await verifyPassword(input.password, user.passwordHash)).ok
    : false;
  if (!ok) await lockoutFailure(deps, auth, WRONG_PASSWORD, 'password');
  if (user.phone === input.phone) {
    throw new AppError('VALIDATION_ERROR', 'This is already your number.', {
      issues: [{ path: 'body.phone', code: 'custom', message: 'This is already your number.' }],
    });
  }
  await checkFree(deps, user.id, input.phone);

  const now = deps.clock();
  const sentThisHour = await deps.db.notificationDelivery.count({
    where: {
      templateCode: 'APPROVAL_OTP',
      createdAt: { gte: new Date(now.getTime() - 3_600_000) },
      AND: [
        { payload: { path: ['purpose'], equals: PURPOSE } },
        { payload: { path: ['userId'], equals: user.id } },
      ],
    },
  });
  if (sentThisHour >= PHONE_CODES_PER_HOUR) {
    throw new AppError('RATE_LIMITED', 'Too many codes this hour: try again later.');
  }

  const wa = messageTemplateDef('APPROVAL_OTP')?.whatsapp;
  if (!wa) throw new Error('APPROVAL_OTP has no WhatsApp template');
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const expires = now.getTime() + PHONE_CODE_MINUTES * 60_000;
  const row = await deps.db.notificationDelivery.create({
    data: {
      propertyId: null,
      channel: 'WHATSAPP',
      templateCode: 'APPROVAL_OTP',
      recipient: input.phone,
      payload: { purpose: PURPOSE, userId: user.id },
      attempts: 1,
    },
    select: { id: true },
  });
  try {
    const { providerRef } = await deps.messages.sendTemplate({
      to: input.phone,
      templateName: wa.name,
      language: DEFAULT_MESSAGE_LANGUAGE,
      category: wa.category,
      params: [code],
    });
    await deps.db.notificationDelivery.update({
      where: { id: row.id },
      data: { status: 'SENT', providerRef, sentAt: now },
    });
  } catch (err) {
    const known = err instanceof MessageSendError;
    await deps.db.notificationDelivery.update({
      where: { id: row.id },
      data: { status: 'FAILED', lastError: known ? err.message : 'Unexpected error while sending' },
    });
    if (known && err.permanent) {
      const message = 'WhatsApp could not deliver a code to this number. Check it and try again.';
      throw new AppError('VALIDATION_ERROR', message, {
        issues: [{ path: 'body.phone', code: 'custom', message }],
      });
    }
    throw new AppError('MESSAGE_PROVIDER_UNAVAILABLE', 'WhatsApp is not answering: try again.');
  }

  const claim = Buffer.from(JSON.stringify({ u: user.id, p: input.phone, e: expires })).toString(
    'base64url',
  );
  const sig = signature(deps.config.sessionSecret, user.id, input.phone, expires, code);
  return { challenge: `${claim}.${sig}`, expiresAt: iso(new Date(expires)) };
}

function readChallenge(challenge: string): { u: string; p: string; e: number; sig: string } | null {
  const [claim, sig] = challenge.split('.');
  if (!claim || !sig) return null;
  try {
    const c = JSON.parse(Buffer.from(claim, 'base64url').toString()) as Record<string, unknown>;
    if (typeof c['u'] !== 'string' || typeof c['p'] !== 'string' || typeof c['e'] !== 'number') {
      return null;
    }
    return { u: c['u'], p: c['p'], e: c['e'], sig };
  } catch {
    return null;
  }
}

/** POST /me/phone/confirm: the code from WhatsApp sets the number. */
export async function confirmPhoneChange(
  deps: PhoneDeps,
  auth: AuthContext,
  input: { challenge: string; code: string },
): Promise<{ phone: string }> {
  const c = readChallenge(input.challenge);
  const expired = 'The code has expired: ask for a new one.';
  if (!c || c.u !== auth.user.id) {
    throw new AppError('VALIDATION_ERROR', expired, {
      issues: [{ path: 'body.code', code: 'custom', message: expired }],
    });
  }
  const expected = Buffer.from(signature(deps.config.sessionSecret, c.u, c.p, c.e, input.code));
  const given = Buffer.from(c.sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    await lockoutFailure(deps, auth, 'The code is wrong.', 'code');
  }
  if (c.e <= deps.clock().getTime()) {
    throw new AppError('VALIDATION_ERROR', expired, {
      issues: [{ path: 'body.code', code: 'custom', message: expired }],
    });
  }
  await checkFree(deps, auth.user.id, c.p);
  const before = await deps.db.user.findUniqueOrThrow({
    where: { id: auth.user.id },
    select: { phone: true },
  });
  const last4 = (p: string | null) => (p ? `…${p.slice(-4)}` : null);
  try {
    await deps.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: auth.user.id },
        data: { phone: c.p, failedLogins: 0 },
      });
      await recordUserEvent(tx, auth.user.id, {
        action: 'user.phone_changed',
        before: { phone: last4(before.phone) },
        after: { phone: last4(c.p) },
      });
    });
  } catch (err) {
    // Someone took the number between the check and the update (unique index).
    if ((err as { code?: string }).code === 'P2002') {
      throw new AppError('VALIDATION_ERROR', TAKEN, {
        issues: [{ path: 'body.code', code: 'custom', message: TAKEN }],
      });
    }
    throw err;
  }
  return { phone: c.p };
}
