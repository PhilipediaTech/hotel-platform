import type { ErrorBody, ErrorEnvelope } from '@hotel/shared';
import type { Router } from 'express';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/core/config.ts';
import { createLogger } from '../src/core/logger.ts';

export const TEST_CONFIG: Config = {
  nodeEnv: 'test',
  port: 0,
  logLevel: 'info',
  appOrigin: 'http://app.test.localhost',
  siteOrigin: 'http://site.test.localhost',
  // Not used by HTTP-only tests; DB tests use test/db.ts.
  databaseUrl: 'postgresql://unused@localhost:5432/unused',
};

/** Builds the app with a logger that captures JSON log lines instead of printing them. */
export function buildTestApp(routes?: Router) {
  const logLines: Record<string, unknown>[] = [];
  const logger = createLogger(TEST_CONFIG, {
    write: (line: string) => {
      logLines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  const app = createApp(
    routes ? { config: TEST_CONFIG, logger, routes } : { config: TEST_CONFIG, logger },
  );
  return { app, logLines, logger };
}

/** Typed access to an error envelope in a Supertest response. */
export function errorOf(res: { body: unknown }): ErrorBody {
  return (res.body as ErrorEnvelope).error;
}
