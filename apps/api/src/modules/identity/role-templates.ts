// Role and department templates every new organisation starts with (Strategy §5; PRD M1-05
// lets the owner edit them). Used by sign-up and by the demo seed.
//
// PROVISIONAL permission lists: T-013 builds the permission catalogue and replaces these.
// They use the PRD codes the web navigation already checks, so a signed-in user sees the
// screens their role is meant for. `device.manage` (T-011) lets a manager open a shared
// device that staff switch into with a PIN.

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

const FRONT_DESK = ['frontdesk.read', 'reservation.create', 'folio.read', 'shift.open'] as const;
const REPORTING = ['report.dashboard', 'report.audit', 'report.tax', 'report.flash'] as const;

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    name: 'Owner',
    slug: 'owner',
    requiresMfa: true,
    orgWide: true,
    department: null,
    permissions: [
      'owner.read',
      ...REPORTING,
      ...FRONT_DESK,
      'audit.run',
      'hk.read',
      'hk.assign',
      'task.create',
      'task.assign',
      'task.report',
      'handover.manage',
      'device.manage',
      'approval.decide',
      'approval.policy.manage',
      'leakage.review',
      'rate.manage',
      'message.send',
      'template.manage',
      'room.manage',
      'roomtype.manage',
      'tax.manage',
      'fx.manage',
      'property.setup',
      'user.invite',
      'role.assign',
      'role.manage',
      'import.run',
      'subscription.read',
      'audit.read',
    ],
  },
  {
    name: 'General Manager',
    slug: 'gm',
    requiresMfa: true,
    orgWide: false,
    department: 'MGT',
    permissions: [
      ...REPORTING,
      ...FRONT_DESK,
      'audit.run',
      'hk.read',
      'hk.assign',
      'task.create',
      'task.assign',
      'task.report',
      'handover.manage',
      'device.manage',
      'approval.decide',
      'leakage.review',
      'rate.manage',
      'message.send',
      'room.manage',
      'property.setup',
      'user.invite',
      'role.assign',
      'audit.read',
    ],
  },
  {
    name: 'Night Auditor',
    slug: 'night-auditor',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
    permissions: ['audit.run', 'report.audit', 'frontdesk.read', 'folio.read', 'task.report'],
  },
  {
    name: 'Front Desk / Cashier',
    slug: 'front-desk',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
    permissions: [...FRONT_DESK, 'message.send', 'task.report'],
  },
  {
    name: 'Reservations Agent',
    slug: 'reservations',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
    permissions: ['frontdesk.read', 'reservation.create', 'message.send', 'task.report'],
  },
  {
    name: 'Finance',
    slug: 'finance',
    requiresMfa: true,
    orgWide: false,
    department: 'FIN',
    permissions: [
      'folio.read',
      'shift.open',
      'report.tax',
      'report.audit',
      'tax.manage',
      'fx.manage',
      'task.report',
    ],
  },
  {
    name: 'Housekeeping Supervisor',
    slug: 'hk-supervisor',
    requiresMfa: false,
    orgWide: false,
    department: 'HK',
    permissions: [
      'hk.read',
      'hk.assign',
      'task.create',
      'task.assign',
      'task.report',
      'handover.manage',
      'device.manage',
    ],
  },
  {
    name: 'Housekeeping Attendant',
    slug: 'hk-attendant',
    requiresMfa: false,
    orgWide: false,
    department: 'HK',
    permissions: ['hk.work', 'task.report'],
  },
  {
    name: 'Maintenance',
    slug: 'maintenance',
    requiresMfa: false,
    orgWide: false,
    department: 'MNT',
    permissions: ['task.work', 'task.report'],
  },
  {
    name: 'Department Manager',
    slug: 'dept-manager',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
    permissions: ['task.create', 'task.assign', 'task.report', 'handover.manage', 'device.manage'],
  },
  {
    name: 'Staff Member',
    slug: 'staff',
    requiresMfa: false,
    orgWide: false,
    department: 'FO',
    permissions: ['task.report'],
  },
  {
    name: 'Auditor (read-only)',
    slug: 'auditor',
    requiresMfa: false,
    orgWide: true,
    department: null,
    permissions: ['audit.read', 'report.audit', 'folio.read'],
  },
];

export function roleTemplate(slug: string): RoleTemplate {
  const template = ROLE_TEMPLATES.find((t) => t.slug === slug);
  if (!template) throw new Error(`Unknown role template ${slug}`);
  return template;
}
