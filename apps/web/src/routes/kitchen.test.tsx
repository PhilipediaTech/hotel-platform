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

// S44 Kitchen display (PRD M8-06; T-156).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OUTLET = id(9);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ticket = (n: number, over: object = {}) => ({
  id: id(n),
  orderId: id(100 + n),
  orderNumber: `P0000${n}`,
  label: `Table ${n}`,
  number: 1,
  station: 'Kitchen',
  sentAt: minutesAgo(2),
  sentBy: 'Bisi Cashier',
  bumpedAt: null,
  bumpedBy: null,
  cancelled: false,
  lines: [{ id: id(200 + n), name: 'Jollof rice', quantity: 2, note: 'No pepper', voided: false }],
  ...over,
});

const calls: { key: string; search: string }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (search: string) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['pos.kitchen'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /kitchen/tickets': () =>
      json(200, {
        outlets: [{ id: OUTLET, name: 'Restaurant', stations: ['Kitchen', 'Grill'] }],
        waiting: [
          ticket(4, { sentAt: minutesAgo(25.5) }),
          ticket(7, {
            lines: [
              { id: id(301), name: 'Suya', quantity: 1, note: null, voided: true },
              { id: id(302), name: 'Pepper soup', quantity: 1, note: null, voided: false },
            ],
          }),
        ],
        bumped: [ticket(2, { bumpedAt: minutesAgo(1), bumpedBy: 'Chef Ade' })],
      }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      calls.push({ key, search: url.search });
      const handler = handlers[key];
      if (!handler) return Promise.reject(new Error(`Unexpected request ${key}`));
      return Promise.resolve(handler(url.search));
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

describe('Kitchen display (S44)', () => {
  it('shows the tickets oldest first with how long they waited, and bumps one', async () => {
    const user = userEvent.setup();
    handlers[`POST /kitchen/tickets/${id(4)}/bump`] = () => json(200, ticket(4));
    renderAt('/kitchen');
    const waiting = await screen.findByRole('list', { name: 'Tickets waiting' });
    const cards = await within(waiting).findAllByRole('listitem', { name: /ticket 1/ });
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Table 4, ticket 1',
      'Table 7, ticket 1',
    ]);
    const first = cards[0] as HTMLElement;
    expect(within(first).getByText('25 min')).toBeInTheDocument();
    expect(within(first).getByText('No pepper')).toBeInTheDocument();
    // A voided item is struck through.
    expect(within(cards[1] as HTMLElement).getByText('(cancelled)')).toBeInTheDocument();
    await user.click(within(first).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(sent(`POST /kitchen/tickets/${id(4)}/bump`)).toHaveLength(1));
  });

  it('recalls a ticket done by mistake, and switches station', async () => {
    const user = userEvent.setup();
    handlers[`POST /kitchen/tickets/${id(2)}/recall`] = () => json(200, ticket(2));
    renderAt('/kitchen');
    await user.click(await screen.findByText('1 ticket done recently'));
    const recent = screen.getByRole('list', { name: 'Tickets done recently' });
    await user.click(within(recent).getByRole('button', { name: 'Bring back' }));
    await waitFor(() => expect(sent(`POST /kitchen/tickets/${id(2)}/recall`)).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'Grill' }));
    await waitFor(() =>
      expect(sent('GET /kitchen/tickets').at(-1)?.search).toBe(`?outletId=${OUTLET}&station=Grill`),
    );
  });

  it('says how to set a display up when there is none', async () => {
    handlers['GET /kitchen/tickets'] = () => json(200, { outlets: [], waiting: [], bumped: [] });
    renderAt('/kitchen');
    expect(await screen.findByText(/No kitchen display is set up yet/)).toBeInTheDocument();
  });
});
