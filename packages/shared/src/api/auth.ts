import { z } from 'zod';
import { SIGN_UP_COUNTRY_CODES } from '../countries.ts';
import { defineRoute } from './contract.ts';
import { Instant, Uuid } from './primitives.ts';

// Auth and "me" endpoints (tab 4 rows Auth and Me; PRD M1-01, M1-06). MFA, PIN switch and
// MFA enrolment arrive with T-011.

/** Length rules only (NIST 800-63B): long passphrases beat composition rules. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export const Password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

/** Emails are stored lower-case (a CHECK in the database enforces it). */
export const Email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((v) => v.toLowerCase());

/** E.164, e.g. +2348012345678. */
export const Phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +2348012345678');

/** Single-use token from an email link. */
const LinkToken = z.string().min(20).max(200);

const AcceptedResponse = z.object({ accepted: z.literal(true) }).meta({
  id: 'Accepted',
  description: 'Sent if the account exists and qualifies; never says which.',
});

export const SignUpBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: Email,
  password: Password,
  organisationName: z.string().trim().min(1).max(120),
  country: z.enum(SIGN_UP_COUNTRY_CODES),
  propertyName: z.string().trim().min(1).max(120),
});

export const signUp = defineRoute({
  operationId: 'signUp',
  method: 'post',
  path: '/auth/sign-up',
  summary: 'Create an owner account, organisation and first property',
  description:
    'Creates the owner, their organisation (with role templates) and first property in SETUP, then emails a verification link. Answers the same way when the email is already registered, so it never reveals which addresses have accounts.',
  tags: ['Auth'],
  auth: 'none',
  body: SignUpBody,
  status: 201,
  response: z.object({ verificationSent: z.literal(true) }),
});

export const verifyEmail = defineRoute({
  operationId: 'verifyEmail',
  method: 'post',
  path: '/auth/email/verify',
  summary: 'Confirm an email address with the link token',
  tags: ['Auth'],
  auth: 'none',
  body: z.object({ token: LinkToken }),
  status: 204,
  response: z.void(),
});

export const resendVerification = defineRoute({
  operationId: 'resendVerification',
  method: 'post',
  path: '/auth/email/resend',
  summary: 'Send a new verification link',
  tags: ['Auth'],
  auth: 'none',
  body: z.object({ email: Email }),
  status: 202,
  response: AcceptedResponse,
});

const MeUser = z.object({
  id: Uuid,
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  mfaEnabled: z.boolean(),
});

const MeProperty = z.object({
  id: Uuid,
  organisationId: Uuid,
  code: z.string(),
  name: z.string(),
  status: z.enum(['SETUP', 'LIVE', 'SUSPENDED', 'ARCHIVED']),
  timeZone: z.string(),
  baseCurrency: z.string(),
  locale: z.string(),
});

const MeMembership = z.object({
  organisationId: Uuid,
  /** null = the role applies to every property of the organisation. */
  propertyId: Uuid.nullable(),
  role: z.object({
    id: Uuid,
    name: z.string(),
    requiresMfa: z.boolean(),
    permissions: z.array(z.string()),
  }),
});

export const Me = z
  .object({
    user: MeUser,
    session: z.object({
      id: Uuid,
      sharedDevice: z.boolean(),
      /** False until the user enters an MFA code, when their roles require MFA. */
      mfaPassed: z.boolean(),
      /** This browser is a manager-opened shared device: staff can switch in with a PIN. */
      pinSwitchAvailable: z.boolean(),
      expiresAt: Instant,
    }),
    organisations: z.array(z.object({ id: Uuid, name: z.string() })),
    /** Every property the user can open, through property or organisation-wide roles. */
    properties: z.array(MeProperty),
    memberships: z.array(MeMembership),
  })
  .meta({ id: 'Me', description: 'The signed-in user, their session and what they can access.' });

