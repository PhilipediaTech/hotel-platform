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
import { toMinor } from '../lib/money.ts';

// S11 Folio (PRD M4-01–M4-05; T-060).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FOLIO = id(1);
/** The page asks for the rates of the session's business date (none here: today). */
const TODAY = new Date().toISOString().slice(0, 10);
const CHARGE = id(10);

const line = (n: number, extra: object) => ({
  id: id(n),
  windowNumber: 1,
  businessDate: '2026-11-10',
  postedAt: '2026-11-10T09:00:00Z',
  kind: 'TAX',
  revenueCode: 'SVC',
  revenueCodeName: 'Service charge',
  description: 'Service charge',
  quantity: 1,
  unitAmountMinor: '0',
  amountMinor: '0',
  parentLineId: CHARGE,
  reversesLineId: null,
  reversedByLineId: null,
  postedBy: 'Bola Desk',
  reason: null,
  ...extra,
});

const folio = (windows: object[] = [], extra: object = {}) => ({
  id: FOLIO,
  number: 'F00001',
  kind: 'GUEST',
  status: 'OPEN',
  name: 'Ada Obi',
  currency: 'NGN',
  reservationId: id(2),
  confirmationNo: 'LAG-00001',
  stay: {
    id: id(3),
    status: 'CHECKED_IN',
    roomNumber: '101',
    arrival: '2026-11-10',
    departure: '2026-11-12',
  },
  company: { id: id(4), name: 'Dangote Group' },
  windows: [
    {
      number: 1,
      payerType: 'GUEST',
      payerName: 'Ada Obi',
      balanceMinor: '12325000',
      lines: [
        line(10, {
          kind: 'CHARGE',
          revenueCode: 'ROOM',
          revenueCodeName: 'Room revenue',
          description: 'Room 101',
          amountMinor: '10000000',
          parentLineId: null,
        }),
        line(11, { amountMinor: '1000000' }),
        line(12, { revenueCode: 'VAT', description: 'VAT', amountMinor: '825000' }),
        line(13, {
          revenueCode: 'LCT',
          description: 'Lagos consumption tax',
          amountMinor: '500000',
        }),
      ],
      payments: [],
    },
    ...windows,
  ],
  routingRules: [],
  revenueCodes: [
    { code: 'FNB', name: 'Food and beverage', group: 'FNB' },
    { code: 'MISC', name: 'Other charges', group: 'OTHER' },
    { code: 'ROOM', name: 'Room revenue', group: 'ROOM' },
  ],
  balanceMinor: '12325000',
  paymentMethods: ['CASH', 'POS_TERMINAL'],
  version: 0,
  ...extra,
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = [
    'frontdesk.read',
    'folio.read',
    'folio.charge',
    'folio.discount',
    'folio.reverse',
    'folio.route',
    'folio.invoice',
    'payment.capture',
  ];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    [`GET /folios/${FOLIO}`]: () => json(200, folio()),
    [`GET /exchange-rates/${TODAY}`]: () =>
      json(200, { date: '2026-11-10', baseCurrency: 'NGN', businessDate: '2026-11-10', rates: [] }),
    'GET /folios': (_b, url) =>
      json(200, {
        data: [
          {
            id: FOLIO,
            number: 'F00001',
            name: 'Ada Obi',
            kind: 'GUEST',
            status: url.searchParams.get('status'),
            roomNumber: '101',
            confirmationNo: 'LAG-00001',
            balanceMinor: '12325000',
          },
        ],
      }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body, url });
      const handler = handlers[key];
      if (!handler) return Promise.reject(new Error(`Unexpected request ${key}`));
      return Promise.resolve(handler(body, url));
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

describe('toMinor', () => {
  it.each([
    ['1,500', '150000'],
    ['1500.5', '150050'],
    ['₦ 20,000.00', '2000000'],
    ['0', null],
    ['12.345', null],
    ['abc', null],
  ])('%j → %j', (text, minor) => {
    expect(toMinor(text)).toBe(minor);
  });
});

describe('Folios (S11)', () => {
  it('lists open folios with their balance', async () => {
    renderAt('/folios');
    const table = await screen.findByRole('table', { name: 'Folios' });
    expect(table).toHaveTextContent('F00001');
    expect(table).toHaveTextContent('₦123,250.00');
    expect(sent('GET /folios')[0]?.url.searchParams.get('status')).toBe('OPEN');
  });

  it('shows windows, the charge with its taxes, and the balance', async () => {
    renderAt(`/folios/${FOLIO}`);
    expect(
      await screen.findByRole('heading', { name: /Folio F00001 · Ada Obi/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Window 1: Ada Obi · ₦123,250.00' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const lines = screen.getByRole('table', { name: 'Folio lines' });
    const rows = within(lines).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Room 101'),
      expect.stringContaining('Service charge'),
      expect.stringContaining('VAT'),
      expect.stringContaining('Lagos consumption tax'),
    ]);
    // Only the charge can be discounted or reversed; its taxes go with it.
    expect(within(lines).getAllByRole('button', { name: /^Reverse/ })).toHaveLength(1);
    expect(within(lines).getAllByRole('button', { name: /^Discount/ })).toHaveLength(1);
  });

  it('posts a charge in naira as minor units, by routing unless a window is chosen', async () => {
    handlers[`POST /folios/${FOLIO}/lines`] = () => json(201, { lines: [], balanceMinor: '0' });
    const user = userEvent.setup();
    renderAt(`/folios/${FOLIO}`);
    const form = await screen.findByRole('form', { name: 'Post a charge' });
    await user.selectOptions(within(form).getByLabelText('Code'), 'MISC');
    await user.type(within(form).getByLabelText('Description'), 'Laundry - 3 shirts');
    await user.clear(within(form).getByLabelText('Quantity'));
    await user.type(within(form).getByLabelText('Quantity'), '3');
    await user.type(within(form).getByLabelText('Price each (₦)'), '1,500');
    await user.click(within(form).getByRole('button', { name: 'Post charge' }));
    await waitFor(() => expect(sent(`POST /folios/${FOLIO}/lines`)).toHaveLength(1));
    expect(sent(`POST /folios/${FOLIO}/lines`)[0]?.body).toEqual({
      revenueCode: 'MISC',
      description: 'Laundry - 3 shirts',
      quantity: 3,
      unitAmountMinor: '150000',
      note: null,
    });
  }, 15_000);

  it('reverses with a reason, and says when a discount went to a manager', async () => {
    handlers[`POST /folio-lines/${CHARGE}/reverse`] = () =>
      json(201, { reversalLineIds: [id(20)], balanceMinor: '0' });
    handlers[`POST /folios/${FOLIO}/discounts`] = () =>
      json(202, {
        approvalRequestId: id(30),
        status: 'PENDING',
        expiresAt: '2026-11-10T09:30:00Z',
        approverRoles: ['General Manager'],
      });
    const user = userEvent.setup();
    renderAt(`/folios/${FOLIO}`);
    await user.click(await screen.findByRole('button', { name: 'Reverse Room 101' }));
    const reverse = screen.getByRole('form', { name: 'Reverse Room 101' });
    await user.type(within(reverse).getByLabelText('Reason'), 'Wrong room');
    await user.click(within(reverse).getByRole('button', { name: 'Reverse with its taxes' }));
    await waitFor(() => expect(sent(`POST /folio-lines/${CHARGE}/reverse`)).toHaveLength(1));
    expect(sent(`POST /folio-lines/${CHARGE}/reverse`)[0]?.body).toEqual({ reason: 'Wrong room' });

    await user.click(screen.getByRole('button', { name: 'Discount Room 101' }));
    const discount = screen.getByRole('form', { name: 'Discount Room 101' });
    await user.type(within(discount).getByLabelText('Percent'), '20');
    await user.type(within(discount).getByLabelText('Reason'), 'Complaint');
    await user.click(within(discount).getByRole('button', { name: 'Give discount' }));
    expect(await screen.findByText('Sent to a manager for approval.')).toBeInTheDocument();
    expect(sent(`POST /folios/${FOLIO}/discounts`)[0]?.body).toEqual({
      lineId: CHARGE,
      percent: 20,
      reason: 'Complaint',
    });
  }, 15_000);

  it('adds a company window and routes room charges to it', async () => {
    handlers[`POST /folios/${FOLIO}/windows`] = () => json(201, folio());
    handlers[`POST /folios/${FOLIO}/routing-rules`] = () => json(201, folio());
    handlers[`GET /folios/${FOLIO}`] = () =>
      json(
        200,
        folio([
          {
            number: 2,
            payerType: 'COMPANY',
            payerName: 'Dangote Group',
            balanceMinor: '0',
            lines: [],
            payments: [],
          },
        ]),
      );
    const user = userEvent.setup();
    renderAt(`/folios/${FOLIO}`);
    const routing = await screen.findByRole('region', { name: 'Windows and routing' });
    await user.click(
      within(routing).getByRole('button', { name: 'Add a window for Dangote Group' }),
    );
    await waitFor(() => expect(sent(`POST /folios/${FOLIO}/windows`)).toHaveLength(1));
    expect(sent(`POST /folios/${FOLIO}/windows`)[0]?.body).toEqual({
      payerType: 'COMPANY',
      companyId: id(4),
    });
    await user.selectOptions(within(routing).getByLabelText('Send'), 'ROOM');
    await user.selectOptions(within(routing).getByLabelText('Window'), '2');
    await user.click(within(routing).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(sent(`POST /folios/${FOLIO}/routing-rules`)).toHaveLength(1));
    expect(sent(`POST /folios/${FOLIO}/routing-rules`)[0]?.body).toEqual({
      revenueGroup: 'ROOM',
      windowNumber: 2,
    });
  });

  it('offers no posting without the permissions, and none on a settled folio', async () => {
    permissions = ['folio.read'];
    renderAt(`/folios/${FOLIO}`);
    await screen.findByRole('table', { name: 'Folio lines' });
    expect(screen.queryByRole('form', { name: 'Post a charge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Reverse/ })).not.toBeInTheDocument();
  });
});

describe('Payments and documents (M4-08; T-062)', () => {
  const paid = () =>
    folio([], {
      windows: [
        {
          number: 1,
          payerType: 'GUEST',
          payerName: 'Ada Obi',
          balanceMinor: '7325000',
          lines: [],
          payments: [
            {
              id: id(40),
              windowNumber: 1,
              method: 'CASH',
              amountMinor: '5000000',
              currency: 'NGN',
              baseAmountMinor: '5000000',
              rate: null,
              externalRef: null,
              businessDate: '2026-11-10',
              receivedAt: '2026-11-10T10:00:00Z',
              receivedBy: 'Bola Desk',
              note: 'Part payment',
            },
          ],
        },
      ],
      balanceMinor: '7325000',
    });

  it('takes a payment with a reference for anything but cash', async () => {
    handlers['POST /payments'] = () =>
      json(201, { paymentId: id(41), shiftId: id(42), balanceMinor: '0' });
    const user = userEvent.setup();
    renderAt(`/folios/${FOLIO}`);
    const form = await screen.findByRole('form', { name: 'Take a payment' });
    expect(within(form).queryByLabelText('Reference')).not.toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText('Method'), 'POS_TERMINAL');
    await user.type(within(form).getByLabelText('Amount (₦)'), '123,250');
    const take = within(form).getByRole('button', { name: 'Take payment' });
    // A POS payment needs its slip number.
    expect(take).toBeDisabled();
    await user.type(within(form).getByLabelText('Reference'), 'MPT-77812');
    await user.click(take);
    await waitFor(() => expect(sent('POST /payments')).toHaveLength(1));
    expect(sent('POST /payments')[0]?.body).toEqual({
      folioId: FOLIO,
      windowNumber: 1,
      method: 'POS_TERMINAL',
      amountMinor: '12325000',
      externalRef: 'MPT-77812',
      note: null,
    });
    expect(
      await within(form).findByText('Payment recorded. Balance now ₦0.00.'),
    ).toBeInTheDocument();
  }, 15_000);

  it('lists payments, and opens the receipt and the invoice as PDFs', async () => {
    handlers[`GET /folios/${FOLIO}`] = () => json(200, paid());
    handlers[`GET /folios/${FOLIO}/receipt.pdf`] = () =>
      new Response('%PDF-1.3', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    handlers[`GET /folios/${FOLIO}/invoice.pdf`] = () =>
      new Response('%PDF-1.3', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.stubGlobal(
      'open',
      vi.fn(() => tab),
    );
    URL.createObjectURL = vi.fn(() => 'blob:pdf');
    URL.revokeObjectURL = vi.fn();
    const user = userEvent.setup();
    renderAt(`/folios/${FOLIO}`);
    const table = await screen.findByRole('table', { name: 'Payments' });
    expect(table).toHaveTextContent('Cash');
    expect(table).toHaveTextContent('Part payment');
    expect(table).toHaveTextContent('−₦50,000.00');

    await user.click(within(table).getByRole('button', { name: 'Receipt for ₦50,000.00' }));
    await waitFor(() => expect(tab.location.href).toBe('blob:pdf'));
    const receipt = sent(`GET /folios/${FOLIO}/receipt.pdf`)[0];
    expect(receipt?.url.searchParams.get('paymentId')).toBe(id(40));

    tab.location.href = '';
    await user.click(screen.getByRole('button', { name: 'Print invoice' }));
    await waitFor(() => expect(tab.location.href).toBe('blob:pdf'));
    expect(sent(`GET /folios/${FOLIO}/invoice.pdf`)).toHaveLength(1);
  });

  it('offers no payment form or documents without the permissions', async () => {
    permissions = ['folio.read'];
    handlers[`GET /folios/${FOLIO}`] = () => json(200, paid());
    renderAt(`/folios/${FOLIO}`);
    const table = await screen.findByRole('table', { name: 'Payments' });
    expect(within(table).queryByRole('button', { name: /^Receipt/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Take a payment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Print invoice' })).not.toBeInTheDocument();
  });

  it('says where to switch payment methods on when none are', async () => {
    handlers[`GET /folios/${FOLIO}`] = () => json(200, folio([], { paymentMethods: [] }));
    renderAt(`/folios/${FOLIO}`);
    expect(await screen.findByText(/No payment methods are switched on/)).toBeInTheDocument();
  });
});

describe('House accounts, transfers and foreign currency (T-065)', () => {
  it('takes US dollars at the day’s rate, showing the naira value', async () => {
    handlers[`GET /exchange-rates/${TODAY}`] = () =>
      json(200, {
        date: '2026-11-10',
        baseCurrency: 'NGN',
        businessDate: '2026-11-10',
        rates: [
          {
            currency: 'USD',
            rate: '1580.5',
            setFor: '2026-11-10',
            setBy: 'Finance',
            lockedAt: null,
          },
        ],
      });
    handlers['POST /payments'] = () =>
      json(201, {
        paymentId: id(41),
        shiftId: id(42),
        baseAmountMinor: '7902500',
        balanceMinor: '4422500',
      });
    const user = userEvent.setup();
    renderAt(`/folios/${FOLIO}`);
    const form = await screen.findByRole('form', { name: 'Take a payment' });
    await user.selectOptions(await within(form).findByLabelText('Currency'), 'USD');
    await user.type(within(form).getByLabelText('Amount (USD)'), '50');
    expect(within(form).getByText('= ₦79,025.00 at 1580.5')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Take payment' }));
    await waitFor(() => expect(sent('POST /payments')).toHaveLength(1));
    expect(sent('POST /payments')[0]?.body).toMatchObject({
      method: 'CASH',
      currency: 'USD',
      amountMinor: '5000',
    });
  }, 15_000);

  it('transfers to another window, or to another folio by number (sent for approval)', async () => {
    handlers[`GET /folios/${FOLIO}`] = () =>
      json(
        200,
        folio([
          {
            number: 2,
            payerType: 'COMPANY',
            payerName: 'Dangote Group',
            balanceMinor: '0',
            lines: [],
            payments: [],
          },
        ]),
      );
    let pending = false;
    handlers[`POST /folios/${FOLIO}/transfer`] = () =>
      pending
        ? json(202, {
            approvalRequestId: id(50),
            status: 'PENDING',
            expiresAt: '2026-11-10T09:30:00Z',
            approverRoles: ['General Manager'],
          })
        : json(201, { lineIds: [id(51), id(52)], balanceMinor: '12325000' });
    handlers['GET /folios'] = () =>
      json(200, {
        data: [
          {
            id: id(60),
            number: 'F00009',
            name: 'Dangote retreat',
            kind: 'PAYMASTER',
            status: 'OPEN',
            roomNumber: null,
            confirmationNo: null,
            balanceMinor: '0',
          },
        ],
      });
    const user = userEvent.setup();
    renderAt(`/folios/${FOLIO}`);
    const form = await screen.findByRole('form', { name: 'Transfer' });
    expect(form).toHaveTextContent('Transfer from window 1 (owes ₦123,250.00)');
    await user.type(within(form).getByLabelText('Amount (₦)'), '100,000');
    await user.type(within(form).getByLabelText('Reason'), 'Company pays the room');
    await user.click(within(form).getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(sent(`POST /folios/${FOLIO}/transfer`)).toHaveLength(1));
    expect(sent(`POST /folios/${FOLIO}/transfer`)[0]?.body).toEqual({
      fromWindow: 1,
      toFolioId: FOLIO,
      toWindow: 2,
      amountMinor: '10000000',
      reason: 'Company pays the room',
    });
    expect(await within(form).findByText('Transferred.')).toBeInTheDocument();

    pending = true;
    await user.selectOptions(within(form).getByLabelText('To'), 'folio');
    await user.type(within(form).getByLabelText('Folio number'), 'f00009');
    await user.type(within(form).getByLabelText('Amount (₦)'), '23,250');
    await user.type(within(form).getByLabelText('Reason'), 'Retreat pays the extras');
    await user.click(within(form).getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(sent(`POST /folios/${FOLIO}/transfer`)).toHaveLength(2));
    expect(sent(`POST /folios/${FOLIO}/transfer`)[1]?.body).toMatchObject({
      toFolioId: id(60),
      toWindow: 1,
      amountMinor: '2325000',
    });
    expect(await within(form).findByText('Sent to a manager for approval.')).toBeInTheDocument();
  }, 20_000);

  it('filters the list by kind and opens a house account', async () => {
    permissions = [...permissions, 'folio.house'];
    handlers['POST /folios'] = () =>
      json(201, folio([], { id: id(70), kind: 'HOUSE', name: 'Staff meals' }));
    handlers[`GET /folios/${id(70)}`] = () =>
      json(200, folio([], { id: id(70), kind: 'HOUSE', name: 'Staff meals' }));
    const user = userEvent.setup();
    renderAt('/folios');
    await screen.findByRole('table', { name: 'Folios' });
    await user.selectOptions(screen.getByLabelText('Kind'), 'HOUSE');
    await waitFor(() =>
      expect(sent('GET /folios').at(-1)?.url.searchParams.get('kind')).toBe('HOUSE'),
    );
    const form = screen.getByRole('form', { name: 'Open a house or paymaster account' });
    await user.type(within(form).getByLabelText('Name'), 'Staff meals');
    await user.click(within(form).getByRole('button', { name: 'Open account' }));
    await waitFor(() => expect(sent('POST /folios')).toHaveLength(1));
    expect(sent('POST /folios')[0]?.body).toEqual({ kind: 'HOUSE', name: 'Staff meals' });
    expect(await screen.findByText('House account')).toBeInTheDocument();
  }, 15_000);
});

describe('Refunds (T-072)', () => {
  const overpaid = () =>
    folio([], {
      windows: [
        {
          number: 1,
          payerType: 'GUEST',
          payerName: 'Ada Obi',
          balanceMinor: '-2000000',
          lines: [],
          payments: [
            {
              id: id(80),
              windowNumber: 1,
              method: 'POS_TERMINAL',
              amountMinor: '14325000',
              currency: 'NGN',
              baseAmountMinor: '14325000',
              rate: null,
              refundsPaymentId: null,
              refundableMinor: '14325000',
              externalRef: 'MPT-1',
              businessDate: '2026-11-10',
              receivedAt: '2026-11-10T10:00:00Z',
              receivedBy: 'Bola Desk',
              note: null,
            },
          ],
        },
      ],
      balanceMinor: '-2000000',
    });

  it('refunds part of a payment in cash and says it went to a manager', async () => {
    permissions = [...permissions, 'payment.refund'];
    handlers[`GET /folios/${FOLIO}`] = () => json(200, overpaid());
    handlers[`POST /payments/${id(80)}/refund`] = () =>
      json(202, {
        approvalRequestId: id(81),
        status: 'PENDING',
        expiresAt: '2026-11-12T10:00:00Z',
        approverRoles: ['General Manager'],
      });
    const user = userEvent.setup();
    renderAt(`/folios/${FOLIO}`);
    await user.click(await screen.findByRole('button', { name: 'Refund ₦143,250.00' }));
    const form = screen.getByRole('form', { name: 'Refund' });
    expect(form).toHaveTextContent('Refund (up to ₦143,250.00 left)');
    const amount = within(form).getByLabelText('Amount (NGN)');
    await user.clear(amount);
    await user.type(amount, '20,000');
    await user.selectOptions(within(form).getByLabelText('Method'), 'CASH');
    await user.type(within(form).getByLabelText('Reason'), 'Overpaid');
    await user.click(within(form).getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(sent(`POST /payments/${id(80)}/refund`)).toHaveLength(1));
    expect(sent(`POST /payments/${id(80)}/refund`)[0]?.body).toEqual({
      amountMinor: '2000000',
      method: 'CASH',
      externalRef: null,
      reason: 'Overpaid',
    });
    expect(await within(form).findByText('Sent to a manager for approval.')).toBeInTheDocument();
  }, 15_000);

  it('shows a refund as money back, and no refund button without payment.refund', async () => {
    handlers[`GET /folios/${FOLIO}`] = () => {
      const f = overpaid();
      const w = f.windows[0] as { payments: object[] };
      w.payments.push({
        id: id(82),
        windowNumber: 1,
        method: 'CASH',
        amountMinor: '-2000000',
        currency: 'NGN',
        baseAmountMinor: '-2000000',
        rate: null,
        refundsPaymentId: id(80),
        refundableMinor: '0',
        externalRef: null,
        businessDate: '2026-11-10',
        receivedAt: '2026-11-10T11:00:00Z',
        receivedBy: 'Finance',
        note: 'Overpaid',
      });
      return json(200, f);
    };
    renderAt(`/folios/${FOLIO}`);
    const table = await screen.findByRole('table', { name: 'Payments' });
    expect(table).toHaveTextContent('Refund · Cash');
    expect(table).toHaveTextContent('+₦20,000.00');
    expect(within(table).queryByRole('button', { name: /^Refund/ })).not.toBeInTheDocument();
  });
});

describe('Payment links (M4-08; T-070)', () => {
  const link = (extra: object = {}) => ({
    id: id(70),
    folioId: FOLIO,
    windowNumber: 1,
    reservationId: null,
    provider: 'PAYSTACK',
    reference: 'HP-abc',
    amountMinor: '12325000',
    currency: 'NGN',
    status: 'CREATED',
    checkoutUrl: 'https://checkout.paystack.com/abc',
    sentTo: 'ada@example.com',
    requestedBy: 'Bola Desk',
    paymentId: null,
    paidAt: null,
    expiresAt: '2026-11-13T09:00:00Z',
    createdAt: '2026-11-10T09:00:00Z',
    ...extra,
  });

  it('emails a link for the balance, then checks it was paid', async () => {
    permissions = [...permissions, 'payment.request'];
    let links: object[] = [];
    handlers['GET /payment-intents'] = () => json(200, { data: links });
    handlers['POST /payment-intents'] = () => {
      links = [link()];
      return json(201, link());
    };
    handlers[`POST /payment-intents/${id(70)}/check`] = () => {
      links = [link({ status: 'SUCCEEDED', paymentId: id(71), paidAt: '2026-11-10T09:20:00Z' })];
      return json(200, links[0]);
    };
    const user = userEvent.setup();
    renderAt(`/folios/${FOLIO}`);
    const form = await screen.findByRole('form', { name: 'New payment link' });
    await user.type(within(form).getByLabelText('Guest email'), 'ada@example.com');
    await user.click(within(form).getByRole('button', { name: 'Create payment link' }));
    await waitFor(() => expect(sent('POST /payment-intents')).toHaveLength(1));
    expect(sent('POST /payment-intents')[0]?.body).toEqual({
      folioId: FOLIO,
      windowNumber: 1,
      amountMinor: '12325000',
      email: 'ada@example.com',
      send: true,
    });
    expect(await within(form).findByText(/Link emailed to ada@example.com/)).toBeInTheDocument();

    const section = screen.getByRole('region', { name: 'Payment links' });
    expect(await within(section).findByText('Waiting')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Check payment' }));
    expect(await within(section).findByText('Paid')).toBeInTheDocument();
    expect(
      within(section).queryByRole('button', { name: 'Check payment' }),
    ).not.toBeInTheDocument();
  }, 15_000);

  it('offers no payment links without payment.request', async () => {
    renderAt(`/folios/${FOLIO}`);
    await screen.findByRole('form', { name: /Take a payment/ });
    expect(screen.queryByRole('region', { name: 'Payment links' })).not.toBeInTheDocument();
  });
});
