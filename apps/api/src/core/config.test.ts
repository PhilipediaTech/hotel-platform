import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const DB = 'postgresql://postgres:pw@localhost:5432/hotel_dev';
const ORIGINS = {
  APP_ORIGIN: 'http://localhost:5173',
  SITE_ORIGIN: 'http://localhost:4321',
  DATABASE_URL: DB,
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
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
      cookieDomain: undefined,
      cookieSecure: false,
    });
  });

  it('requires a long SESSION_SECRET and refuses the placeholder in production', () => {
    expect(() => loadConfig({ ...ORIGINS, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    const placeholder = 'dev-only-session-secret-change-me-0123456789';
    expect(loadConfig({ ...ORIGINS, SESSION_SECRET: placeholder }).sessionSecret).toBe(placeholder);
    expect(() =>
      loadConfig({ ...ORIGINS, NODE_ENV: 'production', SESSION_SECRET: placeholder }),
    ).toThrow(/placeholder/);
  });

  it('sets a Secure cookie in production and reads the cookie domain', () => {
    const config = loadConfig({
      ...ORIGINS,
      NODE_ENV: 'production',
      COOKIE_DOMAIN: '.example.com',
    });
    expect(config).toMatchObject({ cookieSecure: true, cookieDomain: '.example.com' });
    expect(() => loadConfig({ ...ORIGINS, COOKIE_DOMAIN: 'https://x' })).toThrow(/COOKIE_DOMAIN/);
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
