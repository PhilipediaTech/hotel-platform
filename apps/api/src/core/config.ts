import path from 'node:path';
import { z } from 'zod';

// Zod still runs the refinement when the URL check fails, so guard the parse.
const origin = z
  .url({ protocol: /^https?$/ })
  .refine((value) => URL.canParse(value) && new URL(value).origin === value, {
    message: 'Must be a bare origin like https://app.example.com (no path or trailing slash)',
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_ORIGIN: origin,
  SITE_ORIGIN: origin,
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  MFA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64url').length === 32, {
    message: 'MFA_ENCRYPTION_KEY must be 32 bytes, base64url-encoded',
  }),
  // Encrypts guest ID numbers (T-051). Required in production; development and tests use a
  // fixed key when it is not set.
  ID_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64url').length === 32, {
      message: 'ID_ENCRYPTION_KEY must be 32 bytes, base64url-encoded',
    })
    .optional(),
  COOKIE_DOMAIN: z
    .string()
    .regex(/^\.?[a-z0-9.-]+$/i, 'COOKIE_DOMAIN must be a domain like .example.com')
    .optional(),
  // Local file store directory (T-023), shared by the API and the worker; never production.
  LOCAL_FILES_DIR: z.string().min(1).optional(),
});

const PLACEHOLDER_SECRET = /^dev-only-/;

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Browser origins allowed by CORS (and, from T-010, the Origin check). */
  appOrigin: string;
  siteOrigin: string;
  databaseUrl: string;
  /** HMAC key for session and email tokens; only hashes are stored (T-010). */
  sessionSecret: string;
  /** AES-256-GCM key for TOTP secrets at rest (T-011). */
  mfaKey: Buffer;
  /** AES-256-GCM key for guest ID numbers at rest (T-051). */
  idKey: Buffer;
  /** Domain of the `sid` cookie, e.g. `.example.com`; host-only when unset. */
  cookieDomain: string | undefined;
  /** `Secure` on the `sid` cookie. Off only outside production, where local HTTP is used. */
  cookieSecure: boolean;
  /** Where the local (fake) file store keeps files; default `.data/files` in the repo. */
  localFilesDir: string;
}

/** Repository root: config.ts lives in apps/api/src/core. */
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const mfaKey = Buffer.from(e.MFA_ENCRYPTION_KEY, 'base64url');
  if (e.NODE_ENV === 'production' && mfaKey.toString('latin1').startsWith('dev-only-')) {
    throw new Error(
      'Invalid environment configuration:\n✖ MFA_ENCRYPTION_KEY is the .env.example placeholder',
    );
  }
  if (e.NODE_ENV === 'production' && PLACEHOLDER_SECRET.test(e.SESSION_SECRET)) {
    throw new Error(
      'Invalid environment configuration:\n✖ SESSION_SECRET is the .env.example placeholder',
    );
  }
  if (e.NODE_ENV === 'production' && !e.ID_ENCRYPTION_KEY) {
    throw new Error(
      'Invalid environment configuration:\n✖ ID_ENCRYPTION_KEY is required in production',
    );
  }
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    appOrigin: e.APP_ORIGIN,
    siteOrigin: e.SITE_ORIGIN,
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET,
    mfaKey,
    idKey: e.ID_ENCRYPTION_KEY
      ? Buffer.from(e.ID_ENCRYPTION_KEY, 'base64url')
      : Buffer.from('dev-only-id-key-not-for-production', 'latin1').subarray(0, 32),
    cookieDomain: e.COOKIE_DOMAIN,
    cookieSecure: e.NODE_ENV === 'production',
    localFilesDir: path.resolve(REPO_ROOT, e.LOCAL_FILES_DIR ?? '.data/files'),
  };
}
