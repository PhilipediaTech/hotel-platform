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

const OPERATIONS = {
  from: '2026-10-13',
  to: '2026-11-11',
  totals: {
    created: 3,
    bySeverity: {
      LOW: 1,
      NORMAL: 1,
      HIGH: 1,
      CRITICAL: 0,
    },
    resolved: 1,
    open: 2,
    overdue: 1,
    ackMedianMinutes: 10,
    ackP90Minutes: 30,
    resolveMedianMinutes: 180,
    resolveP90Minutes: 180,
    reopenRateBps: 5000,
    slaMetBps: 5000,
    slaTasks: 2,
    holdMinutes: 60,
  },
  departments: [
    {
      departmentId: '88888888-0000-4000-8000-000000000001',
      name: 'Maintenance',
      figures: {
        created: 2,
        bySeverity: {
          LOW: 1,
          NORMAL: 1,
          HIGH: 1,
          CRITICAL: 0,
        },
        resolved: 1,
        open: 2,
        overdue: 1,
        ackMedianMinutes: 10,
        ackP90Minutes: 30,
        resolveMedianMinutes: 180,
        resolveP90Minutes: 180,
        reopenRateBps: 5000,
        slaMetBps: 5000,
        slaTasks: 2,
        holdMinutes: 60,
      },
    },
  ],
  people: [
    {
      userId: '88888888-0000-4000-8000-000000000002',
      name: 'Tunde Tech',
      figures: {
        created: 2,
        bySeverity: {
          LOW: 1,
          NORMAL: 1,
          HIGH: 1,
          CRITICAL: 0,
        },
        resolved: 1,
        open: 2,
        overdue: 1,
        ackMedianMinutes: 10,
        ackP90Minutes: 30,
        resolveMedianMinutes: 180,
        resolveP90Minutes: 180,
        reopenRateBps: 5000,
        slaMetBps: 5000,
        slaTasks: 2,
        holdMinutes: 60,
      },
      pattern: {
        NIGHT: 0,
        MORNING: 4,
        AFTERNOON: 1,
        EVENING: 0,
        daysActive: 1,
      },
    },
  ],
  unassigned: 1,
  definitions: 'People are listed by name, never ranked.',
};

let permissions: string[];
const PACE = {
  from: '2026-11-20',
  days: 2,
  asOf: '2026-11-20T09:30:00Z',
  currency: 'NGN',
  nights: [
    {
      date: '2026-11-20',
      roomsAvailable: 10,
      rooms: 6,
      revenueMinor: '60000000',
      occupancyBps: 6000,
      pickup: { d1: 1, d7: 3, d30: -1 },
      lastYear: { date: '2025-11-21', sameTime: 4, final: 8 },
      forecast: {
        rooms: 9,
        low: 8,
        high: 10,
        occupancyBps: 9000,
        method: 'LAST_YEAR',
        usualPickup: 3,
        compared: 3,
      },
    },
    {
      date: '2026-11-21',
      roomsAvailable: 10,
      rooms: 2,
      revenueMinor: '20000000',
      occupancyBps: 2000,
      pickup: { d1: 0, d7: 0, d30: 2 },
      lastYear: { date: '2025-11-22', sameTime: 1, final: 5 },
      forecast: {
        rooms: 2,
        low: 2,
        high: 2,
        occupancyBps: 2000,
        method: 'ON_THE_BOOKS',
        usualPickup: 0,
        compared: 0,
      },
    },
  ],
  totals: {
    roomsAvailable: 20,
    rooms: 8,
    revenueMinor: '80000000',
    occupancyBps: 4000,
    pickup: { d1: 1, d7: 3, d30: 1 },
    lastYear: { sameTime: 5, final: 13 },
    forecast: { rooms: 11, low: 10, high: 12, occupancyBps: 5500 },
  },
  definitions: 'Rooms: overnight stays on the books.',
};

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
    'GET /reports/operations': () => json(200, OPERATIONS),
    'GET /reports/pace': () => json(200, PACE),
    'POST /reports/pace/explain': () =>
      json(200, { note: 'Expect 55% over the 2 nights; 2026-11-20 is the strongest.' }),
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
  it('shows operations metrics by department and person, unranked (M6-12)', async () => {
    permissions = ['report.ops', 'report.export'];
    const user = userEvent.setup();
    renderAt('/reports');
    const tabs = await screen.findByRole('tablist', { name: 'Reports' });
    expect(within(tabs).getByRole('tab', { name: 'Operations' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const depts = await screen.findByRole('table', { name: 'By department' });
    expect(within(depts).getByRole('row', { name: /All tasks/ })).toHaveTextContent(
      '1 / 1 / 1 / 0',
    );
    expect(within(depts).getByRole('row', { name: /Maintenance/ })).toHaveTextContent('3.0 h');
    const people = screen.getByRole('table', { name: 'Workload by person' });
    expect(within(people).getByRole('row', { name: /Tunde Tech/ })).toHaveTextContent(
      '0 / 4 / 1 / 0 (1 day)',
    );
    expect(screen.getByText(/not ranked/)).toBeInTheDocument();
    expect(screen.getByText('1 task given to no one.')).toBeInTheDocument();
    // CSV only: no PDF of this report.
    expect(screen.queryByRole('button', { name: 'Open PDF' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() =>
      expect(
        calls.some(
          (u) =>
            u.pathname.endsWith('/reports/operations') && u.searchParams.get('format') === 'csv',
        ),
      ).toBe(true),
    );
  });
});

describe('Pickup and pace (T-165)', () => {
  it('shows the coming nights on the books, their pickup and last year', async () => {
    const user = userEvent.setup();
    renderAt('/reports');
    await user.click(await screen.findByRole('tab', { name: 'Pickup and pace' }));
    const summary = await screen.findByRole('status');
    expect(summary).toHaveTextContent('8 room nights on the books (40.0%)');
    expect(summary).toHaveTextContent(
      'Picked up: +1 in the last day, +3 in 7 days, +1 in 30 days. Last year at this point: 5; it finished with 13.',
    );
    const table = screen.getByRole('table', { name: 'Nights on the books' });
    const first = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(within(first).getByText('-1')).toBeInTheDocument();
    // The forecast (T-179): the likely finish, its range and why.
    expect(
      screen.getByText('Forecast: 11 room nights (55.0%), likely between 10 and 12.'),
    ).toBeInTheDocument();
    expect(within(first).getByText('(8–10)')).toBeInTheDocument();
    expect(
      within(first).getByText('Last year this weekday picked up +3 from this point'),
    ).toBeInTheDocument();
    const second = within(table).getAllByRole('row')[2] as HTMLElement;
    expect(
      within(second).getByText('No nights to compare yet: on the books only'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Explain with AI' }));
    expect(
      await screen.findByText('Expect 55% over the 2 nights; 2026-11-20 is the strongest.'),
    ).toBeInTheDocument();
    expect(screen.getByText('AI note, from the figures above:')).toBeInTheDocument();
    expect(
      calls.some(
        (u) => u.pathname.endsWith('/reports/pace') && u.searchParams.get('days') === '30',
      ),
    ).toBe(true);
  });
});
