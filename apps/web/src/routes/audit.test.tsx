import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../app/query-client.ts';
import { routes } from '../app/routes.tsx';
import { setApiPropertyId } from '../lib/api.ts';
import { LAGOS, makeMe, membership } from '../test/me-fixture.ts';
import { startOfDay } from './audit.tsx';

// S27 Audit log with the real router; fake network.

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const GM = '22222222-0000-4000-8000-000000000001';
const event = (id: string, extra: object = {}) => ({
  id,
  occurredAt: '2026-10-26T09:30:00Z',
  actorType: 'USER',
  actor: { id: GM, name: 'Chidi Eze' },
  action: 'role.updated',
  entityType: 'role',
  entityId: '11111111-0000-4000-8000-000000000002',
  propertyId: null,
  before: { name: 'Front Desk', permissions: ['folio.read'] },
  after: { name: 'Front Desk', permissions: ['folio.read', 'folio.discount'] },
  reason: null,
  approvalRequestId: null,
  requestId: 'req_abc',
  ip: '10.0.0.7',
  userAgent: 'Mozilla/5.0 test',
  ...extra,
});

let handlers: Record<string, (url: URL) => Response>;
const calls: URL[] = [];
const auditCalls = () => calls.filter((u) => u.pathname.endsWith('/audit-events'));

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['audit.read', 'role.assign'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /users': () =>
      json(200, {
        data: [
          {
            id: GM,
            name: 'Chidi Eze',
            email: 'chidi@example.test',
            phone: null,
            status: 'ACTIVE',
            mfaEnabled: true,
            lastLoginAt: null,
            roles: [],
            canManage: false,
          },
        ],
        nextCursor: null,
      }),
    'GET /audit-events': (url) =>
      url.searchParams.get('cursor')
        ? json(200, {
            data: [event('1', { action: 'auth.locked', actorType: 'SYSTEM', actor: null })],
            nextCursor: null,
          })
        : json(200, {
            data: [
              event('3'),
              event('2', {
                action: 'user.disabled',
                entityType: 'user',
                propertyId: LAGOS,
                before: { status: 'ACTIVE' },
                after: { status: 'DISABLED' },
              }),
            ],
            nextCursor: 'next',
          }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      calls.push(url);
      const handler = handlers[`${init.method} ${url.pathname.replace('/api/v1', '')}`];
      if (!handler) return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
      return Promise.resolve(handler(url));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setApiPropertyId(null);
});

function renderAt(path: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

describe('Audit log (S27)', () => {
  it('lists events newest first with the actor, record and property time', async () => {
    renderAt('/audit');
    const list = await screen.findByRole('list', { name: 'Events' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Role changed');
    // 09:30 UTC is 10:30 in Lagos.
    expect(rows[0]).toHaveTextContent(/Chidi Eze · Role · .*10:30.* · organisation-wide/);
    expect(rows[1]).toHaveTextContent('Account disabled');
    expect(rows[1]).not.toHaveTextContent('organisation-wide');
  });

  it('opens a row to show the before/after values and request details', async () => {
    renderAt('/audit');
    await userEvent.click(await screen.findByRole('button', { name: /Role changed/ }));
    const table = screen.getByRole('table');
    const permissions = within(table).getByRole('row', { name: /permissions/ });
    expect(permissions).toHaveTextContent('changed');
    expect(permissions).toHaveTextContent('["folio.read","folio.discount"]');
    expect(within(table).getByRole('row', { name: /^name/ })).not.toHaveTextContent('changed');
    expect(screen.getByText('10.0.0.7')).toBeInTheDocument();
    expect(screen.getByText('req_abc')).toBeInTheDocument();
  });

  it('filters by person, action, record and dates in the property’s time zone', async () => {
    renderAt('/audit');
    await screen.findByText('Role changed');
    await userEvent.selectOptions(await screen.findByLabelText('Person'), 'Chidi Eze');
    await userEvent.selectOptions(screen.getByLabelText('Action'), 'People');
    await userEvent.selectOptions(screen.getByLabelText('Record'), 'Person');
    await userEvent.type(screen.getByLabelText('From'), '2026-10-01');
    await userEvent.type(screen.getByLabelText('To'), '2026-10-26');
    await waitFor(() => {
      const last = auditCalls().at(-1);
      expect(Object.fromEntries(last?.searchParams ?? [])).toEqual({
        limit: '50',
        actorUserId: GM,
        action: 'user',
        entityType: 'user',
        from: '2026-09-30T23:00:00Z',
        to: '2026-10-26T23:00:00Z',
      });
    });
  });

  it('loads more with the cursor', async () => {
    renderAt('/audit');
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Account locked after failed attempts')).toBeInTheDocument();
    expect(screen.getByText(/^System · /)).toBeInTheDocument();
    expect(auditCalls().at(-1)?.searchParams.get('cursor')).toBe('next');
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('hides the person filter without role.assign', async () => {
    handlers['GET /me'] = () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['audit.read'])] }));
    renderAt('/audit');
    await screen.findByText('Role changed');
    expect(screen.queryByLabelText('Person')).not.toBeInTheDocument();
    expect(calls.some((u) => u.pathname.endsWith('/users'))).toBe(false);
  });
});

describe('startOfDay', () => {
  it('turns a property date into the instant its day starts', () => {
    expect(startOfDay('2026-10-26', 'Africa/Lagos')).toBe('2026-10-25T23:00:00Z');
    expect(startOfDay('2026-10-31', 'Africa/Lagos', 1)).toBe('2026-10-31T23:00:00Z');
    expect(startOfDay('2026-07-01', 'Europe/London')).toBe('2026-06-30T23:00:00Z');
    expect(startOfDay('2026-01-01', 'UTC')).toBe('2026-01-01T00:00:00Z');
  });
});