export const SignInBody = z.object({
  login: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  /** Shared tablets get a 30-minute idle timeout instead of 12 hours. */
  sharedDevice: z.boolean().default(false),
  deviceLabel: z.string().trim().max(80).optional(),
});

export const signIn = defineRoute({
  operationId: 'signIn',
  method: 'post',
  path: '/auth/sign-in',
  summary: 'Sign in with email or phone and password',
  description:
    'Sets the `sid` cookie. Five wrong passwords lock the account for 15 minutes; while locked, even the right password is refused with the same message. An unverified email gives 403 with `details.reason = EMAIL_NOT_VERIFIED` (only after a correct password).',
  tags: ['Auth'],
  auth: 'none',
  body: SignInBody,
  response: Me,
  errors: ['UNAUTHENTICATED', 'FORBIDDEN'],
});

export const signOut = defineRoute({
  operationId: 'signOut',
  method: 'post',
  path: '/auth/sign-out',
  summary: 'End the current session',
  description:
    'On a shared device only this session ends and the device waits for the next PIN, except when the manager who opened the device signs out without `keepDevice`: that closes the device and every session on it. "Switch user" sends `keepDevice: true`.',
  tags: ['Auth'],
  auth: 'none',
  body: z.object({ keepDevice: z.boolean().default(false) }).default({ keepDevice: false }),
  status: 204,
  response: z.void(),
});

export const requestPasswordReset = defineRoute({
  operationId: 'requestPasswordReset',
  method: 'post',
  path: '/auth/password/reset-request',
  summary: 'Email a password reset link',
  tags: ['Auth'],
  auth: 'none',
  body: z.object({ email: Email }),
  status: 202,
  response: AcceptedResponse,
});

export const resetPassword = defineRoute({
  operationId: 'resetPassword',
  method: 'post',
  path: '/auth/password/reset',
  summary: 'Set a new password with the link token',
  description: 'Signs out every session of the user and clears any lockout.',
  tags: ['Auth'],
  auth: 'none',
  body: z.object({ token: LinkToken, password: Password }),
  status: 204,
  response: z.void(),
});

export const getMe = defineRoute({
  operationId: 'getMe',
  method: 'get',
  path: '/me',
  summary: 'The signed-in user',
  description: 'Also answers before MFA is passed, so the app can show the MFA step.',
  tags: ['Me'],
  allowPendingMfa: true,
  response: Me,
});

