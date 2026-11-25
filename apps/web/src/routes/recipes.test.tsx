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

// Recipes (PRD M8-07; T-157).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RICE = { id: id(20), code: 'RICE', name: 'Rice', unit: 'KG', unitCostMinor: '150000' };
const OIL = { id: id(21), code: 'OIL', name: 'Vegetable oil', unit: 'L', unitCostMinor: '300000' };
const STORE = { id: id(30), code: 'KIT', name: 'Kitchen store' };
const book = (over: { located?: boolean; recipe?: boolean } = {}) => ({
  currency: 'NGN',
  outlets: [
    {
      id: id(1),
      name: 'Restaurant',
      stockLocation: over.located ? STORE : null,
      items: [
        {
          menuItemId: id(10),
          name: 'Jollof rice',
          category: 'Mains',
          priceMinor: '450000',
          active: true,
          recipe: over.recipe
            ? {
                lines: [
                  {
                    stockItemId: RICE.id,
                    code: 'RICE',
                    name: 'Rice',
                    unit: 'KG',
                    quantity: '0.25',
                    costMinor: '37500',
                  },
                ],
                costMinor: '37500',
                costBps: 833,
              }
            : null,
        },
      ],
    },
  ],
  stockItems: [RICE, OIL],
  locations: [STORE],
});

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['pos.recipe'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /recipes': () => json(200, book()),
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

describe('Recipes', () => {
  it('chooses where an outlet takes stock from', async () => {
    const user = userEvent.setup();
    handlers['PUT /outlets/' + id(1) + '/stock-location'] = () =>
      json(200, book({ located: true }));
    renderAt('/recipes');
    const outlet = await screen.findByRole('region', { name: 'Restaurant' });
    expect(within(outlet).getByText(/this outlet's sales won't use any stock/)).toBeInTheDocument();
    await user.selectOptions(within(outlet).getByLabelText('Takes stock from'), STORE.id);
    await user.click(within(outlet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent(`PUT /outlets/${id(1)}/stock-location`)[0]?.body).toEqual({
        stockLocationId: STORE.id,
      }),
    );
    expect(within(outlet).queryByText(/won't use any stock/)).toBeNull();
  });

  it('adds a recipe line by line and shows its cost against the price', async () => {
    const user = userEvent.setup();
    handlers[`PUT /menu-items/${id(10)}/recipe`] = () =>
      json(200, book({ located: true, recipe: true }));
    renderAt('/recipes');
    await user.click(await screen.findByRole('button', { name: 'Add a recipe' }));
    const form = screen.getByRole('form', { name: 'Recipe for Jollof rice' });
    await user.selectOptions(within(form).getByLabelText('Stock item'), RICE.id);
    await user.type(within(form).getByLabelText('Quantity for one (KG)'), '0.25');
    await user.click(within(form).getByRole('button', { name: 'Save recipe' }));
    await waitFor(() =>
      expect(sent(`PUT /menu-items/${id(10)}/recipe`)[0]?.body).toEqual({
        lines: [{ stockItemId: RICE.id, quantity: '0.25' }],
      }),
    );
    expect(await screen.findByText(/0.25 KG Rice/)).toBeInTheDocument();
    expect(screen.getByText(/8.3% of the price/)).toBeInTheDocument();
  });
});
