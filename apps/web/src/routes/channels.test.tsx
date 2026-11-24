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

// S41 Channel manager (PRD M11-07; T-151).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BAR = { id: id(1), code: 'BAR', name: 'Best available', kind: 'BAR' };
const NRF = { id: id(2), code: 'NRF', name: 'Non-refundable', kind: 'DERIVED' };
const view = (connected: boolean) => ({
  provider: 'CHANNEX',
  connection: connected
    ? {
        status: 'CONNECTING',
        externalPropertyId: 'ext-1',
        lastError: 'Channex answered 422: Validation Error',
        connectedBy: { id: id(9), name: 'Grace GM' },
        createdAt: '2026-11-10T09:00:00.000Z',
        checkedAt: null,
        fullSyncAt: null,
        fullSyncPending: true,
        syncError: null,
        retryAt: null,
      }
    : null,
  roomTypes: [{ id: id(3), code: 'STD', name: 'Standard', rooms: 12, mapped: connected }],
  ratePlans: [
    { ...BAR, selected: false, mappedRoomTypes: 0 },
    { ...NRF, selected: false, mappedRoomTypes: 0 },
  ],
  logs: connected
    ? [
        {
          at: '2026-11-10T09:00:00.000Z',
          kind: 'SETUP',
          status: 'FAILED',
          items: 2,
          message: 'Channex answered 422: Validation Error',
        },
      ]
    : [],
});

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['channel.manage'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /channel-connection': () => json(200, view(false)),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body });
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
}

describe('Channel manager (S41)', () => {
  it('connects with the plans chosen to sell online', async () => {
    const user = userEvent.setup();
    handlers['POST /channel-connection'] = () => json(200, view(true));
    renderAt('/channels');
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Rate plans to sell online' });
    const connect = within(form).getByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();
    await user.click(within(form).getByLabelText('Best available (BAR)'));
    await user.click(connect);
    await waitFor(() => expect(sent('POST /channel-connection')).toHaveLength(1));
    expect(sent('POST /channel-connection')[0]?.body).toEqual({ ratePlanIds: [BAR.id] });
  });

  it('shows an unfinished setup with its last problem and the activity', async () => {
    handlers['GET /channel-connection'] = () => json(200, view(true));
    renderAt('/channels');
    expect(await screen.findByText('Setup not finished')).toBeInTheDocument();
    expect(
      screen.getByText('Last problem: Channex answered 422: Validation Error'),
    ).toBeInTheDocument();
    const log = screen.getByRole('list', { name: 'Activity' });
    expect(within(log).getByText(/SETUP · 2 items · failed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and finish setup' })).toBeInTheDocument();
  });

  it('shows how prices and availability are sent, and sends everything again', async () => {
    const user = userEvent.setup();
    const active = view(true);
    const connected = {
      ...active,
      connection: {
        ...active.connection,
        status: 'ACTIVE',
        lastError: null,
        checkedAt: '2026-11-10T09:05:00.000Z',
        fullSyncAt: '2026-11-10T09:01:00.000Z',
        fullSyncPending: false,
        syncError: 'Channex answered 429: Too Many Requests',
        retryAt: '2026-11-10T09:07:00.000Z',
      },
    };
    handlers['GET /channel-connection'] = () => json(200, connected);
    handlers['POST /channel-connection/full-sync'] = () =>
      json(200, { ...connected, connection: { ...connected.connection, fullSyncPending: true } });
    renderAt('/channels');
    const sync = await screen.findByRole('list', { name: 'Prices and availability' });
    expect(within(sync).getByText(/^Up to date at/)).toBeInTheDocument();
    expect(within(sync).getByText(/^Everything last sent again at/)).toBeInTheDocument();
    expect(
      screen.getByText(/^Sending stopped: Channex answered 429: Too Many Requests. Next try at/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send everything again' }));
    await waitFor(() => expect(sent('POST /channel-connection/full-sync')).toHaveLength(1));
  });
});
