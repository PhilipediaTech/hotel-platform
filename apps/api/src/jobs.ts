import type { Logger } from 'pino';
import { cleanupJob } from './core/cleanup.ts';
import type { Config } from './core/config.ts';
import type { Db } from './core/db.ts';
import type { FileScanner } from './core/file-scan.ts';
import type { FileStore } from './core/files.ts';
import type { JobDefinition } from './core/jobs.ts';
import type { EventHandler } from './core/outbox.ts';
import {
  approvalExpiryJob,
  approvalOtpHandler,
  createLoggingOtpChannel,
} from './modules/approvals/jobs.ts';
import { fileScanJob } from './modules/files/jobs.ts';
import { inventoryJob } from './modules/availability/inventory.ts';
import { idPurgeJob } from './modules/reservations/check-in.ts';
import { holdExpiryJob } from './modules/reservations/jobs.ts';
import { roomBlockStatusJob } from './modules/rooms/jobs.ts';

// Everything the worker runs. Modules add their scheduled jobs and outbox handlers here.

export function workerJobs(deps: {
  files: FileStore;
  scanner: FileScanner;
}): readonly JobDefinition<never>[] {
  return [
    cleanupJob,
    approvalExpiryJob,
    fileScanJob({ store: deps.files, scanner: deps.scanner }),
    roomBlockStatusJob,
    inventoryJob,
    holdExpiryJob,
    idPurgeJob({ store: deps.files }),
  ];
}

export function eventHandlers(deps: { db: Db; config: Config; logger: Logger }): EventHandler[] {
  return [
    // Stub channel until WhatsApp (T-024); never logs codes in production.
    ...(deps.config.nodeEnv === 'production'
      ? []
      : [
          approvalOtpHandler({
            db: deps.db,
            otpSecret: deps.config.sessionSecret,
            channel: createLoggingOtpChannel(deps.logger),
          }),
        ]),
  ];
}
