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

// Group dashboards (PRD M1-13, M12-07; S46; T-161).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (over: object) => ({
  propertyId: id(1),
  code: 'LAG',
  name: 'Lagos Hotel',
  currency: 'NGN',
  days: 2,
  through: '2026-11-02',
  roomsAvailable: 20,
  roomsSold: 14,
  occupancyBps: 7000,
  roomRevenueMinor: '14000000',
  revenueMinor: '16000000',
  adrMinor: '1000000',
  revparMinor: '700000',
  rate: '1',
  inGroupCurrency: {
    roomRevenueMinor: '14000000',
    revenueMinor: '16000000',
    adrMinor: '1000000',
    revparMinor: '700000',
  },
  ...over,
});
const DASHBOARD = {
  month: '2026-11',
  groupCurrency: 'NGN',
  properties: [
    row({}),
    row({
      propertyId: id(2),
      code: 'ACC',
      name: 'Accra Hotel',
      currency: 'GHS',
      days: 1,
      revenueMinor: '200000',
      rate: null,
      inGroupCurrency: null,
    }),
  ],
  totals: {
    roomsAvailable: 25,
    roomsSold: 17,
    occupancyBps: 6800,
    roomRevenueMinor: '14000000',
    revenueMinor: '16000000',
    adrMinor: '1000000',
    revparMinor: '700000',
    propertiesInMoneyTotals: 1,
  },
  missingRates: ['GHS'],
  definitions: 'Closed days.',
};
const RATES = {
  month: '2026-11',
  groupCurrency: 'NGN',
  rates: [{ currency: 'GHS', rate: null, setBy: null, setAt: null }],
};

const COMPANY = {
  companyId: id(9),
  name: 'Dangote Group',
  kind: 'COMPANY',
  properties: 2,
  groupCurrency: 'NGN',
  groupLimitMinor: '20000000',
  balanceMinor: '22325000',
  overdueMinor: '10000000',
  overLimit: true,
  missingRates: [],
};
const COMPANY_DETAIL = {
  ...COMPANY,
  accounts: [
    {
      propertyId: id(1),
      propertyName: 'Lagos Hotel',
      accountId: id(11),
      currency: 'NGN',
      status: 'ACTIVE',
      creditLimitMinor: '50000000',
      balanceMinor: '12325000',
      overdueMinor: '0',
      inGroupCurrencyMinor: '12325000',
    },
  ],
  openInvoices: [
    {
      propertyName: 'Accra Hotel',
      number: 'AR-00001',
      currency: 'GHS',
      openMinor: '100000',
      issuedOn: '2026-10-02',
      dueOn: '2026-11-01',
      overdue: true,
    },
  ],
};

const calls: { key: string; body: unknown; search: string }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown, search: string) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['report.group'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /group/dashboard': () => json(200, DASHBOARD),
    'GET /group/rates': () => json(200, RATES),
    'GET /group/companies': () => json(200, { data: [COMPANY] }),
    [`GET /group/companies/${id(9)}`]: () => json(200, COMPANY_DETAIL),
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
      return Promise.resolve(handler(body, url.search));
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

describe('Group', () => {
  it('shows totals, each property side by side, and says which rate is missing', async () => {
    renderAt('/group');
    const totals = await screen.findByRole('group', { name: 'Group totals' });
    expect(within(totals).getByText('68.0%')).toBeInTheDocument();
    expect(within(totals).getByText('Money totals count 1 of 2 properties.')).toBeInTheDocument();
    expect(
      within(totals).getByText(/No 2026-11 rate for GHS: those properties are left out/),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Properties' });
    const accra = within(table).getByRole('row', { name: /Accra Hotel/ });
    expect(within(accra).getByText('No rate')).toBeInTheDocument();
    expect(within(accra).getByText(/GH₵\s?2,000\.00|GHS\s?2,000\.00/)).toBeInTheDocument();
  });

  it('sets the month’s rate and shows the totals again', async () => {
    const user = userEvent.setup();
    handlers['PUT /group/rates'] = () =>
      json(200, {
        ...RATES,
        rates: [{ currency: 'GHS', rate: '105.5', setBy: 'Owner', setAt: '2026-11-20T09:00:00Z' }],
      });
    renderAt('/group');
    const form = await screen.findByRole('form', { name: 'Group currency and rates' });
    await user.type(within(form).getByLabelText('GHS → NGN'), '105.5');
    await user.click(within(form).getByRole('button', { name: 'Save rates' }));
    await waitFor(() => expect(sent('PUT /group/rates')).toHaveLength(1));
    expect(sent('PUT /group/rates')[0]?.body).toEqual({
      month: expect.stringMatching(/^\d{4}-\d{2}$/) as unknown,
      groupCurrency: 'NGN',
      rates: [{ currency: 'GHS', rate: '105.5' }],
    });
    await waitFor(() => expect(sent('GET /group/dashboard').length).toBeGreaterThan(1));
    expect(await within(form).findByText('Set by Owner')).toBeInTheDocument();
  });

  it('lists what each company owes the group, and opens one across properties', async () => {
    const user = userEvent.setup();
    renderAt('/group');
    const table = await screen.findByRole('table', { name: 'Company accounts' });
    const row = within(table).getByRole('row', { name: /Dangote Group/ });
    expect(within(row).getByText('Over the limit')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Show Dangote Group' }));
    const region = await screen.findByRole('region', { name: 'Dangote Group' });
    const invoices = within(region).getByRole('table', { name: 'Open invoices' });
    expect(within(invoices).getByText('Accra Hotel')).toBeInTheDocument();
    expect(within(invoices).getByText(/2026-11-01 · Overdue/)).toBeInTheDocument();
  });
});
