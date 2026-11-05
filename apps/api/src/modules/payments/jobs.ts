import { defineJob } from '../../core/jobs.ts';
import type { PaymentProvider } from '../../core/payments.ts';
import { checkOpenIntents } from './intents.ts';
import { processWebhookEvents, unmatchedTransferAlerts } from './webhooks.ts';

/** Payment links are asked about every 5 minutes, in case a webhook went missing (T-070). */
export function paymentLinkCheckJob(deps: { provider: PaymentProvider }) {
  return defineJob({
    name: 'payment-link-check',
    schedule: { cron: '*/5 * * * *' },
    async run(_data, { db, clock, logger }) {
      const paid = await checkOpenIntents({ db, clock, provider: deps.provider, logger });
      if (paid > 0) logger.info({ paid }, 'Payment links paid');
    },
  });
}

/** Stored webhooks are recorded within a minute (T-071; tab 4 "return 200 → process in a job"). */
export function paymentWebhookJob(deps: { provider: PaymentProvider }) {
  return defineJob({
    name: 'payment-webhooks',
    schedule: { cron: '* * * * *' },
    async run(_data, { db, clock, logger }) {
      const done = await processWebhookEvents({ db, clock, provider: deps.provider, logger });
      if (done > 0) logger.info({ done }, 'Payment webhooks processed');
    },
  });
}

/** M4 rule 7: transfers unmatched for 24 hours raise a Leakage Guard alert (checked hourly). */
export const unmatchedTransferJob = defineJob({
  name: 'unmatched-transfer-alerts',
  schedule: { cron: '15 * * * *' },
  async run(_data, { db, clock, logger }) {
    const raised = await unmatchedTransferAlerts(db, clock);
    if (raised > 0) logger.warn({ raised }, 'Unmatched transfers overdue');
  },
});
