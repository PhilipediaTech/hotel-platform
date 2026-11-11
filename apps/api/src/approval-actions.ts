import type { ApprovalActionHandler } from './core/approvals.ts';
import type { Clock } from './core/clock.ts';
import type { Db } from './core/db.ts';
import type { TenantDb } from './core/tenant-db.ts';
import { discountHandler, reverseHandler } from './modules/folios/service.ts';
import { transferHandler } from './modules/folios/transfers.ts';
import { arTransferHandler } from './modules/ar/service.ts';
import { eventConfirmHandler } from './modules/events/sales.ts';
import { refundHandler } from './modules/payments/refunds.ts';
import { roomMoveHandler, roomNotReadyHandler } from './modules/reservations/rooms.ts';
import { doNotRentHandler } from './modules/reservations/service.ts';

// Every protected action the approvals engine can execute (core/approvals.ts). Modules add
// their handler here when they build the action (folio discounts and voids in T-04x, refunds
// and write-offs with payments, room moves with front desk).

export function approvalHandlers(deps: {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}): readonly ApprovalActionHandler<never>[] {
  return [
    doNotRentHandler(deps),
    roomNotReadyHandler(deps),
    roomMoveHandler(deps),
    reverseHandler(deps),
    discountHandler(deps),
    transferHandler(deps),
    refundHandler(deps),
    eventConfirmHandler(deps),
    arTransferHandler(deps),
  ].map((h) => h as unknown as ApprovalActionHandler<never>);
}
