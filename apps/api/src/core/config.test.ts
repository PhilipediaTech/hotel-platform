import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const DB = 'postgresql://postgres:pw@localhost:5432/hotel_dev';
const ORIGINS = {
  APP_ORIGIN: 'http://localhost:5173',
  SITE_ORIGIN: 'http://localhost:4321',
  DATABASE_URL: DB,
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
  ID_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64url'),
};

/** WhatsApp through Meta, which production needs (T-024). */
const META = {
  WHATSAPP_PROVIDER: 'meta',
  WHATSAPP_TOKEN: 'EAAtest-token-0123456789',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ ...ORIGINS })).toEqual({
      nodeEnv: 'development',
      port: 4000,
      logLevel: 'info',
      appOrigin: 'http://localhost:5173',
      siteOrigin: 'http://localhost:4321',
      databaseUrl: DB,
      sessionSecret: 'test-session-secret-0123456789abcdef',
      mfaKey: Buffer.alloc(32, 7),
      idKey: Buffer.alloc(32, 9),
      cookieDomain: undefined,
      cookieSecure: false,
      localFilesDir: path.resolve(import.meta.dirname, '../../../../.data/files'),
      payments: { provider: 'fake', secretKey: null, webhookSecret: null },
      ai: { provider: 'fake', apiKey: null, model: 'claude-opus-5-5' },
      platformAdminEmails: [],
      passwordBreachCheck: 'hibp',
      whatsapp: {
        provider: 'fake',
        token: null,
        phoneNumberId: null,
        businessAccountId: null,
        appSecret: null,
        verifyToken: null,
        graphVersion: 'v23.0',
      },
    });
  });

  it('resolves LOCAL_FILES_DIR from the repository root', () => {
    const root = path.resolve(import.meta.dirname, '../../../..');
    expect(loadConfig({ ...ORIGINS, LOCAL_FILES_DIR: 'tmp/files' }).localFilesDir).toBe(
      path.join(root, 'tmp', 'files'),
    );
  });

  it('checks passwords with Have I Been Pwned, and never the fake in production (T-102)', () => {
    expect(loadConfig({ ...ORIGINS, PASSWORD_BREACH_CHECK: 'fake' }).passwordBreachCheck).toBe(
      'fake',
    );
    expect(() =>
      loadConfig({
        ...ORIGINS,
        ...META,
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'paystack',
        PAYMENT_SECRET_KEY: 'sk_live_abc123',
        PASSWORD_BREACH_CHECK: 'fake',
      }),
    ).toThrow(/PASSWORD_BREACH_CHECK=fake in production/);
  });

  it('requires a long SESSION_SECRET and refuses the placeholder in production', () => {
    expect(() => loadConfig({ ...ORIGINS, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    const placeholder = 'dev-only-session-secret-change-me-0123456789';
    expect(loadConfig({ ...ORIGINS, SESSION_SECRET: placeholder }).sessionSecret).toBe(placeholder);
    expect(() =>
      loadConfig({ ...ORIGINS, NODE_ENV: 'production', SESSION_SECRET: placeholder }),
    ).toThrow(/placeholder/);
  });

  it('needs a 32-byte MFA key and refuses the placeholder in production', () => {
    expect(() => loadConfig({ ...ORIGINS, MFA_ENCRYPTION_KEY: 'c2hvcnQ' })).toThrow(
      /MFA_ENCRYPTION_KEY/,
    );
    const placeholder = 'ZGV2LW9ubHktbWZhLWtleS1jaGFuZ2UtbWUtMDAwMDA';
    expect(loadConfig({ ...ORIGINS, MFA_ENCRYPTION_KEY: placeholder }).mfaKey).toHaveLength(32);
    expect(() =>
      loadConfig({ ...ORIGINS, NODE_ENV: 'production', MFA_ENCRYPTION_KEY: placeholder }),
    ).toThrow(/MFA_ENCRYPTION_KEY is the .env.example placeholder/);
  });

  it('needs a 32-byte ID key in production and uses a fixed one in development', () => {
    expect(() => loadConfig({ ...ORIGINS, ID_ENCRYPTION_KEY: 'c2hvcnQ' })).toThrow(
      /ID_ENCRYPTION_KEY/,
    );
    const { ID_ENCRYPTION_KEY: _key, ...withoutKey } = ORIGINS;
    expect(loadConfig(withoutKey).idKey).toHaveLength(32);
    expect(() => loadConfig({ ...withoutKey, NODE_ENV: 'production' })).toThrow(
      /ID_ENCRYPTION_KEY is required in production/,
    );
  });

  it('sets a Secure cookie in production and reads the cookie domain', () => {
    const config = loadConfig({
      ...ORIGINS,
      NODE_ENV: 'production',
      COOKIE_DOMAIN: '.example.com',
      PAYMENT_PROVIDER: 'paystack',
      PAYMENT_SECRET_KEY: 'sk_live_abc123',
      ...META,
    });
    expect(config).toMatchObject({ cookieSecure: true, cookieDomain: '.example.com' });
    expect(() => loadConfig({ ...ORIGINS, COOKIE_DOMAIN: 'https://x' })).toThrow(/COOKIE_DOMAIN/);
    expect(() => loadConfig({ ...ORIGINS, COOKIE_DOMAIN: 'xexample.com/' })).toThrow(
      /COOKIE_DOMAIN/,
    );
    expect(loadConfig({ ...ORIGINS, COOKIE_DOMAIN: 'example.com' }).cookieDomain).toBe(
      'example.com',
    );
  });

  it('takes Paystack with its key, test keys only outside production, never the fake in production', () => {
    expect(
      loadConfig({ ...ORIGINS, PAYMENT_PROVIDER: 'paystack', PAYMENT_SECRET_KEY: 'sk_test_abc123' })
        .payments,
    ).toEqual({ provider: 'paystack', secretKey: 'sk_test_abc123', webhookSecret: null });
    expect(() => loadConfig({ ...ORIGINS, PAYMENT_PROVIDER: 'paystack' })).toThrow(
      /PAYMENT_SECRET_KEY is required/,
    );
    expect(() =>
      loadConfig({ ...ORIGINS, PAYMENT_PROVIDER: 'paystack', PAYMENT_SECRET_KEY: 'pk_test_abc' }),
    ).toThrow(/Paystack secret key/);
    expect(() =>
      loadConfig({ ...ORIGINS, PAYMENT_PROVIDER: 'paystack', PAYMENT_SECRET_KEY: 'sk_live_abc' }),
    ).toThrow(/use a test key/);
    expect(() => loadConfig({ ...ORIGINS, NODE_ENV: 'production' })).toThrow(
      /PAYMENT_PROVIDER=fake in production/,
    );
  });

  it('takes Meta for WhatsApp with its token and number ID, never the fake in production', () => {
    expect(
      loadConfig({ ...ORIGINS, ...META, WHATSAPP_BUSINESS_ACCOUNT_ID: '987654321' }).whatsapp,
    ).toEqual({
      provider: 'meta',
      token: 'EAAtest-token-0123456789',
      phoneNumberId: '1234567890',
      businessAccountId: '987654321',
      appSecret: null,
      verifyToken: null,
      graphVersion: 'v23.0',
    });
    expect(() => loadConfig({ ...ORIGINS, WHATSAPP_PROVIDER: 'meta' })).toThrow(
      /WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required/,
    );
    expect(() =>
      loadConfig({ ...ORIGINS, ...META, WHATSAPP_PHONE_NUMBER_ID: '+2348012345678' }),
    ).toThrow(/number ID, digits only/);
    expect(() =>
      loadConfig({
        ...ORIGINS,
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'paystack',
        PAYMENT_SECRET_KEY: 'sk_live_abc123',
      }),
    ).toThrow(/WHATSAPP_PROVIDER=fake in production/);
  });

  it('requires a PostgreSQL DATABASE_URL', () => {
    const { DATABASE_URL: _omit, ...withoutDb } = ORIGINS;
    expect(() => loadConfig(withoutDb)).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...ORIGINS, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('never echoes the database password in the error message', () => {
    expect(() => loadConfig({ ...ORIGINS, DATABASE_URL: 'mysql://u:s3cret@localhost/db' })).toThrow(
      /^(?![\s\S]*s3cret)/,
    );
  });

  it('reads and coerces values', () => {
    const config = loadConfig({
      ...ORIGINS,
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      PAYMENT_PROVIDER: 'paystack',
      PAYMENT_SECRET_KEY: 'sk_live_abc123',
      ...META,
    });
    expect(config).toMatchObject({ nodeEnv: 'production', port: 8080, logLevel: 'warn' });
  });

  it('fails when an origin is missing', () => {
    expect(() => loadConfig({ APP_ORIGIN: ORIGINS.APP_ORIGIN })).toThrow(/SITE_ORIGIN/);
  });

  it.each([
    'https://app.example.com/',
    'https://app.example.com/login',
    'ftp://app.example.com',
    'nonsense',
  ])('rejects APP_ORIGIN %j', (value) => {
    expect(() => loadConfig({ ...ORIGINS, APP_ORIGIN: value })).toThrow(/APP_ORIGIN/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...ORIGINS, PORT: '70000' })).toThrow(/PORT/);
  });
});
