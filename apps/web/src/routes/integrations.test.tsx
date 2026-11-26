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

// Integrations (Versions V2; T-166): partner API keys and webhooks.

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const apiKey = (over: object = {}) => ({
  id: id(1),
  name: 'Accounting sync',
  prefix: 'hk_AbCdEfGh',
  scopes: ['reservations:read', 'folios:read'],
  createdAt: '2026-11-10T09:00:00Z',
  createdBy: 'Grace GM',
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});
const endpoint = (over: object = {}) => ({
  id: id(2),
  url: 'https://hooks.example.com/hotel',
  description: null,
  events: ['reservation.created', 'business_day.closed'],
  active: true,
  createdAt: '2026-11-10T09:00:00Z',
  createdBy: 'Grace GM',
  delivered: 4,
  failed: 1,
  pending: 0,
  ...over,
});
const delivery = (over: object = {}) => ({
  id: id(3),
  endpointId: id(2),
  url: 'https://hooks.example.com/hotel',
  eventType: 'reservation.created',
  status: 'FAILED',
  attempts: 7,
  nextAttemptAt: null,
  lastStatusCode: 500,
  lastError: 'The endpoint answered 500',
  createdAt: '2026-11-10T09:00:00Z',
  deliveredAt: null,
  ...over,
});

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['integration.manage'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /api-keys': () => json(200, { data: [apiKey()] }),
    'GET /webhook-endpoints': () => json(200, { data: [endpoint()] }),
    'GET /webhook-deliveries': () => json(200, { data: [delivery()] }),
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

describe('Integrations', () => {
  it('makes a key with scopes and shows it once', async () => {
    const user = userEvent.setup();
    handlers['POST /api-keys'] = () =>
      json(201, { key: apiKey({ id: id(9), name: 'POS' }), token: 'hk_the-whole-secret-key' });
    renderAt('/integrations');
    await screen.findByText('Accounting sync');
    const keys = screen.getByRole('list', { name: 'API keys' });
    expect(within(keys).getByText('Accounting sync')).toBeInTheDocument();
    expect(within(keys).getByText('Reservations, Bills and balances')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Make key' });
    await user.type(within(form).getByLabelText('Name'), 'POS');
    await user.click(within(form).getByLabelText('Availability'));
    await user.click(within(form).getByLabelText('Reservations'));
    await user.click(within(form).getByRole('button', { name: 'Make key' }));
    await waitFor(() => expect(sent('POST /api-keys')).toHaveLength(1));
    expect(sent('POST /api-keys')[0]?.body).toEqual({
      name: 'POS',
      scopes: ['availability:read', 'reservations:read'],
    });
    expect(await screen.findByText('hk_the-whole-secret-key')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('hk_the-whole-secret-key')).not.toBeInTheDocument();
  });

  it('asks before revoking a key', async () => {
    const user = userEvent.setup();
    handlers[`POST /api-keys/${id(1)}/revoke`] = () =>
      json(200, apiKey({ revokedAt: '2026-11-10T10:00:00Z' }));
    renderAt('/integrations');
    await screen.findByText('Accounting sync');
    const keys = screen.getByRole('list', { name: 'API keys' });
    await user.click(within(keys).getByRole('button', { name: 'Revoke' }));
    expect(sent(`POST /api-keys/${id(1)}/revoke`)).toHaveLength(0);
    await user.click(within(keys).getByRole('button', { name: 'Yes, revoke' }));
    await waitFor(() => expect(sent(`POST /api-keys/${id(1)}/revoke`)).toHaveLength(1));
  });

  it('adds a webhook URL with events, and sends a failed delivery again', async () => {
    const user = userEvent.setup();
    handlers['POST /webhook-endpoints'] = () =>
      json(201, { endpoint: endpoint({ id: id(8) }), secret: 'whsec_shown-once' });
    handlers[`POST /webhook-deliveries/${id(3)}/retry`] = () =>
      json(200, delivery({ status: 'DELIVERED', attempts: 1 }));
    renderAt('/integrations');
    await screen.findByText('https://hooks.example.com/hotel', { selector: 'span.font-medium' });
    await screen.findByText('Send again');
    const hooks = screen.getByRole('list', { name: 'Webhook endpoints' });
    expect(
      within(hooks).getByText('Sends: Reservation made, Day closed (accounting journal ready)'),
    ).toBeInTheDocument();
    expect(
      within(hooks).getByText('Last 7 days: 4 delivered, 1 failed, 0 waiting'),
    ).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Add URL' });
    await user.type(within(form).getByLabelText('URL'), 'https://pos.example.com/in');
    await user.click(within(form).getByLabelText('Checked out'));
    await user.click(within(form).getByLabelText('Charge posted'));
    await user.click(within(form).getByRole('button', { name: 'Add URL' }));
    await waitFor(() => expect(sent('POST /webhook-endpoints')).toHaveLength(1));
    // In the catalogue's order, whatever order they were ticked in.
    expect(sent('POST /webhook-endpoints')[0]?.body).toEqual({
      url: 'https://pos.example.com/in',
      events: ['stay.checked_out', 'folio.charge_posted'],
    });
    expect(await screen.findByText('whsec_shown-once')).toBeInTheDocument();

    const log = screen.getByRole('list', { name: 'Recent deliveries' });
    expect(
      within(log).getByText(/Failed · 7 tries · The endpoint answered 500/),
    ).toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(sent(`POST /webhook-deliveries/${id(3)}/retry`)).toHaveLength(1));
  });
});
