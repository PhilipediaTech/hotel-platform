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

// S42 Inventory (PRD M10-01, M10-02, M10-05; T-145).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BTL = { id: id(1), code: 'BTL', name: 'Bottle', active: true };
const MAIN = { id: id(2), code: 'MAIN', name: 'Main store', active: true };
const gin = {
  id: id(3),
  code: 'GIN',
  name: 'Gordon’s gin',
  category: 'Spirits',
  unit: { id: BTL.id, code: 'BTL', name: 'Bottle' },
  par: '24',
  reorderPoint: '6',
  unitCostMinor: '1200000',
  active: true,
  onHand: '5',
  byLocation: [{ locationId: MAIN.id, onHand: '5' }],
  needsReorder: true,
  toPar: '19',
};
const person = (n: number, name: string) => ({ id: id(n), name });
const requisition = (mine: boolean) => ({
  id: id(10),
  number: 7,
  status: 'SUBMITTED',
  department: { id: id(11), code: 'HK', name: 'Housekeeping' },
  requestedBy: person(12, 'Ngozi Eze'),
  mine,
  note: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  closedBy: null,
  closedAt: null,
  closeReason: null,
  lines: [
    {
      id: id(13),
      item: { id: gin.id, code: 'GIN', name: gin.name, unit: 'BTL' },
      quantity: '3',
      issued: '1',
    },
  ],
});

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

function setUp(permissions: string[], mine = false) {
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /stock-items': () =>
      json(200, { items: [gin], units: [BTL], locations: [MAIN], currency: 'NGN' }),
    'GET /requisitions': () =>
      json(200, { data: [requisition(mine)], departments: [requisition(mine).department] }),
  };
}

