import type { Logger } from 'pino';
import { cleanupJob } from './core/cleanup.ts';
import type { Config } from './core/config.ts';
import type { Db } from './core/db.ts';
import type { FileScanner } from './core/file-scan.ts';
import type { FileStore } from './core/files.ts';
import type { JobDefinition } from './core/jobs.ts';
import type { EventHandler } from './core/outbox.ts';
import type { PaymentProvider } from './core/payments.ts';
import type { Clock } from './core/clock.ts';
import type { EmailProvider } from './core/email.ts';
import type { MessageProvider } from './core/messaging.ts';
import { approvalExpiryJob, approvalOtpHandler } from './modules/approvals/jobs.ts';
import { notificationSendHandler, whatsappOtpChannel } from './modules/notifications/delivery.ts';
import { fileScanJob } from './modules/files/jobs.ts';
import { inventoryJob } from './modules/availability/inventory.ts';
import { idPurgeJob } from './modules/reservations/check-in.ts';
import { holdExpiryJob } from './modules/reservations/jobs.ts';
import {
  paymentLinkCheckJob,
  paymentWebhookJob,
  unmatchedTransferJob,
} from './modules/payments/jobs.ts';
import { roomBlockStatusJob } from './modules/rooms/jobs.ts';
import { taskEscalationJob } from './modules/tasks/jobs.ts';

// Everything the worker runs. Modules add their scheduled jobs and outbox handlers here.

export function workerJobs(deps: {
  files: FileStore;
  scanner: FileScanner;
  payments: PaymentProvider;
}): readonly JobDefinition<never>[] {
  return [
    cleanupJob,
    approvalExpiryJob,
    fileScanJob({ store: deps.files, scanner: deps.scanner }),
    roomBlockStatusJob,
    inventoryJob,
    holdExpiryJob,
    idPurgeJob({ store: deps.files }),
    // The fake keeps its links in the API process: nothing for the worker to ask.
    ...(deps.payments.name === 'FAKE' ? [] : [paymentLinkCheckJob({ provider: deps.payments })]),
    paymentWebhookJob({ provider: deps.payments }),
    unmatchedTransferJob,
    taskEscalationJob,
  ];
}

export function eventHandlers(deps: {
  db: Db;
  config: Config;
  logger: Logger;
  clock: Clock;
  messages: MessageProvider;
  email: EmailProvider;
}): EventHandler[] {
  const send = {
    db: deps.db,
    messages: deps.messages,
    email: deps.email,
    clock: deps.clock,
    logger: deps.logger,
  };
  return [
    // Approval codes by WhatsApp (T-024; production refuses the fake, which logs them).
    approvalOtpHandler({
      db: deps.db,
      otpSecret: deps.config.sessionSecret,
      channel: whatsappOtpChannel(send),
    }),
    notificationSendHandler(send),
  ];
}
