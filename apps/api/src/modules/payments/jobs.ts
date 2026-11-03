import { defineJob } from '../../core/jobs.ts';
import type { PaymentProvider } from '../../core/payments.ts';
import { checkOpenIntents } from './intents.ts';

/** Payment links are asked about every 5 minutes until webhooks arrive (T-070, T-071). */
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
