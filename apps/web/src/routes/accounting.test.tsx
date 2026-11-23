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

// S43 accounting export (PRD M10-07; T-148).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const mappings = [
  {
    kind: 'CONTROL',
    key: 'GUEST_LEDGER',
    label: 'Guest ledger (folios receivable)',
    accountCode: '1200',
    accountName: null,
  },
  { kind: 'PAY_METHOD', key: 'CASH', label: 'Cash', accountCode: null, accountName: null },
];

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['accounting.export'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /accounting-mappings': () => json(200, { data: mappings }),
    'GET /accounting-exports': () => json(200, { data: [], lastClosedDay: '2026-11-10' }),
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

describe('Accounting export (S43)', () => {
  it('saves only the account codes that changed', async () => {
    const user = userEvent.setup();
    handlers['PUT /accounting-mappings'] = () => json(200, { data: mappings });
    renderAt('/accounting');
    const form = await screen.findByRole('form', { name: 'Account codes' });
    const cash = await within(form).findByLabelText('Account code for Cash');
    expect(
      within(form).getByLabelText('Account code for Guest ledger (folios receivable)'),
    ).toHaveValue('1200');
    await user.type(cash, '1010');
    await user.click(within(form).getByRole('button', { name: 'Save account codes' }));
    await waitFor(() => expect(sent('PUT /accounting-mappings')).toHaveLength(1));
    expect(sent('PUT /accounting-mappings')[0]?.body).toEqual({
      mappings: [{ kind: 'PAY_METHOD', key: 'CASH', accountCode: '1010', accountName: '' }],
    });
  });

  it('lists what still needs an account code when an export is refused', async () => {
    const user = userEvent.setup();
    handlers['POST /accounting-exports'] = () =>
      json(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Give an account code to 1 item first',
          requestId: 'req_1',
          details: {
            issues: [{ path: 'body', code: 'custom', message: 'x' }],
            missing: [{ kind: 'PAY_METHOD', key: 'CASH', label: 'Cash' }],
          },
        },
      });
    renderAt('/accounting');
    const form = await screen.findByRole('form', { name: 'Export a period' });
    await within(form).findByText(/Closed business days up to/);
    expect(within(form).getByLabelText('To')).toHaveValue('2026-11-10');
    await user.type(within(form).getByLabelText('From'), '2026-11-01');
    await user.click(within(form).getByRole('button', { name: 'Build journal' }));
    await waitFor(() => expect(sent('POST /accounting-exports')).toHaveLength(1));
    expect(sent('POST /accounting-exports')[0]?.body).toEqual({
      from: '2026-11-01',
      to: '2026-11-10',
    });
    expect(
      await within(form).findByText('These need an account code first: Cash'),
    ).toBeInTheDocument();
  });
});
