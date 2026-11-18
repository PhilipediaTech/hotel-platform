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

// S36 timesheets and payroll (PRD M7-06, M7-07, M7-08; T-139).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BISI = { id: id(1), number: 1, name: 'Bisi Cook' };
const ADA = { id: id(2), number: 2, name: 'Ada Accountant' };
const GM = { id: id(90), name: 'Grace Manager' };

const sheet = {
  id: id(10),
  staff: BISI,
  from: '2026-11-01',
  to: '2026-11-30',
  status: 'DRAFT',
  workedMinutes: 1890,
  overtimeMinutes: 150,
  approvedOvertimeMinutes: null,
  daysWorked: 4,
  openClocks: 1,
  days: [],
  calculatedAt: '2026-11-30T20:00:00Z',
  note: null,
  approvedBy: null,
  approvedAt: null,
};
const item = {
  id: id(20),
  staff: BISI,
  type: 'ADVANCE',
  amountMinor: '2000000',
  currency: 'NGN',
  month: '2026-11',
  description: 'Salary advance',
  status: 'PENDING',
  requestedBy: GM,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: '2026-11-10T09:00:00Z',
};
const row = (staff: typeof BISI, extra: object) => ({
  staff,
  department: null,
  jobTitle: 'Kitchen',
  employmentType: 'HOURLY',
  startDate: '2026-01-05',
  endDate: null,
  payRateMinor: null,
  timesheets: 0,
  daysWorked: 0,
  workedMinutes: 0,
  approvedOvertimeMinutes: 0,
  advancesMinor: '0',
  deductionsMinor: '0',
  ...extra,
});

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

function stub(permissions: string[]) {
  handlers['GET /me'] = () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] }));
}

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key: `${key}${url.searchParams.get('format') === 'csv' ? ' csv' : ''}`, body });
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

describe('Timesheets and payroll (S36)', () => {
  it('approves a timesheet with part of the overtime and a note', async () => {
    stub(['timesheet.approve']);
    handlers['GET /timesheets'] = () =>
      json(200, { month: '2026-11', data: [sheet], staff: [BISI], overtimeAfterMinutes: 480 });
    handlers[`POST /timesheets/${sheet.id}/approve`] = () =>
      json(200, { ...sheet, status: 'APPROVED', approvedOvertimeMinutes: 120 });
    const user = userEvent.setup();
    renderAt('/payroll');
    const list = await screen.findByRole('list', { name: 'Timesheets this month' });
    expect(
      await within(list).findByText('4 days · 31.5 h worked · 2.5 h overtime (after 8.0 h a day)'),
    ).toBeInTheDocument();
    expect(within(list).getByText(/1 clock-in without a clock-out/)).toBeInTheDocument();
    const accept = within(list).getByLabelText('Overtime accepted (minutes)');
    await user.clear(accept);
    await user.type(accept, '120');
    await user.type(within(list).getByLabelText('Note'), 'Off sick on the 4th');
    await user.click(within(list).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(sent(`POST /timesheets/${sheet.id}/approve`)).toHaveLength(1));
    expect(sent(`POST /timesheets/${sheet.id}/approve`)[0]?.body).toEqual({
      approvedOvertimeMinutes: 120,
      note: 'Off sick on the 4th',
    });
    // No payroll sections without their permissions.
    expect(screen.queryByRole('heading', { name: 'Payroll file' })).not.toBeInTheDocument();
  }, 15_000);

  it('records an advance for approval', async () => {
    stub(['staff.payitem']);
    handlers['GET /pay-items'] = () => json(200, { month: '2026-11', data: [], staff: [BISI] });
    handlers['POST /pay-items'] = () => json(201, item);
    const user = userEvent.setup();
    renderAt('/payroll');
    await user.click(await screen.findByRole('button', { name: 'Record an advance or deduction' }));
    const form = screen.getByRole('form', { name: 'Advance or deduction' });
    await user.selectOptions(within(form).getByLabelText('Staff member'), BISI.id);
    await user.type(within(form).getByLabelText('Amount'), '20,000');
    await user.type(within(form).getByLabelText('Description'), 'Salary advance');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST /pay-items')).toHaveLength(1));
    expect(sent('POST /pay-items')[0]?.body).toMatchObject({
      staffId: BISI.id,
      type: 'ADVANCE',
      amountMinor: '2000000',
      description: 'Salary advance',
    });
  }, 15_000);

  it('previews the payroll file, says what is waiting, and downloads it', async () => {
    stub(['payroll.export']);
    handlers['GET /payroll-exports'] = () =>
      json(200, {
        month: '2026-11',
        from: '2026-11-01',
        to: '2026-11-30',
        currency: 'NGN',
        rows: [
          row(BISI, {
            workedMinutes: 1890,
            approvedOvertimeMinutes: 120,
            advancesMinor: '2000000',
          }),
          row(ADA, { employmentType: 'MONTHLY_SALARY', payRateMinor: '30000000' }),
        ],
        waiting: { draftTimesheets: 1, pendingPayItems: 2 },
      });
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
    );
    const user = userEvent.setup();
    renderAt('/payroll');
    const table = await screen.findByRole('table', { name: 'Payroll for the month' });
    expect(await within(table).findByText('Ada Accountant')).toBeInTheDocument();
    expect(within(table).getByText('Monthly salary')).toBeInTheDocument();
    expect(
      screen.getByText(/1 draft timesheets, 2 advances or deductions waiting/),
    ).toBeInTheDocument();
    handlers['GET /payroll-exports'] = () =>
      new Response('Staff number\r\n', { status: 200, headers: { 'Content-Type': 'text/csv' } });
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(sent('GET /payroll-exports csv')).toHaveLength(1));
  }, 15_000);
});
