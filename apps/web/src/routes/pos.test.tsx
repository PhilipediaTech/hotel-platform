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

// S33 Lite POS register (PRD M8-02, M8-03, M8-05; T-142; voids and discounts M8-04, T-143).

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
  discountMinor: '0',
  totalMinor: lines.length ? '168750' : '0',
  settledAt: null,
  settledBy: null,
  payments: [],
  room: null,
  unsentKitchenLines: 0,
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
  voided: null,
  discount: null,
  totalMinor: '168750',
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

  it('voids an item with a reason; above the limit it waits for a manager (M8-04)', async () => {
    handlers['GET /me'] = () =>
      json(
        200,
        makeMe({ memberships: [membership(LAGOS, ['pos.order', 'pos.shift', 'pos.void'])] }),
      );
    handlers['GET /pos/orders'] = () => json(200, { data: [order([line])] });
    handlers[`GET /pos/orders/${id(3)}`] = () => json(200, order([line]));
    handlers[`POST /pos/orders/${id(3)}/lines/${line.id}/void`] = () =>
      json(202, {
        approvalRequestId: id(40),
        status: 'PENDING',
        expiresAt: '2026-11-10T09:31:00Z',
        approverRoles: ['General Manager'],
      });
    const user = userEvent.setup();
    renderAt('/pos');
    const list = await screen.findByRole('list', { name: 'Open orders' });
    await user.click(await within(list).findByRole('button', { name: /Table 4/ }));
    await user.click(await screen.findByRole('button', { name: 'Void or discount Zobo' }));
    const form = screen.getByRole('form', { name: 'Void or discount: Zobo' });
    const confirm = within(form).getByRole('button', { name: 'Void' });
    expect(confirm).toBeDisabled(); // a reason first
    await user.type(within(form).getByLabelText('Reason'), 'Wrong drink');
    await user.click(confirm);
    await waitFor(() =>
      expect(sent(`POST /pos/orders/${id(3)}/lines/${line.id}/void`)).toHaveLength(1),
    );
    expect(sent(`POST /pos/orders/${id(3)}/lines/${line.id}/void`)[0]?.body).toEqual({
      reason: 'Wrong drink',
    });
    expect(await screen.findByText(/Sent to a manager for approval/)).toBeInTheDocument();
  }, 15_000);

  it('sends kitchen items to the kitchen display (M8-06; T-156)', async () => {
    const jollof = {
      ...line,
      id: id(12),
      name: 'Jollof rice',
      kitchen: { station: 'Kitchen', sentAt: null },
    };
    handlers['GET /pos/orders'] = () => json(200, { data: [order([jollof])] });
    let current = order([jollof], { unsentKitchenLines: 1 });
    handlers[`GET /pos/orders/${id(3)}`] = () => json(200, current);
    handlers[`POST /pos/orders/${id(3)}/send-to-kitchen`] = () => {
      current = order([
        { ...jollof, kitchen: { station: 'Kitchen', sentAt: '2026-11-10T09:02:00Z' } },
      ]);
      return json(200, current);
    };
    const user = userEvent.setup();
    renderAt('/pos');
    const list = await screen.findByRole('list', { name: 'Open orders' });
    await user.click(await within(list).findByRole('button', { name: /Table 4/ }));
    expect(await screen.findByText('for Kitchen, not sent yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send 1 item to the kitchen' }));
    await waitFor(() => expect(sent(`POST /pos/orders/${id(3)}/send-to-kitchen`)).toHaveLength(1));
    expect(await screen.findByText('sent to Kitchen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /to the kitchen/ })).toBeNull();
  }, 15_000);

  it('gives a discount and shows it on the order (M8-04)', async () => {
    handlers['GET /me'] = () =>
      json(
        200,
        makeMe({ memberships: [membership(LAGOS, ['pos.order', 'pos.shift', 'pos.void'])] }),
      );
    let current = order([line]);
    handlers['GET /pos/orders'] = () => json(200, { data: [current] });
    handlers[`GET /pos/orders/${id(3)}`] = () => json(200, current);
    handlers[`POST /pos/orders/${id(3)}/lines/${line.id}/discount`] = () => {
      current = order(
        [
          {
            ...line,
            discount: {
              amountMinor: '50000',
              at: '2026-11-10T09:05:00Z',
              by: 'Cashier',
              reason: 'Regular guest',
            },
            totalMinor: '118750',
          },
        ],
        { discountMinor: '50000', totalMinor: '118750' },
      );
      return json(200, current);
    };
    const user = userEvent.setup();
    renderAt('/pos');
    const list = await screen.findByRole('list', { name: 'Open orders' });
    await user.click(await within(list).findByRole('button', { name: /Table 4/ }));
    await user.click(await screen.findByRole('button', { name: 'Void or discount Zobo' }));
    const form = screen.getByRole('form', { name: 'Void or discount: Zobo' });
    await user.click(within(form).getByLabelText('Give a discount'));
    await user.selectOptions(within(form).getByLabelText('Discount by'), 'amount');
    await user.type(within(form).getByLabelText('Amount off'), '500');
    await user.type(within(form).getByLabelText('Reason'), 'Regular guest');
    await user.click(within(form).getByRole('button', { name: 'Give discount' }));
    await waitFor(() =>
      expect(sent(`POST /pos/orders/${id(3)}/lines/${line.id}/discount`)).toHaveLength(1),
    );
    expect(sent(`POST /pos/orders/${id(3)}/lines/${line.id}/discount`)[0]?.body).toEqual({
      amountMinor: '50000',
      reason: 'Regular guest',
    });
    expect(await screen.findByText(/Discount: Regular guest/)).toBeInTheDocument();
  }, 15_000);

  it('keeps taking orders offline, and sends them in order once back (M8-08; T-158)', async () => {
    let online = true;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
    const real = globalThis.fetch;
    let created: { id: string; label: string } | null = null;
    handlers[`GET /pos/orders/${id(3)}`] = () => json(200, order([]));
    handlers['POST /pos/orders'] = (body) => {
      created = body as { id: string; label: string };
      handlers[`POST /pos/orders/${created.id}/lines`] = () =>
        json(201, order([line], { id: created?.id, label: created?.label }));
      return json(201, order([], { id: created.id, label: created.label }));
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init: RequestInit) =>
        online ? real(input, init) : Promise.reject(new TypeError('Failed to fetch')),
      ),
    );
    const user = userEvent.setup();
    renderAt('/pos');
    // Online first: the menu and the orders are saved on the device.
    const list = await screen.findByRole('list', { name: 'Open orders' });
    await user.click(await within(list).findByRole('button', { name: /Table 4/ }));
    await screen.findByRole('region', { name: 'Drinks' });

    online = false;
    window.dispatchEvent(new Event('offline'));
    await user.type(screen.getByLabelText('Table or tab name'), 'Table 9');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const panel = await screen.findByRole('complementary', { name: 'Table 9 (on this device)' });
    expect(within(list).getByRole('button', { name: /Table 9.*not sent yet/ })).toBeInTheDocument();
    const drinks = screen.getByRole('region', { name: 'Drinks' });
    await user.click(within(drinks).getByRole('button', { name: /Zobo/ }));
    const waiting = await within(panel).findByRole('list', { name: 'Items waiting to be sent' });
    expect(within(waiting).getByText(/Zobo/)).toBeInTheDocument();
    expect(within(panel).getByText(/About ₦1,500.00 before tax/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Take payment' })).toBeDisabled();
    expect(sent('POST /pos/orders')).toHaveLength(0);

    // Back online: the order goes first, then its item, naming the order by its own ID.
    online = true;
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toMatchObject({ outletId: outlet.id, label: 'Table 9' });
    expect((created as unknown as { takenAt?: string }).takenAt).toMatch(/^\d{4}-/);
    const orderId = (created as unknown as { id: string }).id;
    await waitFor(() => expect(sent(`POST /pos/orders/${orderId}/lines`)).toHaveLength(1));
    expect(sent(`POST /pos/orders/${orderId}/lines`)[0]?.body).toMatchObject({
      menuItemId: zobo.id,
      modifierIds: [],
      takenAt: expect.any(String) as string,
    });
  }, 20_000);
});