beforeEach(() => {
  calls.length = 0;
  setUp(['stock.manage', 'stock.requisition', 'stock.count']);
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

describe('Stock (S42)', () => {
  it('shows stock on hand with the reorder flag, and adjusts with a reason', async () => {
    const user = userEvent.setup();
    handlers['POST /stock-movements/adjustments'] = () => json(201, {});
    renderAt('/stock');
    const items = await screen.findByRole('list', { name: 'Items' });
    const row = (await within(items).findByText(/Gordon’s gin/)).closest('li') as HTMLElement;
    expect(within(row).getByText('5 BTL')).toBeInTheDocument();
    expect(within(row).getByText('Reorder')).toBeInTheDocument();
    expect(within(row).getByText('19 BTL to par')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Adjust: Gordon’s gin' }));
    const form = within(row).getByRole('form', { name: 'Adjust Gordon’s gin' });
    await user.selectOptions(within(form).getByLabelText('Location'), MAIN.id);
    await user.type(within(form).getByLabelText('Quantity (BTL)'), '-1');
    const submit = within(form).getByRole('button', { name: 'Adjust' });
    expect(submit).toBeDisabled();
    await user.type(within(form).getByLabelText('Reason'), 'Broken bottle');
    await user.click(submit);
    await waitFor(() => expect(sent('POST /stock-movements/adjustments')).toHaveLength(1));
    expect(sent('POST /stock-movements/adjustments')[0]?.body).toEqual({
      itemId: gin.id,
      locationId: MAIN.id,
      quantity: '-1',
      reason: 'Broken bottle',
    });
  });

  it('issues what is left of a requisition from a location', async () => {
    const user = userEvent.setup();
    handlers['POST /requisitions/' + id(10) + '/issue'] = () =>
      json(200, { ...requisition(false), status: 'ISSUED' });
    renderAt('/stock');
    await user.click(await screen.findByRole('tab', { name: 'Requisitions' }));
    const list = await screen.findByRole('list', { name: 'Requisitions' });
    expect(within(list).getByText('Requisition 7 · Housekeeping')).toBeInTheDocument();
    expect(within(list).getByText('Gordon’s gin: 1 of 3 BTL issued')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Issue' }));
    const form = within(list).getByRole('form', { name: 'Issue requisition 7' });
    await user.selectOptions(within(form).getByLabelText('Issue from'), MAIN.id);
    // What is still asked for is filled in.
    expect(within(form).getByLabelText('Issue now: Gordon’s gin (BTL)')).toHaveValue('2');
    await user.click(within(form).getByRole('button', { name: 'Issue stock' }));
    await waitFor(() => expect(sent(`POST /requisitions/${id(10)}/issue`)).toHaveLength(1));
    expect(sent(`POST /requisitions/${id(10)}/issue`)[0]?.body).toEqual({
      locationId: MAIN.id,
      lines: [{ lineId: id(13), quantity: '2' }],
    });
  });

  it('never offers to issue your own requisition, and a department only requests', async () => {
    const user = userEvent.setup();
    setUp(['stock.manage', 'stock.requisition', 'stock.count'], true);
    renderAt('/stock');
    await user.click(await screen.findByRole('tab', { name: 'Requisitions' }));
    const list = await screen.findByRole('list', { name: 'Requisitions' });
    await within(list).findByText('Requisition 7 · Housekeeping');
    expect(within(list).queryByRole('button', { name: 'Issue' })).toBeNull();
    expect(within(list).getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
    expect(
      within(list).getByText('You raised this requisition, so another store keeper issues it.'),
    ).toBeInTheDocument();
  });

  it('shows a requesting department only items and requisitions, without changes', async () => {
    setUp(['stock.requisition']);
    renderAt('/stock');
    await screen.findByRole('list', { name: 'Items' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Items', 'Requisitions']);
    expect(screen.queryByRole('button', { name: 'Add an item' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Adjust/ })).toBeNull();
  });
});

// S42 purchasing (PRD M10-03, M10-04; T-146).

const SUPPLIER = {
  id: id(20),
  name: 'Lagos Beverages Ltd',
  contactName: 'Tunde',
  phone: null,
  email: null,
  note: null,
  active: true,
};
const order = (status: string) => ({
  id: id(21),
  number: 4,
  status,
  supplier: { id: SUPPLIER.id, name: SUPPLIER.name },
  note: null,
  expectedOn: null,
  totalMinor: '15000000',
  createdBy: person(22, 'Bola Ade'),
  createdAt: '2026-11-10T09:00:00.000Z',
  approvedBy: status === 'DRAFT' ? null : person(22, 'Bola Ade'),
  approvedAt: status === 'DRAFT' ? null : '2026-11-10T09:05:00.000Z',
  closedBy: null,
  closedAt: null,
  closeReason: null,
  lines: [
    {
      id: id(23),
      item: { id: gin.id, code: 'GIN', name: gin.name, unit: 'BTL' },
      quantity: '12',
      unitPriceMinor: '1250000',
      amountMinor: '15000000',
      received: status === 'PARTIAL' ? '10' : '0',
    },
  ],
});

describe('Stock purchasing (S42)', () => {
  it('asks for approval with a reason and says when it went to a manager', async () => {
    const user = userEvent.setup();
    setUp(['po.manage']);
    handlers['GET /purchase-orders'] = () => json(200, { data: [order('DRAFT')], currency: 'NGN' });
    handlers['GET /suppliers'] = () => json(200, { data: [SUPPLIER] });
    handlers[`POST /purchase-orders/${id(21)}/approve`] = () =>
      json(202, {
        approvalRequestId: id(30),
        status: 'PENDING',
        expiresAt: '2026-11-12T09:00:00Z',
        approverRoles: ['General Manager'],
      });
    renderAt('/stock');
    const list = await screen.findByRole('list', { name: 'Purchase orders' });
    await within(list).findByText('PO 4 · Lagos Beverages Ltd');
    expect(within(list).getByText('Draft')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Approve' }));
    const form = within(list).getByRole('form', { name: 'Approve PO 4' });
    await user.type(within(form).getByLabelText('Reason'), 'Christmas stock');
    await user.click(within(form).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(sent(`POST /purchase-orders/${id(21)}/approve`)).toHaveLength(1));
    expect(sent(`POST /purchase-orders/${id(21)}/approve`)[0]?.body).toEqual({
      reason: 'Christmas stock',
    });
    expect(
      await screen.findByText(
        'Sent to a manager for approval. The order stays a draft until it is approved.',
      ),
    ).toBeInTheDocument();
  });

  it('receives what is still to come into a location', async () => {
    const user = userEvent.setup();
    setUp(['stock.receive']);
    handlers['GET /goods-receipts'] = () =>
      json(200, { awaiting: [order('PARTIAL')], data: [], locations: [MAIN] });
    handlers['POST /goods-receipts'] = () =>
      json(201, {
        id: id(40),
        number: 2,
        order: { id: id(21), number: 4, supplier: SUPPLIER.name },
        location: { id: MAIN.id, code: MAIN.code, name: MAIN.name },
        supplierRef: 'DN-4471',
        note: null,
        receivedBy: person(41, 'Kemi Store'),
        receivedAt: '2026-11-10T10:00:00.000Z',
        lines: [],
        valueMinor: '2500000',
      });
    renderAt('/stock');
    const form = await screen.findByRole('form', { name: 'Receive PO 4' });
    expect(within(form).getByLabelText('Gordon’s gin (2 BTL to come)')).toHaveValue('2');
    await user.selectOptions(within(form).getByLabelText('Receive into'), MAIN.id);
    await user.type(
      within(form).getByLabelText('Delivery note or invoice number (optional)'),
      'DN-4471',
    );
    await user.click(within(form).getByRole('button', { name: 'Receive goods' }));
    await waitFor(() => expect(sent('POST /goods-receipts')).toHaveLength(1));
    expect(sent('POST /goods-receipts')[0]?.body).toEqual({
      purchaseOrderId: id(21),
      locationId: MAIN.id,
      supplierRef: 'DN-4471',
      lines: [{ lineId: id(23), quantity: '2' }],
    });
  });
});
