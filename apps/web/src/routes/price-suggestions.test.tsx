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

// Price suggestions (PRD M14-13; T-149).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const suggestion = {
  ratePlan: { id: id(1), code: 'BAR', name: 'Best available' },
  roomType: { id: id(2), code: 'STD', name: 'Standard' },
  date: '2026-11-20',
  currentMinor: '10000000',
  suggestedMinor: '11500000',
  changeBps: 1500,
  sold: 18,
  capacity: 20,
  daysOut: 10,
  lastYear: { date: '2025-11-21', soldThen: 9, soldFinal: 16, capacity: 20 },
  reasons: [
    'Nearly full: 90% sold (18 of 20) 10 days out',
    'last year: 45% at this point, 80% in the end',
  ],
};

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['rate.manage'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /price-suggestions': () => json(200, { data: [suggestion], currency: 'NGN' }),
    'POST /price-suggestions/accept': () => json(200, { changedDays: 1 }),
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

describe('Price suggestions (M14-13)', () => {
  it('shows each suggestion with its reasons, and accepts it at a changed price', async () => {
    const user = userEvent.setup();
    renderAt('/price-suggestions');
    const list = await screen.findByRole('list', { name: 'Price suggestions' });
    expect(
      await within(list).findByText('Nearly full: 90% sold (18 of 20) 10 days out'),
    ).toBeInTheDocument();
    expect(
      within(list).getByText('last year: 45% at this point, 80% in the end'),
    ).toBeInTheDocument();
    expect(within(list).getByText('+15%')).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: 'Accept selected (0)' });
    expect(accept).toBeDisabled();
    await user.click(within(list).getByRole('checkbox', { name: /^Accept Standard on / }));
    const price = within(list).getByRole('textbox', { name: /^Price to set for Standard on / });
    expect(price).toHaveValue('115000.00');
    await user.clear(price);
    await user.type(price, '110000');
    await user.click(screen.getByRole('button', { name: 'Accept selected (1)' }));
    await waitFor(() => expect(sent('POST /price-suggestions/accept')).toHaveLength(1));
    expect(sent('POST /price-suggestions/accept')[0]?.body).toEqual({
      items: [
        {
          ratePlanId: id(1),
          roomTypeId: id(2),
          date: '2026-11-20',
          amountMinor: '11000000',
          suggestedMinor: '11500000',
        },
      ],
    });
    expect(await screen.findByText('1 prices changed.')).toBeInTheDocument();
  });
});
