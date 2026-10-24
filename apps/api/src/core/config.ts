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
  COOKIE_DOMAIN: z
    .string()
    .regex(/^.?[a-z0-9.-]+$/i, 'COOKIE_DOMAIN must be a domain like .example.com')
    .optional(),
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
  /** Domain of the `sid` cookie, e.g. `.example.com`; host-only when unset. */
  cookieDomain: string | undefined;
  /** `Secure` on the `sid` cookie. Off only outside production, where local HTTP is used. */
  cookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && PLACEHOLDER_SECRET.test(e.SESSION_SECRET)) {
    throw new Error(
      'Invalid environment configuration:\n✖ SESSION_SECRET is the .env.example placeholder',
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
    cookieDomain: e.COOKIE_DOMAIN,
    cookieSecure: e.NODE_ENV === 'production',
  };
}
