import { localDate } from '@hotel/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/query-client.ts';
import { routes } from '../../app/routes.tsx';
import { setApiPropertyId } from '../../lib/api.ts';
import { LAGOS, makeMe, membership } from '../../test/me-fixture.ts';

// S25 Tax, revenue codes and FX (PRD M4-17; T-032).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const TODAY = localDate(new Date(), 'Africa/Lagos');
const id = (n: number) => `66666666-0000-4000-8000-00000000000${n}`;
const [SVC, VAT, LCT, ROOM, SVC_CODE, VAT_CODE, LCT_CODE] = [1, 2, 3, 4, 5, 6, 7].map(id);

const rule = (ruleId: string, name: string, codeId: string, rateBps: number, sequence: number) => ({
  id: ruleId,
  name,
  authority: name === 'Service charge' ? 'Hotel' : name === 'VAT' ? 'FIRS' : 'LIRS',
  revenueCodeId: codeId,
  versions: [
    {
      id: `${ruleId.slice(0, -1)}9`,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      rateBps,
      basis: name === 'VAT' ? 'NET_PLUS_PRIOR' : 'NET',
      sequence,
      inclusive: false,
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
  currentVersionId: `${ruleId.slice(0, -1)}9`,
});

const code = (
  codeId: string,
  c: string,
  name: string,
  group: string,
  taxRuleIds: string[] = [],
) => ({
  id: codeId,
  code: c,
  name,
  group,
  taxRuleIds,
  active: true,
});

let confirmation: object;
let handlers: Record<string, (body: unknown) => Response>;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  confirmation = { examples: true, confirmedAt: null, confirmedBy: null };
  handlers = {
    'GET /me': () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['tax.manage', 'frontdesk.read'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /tax-rules': () =>
      json(200, {
        data: [
          rule(LCT as string, 'Lagos consumption tax', LCT_CODE as string, 500, 3),
          rule(SVC as string, 'Service charge', SVC_CODE as string, 1000, 1),
          rule(VAT as string, 'VAT', VAT_CODE as string, 750, 2),
        ],
        confirmation,
      }),
    'GET /revenue-codes': () =>
      json(200, {
        data: [
          code(ROOM as string, 'ROOM', 'Room revenue', 'ROOM', [SVC, VAT, LCT] as string[]),
          code(SVC_CODE as string, 'SVC', 'Service charge', 'SERVICE_CHARGE'),
          code(VAT_CODE as string, 'VAT', 'VAT', 'TAX'),
          code(LCT_CODE as string, 'LCT', 'Lagos consumption tax', 'TAX'),
        ],
      }),
    'POST /tax-rules/confirm': () => {
      confirmation = {
        examples: true,
        confirmedAt: '2026-11-10T09:00:00Z',
        confirmedBy: { id: id(8), name: 'Ada Obi' },
      };
      return json(200, confirmation);
    },
    [`POST /tax-rules/${VAT}/versions`]: () => json(201, {}),
    'POST /revenue-codes': () => json(201, {}),
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
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

describe('Taxes tab', () => {
  it('marks example rates and records the confirmation', async () => {
    const user = userEvent.setup();
    renderAt('/settings/finance');
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Example rates: check them with your accountant');
    expect(banner).toHaveTextContent(/VAT 7.5%/);
    await user.click(
      within(banner).getByRole('button', { name: 'I have checked these rates with my accountant' }),
    );
    await waitFor(() => expect(sent('POST /tax-rules/confirm')).toHaveLength(1));
    expect(await screen.findByText(/Rates checked by Ada Obi/)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists taxes in their order with rate, basis and code', async () => {
    renderAt('/settings/finance');
    await screen.findByText('Hotel');
    const rows = screen.getAllByRole('row').slice(1, 4);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(rows[1]).toHaveTextContent('VAT');
    expect(rows[1]).toHaveTextContent('7.5%');
    expect(rows[1]).toHaveTextContent('The price plus earlier taxes');
  });

  it('works the ₦100,000 example through today’s rules', async () => {
    renderAt('/settings/finance');
    const example = await screen.findByRole('table', { name: 'Worked example' });
    const text = example.textContent ?? '';
    expect(text).toMatch(/Price before tax₦100,000\.00/);
    expect(text).toMatch(/Service charge.*₦10,000\.00/);
    expect(text).toMatch(/VAT\s*on ₦110,000\.00₦8,250\.00/);
    expect(text).toMatch(/Lagos consumption tax\s*on ₦100,000\.00₦5,000\.00/);
    expect(text).toMatch(/Guest pays₦123,250\.00/);
  });

  it('changes a rate from a date', async () => {
    const user = userEvent.setup();
    renderAt('/settings/finance');
    await user.click(await screen.findByRole('button', { name: 'Change VAT' }));
    const form = screen.getByRole('form', { name: 'Change VAT' });
    await user.clear(within(form).getByLabelText('Rate (%)'));
    await user.type(within(form).getByLabelText('Rate (%)'), '10');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent(`POST /tax-rules/${VAT}/versions`)[0]?.body).toEqual({
        effectiveFrom: TODAY,
        rateBps: 1000,
        basis: 'NET_PLUS_PRIOR',
        sequence: 2,
        inclusive: false,
      }),
    );
  });
});

describe('Revenue codes tab', () => {
  it('adds a code with the taxes it carries', async () => {
    const user = userEvent.setup();
    renderAt('/settings/finance?tab=codes');
    await user.click(await screen.findByRole('button', { name: 'Add revenue code' }));
    const form = screen.getByRole('form', { name: 'Add revenue code' });
    await user.type(within(form).getByLabelText('Code'), 'laundry');
    await user.type(within(form).getByLabelText('Name'), 'Laundry');
    await user.click(within(form).getByRole('checkbox', { name: 'VAT' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent('POST /revenue-codes')[0]?.body).toEqual({
        code: 'LAUNDRY',
        name: 'Laundry',
        group: 'OTHER',
        taxRuleIds: [VAT],
      }),
    );
  });
});
