import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import {
  HOMES,
  NAV_ITEMS,
  bottomBarItems,
  homeFor,
  landingPath,
  startPath,
  navItem,
  railItems,
} from './navigation.ts';

const ids = (items: { id: string }[]) => items.map((i) => i.id);

// Permission sets shaped like the tab 5 roles (codes from the PRD).
const ROLE = {
  owner: [
    'owner.read',
    'report.dashboard',
    'leakage.review',
    'approval.decide',
    'audit.run',
    'frontdesk.read',
  ],
  gm: [
    'report.dashboard',
    'task.assign',
    'approval.decide',
    'audit.run',
    'frontdesk.read',
    'rate.manage',
  ],
  nightAuditor: ['audit.run', 'report.audit', 'frontdesk.read', 'folio.read'],
  frontDesk: ['frontdesk.read', 'reservation.create', 'folio.read', 'shift.open'],
  finance: ['folio.read', 'shift.open', 'report.tax', 'tax.manage'],
  hkSupervisor: ['hk.read', 'hk.assign', 'task.assign'],
  attendant: ['hk.work', 'task.report'],
  maintenance: ['task.work', 'task.report'],
};

describe('homeFor (tab 5 role home screens)', () => {
  it.each([
    ['owner', ROLE.owner, '/owner'],
    ['general manager', ROLE.gm, '/dashboard'],
    ['night auditor', ROLE.nightAuditor, '/night-audit'],
    ['front desk / cashier', ROLE.frontDesk, '/front-desk'],
    ['finance', ROLE.finance, '/folios'],
    ['housekeeping supervisor', ROLE.hkSupervisor, '/housekeeping'],
    ['attendant', ROLE.attendant, '/my-rooms'],
    ['maintenance', ROLE.maintenance, '/tasks?assignee=me'],
    ['anyone else', [], '/tasks'],
  ])('lands a %s on %s', (_role, permissions, path) => {
    expect(landingPath(permissions)).toBe(path);
  });

  it('decides by permission, not role name, so the highest-priority code wins', () => {
    // A GM who also runs night audit still lands on the manager dashboard.
    expect(homeFor(['audit.run', 'report.dashboard']).key).toBe('manager');
  });
});

describe('bottomBarItems (tab 5 "Bottom bar on phone", V1 items)', () => {
  it.each([
    ['owner', ROLE.owner, ['owner-home', 'leakage', 'approvals', 'reports']],
    [
      'general manager',
      ['report.dashboard', 'task.create', 'approval.decide'],
      ['dashboard', 'tasks', 'approvals', 'reports'],
    ],
    ['front desk', ROLE.frontDesk, ['arrivals', 'in-house', 'calendar', 'folios']],
    ['night auditor', ROLE.nightAuditor, ['night-audit', 'audit-exceptions', 'reports']],
    [
      'housekeeping supervisor',
      ['hk.read', 'hk.assign', 'task.create'],
      ['housekeeping', 'hk-assign', 'tasks'],
    ],
    ['attendant', ROLE.attendant, ['my-rooms', 'report-fault']],
    ['maintenance', ROLE.maintenance, ['my-jobs', 'report-fault']],
  ])('gives a %s the right items', (_role, permissions, expected) => {
    expect(ids(bottomBarItems(permissions))).toEqual(expected);
  });

  it('drops items the user cannot open', () => {
    // Owner without approval rights: no Approvals tab.
    expect(ids(bottomBarItems(['owner.read', 'leakage.review']))).toEqual([
      'owner-home',
      'leakage',
    ]);
  });
});

describe('railItems', () => {
  it('shows only permitted items, in groups', () => {
    // An attendant sees only their own rooms.
    expect(railItems(['hk.work', 'task.report']).map((g) => [g.group, ids(g.items)])).toEqual([
      ['operations', ['my-rooms']],
    ]);
    const groups = railItems(['frontdesk.read', 'rate.manage', 'audit.read']);
    expect(groups.map((g) => [g.group, ids(g.items)])).toEqual([
      ['operations', ['front-desk', 'calendar', 'reservations']],
      ['revenue', ['rates']],
      ['admin', ['audit-log']],
    ]);
  });

  it('never puts tab-only items (arrivals, exceptions…) in the rail', () => {
    const everything = NAV_ITEMS.flatMap((i) => i.anyOf);
    const railIds = railItems(everything).flatMap((g) => ids(g.items));
    expect(railIds).not.toContain('arrivals');
    expect(railIds).not.toContain('audit-exceptions');
  });
});

describe('navigation data', () => {
  it('has unique ids and unique rail paths', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.id)).size).toBe(NAV_ITEMS.length);
    const railPaths = NAV_ITEMS.filter((i) => i.group !== null).map((i) => i.path);
    expect(new Set(railPaths).size).toBe(railPaths.length);
  });

  it('references only known items from every home', () => {
    for (const home of HOMES) {
      for (const id of [home.landing, ...home.bottomBar]) expect(() => navItem(id)).not.toThrow();
    }
  });

  it('has an English label for every item and group', () => {
    for (const item of NAV_ITEMS) expect(en.nav).toHaveProperty(item.id);
    for (const group of ['operations', 'revenue', 'admin'])
      expect(en.navGroup).toHaveProperty(group);
  });

  it('cites a tab 5 screen and a backlog ticket for every item', () => {
    for (const item of NAV_ITEMS) {
      expect(item.screen).toMatch(/^S\d{2}$/);
      expect(item.ticket).toMatch(/^T-\d{3}$/);
    }
  });
});

describe('startPath (M1-02)', () => {
  it('opens the setup wizard while the property is in setup, for people who can finish it', () => {
    expect(startPath(['property.setup', 'owner.read'], 'SETUP')).toBe('/onboarding');
    expect(startPath(['property.setup', 'owner.read'], 'LIVE')).toBe('/owner');
    expect(startPath(['frontdesk.read'], 'SETUP')).toBe('/front-desk');
    expect(startPath(['property.setup'], null)).toBe('/tasks');
  });
});
