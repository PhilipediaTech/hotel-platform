import type { Logger } from 'pino';
import { cleanupJob } from './core/cleanup.ts';
import type { Config } from './core/config.ts';
import type { Db } from './core/db.ts';
import type { FileScanner } from './core/file-scan.ts';
import type { FileStore } from './core/files.ts';
import type { JobDefinition } from './core/jobs.ts';
import type { EventHandler } from './core/outbox.ts';
import type { AiProvider } from './core/ai.ts';
import type { PaymentProvider } from './core/payments.ts';
import { assistantHandler } from './modules/bookingengine/assistant.ts';
import { createTenantDb } from './core/tenant-db.ts';
import { ownerSummaryJob } from './modules/owner/ai.ts';
import type { Clock } from './core/clock.ts';
import type { EmailProvider } from './core/email.ts';
import type { MessageProvider } from './core/messaging.ts';
import { approvalExpiryJob, approvalOtpHandler } from './modules/approvals/jobs.ts';
import { notificationSendHandler, whatsappOtpChannel } from './modules/notifications/delivery.ts';
import { flashReportHandler, instantAlertHandler } from './modules/owner/notify.ts';
import { fileScanJob } from './modules/files/jobs.ts';
import { inventoryJob } from './modules/availability/inventory.ts';
import { idPurgeJob } from './modules/reservations/check-in.ts';
import { stayAlertJob } from './modules/reservations/alert-jobs.ts';
import { holdExpiryJob } from './modules/reservations/jobs.ts';
import { visitorCutoffJob } from './modules/reservations/visitors.ts';
import {
  paymentLinkCheckJob,
  paymentWebhookJob,
  unmatchedTransferJob,
} from './modules/payments/jobs.ts';
import { roomBlockStatusJob } from './modules/rooms/jobs.ts';
import { taskEscalationJob } from './modules/tasks/jobs.ts';
import { preventiveMaintenanceJob } from './modules/maintenance/preventive.ts';
import { checklistsJob } from './modules/checklists/service.ts';
import { staffDocumentPurgeJob } from './modules/staff/documents.ts';
import { certificationRemindersJob } from './modules/staff/service.ts';
import { eventHoldExpiryJob } from './modules/events/routes.ts';
import { groupBlockReleaseJob } from './modules/groups/routes.ts';
import { platformBillingJob } from './modules/platform/billing.ts';
import type { ChannelManager } from './core/channel-manager.ts';
import { channelSyncJob } from './modules/channels/sync.ts';
import { channelBookingsHandler, channelBookingsJob } from './modules/channels/bookings.ts';
import { reviewDraftHandler, reviewRequestJob } from './modules/reviews/service.ts';

// Everything the worker runs. Modules add their scheduled jobs and outbox handlers here.

export function workerJobs(deps: {
  files: FileStore;
  scanner: FileScanner;
  payments: PaymentProvider;
  ai: AiProvider;
  email: EmailProvider;
  config: Config;
  /** Prices and availability to the channel manager (T-152). */
  channel: ChannelManager;
}): readonly JobDefinition<never>[] {
  return [
    ownerSummaryJob({ ai: deps.ai }),
    cleanupJob,
    approvalExpiryJob,
    fileScanJob({ store: deps.files, scanner: deps.scanner }),
    roomBlockStatusJob,
    inventoryJob,
    holdExpiryJob,
    eventHoldExpiryJob,
    groupBlockReleaseJob,
    platformBillingJob({ payments: deps.payments, email: deps.email, config: deps.config }),
    stayAlertJob,
    visitorCutoffJob,
    idPurgeJob({ store: deps.files }),
    staffDocumentPurgeJob({ store: deps.files }),
    // The fake keeps its links in the API process: nothing for the worker to ask.
    ...(deps.payments.name === 'FAKE' ? [] : [paymentLinkCheckJob({ provider: deps.payments })]),
    paymentWebhookJob({ provider: deps.payments }),
    unmatchedTransferJob,
    taskEscalationJob,
    preventiveMaintenanceJob,
    checklistsJob,
    certificationRemindersJob,
    // Review requests after check-out (T-155).
    reviewRequestJob({ config: deps.config }),
    // No channel manager on the platform: nothing to send.
    ...(deps.channel.name === 'OFF'
      ? []
      : [channelSyncJob({ channel: deps.channel }), channelBookingsJob({ channel: deps.channel })]),
  ];
}

export function eventHandlers(deps: {
  db: Db;
  config: Config;
  logger: Logger;
  clock: Clock;
  messages: MessageProvider;
  email: EmailProvider;
  /** For the WhatsApp assistant (T-117). */
  ai: AiProvider;
  payments: PaymentProvider;
  files: FileStore;
  /** OTA bookings, read at once when the channel manager's webhook says one waits (T-153). */
  channel: ChannelManager;
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
    // To the owner (T-091): instant leakage alerts and the flash report at day close.
    instantAlertHandler({ db: deps.db, logger: deps.logger }),
    flashReportHandler({ db: deps.db, logger: deps.logger }),
    // Guests' WhatsApp messages (T-117).
    assistantHandler({
      db: deps.db,
      tenantDb: createTenantDb(deps.db),
      clock: deps.clock,
      config: deps.config,
      provider: deps.payments,
      email: deps.email,
      store: deps.files,
      ai: deps.ai,
      messages: deps.messages,
      logger: deps.logger,
    }),
    // Drafts a reply to each review that comes in (T-155).
    reviewDraftHandler({ db: deps.db, ai: deps.ai, clock: deps.clock, logger: deps.logger }),
    ...(deps.channel.name === 'OFF'
      ? []
      : [
          channelBookingsHandler({
            db: deps.db,
            clock: deps.clock,
            channel: deps.channel,
            logger: deps.logger,
          }),
        ]),
  ];
}
