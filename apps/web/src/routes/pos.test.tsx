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

// S33 Lite POS register (PRD M8-02, M8-03, M8-05; T-142).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const outlet = { id: id(1), code: 'POOL', name: 'Pool bar' };
const shift = {
  id: id(2),
  outletId: outlet.id,
  outlet: 'Pool bar',
  status: 'OPEN',
  openedAt: '2026-11-10T08:00:00Z',
  floatMinor: '2000000',
  paymentCounts: [],
  roomCharges: 0,
  openOrders: 1,
};
const register = (shifts: unknown[]) => ({
  currency: 'NGN',
  outlets: [outlet],
  shifts,
  methods: ['CASH', 'POS_TERMINAL'],
});
const order = (lines: unknown[], extra: object = {}) => ({
  id: id(3),
  number: 'P00001',
  label: 'Table 4',
  status: 'OPEN',
  outletId: outlet.id,
  outlet: 'Pool bar',
  openedBy: 'Cashier',
  openedAt: '2026-11-10T09:00:00Z',
  currency: 'NGN',
  lines,
  subtotalMinor: lines.length ? '150000' : '0',
  taxMinor: lines.length ? '18750' : '0',
  totalMinor: lines.length ? '168750' : '0',
  settledAt: null,
  settledBy: null,
  payments: [],
  room: null,
  version: 0,
  ...extra,
});
const zobo = {
  id: id(10),
  name: 'Zobo',
  description: null,
  priceMinor: '150000',
  revenueCode: { id: id(50), code: 'FNB', name: 'Food and beverage' },
  sortOrder: 0,
  active: true,
  modifiers: [],
};
const line = {
  id: id(11),
  name: 'Zobo',
  quantity: 1,
  unitPriceMinor: '150000',
  amountMinor: '150000',
  note: null,
  addedBy: 'Cashier',
  addedAt: '2026-11-10T09:01:00Z',
};

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['pos.order', 'pos.shift'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /pos/register': () => json(200, register([shift])),
    'GET /pos/orders': () => json(200, { data: [order([])] }),
    'GET /menu-items': () =>
      json(200, {
        outletId: outlet.id,
        outlet: 'Pool bar',
        currency: 'NGN',
        categories: [{ id: id(20), name: 'Drinks', sortOrder: 0, active: true, items: [zobo] }],
      }),
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

describe('POS register (S33)', () => {
  it('opens a shift at an outlet with a float', async () => {
    handlers['GET /pos/register'] = () => json(200, register([]));
    handlers['POST /outlet-shifts'] = () => json(201, register([shift]));
    const user = userEvent.setup();
    renderAt('/pos');
    const form = await screen.findByRole('form', { name: 'Open a shift' });
    await user.selectOptions(within(form).getByLabelText('Outlet'), outlet.id);
    await user.type(within(form).getByLabelText('Float counted'), '20,000');
    await user.click(within(form).getByRole('button', { name: 'Open shift' }));
    await waitFor(() => expect(sent('POST /outlet-shifts')).toHaveLength(1));
    expect(sent('POST /outlet-shifts')[0]?.body).toEqual({
      outletId: outlet.id,
      floatMinor: '2000000',
    });
  }, 15_000);

  it('adds an item to a table and settles it in cash', async () => {
    let current = order([]);
    handlers[`GET /pos/orders/${id(3)}`] = () => json(200, current);
    handlers[`POST /pos/orders/${id(3)}/lines`] = () => {
      current = order([line]);
      return json(201, current);
    };
    handlers[`POST /pos/orders/${id(3)}/settle`] = () => {
      current = order([line], {
        status: 'PAID',
        payments: [{ method: 'CASH', amountMinor: '168750', externalRef: null }],
      });
      return json(200, current);
    };
    const user = userEvent.setup();
    renderAt('/pos');
    const list = await screen.findByRole('list', { name: 'Open orders' });
    await user.click(await within(list).findByRole('button', { name: /Table 4/ }));
    const drinks = await screen.findByRole('region', { name: 'Drinks' });
    await user.click(within(drinks).getByRole('button', { name: /Zobo/ }));
    await waitFor(() => expect(sent(`POST /pos/orders/${id(3)}/lines`)).toHaveLength(1));
    expect(sent(`POST /pos/orders/${id(3)}/lines`)[0]?.body).toEqual({
      menuItemId: zobo.id,
      modifierIds: [],
    });
    await user.click(await screen.findByRole('button', { name: 'Take payment' }));
    const pay = screen.getByRole('form', { name: 'Payments' });
    expect(within(pay).getByLabelText('Amount')).toHaveValue('1687.50');
    await user.click(within(pay).getByRole('button', { name: 'Settle' }));
    await waitFor(() => expect(sent(`POST /pos/orders/${id(3)}/settle`)).toHaveLength(1));
    expect(sent(`POST /pos/orders/${id(3)}/settle`)[0]?.body).toEqual({
      payments: [{ method: 'CASH', amountMinor: '168750', externalRef: null }],
    });
    expect(await screen.findByText(/Paid/)).toBeInTheDocument();
  }, 15_000);

  it('closes the shift with a blind count and shows the variance', async () => {
    handlers[`POST /outlet-shifts/${shift.id}/close`] = () =>
      json(200, {
        id: shift.id,
        userId: id(9),
        cashier: 'Cashier',
        outlet: 'Pool bar',
        status: 'CLOSING',
        openedAt: shift.openedAt,
        closedAt: '2026-11-10T18:00:00Z',
        floatMinor: '2000000',
        currency: 'NGN',
        lines: [
          {
            method: 'CASH',
            currency: 'NGN',
            expectedMinor: '2168750',
            countedMinor: '2100000',
            varianceMinor: '-68750',
          },
        ],
        toleranceMinor: '50000',
        requiresSignOff: true,
        varianceNote: null,
        signedOffBy: null,
      });
    const user = userEvent.setup();
    renderAt('/pos');
    await user.click(await screen.findByRole('button', { name: 'Close shift' }));
    const form = screen.getByRole('form', { name: 'Count what is in the drawer' });
    await user.type(within(form).getByLabelText('Counted: Cash'), '21,000');
    await user.click(within(form).getByRole('button', { name: 'Close shift' }));
    await waitFor(() => expect(sent(`POST /outlet-shifts/${shift.id}/close`)).toHaveLength(1));
    expect(sent(`POST /outlet-shifts/${shift.id}/close`)[0]?.body).toEqual({
      counts: [
        { method: 'CASH', currency: 'NGN', countedMinor: '2100000' },
        { method: 'POS_TERMINAL', currency: 'NGN', countedMinor: '0' },
      ],
      varianceNote: null,
    });
    expect(
      await screen.findByText("Counted: the variance needs a supervisor's sign-off"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Reason for the variance')).toBeInTheDocument();
  }, 15_000);
});
