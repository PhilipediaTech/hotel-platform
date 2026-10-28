import { loadConfig } from './core/config.ts';
import { systemClock } from './core/clock.ts';
import { createDb } from './core/db.ts';
import { startWorker } from './core/jobs.ts';
import { createLogger } from './core/logger.ts';
import { EVENT_HANDLERS, JOBS } from './jobs.ts';

// Worker entry (tab 2: one process for HTTP, one for jobs; T-021): scheduled jobs, outbox
// handlers and the outbox publisher. Needs the same environment as the API.

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const logger = createLogger(config).child({ process: 'worker' });
const db = createDb(config.databaseUrl);

let worker: Awaited<ReturnType<typeof startWorker>>;
try {
  worker = await startWorker({
    databaseUrl: config.databaseUrl,
    db,
    clock: systemClock,
    logger,
    jobs: JOBS,
    handlers: EVENT_HANDLERS,
  });
} catch (err) {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
}

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Worker shutting down');
  setTimeout(() => process.exit(1), 15_000).unref();
  void worker
    .stop()
    .then(() => db.$disconnect())
    .finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
