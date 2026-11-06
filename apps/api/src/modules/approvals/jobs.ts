import { expireRequests, issueApprovalOtp, type ApprovalOtpChannel } from '../../core/approvals.ts';
import type { Db } from '../../core/db.ts';
import { defineJob } from '../../core/jobs.ts';
import type { EventHandler } from '../../core/outbox.ts';

/** Rule 3: expired requests cannot execute. Every minute (tab 2 "hold expiry" cadence). */
export const approvalExpiryJob = defineJob({
  name: 'approval-expiry',
  schedule: { cron: '* * * * *' },
  async run(_data, { db, clock, logger }) {
    const expired = await expireRequests(db, clock);
    if (expired > 0) logger.info({ expired }, 'Approval requests expired');
  },
});

/** On a new request, issue its one-time code and send it to the approvers. */
export function approvalOtpHandler(deps: {
  db: Db;
  otpSecret: string;
  channel: ApprovalOtpChannel;
}): EventHandler {
  return {
    name: 'approval-otp',
    events: ['approval.requested'],
    async handle(event) {
      const id = event.payload['approvalRequestId'];
      if (typeof id === 'string') await issueApprovalOtp(deps.db, deps, id);
    },
  };
}
