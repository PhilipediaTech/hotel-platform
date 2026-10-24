import type { ErrorBody, ErrorEnvelope } from '@hotel/shared';
import type { Router } from 'express';
import { createApp } from '../src/app.ts';
import type { Clock } from '../src/core/clock.ts';
import type { Config } from '../src/core/config.ts';
import { createDb, type Db } from '../src/core/db.ts';
import { createFakeEmailProvider } from '../src/core/email.ts';
import { createLogger } from '../src/core/logger.ts';

export const TEST_CONFIG: Config = {
  nodeEnv: 'test',
  port: 0,
  logLevel: 'info',
  appOrigin: 'http://app.test.localhost',
  siteOrigin: 'http://site.test.localhost',
  // HTTP-only tests never reach the database; DB tests pass testDb() to buildTestApp.
  databaseUrl: 'postgresql://unused@localhost:5432/unused',
  sessionSecret: 'test-session-secret-0123456789abcdef',
  mfaKey: Buffer.alloc(32, 7),
  cookieDomain: undefined,
  cookieSecure: false,
};

/** `Origin` the API accepts on non-GET requests (middleware step 6). */
export const APP_ORIGIN = TEST_CONFIG.appOrigin;

let unusedDb: Db | undefined;

export interface TestAppOptions {
  /** Real database for integration tests (`testDb()`); omitted = never connects. */
  db?: Db;
  clock?: Clock;
}

/** Builds the app with a fake email provider and a logger that captures JSON log lines. */
export function buildTestApp(routes?: Router, options: TestAppOptions = {}) {
  const logLines: Record<string, unknown>[] = [];
  const logger = createLogger(TEST_CONFIG, {
    write: (line: string) => {
      logLines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  // PrismaClient connects lazily, so this one only fails if a test unexpectedly queries it.
  unusedDb ??= createDb(TEST_CONFIG.databaseUrl);
  const email = createFakeEmailProvider();
  const app = createApp({
    config: TEST_CONFIG,
    logger,
    db: options.db ?? unusedDb,
    email,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(routes ? { routes } : {}),
  });
  return { app, logLines, logger, email };
}

/** Typed access to an error envelope in a Supertest response. */
export function errorOf(res: { body: unknown }): ErrorBody {
  return (res.body as ErrorEnvelope).error;
}
