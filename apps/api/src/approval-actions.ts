import type { ApprovalActionHandler } from './core/approvals.ts';

// Every protected action the approvals engine can execute (core/approvals.ts). Modules add
// their handler here when they build the action (folio discounts and voids in T-04x, refunds
// and write-offs with payments, room moves with front desk).

export const APPROVAL_HANDLERS: readonly ApprovalActionHandler<never>[] = [];
