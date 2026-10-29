import { HOTEL_PERMISSION_CODES } from '@hotel/shared';

// Role and department templates every new organisation starts with (Strategy §5 "Roles and
// permissions"; PRD M1-05 lets the owner edit them). Used by sign-up and by the demo seed.
// Codes come from the permission catalogue in @hotel/shared; each role gets what its
// Strategy §5 "key permissions" describe. Limits start empty: approval policies supply the
// thresholds until an owner sets role limits (spec issue 21).

export const DEPARTMENT_TEMPLATES = [
  { code: 'MGT', name: 'Management' },
  { code: 'FO', name: 'Front office' },
  { code: 'HK', name: 'Housekeeping' },
  { code: 'MNT', name: 'Maintenance' },
  { code: 'FIN', name: 'Finance' },
] as const;

export type DepartmentCode = (typeof DEPARTMENT_TEMPLATES)[number]['code'];

export interface RoleTemplate {
  name: string;
  /** Stable key for code and seed data (role names are editable). */
  slug: string;
  /** MFA is mandatory for owner, GM, finance and admin roles (M1-06). */
  requiresMfa: boolean;
  /** Org-wide roles apply to every property. */
  orgWide: boolean;
  department: DepartmentCode | null;
  permissions: readonly string[];
}

/** Everyone who works shifts. */
const SELF_SERVICE = ['task.report', 'attendance.clock', 'leave.request'] as const;

/** Owner-only: the organisation, its subscription, roles and approval policies. */
const OWNER_ONLY = new Set([
  'role.manage',
  'property.create',
  'approval.policy.manage',
  'subscription.read',
  'owner.read',
  'report.group',
]);

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    // Properties, subscription, group reports, access, owner approvals
    name: 'Owner',
    slug: 'owner',
    requiresMfa: true,
    orgWide: true,
    department: null,
    permissions: HOTEL_PERMISSION_CODES,
  },
  {
    // Operations, rates, staff, reports, approvals within limits
    name: 'General Manager',
    slug: 'gm',
    requiresMfa: true,
    orgWide: false,
    department: 'MGT',
    permissions: HOTEL_PERMISSION_CODES.filter((code) => !OWNER_ONLY.has(code)),
  },
  {
    // Run night audit, review exceptions, close the business day
    name: 'Night Auditor',
    slug: 'night-auditor',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
    permissions: [
      'audit.run',
      'frontdesk.read',
      'availability.read',
      'reservation.noshow',
      'folio.read',
      'folio.charge',
      'payment.capture',
      'shift.open',
      'shift.close',
      'report.audit',
      'report.flash',
      ...SELF_SERVICE,
    ],
  },
  {
    // Reservations, check-in/out, charges, payments within own shift
    name: 'Front Desk / Cashier',
    slug: 'front-desk',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
    permissions: [
      'frontdesk.read',
      'availability.read',
      'reservation.create',
      'reservation.modify',
      'reservation.cancel',
      'reservation.checkin',
      'reservation.checkout',
      'reservation.noshow',
      'reservation.dayuse',
      'room.assign',
      'room.move',
      'guest.manage',
      'key.issue',
      'folio.read',
      'folio.charge',
      'folio.discount',
      'folio.route',
      'folio.invoice',
      'payment.capture',
      'payment.request',
      'shift.open',
      'shift.close',
      'shift.handover',
      'message.send',
      ...SELF_SERVICE,
    ],
  },
  {
    // Availability, bookings, group blocks, guest records
    name: 'Reservations Agent',
    slug: 'reservations',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
    permissions: [
      'frontdesk.read',
      'availability.read',
      'reservation.create',
      'reservation.modify',
      'reservation.cancel',
      'group.manage',
      'guest.manage',
      'company.manage',
      'payment.request',
      'message.send',
      ...SELF_SERVICE,
    ],
  },
  {
    // Folios, city ledger, refunds within limits, expenses, reconciliation, tax reports
    name: 'Finance',
    slug: 'finance',
    requiresMfa: true,
    orgWide: false,
    department: 'FIN',
    permissions: [
      'folio.read',
      'folio.invoice',
      'folio.house',
      'folio.reverse',
      'payment.capture',
      'payment.refund',
      'shift.open',
      'shift.signoff',
      'ar.manage',
      'ar.commission',
      'recon.manage',
      'einvoice.submit',
      'tax.manage',
      'fx.manage',
      'expense.manage',
      'accounting.export',
      'report.tax',
      'report.ar',
      'report.audit',
      'report.flash',
      'report.export',
      ...SELF_SERVICE,
    ],
  },
  {
    // Room status, checklists, inspections, lost and found, minibar
    name: 'Housekeeping Supervisor',
    slug: 'hk-supervisor',
    requiresMfa: false,
    orgWide: false,
    department: 'HK',
    permissions: [
      'hk.read',
      'hk.assign',
      'hk.inspect',
      'hk.report',
      'room.block',
      'lostfound.manage',
      'checklist.manage',
      'task.create',
      'task.assign',
      'task.verify',
      'handover.manage',
      'device.manage',
      ...SELF_SERVICE,
    ],
  },
  {
    name: 'Housekeeping Attendant',
    slug: 'hk-attendant',
    requiresMfa: false,
    orgWide: false,
    department: 'HK',
    permissions: ['hk.work', 'lostfound.manage', ...SELF_SERVICE],
  },
  {
    // Work orders, assets, parts, generator log
    name: 'Maintenance',
    slug: 'maintenance',
    requiresMfa: false,
    orgWide: false,
    department: 'MNT',
    permissions: [
      'wo.work',
      'task.work',
      'asset.manage',
      'pm.manage',
      'utility.log',
      ...SELF_SERVICE,
    ],
  },
  {
    // Task queue, assignments, department approvals
    name: 'Department Manager',
    slug: 'dept-manager',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
    permissions: [
      'task.create',
      'task.assign',
      'task.verify',
      'handover.manage',
      'device.manage',
      'rota.manage',
      'leave.approve',
      'timesheet.approve',
      'report.ops',
      ...SELF_SERVICE,
    ],
  },
  {
    // Own tasks, attendance, leave, handovers
    name: 'Staff Member',
    slug: 'staff',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
    permissions: ['task.work', ...SELF_SERVICE],
  },
  {
    // Reports and records, no changes
    name: 'Auditor (read-only)',
    slug: 'auditor',
    requiresMfa: false,
    orgWide: true,
    department: null,
    permissions: [
      'audit.read',
      'frontdesk.read',
      'availability.read',
      'folio.read',
      'hk.read',
      'report.dashboard',
      'report.audit',
      'report.tax',
      'report.ar',
      'report.ops',
      'report.flash',
      'report.export',
    ],
  },
];

export function roleTemplate(slug: string): RoleTemplate {
  const template = ROLE_TEMPLATES.find((t) => t.slug === slug);
  if (!template) throw new Error(`Unknown role template ${slug}`);
  return template;
}

/** The Owner role keeps these so an organisation can never lock itself out (M1-05). */
export const OWNER_ROLE_NAME = 'Owner';
export const OWNER_LOCKED_PERMISSIONS = ['role.manage', 'role.assign', 'user.invite'] as const;
