import { defineJob } from '../../core/jobs.ts';
import { expireHolds } from './service.ts';

/** Tentative holds give back their rooms within a minute of running out (M3 acceptance). */
export const holdExpiryJob = defineJob({
  name: 'reservation-hold-expiry',
  schedule: { cron: '* * * * *' },
  async run(_data, { db, clock, logger }) {
    const expired = await expireHolds(db, clock);
    if (expired > 0) logger.info({ expired }, 'Tentative holds expired');
  },
});
