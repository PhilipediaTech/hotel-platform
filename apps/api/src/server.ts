import { createApp } from './app.ts';
import { loadConfig } from './core/config.ts';
import { createDb } from './core/db.ts';
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
const app = createApp({ config, logger });

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
