// Navigation model for the app shell (spec tab 5): menu items, role home screens and the
// phone bottom bar. Pure data + functions so it is unit-tested without rendering.
//
// Roles are hotel-editable bundles of permission codes, so the home screen is chosen from the
// user's permissions (priority order mirrors the tab 5 "Role home screens" table), not from
// the role's name. Spec issue 30.
//
// Permission codes follow the PRD; T-013 builds the permission catalogue and may adjust them.

export type NavGroup = 'operations' | 'revenue' | 'admin';

export interface NavItem {
  id: string;
  /** Route path; may carry a query for tabs inside one screen. */
  path: string;
  /** Visible if the user holds any of these codes. */
  anyOf: readonly string[];
  /** Left-rail group; null = only reachable from the phone bottom bar. */
  group: NavGroup | null;
  /** Tab 5 screen number and the backlog ticket that builds it. */
  screen: string;
  ticket: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'owner-home',
    path: '/owner',
    anyOf: ['owner.read'],
    group: 'operations',
    screen: 'S04',
    ticket: 'T-091',
  },
  {
    id: 'dashboard',
    path: '/dashboard',
    anyOf: ['report.dashboard'],
    group: 'operations',
    screen: 'S05',
    ticket: 'T-092',
  },
  {
    id: 'front-desk',
    path: '/front-desk',
    anyOf: ['frontdesk.read'],
    group: 'operations',
    screen: 'S06',
    ticket: 'T-053',
  },
  {
    id: 'arrivals',
    path: '/front-desk?tab=arrivals',
    anyOf: ['frontdesk.read'],
    group: null,
    screen: 'S06',
    ticket: 'T-053',
  },
  {
    id: 'in-house',
    path: '/front-desk?tab=in-house',
    anyOf: ['frontdesk.read'],
    group: null,
    screen: 'S06',
    ticket: 'T-053',
  },
  {
    id: 'calendar',
    path: '/calendar',
    anyOf: ['frontdesk.read', 'reservation.create'],
    group: 'operations',
    screen: 'S07',
    ticket: 'T-044',
  },
  {
    id: 'new-booking',
    path: '/bookings/new',
    anyOf: ['reservation.create'],
    group: 'operations',
    screen: 'S08',
    ticket: 'T-044',
  },
  {
    id: 'folios',
    path: '/folios',
    anyOf: ['folio.read'],
    group: 'revenue',
    screen: 'S11',
    ticket: 'T-060',
  },
  {
    id: 'shift',
    path: '/shift',
    anyOf: ['shift.open'],
    group: 'revenue',
    screen: 'S14',
    ticket: 'T-061',
  },
  {
    id: 'night-audit',
    path: '/night-audit',
    anyOf: ['audit.run'],
    group: 'operations',
    screen: 'S15',
    ticket: 'T-073',
  },
  {
    id: 'audit-exceptions',
    path: '/night-audit?view=exceptions',
    anyOf: ['audit.run'],
    group: null,
    screen: 'S15',
    ticket: 'T-073',
  },
  {
    id: 'housekeeping',
    path: '/housekeeping',
    anyOf: ['hk.read'],
    group: 'operations',
    screen: 'S16',
    ticket: 'T-080',
  },
  {
    id: 'hk-assign',
    path: '/housekeeping?view=assign',
    anyOf: ['hk.assign'],
    group: null,
    screen: 'S16',
    ticket: 'T-080',
  },
  {
    id: 'my-rooms',
    path: '/my-rooms',
    anyOf: ['hk.work'],
    group: 'operations',
    screen: 'S17',
    ticket: 'T-080',
  },
  {
    id: 'tasks',
    path: '/tasks',
    anyOf: ['task.create', 'task.work', 'task.assign'],
    group: 'operations',
    screen: 'S18',
    ticket: 'T-082',
  },
  {
    id: 'my-jobs',
    path: '/tasks?assignee=me',
    anyOf: ['task.work'],
    group: null,
    screen: 'S18',
    ticket: 'T-082',
  },
  {
    id: 'report-fault',
    path: '/tasks/new?type=FAULT',
    anyOf: ['task.report', 'task.create'],
    group: null,
    screen: 'S19',
    ticket: 'T-082',
  },
  {
    id: 'handovers',
    path: '/handovers',
    anyOf: ['handover.manage'],
    group: 'operations',
    screen: 'S20',
    ticket: 'T-083',
  },
  {
    id: 'approvals',
    path: '/approvals',
    anyOf: ['approval.decide'],
    group: 'operations',
    screen: 'S21',
    ticket: 'T-022',
  },
  {
    id: 'leakage',
    path: '/leakage',
    anyOf: ['leakage.review'],
    group: 'operations',
    screen: 'S22',
    ticket: 'T-090',
  },
  {
    id: 'rates',
    path: '/rates',
    anyOf: ['rate.manage'],
    group: 'revenue',
    screen: 'S23',
    ticket: 'T-033',
  },
  {
    id: 'reports',
    path: '/reports',
    anyOf: ['report.dashboard', 'report.audit', 'report.tax', 'report.flash'],
    group: 'revenue',
    screen: 'S28',
    ticket: 'T-092',
  },
  {
    id: 'messages',
    path: '/messages',
    anyOf: ['message.send', 'template.manage'],
    group: 'operations',
    screen: 'S29',
    ticket: 'T-024',
  },
  {
    id: 'settings-rooms',
    path: '/settings/rooms',
    anyOf: ['room.manage', 'roomtype.manage'],
    group: 'admin',
    screen: 'S24',
    ticket: 'T-031',
  },
  {
    id: 'settings-finance',
    path: '/settings/finance',
    anyOf: ['tax.manage', 'fx.manage'],
    group: 'admin',
    screen: 'S25',
    ticket: 'T-032',
  },
  {
    id: 'setup',
    path: '/onboarding',
    anyOf: ['property.setup'],
    group: 'admin',
    screen: 'S02',
    ticket: 'T-030',
  },
  {
    id: 'settings-access',
    path: '/settings/access',
    anyOf: ['role.manage', 'user.invite'],
    group: 'admin',
    screen: 'S26',
    ticket: 'T-013',
  },
  {
    id: 'settings-imports',
    path: '/settings/imports',
    anyOf: ['import.run'],
    group: 'admin',
    screen: 'S03',
    ticket: 'T-034',
  },
  {
    id: 'settings-billing',
    path: '/settings/billing',
    anyOf: ['subscription.read'],
    group: 'admin',
    screen: 'S30',
    ticket: 'T-100',
  },
  {
    id: 'audit-log',
    path: '/audit',
    anyOf: ['audit.read'],
    group: 'admin',
    screen: 'S27',
    ticket: 'T-014',
  },
  {
    id: 'platform',
    path: '/platform',
    anyOf: ['platform.admin'],
    group: 'admin',
    screen: 'S31',
    ticket: 'T-100',
  },
];

