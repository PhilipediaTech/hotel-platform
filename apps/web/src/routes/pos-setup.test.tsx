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

// S33 Lite POS setup (PRD M8-01; T-141).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FNB = { id: id(50), code: 'FNB', name: 'Food and beverage', group: 'FNB' };
const bar = {
  id: id(1),
  code: 'POOL',
  name: 'Pool bar',
  active: true,
  categories: [
    {
      id: id(2),
      name: 'Drinks',
      sortOrder: 0,
      active: true,
      items: [
        {
          id: id(3),
          name: 'Chapman',
          description: null,
          priceMinor: '350000',
          revenueCode: { id: FNB.id, code: FNB.code, name: FNB.name },
          sortOrder: 0,
          active: true,
          modifiers: [{ id: id(4), name: 'No ice', priceMinor: '0', active: true }],
        },
      ],
    },
  ],
};

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['pos.setup'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /outlets': () => json(200, { data: [bar], currency: 'NGN', revenueCodes: [FNB] }),
    'GET /pos/settings': () => json(200, { roomChargeLimitMinor: null }),
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

describe('POS setup (S33)', () => {
  it('shows the menu and adds an item with its price and revenue code', async () => {
    handlers[`POST /menu-categories/${id(2)}/items`] = () => json(201, bar);
    const user = userEvent.setup();
    renderAt('/pos/setup');
    const outlet = await screen.findByRole('listitem', { name: 'Pool bar' });
    expect(await within(outlet).findByText(/Chapman/)).toBeInTheDocument();
    expect(within(outlet).getByText(/No ice \(no charge\)/)).toBeInTheDocument();
    const drinks = within(outlet).getByRole('region', { name: 'Drinks' });
    await user.click(within(drinks).getByRole('button', { name: 'Add an item' }));
    const form = within(drinks).getByRole('form', { name: 'Menu item' });
    await user.type(within(form).getByLabelText('Item name'), 'Zobo');
    await user.type(within(form).getByLabelText('Price'), '1,500');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(`POST /menu-categories/${id(2)}/items`)).toHaveLength(1));
    expect(sent(`POST /menu-categories/${id(2)}/items`)[0]?.body).toEqual({
      name: 'Zobo',
      priceMinor: '150000',
      revenueCodeId: FNB.id,
    });
  }, 15_000);

  it('changes a price', async () => {
    handlers[`PATCH /menu-items/${id(3)}`] = () => json(200, bar);
    const user = userEvent.setup();
    renderAt('/pos/setup');
    const outlet = await screen.findByRole('listitem', { name: 'Pool bar' });
    await user.type(await within(outlet).findByLabelText('New price'), '4000');
    await user.click(within(outlet).getByRole('button', { name: 'Change price' }));
    await waitFor(() => expect(sent(`PATCH /menu-items/${id(3)}`)).toHaveLength(1));
    expect(sent(`PATCH /menu-items/${id(3)}`)[0]?.body).toEqual({ priceMinor: '400000' });
  }, 15_000);

  it('sets the room charge limit', async () => {
    handlers['PUT /pos/settings'] = () => json(200, { roomChargeLimitMinor: '50000000' });
    const user = userEvent.setup();
    renderAt('/pos/setup');
    const form = await screen.findByRole('form', { name: 'Room charges' });
    expect(within(form).getByText('No limit')).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Room charge limit'), '500,000');
    await user.click(within(form).getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(sent('PUT /pos/settings')).toHaveLength(1));
    expect(sent('PUT /pos/settings')[0]?.body).toEqual({ roomChargeLimitMinor: '50000000' });
  }, 15_000);
});
