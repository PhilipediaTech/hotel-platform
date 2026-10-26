import { z } from 'zod';

// Permission catalogue (PRD: "Permission codes use resource.action. Every endpoint checks one
// code server-side; roles are bundles of codes that a hotel can edit"). Every code in the
// PRD story tables is listed here, plus `device.manage` (T-011, approved). Platform codes
// belong to platform staff and can never be put in a hotel role.

export type PermissionGroup =
  | 'access'
  | 'rooms'
  | 'frontdesk'
  | 'money'
  | 'housekeeping'
  | 'control'
  | 'workforce'
  | 'pos'
  | 'events'
  | 'stock'
  | 'channels'
  | 'reports'
  | 'platform';

/** Strategy §5: sensitive permissions carry an amount, percentage or count limit. */
export type LimitKind = 'amount' | 'percent' | 'count';

export interface PermissionDef {
  code: string;
  group: PermissionGroup;
  label: string;
  limits?: readonly LimitKind[];
  /** Platform staff only; never in a hotel role. */
  platform?: true;
}

const p = (
  group: PermissionGroup,
  code: string,
  label: string,
  extra: Partial<Pick<PermissionDef, 'limits' | 'platform'>> = {},
): PermissionDef => ({ code, group, label, ...extra });

export const PERMISSIONS: readonly PermissionDef[] = [
  // Setup and access (M1)
  p('access', 'property.setup', 'Set up properties: details, tax, currency, checklist'),
  p('access', 'property.create', 'Add properties to the organisation'),
  p('access', 'import.run', 'Import rooms, rates, guests and balances from Excel'),
  p('access', 'user.invite', 'Invite staff'),
  p('access', 'role.assign', 'Give and remove staff roles; manage staff accounts'),
  p('access', 'role.manage', 'Edit roles: permissions and limits'),
  p('access', 'device.manage', 'Open a shared device for PIN switching'),
  p('access', 'approval.decide', 'Approve or reject requests'),
  p('access', 'approval.policy.manage', 'Configure approval policies'),
  p('access', 'audit.read', 'View the audit log'),
  // Rooms, rates and availability (M2)
  p('rooms', 'roomtype.manage', 'Manage room types'),
  p('rooms', 'room.manage', 'Manage rooms'),
  p('rooms', 'room.block', 'Put rooms out of order or service'),
  p('rooms', 'rate.manage', 'Manage rate plans and prices'),
  p('rooms', 'rate.overbook', 'Set overbooking limits'),
  p('rooms', 'availability.read', 'View availability'),
  p('rooms', 'allotment.manage', 'Manage allotments'),
  p('rooms', 'rate.group.manage', 'Manage group rates'),
  // Reservations and front desk (M3)
  p('frontdesk', 'frontdesk.read', 'View the front desk: arrivals, in-house, departures'),
  p('frontdesk', 'reservation.create', 'Create reservations'),
  p('frontdesk', 'reservation.modify', 'Change reservations'),
  p('frontdesk', 'reservation.cancel', 'Cancel reservations'),
  p('frontdesk', 'reservation.checkin', 'Check guests in'),
  p('frontdesk', 'reservation.checkout', 'Check guests out'),
  p('frontdesk', 'reservation.noshow', 'Mark no-shows'),
  p('frontdesk', 'reservation.dayuse', 'Sell day-use stays'),
  p('frontdesk', 'room.assign', 'Assign rooms'),
  p('frontdesk', 'room.move', 'Move guests between rooms', { limits: ['count'] }),
  p('frontdesk', 'guest.manage', 'Manage guest records'),
  p('frontdesk', 'guest.flag', 'Flag guests (VIP, do not rent)'),
  p('frontdesk', 'company.manage', 'Manage companies and travel agents'),
  p('frontdesk', 'group.manage', 'Manage group bookings'),
  p('frontdesk', 'key.issue', 'Issue room keys'),
  // Folios, payments and night audit (M4)
  p('money', 'folio.read', 'View folios'),
  p('money', 'folio.charge', 'Post charges'),
  p('money', 'folio.reverse', 'Void posted charges', { limits: ['amount'] }),
  p('money', 'folio.discount', 'Give discounts', { limits: ['percent', 'amount'] }),
  p('money', 'folio.route', 'Route and transfer folio charges', { limits: ['amount'] }),
  p('money', 'folio.backdate', 'Post to earlier business days', { limits: ['count'] }),
  p('money', 'folio.invoice', 'Issue invoices'),
  p('money', 'folio.house', 'Use house folios'),
  p('money', 'shift.open', 'Open a cashier shift'),
  p('money', 'shift.close', 'Close a cashier shift'),
  p('money', 'shift.signoff', 'Sign off cashier shifts'),
  p('money', 'shift.handover', 'Hand over cash'),
  p('money', 'payment.capture', 'Take payments'),
  p('money', 'payment.request', 'Send payment links'),
  p('money', 'payment.refund', 'Refund payments', { limits: ['amount'] }),
  p('money', 'audit.run', 'Run the night audit and close the day'),
  p('money', 'tax.manage', 'Manage taxes'),
  p('money', 'fx.manage', 'Set exchange rates'),
  p('money', 'ar.manage', 'Manage the city ledger'),
  p('money', 'ar.commission', 'Manage commissions'),
  p('money', 'recon.manage', 'Reconcile payments'),
  p('money', 'einvoice.submit', 'Submit e-invoices'),
  // Housekeeping and maintenance (M5)
  p('housekeeping', 'hk.read', 'View the room board'),
  p('housekeeping', 'hk.assign', 'Assign rooms to attendants'),
  p('housekeeping', 'hk.work', 'Clean assigned rooms'),
  p('housekeeping', 'hk.report', 'View housekeeping reports'),
  p('housekeeping', 'hk.inspect', 'Inspect rooms'),
  p('housekeeping', 'task.report', 'Report faults and requests'),
  p('housekeeping', 'wo.work', 'Work on work orders'),
  p('housekeeping', 'asset.manage', 'Manage assets'),
  p('housekeeping', 'pm.manage', 'Plan preventive maintenance'),
  p('housekeeping', 'utility.log', 'Log utilities and generator readings'),
  p('housekeeping', 'lostfound.manage', 'Manage lost and found'),
  // Tasks, handovers and control (M6)
  p('control', 'task.create', 'Create tasks'),
  p('control', 'task.assign', 'Assign tasks'),
  p('control', 'task.work', 'Work on assigned tasks'),
  p('control', 'task.verify', 'Verify or reopen resolved tasks'),
  p('control', 'handover.manage', 'Manage shift handovers'),
  p('control', 'leakage.review', 'Review revenue leakage alerts'),
  p('control', 'leakage.notify', 'Receive leakage notifications'),
  p('control', 'owner.read', 'Owner view'),
  p('control', 'checklist.manage', 'Manage checklists'),
  // Workforce (M7)
  p('workforce', 'staff.manage', 'Manage staff records'),
  p('workforce', 'staff.duty', 'Record duty status'),
  p('workforce', 'rota.manage', 'Plan rotas'),
  p('workforce', 'attendance.clock', 'Clock in and out'),
  p('workforce', 'leave.request', 'Request leave'),
  p('workforce', 'leave.approve', 'Approve leave'),
  p('workforce', 'timesheet.approve', 'Approve timesheets'),
  p('workforce', 'staff.payitem', 'Record pay items'),
  p('workforce', 'payroll.export', 'Export payroll'),
  p('workforce', 'staff.docs', 'Manage staff documents'),
  // Point of sale (M8)
  p('pos', 'pos.setup', 'Set up outlets and menus'),
  p('pos', 'pos.shift', 'Open and close outlet shifts'),
  p('pos', 'pos.order', 'Take orders'),
  p('pos', 'pos.void', 'Void orders', { limits: ['amount'] }),
  p('pos', 'pos.kitchen', 'Use the kitchen display'),
  p('pos', 'pos.recipe', 'Manage recipes'),
  // Events (M9)
  p('events', 'space.manage', 'Manage event spaces'),
  p('events', 'event.enquiry', 'Record event enquiries'),
  p('events', 'event.hold', 'Hold event spaces'),
  p('events', 'event.quote', 'Quote events'),
  p('events', 'event.contract', 'Issue event contracts'),
  p('events', 'event.confirm', 'Confirm events'),
  p('events', 'event.brief', 'Issue event briefs'),
  p('events', 'event.close', 'Close events'),
  p('events', 'service.manage', 'Manage services'),
  // Stock and expenses (M10)
  p('stock', 'stock.manage', 'Manage stock items'),
  p('stock', 'stock.requisition', 'Request stock'),
  p('stock', 'po.manage', 'Manage purchase orders'),
  p('stock', 'stock.receive', 'Receive stock'),
  p('stock', 'stock.count', 'Count stock'),
  p('stock', 'expense.manage', 'Record expenses'),
  p('stock', 'accounting.export', 'Export to accounting'),
  // Booking engine and messaging (M11)
  p('channels', 'bookingengine.manage', 'Manage the booking engine'),
  p('channels', 'message.send', 'Send guest messages'),
  p('channels', 'template.manage', 'Manage message templates'),
  // Reports (M12)
  p('reports', 'report.dashboard', 'View the manager dashboard'),
  p('reports', 'report.audit', 'View night audit reports'),
  p('reports', 'report.tax', 'View tax reports'),
  p('reports', 'report.ar', 'View city ledger reports'),
  p('reports', 'report.ops', 'View operations reports'),
  p('reports', 'report.flash', 'Receive the flash report'),
  p('reports', 'report.export', 'Export reports'),
  p('reports', 'report.group', 'View group reports'),
  p('reports', 'subscription.read', 'View the subscription and invoices'),
  // Platform (M13): platform staff only
  p('platform', 'platform.admin', 'Platform administration', { platform: true }),
  p('platform', 'platform.support', 'Platform support sessions', { platform: true }),
  p('platform', 'platform.billing', 'Platform billing', { platform: true }),
  p('platform', 'platform.flags', 'Platform feature flags', { platform: true }),
];