export type HomeKey =
  | 'owner'
  | 'manager'
  | 'night-audit'
  | 'front-desk'
  | 'finance'
  | 'housekeeping'
  | 'attendant'
  | 'maintenance'
  | 'staff';

interface Home {
  key: HomeKey;
  /** First permission (in priority order) that selects this home. */
  when: string | null;
  /** Nav item the user lands on. */
  landing: string;
  /** Phone bottom bar, tab 5 "Bottom bar on phone" (V1 items only). */
  bottomBar: readonly string[];
}

/** Priority order: the first home whose `when` code the user holds wins. */
export const HOMES: readonly Home[] = [
  {
    key: 'owner',
    when: 'owner.read',
    landing: 'owner-home',
    bottomBar: ['owner-home', 'leakage', 'approvals', 'reports'],
  },
  {
    key: 'manager',
    when: 'report.dashboard',
    landing: 'dashboard',
    bottomBar: ['dashboard', 'tasks', 'approvals', 'reports'],
  },
  {
    key: 'night-audit',
    when: 'audit.run',
    landing: 'night-audit',
    bottomBar: ['night-audit', 'audit-exceptions', 'reports'],
  },
  {
    key: 'front-desk',
    when: 'frontdesk.read',
    landing: 'front-desk',
    bottomBar: ['arrivals', 'in-house', 'calendar', 'folios'],
  },
  // Tab 5 has a "Finance home" with no route; the folio list stands in (spec issue 30).
  {
    key: 'finance',
    when: 'folio.read',
    landing: 'folios',
    bottomBar: ['folios', 'shift', 'reports'],
  },
  {
    key: 'housekeeping',
    when: 'hk.assign',
    landing: 'housekeeping',
    bottomBar: ['housekeeping', 'hk-assign', 'tasks'],
  },
  {
    key: 'attendant',
    when: 'hk.work',
    landing: 'my-rooms',
    bottomBar: ['my-rooms', 'report-fault'],
  },
  {
    key: 'maintenance',
    when: 'task.work',
    landing: 'my-jobs',
    bottomBar: ['my-jobs', 'report-fault'],
  },
  { key: 'staff', when: null, landing: 'tasks', bottomBar: ['tasks', 'report-fault'] },
];

const byId = new Map(NAV_ITEMS.map((item) => [item.id, item]));

export function navItem(id: string): NavItem {
  const item = byId.get(id);
  if (!item) throw new Error(`Unknown nav item ${id}`);
  return item;
}

function canSee(item: NavItem, permissions: ReadonlySet<string>): boolean {
  return item.anyOf.some((code) => permissions.has(code));
}

export function homeFor(permissions: Iterable<string>): Home {
  const held = new Set(permissions);
  const home = HOMES.find((h) => h.when === null || held.has(h.when));
  // The last entry has `when: null`, so find() always succeeds.
  return home ?? (HOMES[HOMES.length - 1] as Home);
}

/** Left-rail items the user may see, grouped in display order. */
export function railItems(permissions: Iterable<string>): { group: NavGroup; items: NavItem[] }[] {
  const held = new Set(permissions);
  const groups: NavGroup[] = ['operations', 'revenue', 'admin'];
  return groups
    .map((group) => ({
      group,
      items: NAV_ITEMS.filter((item) => item.group === group && canSee(item, held)),
    }))
    .filter((g) => g.items.length > 0);
}

/** Phone bottom bar for the user's home, minus anything they can't open. */
export function bottomBarItems(permissions: Iterable<string>): NavItem[] {
  const held = new Set(permissions);
  return homeFor(held)
    .bottomBar.map(navItem)
    .filter((item) => canSee(item, held));
}

export function landingPath(permissions: Iterable<string>): string {
  return navItem(homeFor(permissions).landing).path;
}

/**
 * Where `/` goes: the setup wizard while the property is in setup and the user can finish it
 * (M1-02), else the role's home screen.
 */
export function startPath(permissions: Iterable<string>, propertyStatus: string | null): string {
  const held = new Set(permissions);
  if (propertyStatus === 'SETUP' && held.has('property.setup')) return navItem('setup').path;
  return landingPath(held);
}
