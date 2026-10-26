import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/query-client.ts';
import { routes } from '../../app/routes.tsx';
import { setApiPropertyId } from '../../lib/api.ts';
import { LAGOS, makeMe, membership } from '../../test/me-fixture.ts';

// S26 Users and roles, and invitation acceptance, with the real router; fake network.

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const apiError = (status: number, code: string, message: string, details?: object) =>
  json(status, {
    error: { code, message, requestId: 'req_test', ...(details ? { details } : {}) },
  });

const GM_PERMS = [
  'role.assign',
  'user.invite',
  'frontdesk.read',
  'folio.read',
  'folio.discount',
  'hk.read',
];
const ROLE = (id: string, name: string, permissions: string[], extra: object = {}) => ({
  id,
  name,
  isSystem: true,
  requiresMfa: false,
  permissions,
  limits: {},
  memberCount: 1,
  ...extra,
});
const ROLES = [
  ROLE('11111111-0000-4000-8000-000000000001', 'Owner', ['role.manage', ...GM_PERMS], {
    requiresMfa: true,
  }),
  ROLE('11111111-0000-4000-8000-000000000002', 'Front Desk / Cashier', [
    'frontdesk.read',
    'folio.read',
  ]),
  ROLE('11111111-0000-4000-8000-000000000003', 'Housekeeping Supervisor', ['hk.read']),
];
const [OWNER_ROLE, FD_ROLE, HK_ROLE] = ROLES.map((r) => r.id) as [string, string, string];
const STAFF = {
  id: '22222222-0000-4000-8000-000000000001',
  name: 'Chidi Eze',
  email: 'chidi@example.test',
  phone: null,
  status: 'ACTIVE',
  mfaEnabled: true,
  lastLoginAt: null,
  roles: [
    {
      membershipId: '33333333-0000-4000-8000-000000000001',
      roleId: FD_ROLE,
      roleName: 'Front Desk / Cashier',
      scope: 'PROPERTY',
    },
  ],
  canManage: true,
};
const OWNER = {
  ...STAFF,
  id: '22222222-0000-4000-8000-000000000002',
  name: 'Ada Obi',
  email: 'ada@example.test',
  roles: [
    {
      membershipId: '33333333-0000-4000-8000-000000000002',
      roleId: OWNER_ROLE,
      roleName: 'Owner',
      scope: 'ORGANISATION',
    },
  ],
  canManage: false,
};

