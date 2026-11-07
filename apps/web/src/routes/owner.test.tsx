import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../app/query-client.ts';
import { routes } from '../app/routes.tsx';
import { setApiPropertyId } from '../lib/api.ts';
import {
  ABUJA,
  ABUJA_PROPERTY,
  LAGOS,
  LAGOS_PROPERTY,
  makeMe,
  membership,
} from '../test/me-fixture.ts';

// S04 Owner home (PRD M6-11, M4-15; T-091).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const card = (id: string, name: string, extra: object = {}) => ({
  id,
  code: name.slice(0, 3).toUpperCase(),
  name,
  currency: 'NGN',
  status: 'LIVE',
  businessDate: '2026-11-11',
  roomsAvailable: 50,
  roomsOccupied: 36,
  occupancyBps: 7200,
  revenueTodayMinor: '162000000',
  revenueMonthMinor: '1450000000',
  cashTodayMinor: '25000000',
  transfersTodayMinor: '80000000',
  openAlerts: 2,
  pendingApprovals: 1,
  lastFlash: {
    businessDate: '2026-11-10',
    roomsAvailable: 50,
    roomsSold: 34,
    occupancyBps: 6800,
    roomRevenueMinor: '153000000',
    adrMinor: '4500000',
    revparMinor: '3060000',
    paymentsMinor: '148000000',
  },
  ...extra,
});

let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () =>
      json(
        200,
        makeMe({
          properties: [LAGOS_PROPERTY, ABUJA_PROPERTY],
          memberships: [membership(null, ['owner.read', 'leakage.review', 'approval.decide'])],
        }),
      ),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /owner/home': () =>
      json(200, {
        properties: [
          card(LAGOS, 'Lagos Hotel'),
          card(ABUJA, 'Abuja Hotel', { lastFlash: null, openAlerts: 0 }),
        ],
      }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      calls.push(key);
      const handler = handlers[key];
      if (!handler)
        return Promise.resolve(
          json(404, { error: { code: 'NOT_FOUND', message: 'x', requestId: 'r' } }),
        );
      return Promise.resolve(handler(undefined, url));
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

describe('Owner home (S04)', () => {
  it('shows a card per property with today’s numbers and the last flash report', async () => {
    renderAt('/owner');
    const lagos = await screen.findByRole('article', { name: 'Lagos Hotel' });
    expect(within(lagos).getByText('72%')).toBeInTheDocument();
    expect(within(lagos).getByText('36 of 50 rooms')).toBeInTheDocument();
    expect(within(lagos).getByText(/1,620,000\.00/)).toBeInTheDocument();
    expect(within(lagos).getByText(/14,500,000\.00/)).toBeInTheDocument();
    expect(within(lagos).getByText(/250,000\.00/)).toBeInTheDocument();
    expect(within(lagos).getByText(/800,000\.00/)).toBeInTheDocument();
    expect(
      within(lagos).getByRole('heading', { name: /Flash report, .*2026/ }),
    ).toBeInTheDocument();
    expect(within(lagos).getByText('68%')).toBeInTheDocument();
    expect(within(lagos).getByText(/45,000\.00/)).toBeInTheDocument();
    expect(within(lagos).getByText(/ADR: room revenue ÷ rooms sold/)).toBeInTheDocument();
  });

  it('says when a property has no closed day yet', async () => {
    renderAt('/owner');
    const abuja = await screen.findByRole('article', { name: 'Abuja Hotel' });
    expect(within(abuja).getByText(/comes after the first night audit/)).toBeInTheDocument();
  });

  it('opens a property’s alerts from its card, switching to that property', async () => {
    const user = userEvent.setup();
    const router = renderAt('/owner');
    const abuja = await screen.findByRole('article', { name: 'Abuja Hotel' });
    await user.click(within(abuja).getByRole('button', { name: 'Alerts (0)' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/leakage'));
  });
});
