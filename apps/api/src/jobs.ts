import type { Logger } from 'pino';
import { cleanupJob } from './core/cleanup.ts';
import type { Config } from './core/config.ts';
import type { Db } from './core/db.ts';
import type { JobDefinition } from './core/jobs.ts';
import type { EventHandler } from './core/outbox.ts';
import {
  approvalExpiryJob,
  approvalOtpHandler,
  createLoggingOtpChannel,
} from './modules/approvals/jobs.ts';

// Everything the worker runs. Modules add their scheduled jobs and outbox handlers here.

export const JOBS: readonly JobDefinition<never>[] = [cleanupJob, approvalExpiryJob];

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
