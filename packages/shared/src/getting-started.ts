// Getting started (Versions V2 "enhanced onboarding"; T-172, Philip 2026-11-26): each staff
// member's first steps, chosen by the permissions they hold (role names are editable), and
// done once the audit log shows they really did them here. Managers' steps come first, so an
// owner's list is about running the hotel and a front desk agent's about the desk.

export interface GettingStartedStep {
  id: string;
  /** Held by the people the step is for. */
  permission: string;
  /** Audit actions that show it was done (by them, at this property or group-wide). */
  actions: readonly string[];
  /** Where it is done. */
  path: string;
}

export const GETTING_STARTED_STEPS: readonly GettingStartedStep[] = [
  {
    id: 'invite',
    permission: 'user.invite',
    actions: ['invitation.created'],
    path: '/settings/access',
  },
  { id: 'rates', permission: 'rate.manage', actions: ['rates.updated'], path: '/rates' },
  {
    id: 'approve',
    permission: 'approval.decide',
    actions: ['approval.approved', 'approval.rejected'],
    path: '/approvals',
  },
  {
    id: 'booking',
    permission: 'reservation.create',
    actions: ['reservation.created'],
    path: '/bookings/new',
  },
  {
    id: 'checkIn',
    permission: 'reservation.checkin',
    actions: ['stay.checked_in'],
    path: '/front-desk',
  },
  { id: 'payment', permission: 'payment.capture', actions: ['payment.captured'], path: '/folios' },
  { id: 'charge', permission: 'folio.charge', actions: ['folio.charge_posted'], path: '/folios' },
  { id: 'shift', permission: 'shift.open', actions: ['shift.opened'], path: '/shift' },
  {
    id: 'checkOut',
    permission: 'reservation.checkout',
    actions: ['stay.checked_out'],
    path: '/front-desk',
  },
  {
    id: 'nightAudit',
    permission: 'audit.run',
    actions: ['night_audit.started'],
    path: '/night-audit',
  },
  {
    id: 'roomStatus',
    permission: 'hk.work',
    actions: ['room.hk_status_changed'],
    path: '/my-rooms',
  },
  { id: 'posOrder', permission: 'pos.order', actions: ['pos.order_opened'], path: '/pos' },
  {
    id: 'receiveStock',
    permission: 'stock.receive',
    actions: ['stock.goods_received'],
    path: '/stock',
  },
  { id: 'expense', permission: 'expense.manage', actions: ['expense.recorded'], path: '/expenses' },
];

/** Steps one person is shown at most. */
export const MAX_GETTING_STARTED_STEPS = 6;

/** A person's steps: the first few their permissions allow, in the order above. */
export function gettingStartedSteps(permissions: Iterable<string>): GettingStartedStep[] {
  const held = new Set(permissions);
  return GETTING_STARTED_STEPS.filter((s) => held.has(s.permission)).slice(
    0,
    MAX_GETTING_STARTED_STEPS,
  );
}
