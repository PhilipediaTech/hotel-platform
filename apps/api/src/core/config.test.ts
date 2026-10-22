import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const ORIGINS = { APP_ORIGIN: 'http://localhost:5173', SITE_ORIGIN: 'http://localhost:4321' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ ...ORIGINS })).toEqual({
      nodeEnv: 'development',
      port: 4000,
      logLevel: 'info',
      appOrigin: 'http://localhost:5173',
      siteOrigin: 'http://localhost:4321',
    });
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
