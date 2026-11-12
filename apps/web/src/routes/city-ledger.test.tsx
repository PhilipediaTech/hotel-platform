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
import { ArTransferPanel } from './city-ledger.tsx';

// S32 City ledger (PRD M4-21; T-126).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACCOUNT = {
  id: id(1),
  company: { id: id(2), name: 'Dangote Group', kind: 'COMPANY' },
  creditLimitMinor: '50000000',
  termsDays: 30,
  status: 'ACTIVE',
  balanceMinor: '3000000',
  overdueMinor: '1000000',
};
const DETAIL = {
  ...ACCOUNT,
  invoices: [
    {
      id: id(3),
      number: 'AR-00001',
      folio: { id: id(4), number: 'F00001', name: 'Ada Obi' },
      amountMinor: '3000000',
      openMinor: '3000000',
      issuedOn: '2026-10-01',
      dueOn: '2026-10-31',
      status: 'OPEN',
    },
  ],
  payments: [
    {
      id: id(5),
      method: 'BANK_TRANSFER',
      amountMinor: '500000',
      unallocatedMinor: '500000',
      reference: 'GTB-1',
      receivedOn: '2026-11-01',
      note: null,
      allocations: [],
    },
  ],
};

const COMMISSION = {
  id: id(20),
  agent: { id: id(21), name: 'Wakanow' },
  stay: {
    id: id(22),
    confirmationNo: 'LAG-00042',
    guestName: 'Ada Obi',
    arrival: '2026-11-07',
    departure: '2026-11-09',
  },
  checkedOutOn: '2026-11-09',
  baseMinor: '10000000',
  rateBps: 1000,
  amountMinor: '1000000',
  status: 'DUE',
  settledOn: null,
  reference: null,
};

