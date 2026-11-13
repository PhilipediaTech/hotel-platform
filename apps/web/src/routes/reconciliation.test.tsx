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

// S37 Bank reconciliation (PRD M4-23; T-128).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LINE = {
  id: id(1),
  importId: id(2),
  bankAccount: 'GTBank 0123456789',
  postedOn: '2026-11-06',
  description: 'PAYSTACK SETTLEMENT',
  reference: null,
  amountMinor: '9850000',
  balanceMinor: null,
  status: 'UNMATCHED',
  matches: [],
};
const CHARGES = { ...LINE, id: id(3), description: 'COT CHARGES', amountMinor: '-150000' };
const ENTRIES = [
  {
    kind: 'PAYMENT',
    id: id(4),
    date: '2026-11-04',
    method: 'CARD_ONLINE',
    amountMinor: '4000000',
    reference: null,
    payer: 'Ada Obi',
  },
  {
    kind: 'PAYMENT',
    id: id(5),
    date: '2026-11-05',
    method: 'CARD_ONLINE',
    amountMinor: '6000000',
    reference: null,
    payer: 'Bola Ade',
  },
];

const CSV = [
  'Lagoon Hotel Ltd,,,,,',
  'Trans Date,Narration,Reference,Debit,Credit,Balance',
  '05/11/2026,TRF FROM ADA OBI,FT1,,"150,000.00","1,150,000.00"',
  '06/11/2026,COT CHARGES,,"1,500.00",,"1,148,500.00"',
].join('\n');

const calls: { key: string; body: unknown; search: string }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  const handlers: Record<string, () => Response> = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['recon.manage'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /bank-statement-lines': () =>
      json(200, {
        data: [LINE, CHARGES],
        summary: {
          moneyInMinor: '9850000',
          moneyOutMinor: '150000',
          unmatchedCount: 2,
          unmatchedMinor: '9700000',
        },
        bankAccounts: ['GTBank 0123456789'],
      }),
    'POST /bank-statements': () =>
      json(201, { importId: id(9), imported: 2, skipped: 0, autoMatched: 1 }),
    'POST /reconciliation/auto-match': () => json(200, { matched: 0 }),
    'GET /reconciliation/book-entries': () => json(200, { data: ENTRIES, totalMinor: '10000000' }),
    [`POST /bank-statement-lines/${LINE.id}/match`]: () =>
      json(200, { ...LINE, status: 'MATCHED' }),
    [`POST /bank-statement-lines/${CHARGES.id}/explain`]: () =>
      json(200, { ...CHARGES, status: 'MATCHED' }),
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

describe('Bank reconciliation (S37)', { timeout: 20_000 }, () => {
  it('reads a statement CSV here and sends only its transactions', async () => {
    const user = userEvent.setup();
    renderAt('/reconciliation');
    const form = await screen.findByRole('form', { name: 'Import a statement' });
    await waitFor(() =>
      expect(within(form).getByLabelText('Bank account')).toHaveValue('GTBank 0123456789'),
    );
    await user.upload(
      within(form).getByLabelText('Statement file (CSV)'),
      new File([CSV], 'nov.csv', { type: 'text/csv' }),
    );
    expect(
      await within(form).findByText(/2 transactions from 2026-11-05 to 2026-11-06/),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText('Money out')).toHaveDisplayValue('Debit');
    await user.click(within(form).getByRole('button', { name: 'Import 2 transactions' }));
    expect(
      await within(form).findByText('2 new, 0 already imported, 1 matched automatically.'),
    ).toBeInTheDocument();
    expect(sent('POST /bank-statements')[0]?.body).toEqual({
      bankAccount: 'GTBank 0123456789',
      fileName: 'nov.csv',
      lines: [
        {
          postedOn: '2026-11-05',
          description: 'TRF FROM ADA OBI',
          reference: 'FT1',
          amountMinor: '15000000',
          balanceMinor: '115000000',
        },
        {
          postedOn: '2026-11-06',
          description: 'COT CHARGES',
          reference: null,
          amountMinor: '-150000',
          balanceMinor: '114850000',
        },
      ],
    });
  });

  it('matches a settlement to card payments with the gateway fee noted', async () => {
    const user = userEvent.setup();
    renderAt('/reconciliation');
    await user.click(
      await screen.findByRole('button', { name: 'Match the line PAYSTACK SETTLEMENT' }),
    );
    const form = await screen.findByRole('form', { name: 'Match payments' });
    await user.click(await within(form).findByRole('checkbox', { name: /40,000.00 from Ada Obi/ }));
    await user.click(within(form).getByRole('checkbox', { name: /60,000.00 from Bola Ade/ }));
    expect(within(form).getByText(/Difference .*-?1,500.00/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/Why they differ/), 'Gateway fees');
    await user.click(within(form).getByRole('button', { name: 'Match payments' }));
    await waitFor(() =>
      expect(sent(`POST /bank-statement-lines/${LINE.id}/match`)).toHaveLength(1),
    );
    expect(sent(`POST /bank-statement-lines/${LINE.id}/match`)[0]?.body).toEqual({
      paymentIds: [id(4), id(5)],
      arPaymentIds: [],
      differenceNote: 'Gateway fees',
    });
    expect(sent('GET /reconciliation/book-entries')[0]?.search).toContain('from=2026-10-30');
  });

  it('explains bank charges with no payment behind them', async () => {
    const user = userEvent.setup();
    renderAt('/reconciliation');
    await user.click(await screen.findByRole('button', { name: 'Match the line COT CHARGES' }));
    const form = await screen.findByRole('form', { name: 'Explain' });
    await user.type(within(form).getByLabelText('Explanation'), 'Bank charges');
    await user.click(within(form).getByRole('button', { name: 'Explain' }));
    await waitFor(() =>
      expect(sent(`POST /bank-statement-lines/${CHARGES.id}/explain`)).toHaveLength(1),
    );
    expect(sent(`POST /bank-statement-lines/${CHARGES.id}/explain`)[0]?.body).toEqual({
      note: 'Bank charges',
    });
  });
});