let handlers: Record<string, (body: unknown) => Response>;
const calls: { key: string; body: unknown; headers: Headers }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, GM_PERMS)] })),
    'GET /roles': () => json(200, { data: ROLES }),
    'GET /users': () => json(200, { data: [OWNER, STAFF], nextCursor: null }),
    'GET /users/invitations': () => json(200, { data: [] }),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const key = `${init.method} ${new URL(url, 'http://app.test').pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body, headers: new Headers(init.headers) });
      const handler = handlers[key];
      if (!handler) return Promise.reject(new Error(`Unexpected request ${key}`));
      return Promise.resolve(handler(body));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setApiPropertyId(null);
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('Users and roles (S26)', () => {
  it('shows the tabs the user’s permissions allow', async () => {
    handlers['GET /me'] = () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['user.invite', 'frontdesk.read'])] }));
    renderAt('/settings/access');
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Invitations']);
  });

  it('lists people and offers Manage only for those the user may change', async () => {
    renderAt('/settings/access');
    const list = await within(await screen.findByRole('tabpanel')).findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByText(/Obi|Eze/).textContent)).toEqual([
      'Ada Obi',
      'Chidi Eze',
    ]);
    expect(
      within(rows[0] as HTMLElement).queryByRole('button', { name: 'Manage' }),
    ).not.toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('Owner · all properties')).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).getByRole('button', { name: 'Manage' }),
    ).toBeInTheDocument();
    // Requests carry the current property.
    expect(sent('GET /users')[0]?.headers.get('X-Property-Id')).toBe(LAGOS);
  });

  it('gives only roles within the user’s own permissions, and saves', async () => {
    handlers['PATCH /users/22222222-0000-4000-8000-000000000001'] = () => json(200, STAFF);
    renderAt('/settings/access');
    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(screen.getByRole('checkbox', { name: 'Owner' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Front Desk / Cashier' })).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Housekeeping Supervisor' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(sent('PATCH /users/22222222-0000-4000-8000-000000000001')[0]?.body).toEqual({
      roleIds: [FD_ROLE, HK_ROLE],
    });
  });

  it('asks twice before resetting two-step sign-in, and shows server refusals', async () => {
    handlers['PATCH /users/22222222-0000-4000-8000-000000000001'] = () =>
      apiError(403, 'FORBIDDEN', 'This person has permissions you don’t have.');
    renderAt('/settings/access');
    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset two-step sign-in' }));
    expect(sent('PATCH /users/22222222-0000-4000-8000-000000000001')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm: reset two-step sign-in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This person has permissions you don’t have.',
    );
    expect(sent('PATCH /users/22222222-0000-4000-8000-000000000001')[0]?.body).toEqual({
      resetMfa: true,
    });
  });

  it('creates a one-time password reset link to hand over', async () => {
    handlers['POST /users/22222222-0000-4000-8000-000000000001/password-reset-link'] = () =>
      json(201, {
        link: 'http://app.test/reset-password?token=abc',
        expiresAt: '2026-11-13T09:00:00.000Z',
      });
    renderAt('/settings/access');
    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await userEvent.click(screen.getByRole('button', { name: 'Password reset link' }));
    expect(await screen.findByLabelText('One-time link')).toHaveValue(
      'http://app.test/reset-password?token=abc',
    );
  });
});

describe('invitations', () => {
  it('invites by phone and shows the link to share', async () => {
    handlers['POST /users/invitations'] = () =>
      json(201, {
        invitation: { id: '44444444-0000-4000-8000-000000000001' },
        link: 'http://app.test/accept-invitation?token=xyz',
      });
    renderAt('/settings/access');
    await userEvent.click(await screen.findByRole('tab', { name: 'Invitations' }));
    await userEvent.click(screen.getByRole('radio', { name: 'By phone' }));
    await userEvent.type(screen.getByLabelText(/Phone number/), '+2348099990000');
    const select = screen.getByLabelText('Role');
    // Only roles within the inviter's permissions are offered.
    expect(within(select).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();
    await userEvent.selectOptions(select, 'Housekeeping Supervisor');
    expect(screen.queryByLabelText(/every property/)).not.toBeInTheDocument(); // owners only
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByLabelText('One-time link')).toHaveValue(
      'http://app.test/accept-invitation?token=xyz',
    );
    expect(sent('POST /users/invitations')[0]?.body).toEqual({
      phone: '+2348099990000',
      roleId: HK_ROLE,
      scope: 'PROPERTY',
    });
  });

  it('lists pending invitations and withdraws one', async () => {
    let pending = [
      {
        id: '44444444-0000-4000-8000-000000000002',
        email: 'new@example.test',
        phone: null,
        roleId: FD_ROLE,
        roleName: 'Front Desk / Cashier',
        scope: 'PROPERTY',
        invitedBy: { id: OWNER.id, name: 'Ada Obi' },
        createdAt: '2026-11-12T09:00:00.000Z',
        expiresAt: '2026-11-19T09:00:00.000Z',
      },
    ];
    handlers['GET /users/invitations'] = () => json(200, { data: pending });
    handlers['POST /users/invitations/44444444-0000-4000-8000-000000000002/revoke'] = () => {
      pending = [];
      return json(204);
    };
    renderAt('/settings/access');
    await userEvent.click(await screen.findByRole('tab', { name: 'Invitations' }));
    expect(await screen.findByText('new@example.test')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByText('No pending invitations.')).toBeInTheDocument();
  });
});

describe('roles editor', () => {
  it('lets role.manage holders set permissions and limits in everyday units', async () => {
    handlers['GET /me'] = () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['role.manage', ...GM_PERMS])] }));
    handlers['GET /permissions'] = () =>
      json(200, {
        data: [
          { code: 'folio.read', group: 'money', label: 'View folios', limits: [] },
          {
            code: 'folio.discount',
            group: 'money',
            label: 'Give discounts',
            limits: ['percent', 'amount'],
          },
        ],
      });
    handlers['PATCH /roles/11111111-0000-4000-8000-000000000002'] = (body) =>
      json(200, { ...ROLES[1], ...(body as object) });
    renderAt('/settings/access');
    await userEvent.click(await screen.findByRole('tab', { name: 'Roles' }));
    await userEvent.click(await screen.findByRole('button', { name: /Front Desk \/ Cashier/ }));
    expect(screen.getByLabelText('Role name')).toBeDisabled(); // built-in
    await userEvent.click(screen.getByRole('checkbox', { name: /Give discounts/ }));
    await userEvent.type(screen.getByLabelText('Give discounts: Max %'), '15');
    await userEvent.type(screen.getByLabelText('Give discounts: Max amount (₦)'), '50000');
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));
    await waitFor(() =>
      expect(sent('PATCH /roles/11111111-0000-4000-8000-000000000002')).toHaveLength(1),
    );
    expect(sent('PATCH /roles/11111111-0000-4000-8000-000000000002')[0]?.body).toEqual({
      name: 'Front Desk / Cashier',
      permissions: ['frontdesk.read', 'folio.read', 'folio.discount'],
      limits: { 'folio.discount': { maxBps: 1500, maxAmountMinor: '5000000' } },
      requiresMfa: false,
    });
  });

  it('is read-only without role.manage', async () => {
    handlers['GET /permissions'] = () =>
      json(200, {
        data: [{ code: 'folio.read', group: 'money', label: 'View folios', limits: [] }],
      });
    renderAt('/settings/access');
    await userEvent.click(await screen.findByRole('tab', { name: 'Roles' }));
    await userEvent.click(await screen.findByRole('button', { name: /Front Desk \/ Cashier/ }));
    expect(screen.getByRole('checkbox', { name: /View folios/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save role' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New role' })).not.toBeInTheDocument();
  });
});

describe('accepting an invitation', () => {
  const preview = (accountExists: boolean) => () =>
    json(200, {
      organisationName: 'Obi Hotels',
      propertyName: 'Lagos Hotel',
      roleName: 'Front Desk / Cashier',
      email: 'new@example.test',
      phone: null,
      accountExists,
    });

  it('creates an account with a name and password', async () => {
    handlers['POST /auth/invitations/preview'] = preview(false);
    handlers['POST /auth/invitations/accept'] = () => json(204);
    renderAt('/accept-invitation?token=abcdefghijklmnopqrstuvwxyz');
    expect(await screen.findByRole('heading', { name: 'Join Obi Hotels' })).toBeInTheDocument();
    expect(
      screen.getByText(/as Front Desk \/ Cashier at Lagos Hotel \(new@example.test\)/),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your name'), 'Chidi Eze');
    await userEvent.type(screen.getByLabelText('New password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByText(/Your account is ready/)).toBeInTheDocument();
    expect(sent('POST /auth/invitations/accept')[0]?.body).toEqual({
      token: 'abcdefghijklmnopqrstuvwxyz',
      name: 'Chidi Eze',
      password: 'correct horse battery',
    });
  });

  it('asks an existing account to sign in first, then accepts', async () => {
    handlers['POST /auth/invitations/preview'] = preview(true);
    handlers['GET /me'] = () => apiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    renderAt('/accept-invitation?token=abcdefghijklmnopqrstuvwxyz');
    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(link).toHaveAttribute(
      'href',
      `/sign-in?next=${encodeURIComponent('/accept-invitation?token=abcdefghijklmnopqrstuvwxyz')}`,
    );
  });

  it('accepts for the signed-in account', async () => {
    handlers['POST /auth/invitations/preview'] = preview(true);
    handlers['POST /auth/invitations/accept'] = () => json(204);
    renderAt('/accept-invitation?token=abcdefghijklmnopqrstuvwxyz');
    await userEvent.click(await screen.findByRole('button', { name: 'Accept as Ada Obi' }));
    expect(await screen.findByText(/You have joined/)).toBeInTheDocument();
  });

  it('explains a used or expired link', async () => {
    handlers['POST /auth/invitations/preview'] = () =>
      apiError(
        400,
        'VALIDATION_ERROR',
        'This invitation is invalid, used or expired. Ask for a new one.',
        { reason: 'TOKEN_INVALID' },
      );
    renderAt('/accept-invitation?token=abcdefghijklmnopqrstuvwxyz');
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid, used or expired');
  });
});