const MySession = z.object({
  id: Uuid,
  current: z.boolean(),
  sharedDevice: z.boolean(),
  deviceLabel: z.string().nullable(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: Instant,
  lastSeenAt: Instant,
});

export const listMySessions = defineRoute({
  operationId: 'listMySessions',
  method: 'get',
  path: '/me/sessions',
  summary: 'My active sessions and devices',
  tags: ['Me'],
  response: z.object({ data: z.array(MySession) }),
});

export const revokeMySession = defineRoute({
  operationId: 'revokeMySession',
  method: 'delete',
  path: '/me/sessions/{sessionId}',
  summary: 'Sign out one of my sessions',
  tags: ['Me'],
  params: z.object({ sessionId: Uuid }),
  status: 204,
  response: z.void(),
});

// ---------------------------------------------------------------------------------------
// MFA (M1-06) and PIN switch on shared devices (M1-07), T-011

const SIX_DIGITS = /^\d{6}$/;

const TotpCode = z.string().regex(SIX_DIGITS, 'Enter the 6-digit code');

export const MfaVerifyBody = z.union([
  z.object({ code: TotpCode }),
  z.object({ recoveryCode: z.string().trim().min(8).max(20) }),
]);

export const verifyMfa = defineRoute({
  operationId: 'verifyMfa',
  method: 'post',
  path: '/auth/mfa/verify',
  summary: 'Pass MFA for this session with an authenticator or recovery code',
  description:
    'Rotates the session cookie. A wrong code counts towards the sign-in lockout (5 failures, 15 minutes). A code is never accepted twice; a recovery code works once.',
  tags: ['Auth'],
  allowPendingMfa: true,
  body: MfaVerifyBody,
  response: Me,
  errors: ['UNAUTHENTICATED'],
});

export const enrolMfa = defineRoute({
  operationId: 'enrolMfa',
  method: 'post',
  path: '/me/mfa/enrol',
  summary: 'Start turning on MFA: a new secret for the authenticator app',
  description:
    'Returns the secret and an otpauth:// link for the QR code. MFA is on only after /me/mfa/confirm.',
  tags: ['Me'],
  allowPendingMfa: true,
  status: 201,
  response: z.object({ secret: z.string(), otpauthUri: z.string() }),
  errors: ['STATE_TRANSITION_INVALID'],
});

export const confirmMfa = defineRoute({
  operationId: 'confirmMfa',
  method: 'post',
  path: '/me/mfa/confirm',
  summary: 'Finish turning on MFA with a code from the app',
  description:
    'Turns MFA on, passes it for this session (rotating the cookie) and returns 10 single-use recovery codes. They are shown only this once.',
  tags: ['Me'],
  allowPendingMfa: true,
  body: z.object({ code: TotpCode }),
  response: z.object({ recoveryCodes: z.array(z.string()) }),
  errors: ['STATE_TRANSITION_INVALID'],
});

/** 6 digits, not all the same, not a straight run like 123456 or 987654. */
export const Pin = z
  .string()
  .regex(SIX_DIGITS, 'Use exactly 6 digits')
  .refine(
    (pin) => !isWeakPin(pin),
    'Too easy to guess: avoid repeated digits and runs like 123456',
  );

export function isWeakPin(pin: string): boolean {
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - (digits[i] ?? 0)));
  return steps.size === 1 && [0, 1, -1].includes([...steps][0] ?? 2);
}

export const setMyPin = defineRoute({
  operationId: 'setMyPin',
  method: 'put',
  path: '/me/pin',
  summary: 'Set or change my PIN for shared devices',
  description: 'Needs the current password. A wrong password counts towards the sign-in lockout.',
  tags: ['Me'],
  body: z.object({ pin: Pin, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) }),
  status: 204,
  response: z.void(),
  errors: ['UNAUTHENTICATED'],
});

export const getDevice = defineRoute({
  operationId: 'getDevice',
  method: 'get',
  path: '/auth/device',
  summary: 'Whether this browser is a shared device staff can PIN into',
  tags: ['Auth'],
  auth: 'none',
  response: z.object({ pinSwitchAvailable: z.boolean(), deviceLabel: z.string().nullable() }),
});

export const PinSwitchBody = z.object({
  login: z.string().trim().min(3).max(254),
  pin: z.string().regex(SIX_DIGITS, 'Use exactly 6 digits'),
});

export const pinSwitch = defineRoute({
  operationId: 'pinSwitch',
  method: 'post',
  path: '/auth/pin',
  summary: 'Switch user on a shared device with email or phone and PIN',
  description:
    'Needs the device cookie from a manager’s shared-device sign-in. Creates a session under the device session (30-minute idle, ends with the device). Users whose roles require MFA must sign in with their password instead (403, details.reason = MFA_USERS_SIGN_IN_WITH_PASSWORD). Wrong PINs count towards the lockout.',
  tags: ['Auth'],
  auth: 'none',
  body: PinSwitchBody,
  response: Me,
  errors: ['UNAUTHENTICATED', 'FORBIDDEN'],
});

export const AUTH_ROUTES = {
  signUp,
  verifyEmail,
  resendVerification,
  signIn,
  signOut,
  requestPasswordReset,
  resetPassword,
  getMe,
  listMySessions,
  revokeMySession,
  verifyMfa,
  enrolMfa,
  confirmMfa,
  setMyPin,
  getDevice,
  pinSwitch,
} as const;
