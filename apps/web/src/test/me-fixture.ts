import type { MeResponse } from '../app/session.ts';

export const ORG = '0d0d0d0d-0000-4000-8000-000000000001';
export const LAGOS = '0d0d0d0d-0000-4000-8000-000000000002';
export const ABUJA = '0d0d0d0d-0000-4000-8000-000000000003';

const property = (id: string, name: string, code: string) => ({
  id,
  organisationId: ORG,
  code,
  name,
  status: 'LIVE' as const,
  timeZone: 'Africa/Lagos',
  baseCurrency: 'NGN',
  locale: 'en-NG',
  registrationFields: [
    'nationality',
    'purpose',
    'idType',
    'idNumber',
  ] as MeResponse['properties'][number]['registrationFields'],
});

export const LAGOS_PROPERTY = property(LAGOS, 'Lagos Hotel', 'LAG');
export const ABUJA_PROPERTY = property(ABUJA, 'Abuja Hotel', 'ABJ');

type Membership = MeResponse['memberships'][number];

export function membership(
  propertyId: string | null,
  permissions: string[],
  organisationId = ORG,
): Membership {
  return {
    organisationId,
    propertyId,
    role: { id: crypto.randomUUID(), name: 'Role', requiresMfa: false, permissions },
  };
}

/** A GET /me answer; defaults to a front-desk user at the Lagos property. */
export function makeMe(over: Partial<MeResponse> = {}): MeResponse {
  return {
    user: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Ada Obi',
      email: 'ada@example.test',
      phone: null,
      mfaEnabled: false,
    },
    session: {
      id: '22222222-2222-4222-8222-222222222222',
      sharedDevice: false,
      mfaPassed: true,
      pinSwitchAvailable: false,
      expiresAt: '2026-12-12T09:00:00.000Z',
    },
    organisations: [{ id: ORG, name: 'Obi Hotels' }],
    properties: [LAGOS_PROPERTY],
    memberships: [membership(LAGOS, ['frontdesk.read', 'folio.read'])],
    ...over,
  };
}
