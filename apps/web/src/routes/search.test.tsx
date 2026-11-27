import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../app/query-client.ts';
import { routes } from '../app/routes.tsx';
import { setApiPropertyId } from '../lib/api.ts';
import { LAGOS, makeMe, membership } from '../test/me-fixture.ts';

// Search from the top bar (spec issue 31; T-178): plain matches, then Ask AI.

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const GUEST = {
  kind: 'GUEST',
  id: '99999999-0000-4000-8000-000000000001',
  label: 'Ada Obi',
  detail: '+2348031234567',
};
const BOOKING = {
  kind: 'RESERVATION',
  id: '99999999-0000-4000-8000-000000000002',
  label: 'LAG-00042 · Ada Obi',
  detail: '2026-11-10 to 2026-11-12, checked in',
};

const calls: { key: string; search: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  const handlers: Record<string, () => Response> = {
    'GET /me': () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['guest.manage', 'frontdesk.read'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /search': () => json(200, { hits: [GUEST] }),
    'POST /search/ask': () => json(200, { answer: 'Bookings checked in today.', hits: [BOOKING] }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, search: url.search, body });
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

describe('search (T-178)', { timeout: 20_000 }, () => {
  it('searches from the top bar, then asks AI, showing records as links', async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(routes, { initialEntries: ['/search'] });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const box = await screen.findByLabelText(
      'Search guests, bookings, rooms or tasks',
      {},
      { timeout: 10_000 },
    );
    await user.type(box, 'Ada obi{Enter}');
    expect(await screen.findByRole('link', { name: 'Ada Obi' })).toHaveAttribute(
      'href',
      `/guests/${GUEST.id}`,
    );
    expect(calls.find((c) => c.key === 'GET /search')?.search).toBe('?q=Ada+obi');
    // Plain search used no AI.
    expect(calls.some((c) => c.key === 'POST /search/ask')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(await screen.findByText('Bookings checked in today.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'LAG-00042 · Ada Obi' })).toHaveAttribute(
      'href',
      `/reservations/${BOOKING.id}`,
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.key === 'POST /search/ask').map((c) => c.body)).toEqual([
        { question: 'Ada obi' },
      ]),
    );
  });
});
