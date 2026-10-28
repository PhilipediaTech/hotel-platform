import { PgBoss, type QueueOptions } from 'pg-boss';
import pg from 'pg';
import type { Logger } from 'pino';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import {
  handlerQueue,
  publishPending,
  type DomainEventRecord,
  type EventHandler,
} from './outbox.ts';

// Jobs framework (tab 2 "Audit, outbox and jobs", ADR-004; T-021). The worker process
// (`src/worker.ts`) owns pg-boss: scheduled jobs, outbox handlers and the outbox publisher.
// Modules declare their jobs with `defineJob` in their `jobs.ts` and list them in
// `src/jobs.ts`; the HTTP process never runs jobs.

export interface JobContext {
  db: Db;
  clock: Clock;
  logger: Logger;
}

export interface JobDefinition<Data extends object = object> {
  /** kebab-case, unique: the pg-boss queue name. */
  name: string;
  /** Cron (5 fields) and time zone, for jobs that run on a timetable. */
  schedule?: { cron: string; tz?: string };
  /** Retries, expiry and retention; pg-boss defaults otherwise. */
  options?: QueueOptions;
  run(data: Data, ctx: JobContext): Promise<void>;
}

export function defineJob<Data extends object = object>(job: JobDefinition<Data>) {
  return job;
}

/** Outbox handlers retry with backoff: up to 5 attempts over about a minute. */
const HANDLER_QUEUE = { retryLimit: 5, retryDelay: 2, retryBackoff: true };
/**
 * Handler jobs run a few at a time and are polled every second. Not LISTEN/NOTIFY: the
 * publisher inserts jobs inside its own transaction, so a NOTIFY can arrive before the commit,
 * and with NOTIFY on, pg-boss falls back to a 30-second poll (retries never notify at all).
 */
const HANDLER_WORK = { localConcurrency: 4, pollingIntervalSeconds: 1 };

export interface WorkerOptions extends JobContext {
  databaseUrl: string;
  jobs: readonly JobDefinition<never>[];
  handlers: readonly EventHandler[];
  /** How often the publisher looks for new events. */
  publishIntervalMs?: number;
}

export interface RunningWorker {
  boss: PgBoss;
  /** Publishes pending events now (also runs on the interval). */
  publish(): Promise<number>;
  stop(): Promise<void>;
}

function loadEvent(db: Db, id: string): Promise<DomainEventRecord | null> {
  return db.domainEvent.findUnique({ where: { id: BigInt(id) } }).then((e) =>
    e
      ? {
          id: e.id.toString(),
          organisationId: e.organisationId,
          propertyId: e.propertyId,
          type: e.type,
          payload: e.payload as Record<string, unknown>,
          occurredAt: e.occurredAt,
        }
      : null,
  );
}

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const { db, logger, jobs, handlers } = options;
  const names = [...jobs.map((j) => j.name), ...handlers.map(handlerQueue)];
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) throw new Error(`Two jobs or handlers share the queue name ${duplicate}`);

  const boss = new PgBoss({ connectionString: options.databaseUrl });
  boss.on('error', (err: unknown) => logger.error({ err }, 'pg-boss error'));
  await boss.start();

  for (const job of jobs) {
    await boss.createQueue(job.name, job.options ?? {});
    await boss.work<object>(job.name, async ([pgJob]) => {
      if (!pgJob) return;
      const log = logger.child({ job: job.name, jobId: pgJob.id });
      log.info('Job started');
      await job.run(pgJob.data as never, { ...options, logger: log });
      log.info('Job finished');
    });
    if (job.schedule) {
      await boss.schedule(job.name, job.schedule.cron, null, { tz: job.schedule.tz ?? 'UTC' });
    }
  }
  // Timetables removed from the code stop running.
  for (const schedule of await boss.getSchedules()) {
    if (!jobs.some((j) => j.name === schedule.name && j.schedule)) {
      await boss.unschedule(schedule.name);
    }
  }

  for (const handler of handlers) {
    const queue = handlerQueue(handler);
    await boss.createQueue(queue, HANDLER_QUEUE);
    await boss.work<{ eventId: string }>(queue, HANDLER_WORK, async ([pgJob]) => {
      if (!pgJob) return;
      const event = await loadEvent(db, pgJob.data.eventId);
      // Purged events (older than the retention) are simply done.
      if (!event) return;
      await handler.handle(event);
    });
  }

  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 2 });
  let publishing: Promise<number> | null = null;
  const publish = () => {
    // One pass at a time; a pass already running covers the new events too.
    publishing ??= publishPending(pool, boss, handlers).finally(() => {
      publishing = null;
    });
    return publishing;
  };
  const timer = setInterval(() => {
    publish().catch((err: unknown) => logger.error({ err }, 'Outbox publish failed'));
  }, options.publishIntervalMs ?? 1000);

  logger.info(
    { jobs: jobs.map((j) => j.name), handlers: handlers.map((h) => h.name) },
    'Worker started',
  );
  return {
    boss,
    publish,
    async stop() {
      clearInterval(timer);
      await publishing?.catch(() => undefined);
      await boss.stop({ graceful: true, timeout: 10_000 });
      await pool.end();
    },
  };
}
