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

// S28 Reports and S05 Dashboard (PRD M12-01–M12-03, M12-06; T-092).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const NIGHT_AUDIT = '77777777-0000-4000-8000-000000000001';

const FLASH = {
  businessDate: '2026-11-10',
  nightAuditId: NIGHT_AUDIT,
  currency: 'NGN',
  definitions: 'ADR = room revenue without day-use ÷ rooms sold.',
  roomsTotal: 50,
  outOfOrder: 2,
  roomsAvailable: 48,
  roomsSold: 36,
  occupancyBps: 7500,
  roomRevenueMinor: '162000000',
  dayUses: 1,
  dayUseRevenueMinor: '2000000',
  adrMinor: '4444444',
  revparMinor: '3333333',
  revenueByGroup: [{ group: 'ROOM', amountMinor: '162000000' }],
  paymentsByMethod: [{ method: 'CASH', count: 3, amountMinor: '25000000' }],
  arrivals: 5,
  departures: 4,
  noShows: 1,
};

const TAX = {
  from: '2026-11-01',
  through: '2026-11-10',
  currency: 'NGN',
  authorities: [
    {
      authority: 'Federal Inland Revenue Service',
      taxMinor: '12150000',
      rules: [
        {
          taxRuleId: '77777777-0000-4000-8000-000000000002',
          name: 'VAT',
          ratesBps: [750],
          taxableMinor: '162000000',
          taxMinor: '12150000',
          lines: 36,
        },
      ],
    },
  ],
  totalTaxMinor: '12150000',
  definitions: 'Tax lines posted on closed business days.',
};

const DASHBOARD = {
  currency: 'NGN',
  businessDate: '2026-11-11',
  today: {
    roomsAvailable: 48,
    roomsOccupied: 30,
    occupancyBps: 6250,
    revenueMinor: '5000000',
    revenueByGroup: [{ group: 'FNB', amountMinor: '5000000' }],
    paymentsByMethod: [],
  },
  monthToDate: {
    from: '2026-11-01',
    through: '2026-11-10',
    days: 10,
    roomsAvailable: 480,
    roomsSold: 340,
    occupancyBps: 7083,
    roomRevenueMinor: '1530000000',
    adrMinor: '4500000',
    revparMinor: '3187500',
    revenueByGroup: [],
    paymentsByMethod: [{ method: 'CASH', count: 30, amountMinor: '250000000' }],
  },
  balances: { guestLedgerMinor: '12345600', depositLedgerMinor: '-5000000', openFolios: 30 },
  alerts: { open: 2, byRule: [{ rule: 'Cash variance', open: 2 }] },
  definitions: 'Month to date: closed days of this month.',
};

let permissions: string[];
const calls: URL[] = [];

beforeEach(() => {
  calls.length = 0;
  permissions = ['report.audit', 'report.tax', 'report.dashboard', 'report.export'];
  const handlers: Record<string, () => Response> = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /reports/flash': () => json(200, FLASH),
    'GET /reports/tax': () => json(200, TAX),
    'GET /reports/dashboard': () => json(200, DASHBOARD),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      calls.push(url);
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      if (url.searchParams.get('format') === 'csv') {
        return Promise.resolve(
          new Response('Figure,Value\r\n', { headers: { 'Content-Type': 'text/csv' } }),
        );
      }
      const handler = handlers[key];
      if (!handler) {
        return Promise.resolve(
          json(404, { error: { code: 'NOT_FOUND', message: 'Not here', requestId: 'r' } }),
        );
      }
      return Promise.resolve(handler());
    }),
  );
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }),
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

describe('Reports (S28)', () => {
  it('shows only the reports the role holds', async () => {
    permissions = ['report.audit'];
    renderAt('/reports');
    const tabs = await screen.findByRole('tablist', { name: 'Reports' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Flash', 'Trial balance', 'Cashier']);
    // Without report.export: no export buttons, a note instead.
    expect(await screen.findByText(/Exports need the/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download CSV' })).not.toBeInTheDocument();
  });

  it('shows the last closed day’s flash report with its definitions, and exports it as CSV', async () => {
    const user = userEvent.setup();
    renderAt('/reports');
    await user.click(await screen.findByRole('tab', { name: 'Flash' }));
    const table = await screen.findByRole('table', { name: 'Flash' });
    expect(within(table).getByText('75.0%')).toBeInTheDocument();
    expect(within(table).getByText('36')).toBeInTheDocument();
    expect(screen.getByText(/ADR = room revenue without day-use/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() =>
      expect(calls.some((u) => u.searchParams.get('format') === 'csv')).toBe(true),
    );
    const csv = calls.find((u) => u.searchParams.get('format') === 'csv');
    expect(csv?.pathname).toBe('/api/v1/reports/flash');
    expect(csv?.searchParams.get('date')).toBe('2026-11-10');
  });

  it('shows tax by authority with the rate, taxable amount and total', async () => {
    const user = userEvent.setup();
    renderAt('/reports');
    await user.click(await screen.findByRole('tab', { name: 'Tax' }));
    const fed = await screen.findByRole('table', { name: 'Federal Inland Revenue Service' });
    expect(within(fed).getByText('VAT')).toBeInTheDocument();
    expect(within(fed).getByText('7.50%')).toBeInTheDocument();
    expect(screen.getByText(/Total tax/)).toHaveTextContent('121,500.00');
    const call = calls.find((u) => u.pathname === '/api/v1/reports/tax');
    expect(call?.searchParams.get('from')).toMatch(/-01$/);
  });
});

describe('Dashboard (S05)', () => {
  it('shows today, month to date, balances and alerts', async () => {
    renderAt('/dashboard');
    const month = await screen.findByRole('table', { name: 'Month to date' });
    expect(within(month).getByText('70.8%')).toBeInTheDocument();
    expect(within(month).getByText(/45,000\.00/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Balances' })).toHaveTextContent('123,456.00');
    expect(screen.getByRole('table', { name: 'Open alerts' })).toHaveTextContent('Cash variance');
  });
});
