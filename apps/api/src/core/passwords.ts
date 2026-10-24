import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt password hashing (spec tab 2). Stored as `scrypt$N$r$p$salt$hash` (base64url), so
// the cost can be raised later: verifyPassword reports `needsRehash` and sign-in re-hashes.

interface Params {
  N: number;
  r: number;
  p: number;
}

/** 32 MiB per hash: about 50–100 ms on a server core. */
export const SCRYPT_PARAMS: Params = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer, params: Params): Promise<Buffer> {
  const options: ScryptOptions = {
    ...params,
    // Node's default 32 MiB limit is exactly N=2^15, r=8; leave headroom.
    maxmem: 256 * params.N * params.r,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(
  password: string,
  params: Params = SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

function parse(stored: string): { params: Params; salt: Buffer; key: Buffer } | undefined {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) return undefined;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Object.values(params).every((v) => Number.isInteger(v) && v > 0)) return undefined;
  return { params, salt: Buffer.from(salt, 'base64url'), key: Buffer.from(key, 'base64url') };
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const parsed = parse(stored);
  if (!parsed) return { ok: false, needsRehash: false };
  const key = await derive(password, parsed.salt, parsed.params);
  const ok = key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  const current = SCRYPT_PARAMS;
  const needsRehash =
    ok &&
    (parsed.params.N !== current.N ||
      parsed.params.r !== current.r ||
      parsed.params.p !== current.p);
  return { ok, needsRehash };
}

let dummy: Promise<string> | undefined;

/**
 * Spends the same time as a real check when there is no account (or it is locked), so
 * response timing doesn't reveal which logins exist.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword('not-a-real-password-for-timing-only');
  await verifyPassword(password, await dummy);
}