const BY_CODE = new Map(PERMISSIONS.map((def) => [def.code, def]));

export function permissionDef(code: string): PermissionDef | undefined {
  return BY_CODE.get(code);
}

/** Codes a hotel role may hold (everything except platform codes). */
export const HOTEL_PERMISSION_CODES: readonly string[] = PERMISSIONS.filter((d) => !d.platform).map(
  (d) => d.code,
);

export const HotelPermission = z
  .string()
  .refine((code) => permissionDef(code)?.platform === undefined && BY_CODE.has(code), {
    message: 'Unknown permission code',
  });

/** One code's limit: what the role may do without approval (Strategy §5). */
export const PermissionLimit = z
  .object({
    /** Money in minor units of the property currency. */
    maxAmountMinor: z
      .string()
      .regex(/^(0|[1-9]\d{0,17})$/)
      .optional(),
    /** Basis points: 1500 = 15%. */
    maxBps: z.number().int().min(0).max(10_000).optional(),
    maxCount: z.number().int().min(0).max(1000).optional(),
  })
  .refine((l) => Object.keys(l).length > 0, { message: 'Set at least one limit' });

const KIND_FIELD: Record<LimitKind, keyof z.infer<typeof PermissionLimit>> = {
  amount: 'maxAmountMinor',
  percent: 'maxBps',
  count: 'maxCount',
};

/** Limits keyed by permission code; only limit kinds that code supports. */
export const RoleLimits = z.record(z.string(), PermissionLimit).superRefine((limits, ctx) => {
  for (const [code, limit] of Object.entries(limits)) {
    const def = permissionDef(code);
    if (!def?.limits) {
      ctx.addIssue({ code: 'custom', path: [code], message: `${code} takes no limits` });
      continue;
    }
    const allowed = new Set(def.limits.map((k) => KIND_FIELD[k]));
    for (const field of Object.keys(limit)) {
      if (!allowed.has(field as keyof typeof limit)) {
        ctx.addIssue({ code: 'custom', path: [code, field], message: `${code} takes no ${field}` });
      }
    }
  }
});

export type RoleLimitsValue = z.infer<typeof RoleLimits>;
