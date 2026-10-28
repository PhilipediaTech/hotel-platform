import { defineJob } from '../../core/jobs.ts';
import { syncBlockStatuses } from './service.ts';

/** Rooms go out of order on their block's first day and come back dirty after the last. */
export const roomBlockStatusJob = defineJob({
  name: 'room-block-status',
  schedule: { cron: '*/15 * * * *' },
  async run(_data, { db, clock, logger }) {
    const { started, ended } = await syncBlockStatuses(db, clock);
    if (started + ended > 0) logger.info({ started, ended }, 'Room block statuses updated');
  },
});
