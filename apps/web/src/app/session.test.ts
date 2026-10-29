import { describe, expect, it } from 'vitest';
import {
  ABUJA,
  ABUJA_PROPERTY,
  LAGOS,
  LAGOS_PROPERTY,
  makeMe,
  membership,
} from '../test/me-fixture.ts';
import { safeNext } from './session-gate.tsx';
import { toShellSession } from './session.ts';

const OTHER_ORG = '0d0d0d0d-0000-4000-8000-0000000000ff';

describe('toShellSession', () => {
  const me = makeMe({
    properties: [LAGOS_PROPERTY, ABUJA_PROPERTY],
    memberships: [
      membership(null, ['owner.read', 'report.dashboard']), // organisation-wide
      membership(LAGOS, ['frontdesk.read']),
      membership(ABUJA, ['hk.read']),
      membership(null, ['platform.admin'], OTHER_ORG), // another organisation
    ],
  });

  it('uses the remembered property, else the first', () => {
    expect(toShellSession(me, ABUJA).currentPropertyId).toBe(ABUJA);
    expect(toShellSession(me, null).currentPropertyId).toBe(LAGOS);
    // A property the user no longer has falls back to the first.
    expect(toShellSession(me, '99999999-9999-4999-8999-999999999999').currentPropertyId).toBe(
      LAGOS,
    );
  });

  it('grants organisation-wide roles plus the roles for that property only', () => {
    expect(toShellSession(me, LAGOS).permissions).toEqual([
      'frontdesk.read',
      'owner.read',
      'report.dashboard',
    ]);
    expect(toShellSession(me, ABUJA).permissions).toEqual([
      'hk.read',
      'owner.read',
      'report.dashboard',
    ]);
  });

  it('maps the user, properties and placeholders for later tickets', () => {
    expect(toShellSession(me, LAGOS)).toMatchObject({
      userName: 'Ada Obi',
      properties: [
        {
          id: LAGOS,
          code: 'LAG',
          name: 'Lagos Hotel',
          timeZone: 'Africa/Lagos',
          baseCurrency: 'NGN',
          locale: 'en-NG',
        },
        expect.objectContaining({ id: ABUJA }),
      ],
      businessDate: null,
      pendingApprovals: 0,
      openAlerts: 0,
      preview: false,
    });
  });

  it('takes the business date of the current property (T-054)', () => {
    const live = makeMe({
      properties: [{ ...LAGOS_PROPERTY, businessDate: '2026-11-12' }, ABUJA_PROPERTY],
      memberships: [membership(LAGOS, ['frontdesk.read']), membership(ABUJA, ['frontdesk.read'])],
    });
    expect(toShellSession(live, LAGOS).businessDate).toBe('2026-11-12');
    expect(toShellSession(live, ABUJA).businessDate).toBeNull();
  });

  it('handles a user with no property yet', () => {
    const session = toShellSession(makeMe({ properties: [], memberships: [] }), null);
    expect(session).toMatchObject({ currentPropertyId: null, permissions: [], properties: [] });
  });
});

describe('safeNext', () => {
  it.each([
    ['/front-desk?tab=arrivals', '/front-desk?tab=arrivals'],
    [null, '/'],
    ['//evil.example/phish', '/'],
    ['https://evil.example', '/'],
  ])('%s → %s', (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });
});
