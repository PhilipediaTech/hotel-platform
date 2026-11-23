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

// S43 Expenses (PRD M10-06; T-147).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REPAIRS = { id: id(1), code: 'REPAIRS', name: 'Repairs', active: true };
const MNT = { id: id(2), code: 'MNT', name: 'Maintenance' };
const FLOAT = {
  id: id(3),
  name: 'Front office float',
  custodian: { id: id(4), name: 'Ada Finance' },
  active: true,
  balanceMinor: '500000',
};
const setup = {
  categories: [REPAIRS],
  floats: [FLOAT],
  departments: [MNT],
  suppliers: [],
  custodians: [{ id: id(4), name: 'Ada Finance' }],
  currency: 'NGN',
  businessDate: '2026-11-10',
};
const tap = {
  id: id(10),
  number: 7,
  spentOn: '2026-11-10',
  category: { id: REPAIRS.id, code: REPAIRS.code, name: REPAIRS.name },
  department: MNT,
  supplier: null,
  payee: 'Plumber Musa',
  description: 'Fixed the tap in 204',
  amountMinor: '1500000',
  paidFrom: 'PETTY_CASH',
  float: { id: FLOAT.id, name: FLOAT.name },
  reference: null,
  receiptFileId: null,
  recordedBy: { id: id(4), name: 'Ada Finance' },
  recordedAt: '2026-11-10T09:00:00.000Z',
  approvedBy: null,
  voided: null,
};

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['expense.manage'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /expense-setup': () => json(200, setup),
    'GET /expenses': () => json(200, { data: [tap], nextCursor: null, totalMinor: '1500000' }),
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

describe('Expenses (S43)', () => {
  it('lists expenses with the period total and the float balance', async () => {
    renderAt('/expenses');
    const list = await screen.findByRole('list', { name: 'Expenses' });
    expect(await within(list).findByText('Fixed the tap in 204')).toBeInTheDocument();
    expect(within(list).getByText(/Paid to Plumber Musa/)).toBeInTheDocument();
    const floats = screen.getByRole('list', { name: 'Petty cash' });
    expect(within(floats).getByText(/Front office float: /)).toBeInTheDocument();
    expect(within(floats).getByText('held by Ada Finance')).toBeInTheDocument();
  });

  it('records an expense from petty cash and says when it went for approval', async () => {
    const user = userEvent.setup();
    handlers['POST /expenses'] = () =>
      json(202, {
        approvalRequestId: id(30),
        status: 'PENDING',
        expiresAt: '2026-11-12T09:00:00Z',
        approverRoles: ['General Manager'],
      });
    renderAt('/expenses');
    await user.click(await screen.findByRole('button', { name: 'Record an expense' }));
    const form = screen.getByRole('form', { name: 'Expense' });
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: 'Repairs' })).toBeInTheDocument(),
    );
    await user.selectOptions(within(form).getByLabelText('Category'), REPAIRS.id);
    await user.selectOptions(within(form).getByLabelText('Cost centre'), MNT.id);
    await user.type(within(form).getByLabelText('Paid to'), 'Plumber Musa');
    await user.type(within(form).getByLabelText('What for'), 'New pump');
    await user.type(within(form).getByLabelText('Amount'), '80,000');
    await user.selectOptions(within(form).getByLabelText('Petty cash float'), FLOAT.id);
    await user.type(
      within(form).getByLabelText('Reason for the approver (needed above your limit)'),
      'Pump failed',
    );
    await user.click(within(form).getByRole('button', { name: 'Record expense' }));
    await waitFor(() => expect(sent('POST /expenses')).toHaveLength(1));
    expect(sent('POST /expenses')[0]?.body).toEqual({
      spentOn: '2026-11-10',
      categoryId: REPAIRS.id,
      departmentId: MNT.id,
      supplierId: null,
      payee: 'Plumber Musa',
      description: 'New pump',
      amountMinor: '8000000',
      paidFrom: 'PETTY_CASH',
      floatId: FLOAT.id,
      reference: '',
      receiptFileId: null,
      reason: 'Pump failed',
    });
    expect(
      await screen.findByText('Sent to a manager for approval. It is recorded once approved.'),
    ).toBeInTheDocument();
  });
});
