import { createApp } from './app.ts';
import { loadConfig } from './core/config.ts';
import { createDb } from './core/db.ts';
import { systemClock } from './core/clock.ts';
import { createFakeEmailProvider } from './core/email.ts';
import { createLocalFileStore } from './core/files.ts';
import { createLogger } from './core/logger.ts';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const logger = createLogger(config);
const db = createDb(config.databaseUrl);
if (config.nodeEnv === 'production') {
  // The SES adapter arrives with the AWS account (T-005). Never fake email in production.
  logger.fatal('No email provider configured for production');
  process.exit(1);
}
// The R2 adapter arrives with the Cloudflare account; the local store never runs in production
// (the check above already stops production).
// Local development: emails are logged so verification and reset links can be opened.
const email = createFakeEmailProvider(logger);
// Local development: files are kept in LOCAL_FILES_DIR and served by signed links.
const files = createLocalFileStore({
  dir: config.localFilesDir,
  secret: config.sessionSecret,
  clock: systemClock,
});
const app = createApp({ config, logger, db, email, files });

const server = app.listen(config.port, (err?: Error) => {
  if (err) {
    logger.fatal({ err }, 'API failed to start');
    process.exit(1);
  }
  logger.info({ port: config.port, env: config.nodeEnv }, 'API listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Shutting down');
  server.close(() => {
    void db.$disconnect().finally(() => process.exit(0));
  });
  // Force exit if open connections keep the server alive.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
