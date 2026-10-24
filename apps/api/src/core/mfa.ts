import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';
import { generate, generateSecret, generateURI, verify } from 'otplib';
import { hashToken } from './tokens.ts';

// TOTP MFA (spec tab 2: otplib; PRD M1-06). Secrets are encrypted at rest; codes follow
// RFC 6238 (SHA-1, 6 digits, 30 s) so every authenticator app works.

export const TOTP_PERIOD_SECONDS = 30;
/** Accept the previous and next 30 s step to allow for phone clock drift. */
const DRIFT_SECONDS = TOTP_PERIOD_SECONDS;
export const MFA_ISSUER = 'Hotel Platform';

// ---------------------------------------------------------------------------------------
// Secret encryption: version byte | 12-byte IV | 16-byte GCM tag | ciphertext

const FORMAT_V1 = 1;

export function encryptSecret(key: Buffer, secret: string): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  // A plain Uint8Array is what Prisma stores in a bytea column.
  return new Uint8Array(Buffer.concat([Buffer.from([FORMAT_V1]), iv, cipher.getAuthTag(), body]));
}

/** Throws if the data was not produced with this key (GCM authentication). */
export function decryptSecret(key: Buffer, data: Uint8Array): string {
  const buf = Buffer.from(data);
  if (buf[0] !== FORMAT_V1 || buf.length < 1 + 12 + 16)
    throw new Error('Unknown MFA secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(1, 13));
  decipher.setAuthTag(buf.subarray(13, 29));
  return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------------------
// TOTP

export function newTotpSecret(): string {
  return generateSecret({ length: 20 });
}

/** `otpauth://` link for the QR code; the label is what the authenticator app shows. */
export function totpUri(secret: string, label: string): string {
  return generateURI({ issuer: MFA_ISSUER, label, secret, period: TOTP_PERIOD_SECONDS });
}

/** Code for `secret` at `now` (tests and the enrolment screen preview only). */
export function totpCode(secret: string, now: Date): Promise<string> {
  return generate({ secret, epoch: Math.floor(now.getTime() / 1000) });
}

/**
 * Checks a 6-digit code at `now`, refusing any time step at or before `afterStep` (the last
 * accepted one), so an intercepted code can't be replayed. Returns the step to store.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  now: Date,
  afterStep: bigint | null,
): Promise<{ ok: true; step: bigint } | { ok: false }> {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const result = await verify({
    secret,
    token: code,
    epoch: Math.floor(now.getTime() / 1000),
    epochTolerance: DRIFT_SECONDS,
    ...(afterStep !== null ? { afterTimeStep: Number(afterStep) } : {}),
  });
  // otplib types its result as TOTP-or-HOTP; only TOTP results carry `timeStep`.
  return result.valid && 'timeStep' in result
    ? { ok: true, step: BigInt(result.timeStep) }
    : { ok: false };
}

// ---------------------------------------------------------------------------------------
// Recovery codes

export const RECOVERY_CODE_COUNT = 10;
/** No 0/O, 1/I/L: easy to read off paper. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** `XXXX-XXXX`, about 39 bits each; single use and rate-limited, so enough. */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}

/** Case, spaces and dashes don't matter when typing a code. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(secret: string, code: string): string {
  return hashToken(secret, `recovery:${normaliseRecoveryCode(code)}`);
}