let permissions: string[];
let transferReply: () => Response;
const calls: { key: string; body: unknown; search: string }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['ar.manage'];
  transferReply = () => json(201, { invoice: DETAIL.invoices[0], account: ACCOUNT });
  const handlers: Record<string, () => Response> = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /ar-accounts': () => json(200, { data: [ACCOUNT] }),
    [`GET /ar-accounts/${ACCOUNT.id}`]: () => json(200, DETAIL),
    [`POST /ar-accounts/${ACCOUNT.id}/payments`]: () => json(201, DETAIL),
    [`POST /ar-payments/${id(5)}/allocate`]: () => json(200, DETAIL),
    [`POST /ar-accounts/${ACCOUNT.id}/transfers`]: () => transferReply(),
    [`GET /ar-accounts/${ACCOUNT.id}/statement`]: () =>
      json(200, {
        account: ACCOUNT,
        from: '2026-11-01',
        to: '2026-11-10',
        openingMinor: '3000000',
        lines: [],
        closingMinor: '3000000',
      }),
    'GET /commissions': () => json(200, { data: [COMMISSION], dueMinor: '1000000' }),
    'POST /commissions/calculate': () => json(200, { created: 1, updated: 0, data: [COMMISSION] }),
    'POST /commissions/settle': () =>
      json(200, { data: [{ ...COMMISSION, status: 'OFFSET', settledOn: '2026-11-10' }] }),
    'GET /reports/ar-ageing': () =>
      json(200, {
        asOf: '2026-11-10',
        totals: {
          current: '0',
          d1to30: '3000000',
          d31to60: '0',
          d61to90: '0',
          over90: '0',
          totalMinor: '3000000',
        },
        accounts: [
          {
            accountId: ACCOUNT.id,
            company: 'Dangote Group',
            buckets: { current: '0', d1to30: '3000000', d31to60: '0', d61to90: '0', over90: '0' },
            totalMinor: '3000000',
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
      calls.push({ key, body, search: url.search });
      const handler = handlers[key];
      if (!handler) return Promise.reject(new Error(`Unexpected request ${key}`));
      return Promise.resolve(handler());
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

describe('City ledger (S32)', { timeout: 20_000 }, () => {
  it('lists accounts with what each owes and what is overdue, and opens one', async () => {
    const user = userEvent.setup();
    renderAt('/ar');
    const row = (await screen.findByText('Dangote Group')).closest('li') as HTMLElement;
    expect(within(row).getByText(/owes .*30,000\.00/)).toBeInTheDocument();
    expect(within(row).getByText(/10,000\.00 overdue/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Open' }));
    expect(await within(row).findByText('AR-00001')).toBeInTheDocument();
    expect(within(row).getByText('due 2026-10-31')).toBeInTheDocument();
  });

  it('records a payment and allocates what was left over', async () => {
    const user = userEvent.setup();
    renderAt('/ar');
    const row = (await screen.findByText('Dangote Group')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Open' }));
    const form = await within(row).findByRole('form', { name: 'Record a payment' });
    await user.type(within(form).getByLabelText('Amount (₦)'), '20000');
    await user.type(within(form).getByLabelText('Reference'), 'GTB-2');
    await user.click(within(form).getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(sent(`POST /ar-accounts/${ACCOUNT.id}/payments`)).toHaveLength(1));
    expect(sent(`POST /ar-accounts/${ACCOUNT.id}/payments`)[0]?.body).toMatchObject({
      method: 'BANK_TRANSFER',
      amountMinor: '2000000',
      reference: 'GTB-2',
      allocate: true,
    });
    await user.click(within(row).getByRole('button', { name: 'Allocate to the oldest invoices' }));
    await waitFor(() => expect(sent(`POST /ar-payments/${id(5)}/allocate`)).toHaveLength(1));
  });

  it('shows ageing by how long it is overdue', async () => {
    const user = userEvent.setup();
    renderAt('/ar');
    await user.click(await screen.findByRole('tab', { name: 'Ageing' }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('1–30 days')).toBeInTheDocument();
    expect(within(table).getAllByText(/30,000\.00/).length).toBeGreaterThan(1);
  });

  it('works out commissions and sets them off against the agent’s account (M4-22)', async () => {
    const user = userEvent.setup();
    // Finance with commissions only: the accounts tabs are not theirs.
    permissions = ['ar.commission'];
    renderAt('/ar');
    expect(await screen.findByRole('tab', { name: 'Commissions' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Accounts' })).not.toBeInTheDocument();
    const calc = await screen.findByRole('form', { name: 'Calculate commissions' });
    await user.click(within(calc).getByRole('button', { name: 'Calculate commissions' }));
    expect(await within(calc).findByText('1 new, 0 updated.')).toBeInTheDocument();
    expect(sent('POST /commissions/calculate')).toHaveLength(1);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Wakanow')).toBeInTheDocument();
    expect(within(table).getByText('10%')).toBeInTheDocument();
    await user.click(within(table).getByRole('checkbox', { name: /Ada Obi/ }));
    const settle = await screen.findByRole('form', { name: 'Settle commissions' });
    expect(within(settle).getByText(/1 commission chosen, .*10,000.00/)).toBeInTheDocument();
    await user.selectOptions(within(settle).getByLabelText('Settle as'), 'OFFSET');
    await user.click(within(settle).getByRole('button', { name: 'Settle commissions' }));
    await waitFor(() => expect(sent('POST /commissions/settle')).toHaveLength(1));
    expect(sent('POST /commissions/settle')[0]?.body).toMatchObject({
      commissionIds: [COMMISSION.id],
      as: 'OFFSET',
    });
  });

  it('from a folio, transfers the window to an account, or says a manager was asked', async () => {
    const user = userEvent.setup();
    // Rendered on its own, as the folio screen does with the hotel already chosen.
    setApiPropertyId(LAGOS);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ArTransferPanel folioId={id(4)} windowNumber={1} balanceMinor="4500000" />
      </QueryClientProvider>,
    );
    const form = await screen.findByRole('form', { name: 'Transfer to a company account' });
    expect(within(form).getByLabelText('Amount (₦)')).toHaveValue('45000');
    await user.click(await within(form).findByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(sent(`POST /ar-accounts/${ACCOUNT.id}/transfers`)).toHaveLength(1));
    expect(sent(`POST /ar-accounts/${ACCOUNT.id}/transfers`)[0]?.body).toMatchObject({
      folioId: id(4),
      windowNumber: 1,
      amountMinor: '4500000',
    });
    expect(await within(form).findByText(/Transferred/)).toBeInTheDocument();

    transferReply = () =>
      json(202, {
        approvalRequestId: id(9),
        status: 'PENDING',
        expiresAt: '2026-11-12T09:00:00Z',
        approverRoles: ['General Manager'],
      });
    await user.click(within(form).getByRole('button', { name: 'Transfer' }));
    expect(await within(form).findByText(/a manager has been asked/)).toBeInTheDocument();
  });
});
