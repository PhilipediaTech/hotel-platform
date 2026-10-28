import { addDays, localDate } from '@hotel/shared';
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

// Rooms left and overbooking limits on S23 (PRD M2 rule 1, M2-09; T-040).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const TODAY = localDate(new Date(), 'Africa/Lagos');
const STD = '33333333-0000-4000-8000-000000000001';

let permissions: string[];
let handlers: Record<string, (body: unknown) => Response>;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['rate.manage', 'rate.overbook', 'availability.read'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /rate-plans': () => json(200, { data: [] }),
    'GET /cancellation-policies': () => json(200, { data: [] }),
    'GET /room-types': () =>
      json(200, {
        data: [
          {
            id: STD,
            code: 'STD',
            name: 'Standard',
            baseOccupancy: 2,
            maxOccupancy: 2,
            description: null,
            amenities: [],
            photoFileIds: [],
            sortOrder: 0,
            active: true,
            roomCount: 10,
          },
        ],
      }),
    'GET /inventory': () =>
      json(200, {
        days: Array.from({ length: 14 }, (_, i) => ({
          roomTypeId: STD,
          date: addDays(TODAY, i),
          capacity: 10,
          outOfOrder: i === 0 ? 2 : 0,
          sold: i === 1 ? 10 : 3,
          held: i === 0 ? 1 : 0,
          overbookLimit: i === 1 ? 1 : 0,
          available: i === 0 ? 4 : i === 1 ? 1 : 7,
        })),
      }),
    'PUT /inventory/overbooking': () => json(200, { changedDays: 91 }),
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

describe('Rooms left', () => {
  it('shows rooms left per night with out of order and overbooking', async () => {
    renderAt('/rates?view=rooms-left');
    const grid = await screen.findByRole('table', { name: 'Rooms left' });
    const cells = within(within(grid).getByRole('row', { name: /Standard/ })).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('4of 10 · 2 out of order');
    expect(cells[1]).toHaveTextContent('1of 10 · +1 overbook');
    expect(cells[2]).toHaveTextContent('7of 10');
  });

  it('sets an overbooking limit', async () => {
    const user = userEvent.setup();
    renderAt('/rates?view=rooms-left');
    await user.click(await screen.findByRole('button', { name: 'Overbooking limit' }));
    const form = screen.getByRole('form', { name: 'Overbooking limit' });
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent('PUT /inventory/overbooking')[0]?.body).toEqual({
        roomTypeIds: [STD],
        from: TODAY,
        to: addDays(TODAY, 90),
        limit: 1,
      }),
    );
    expect(await within(form).findByText('91 days changed.')).toBeVisible();
  });

  it('offers no limit setting without rate.overbook', async () => {
    permissions = ['rate.manage', 'availability.read'];
    renderAt('/rates?view=rooms-left');
    await screen.findByRole('table', { name: 'Rooms left' });
    expect(screen.queryByRole('button', { name: 'Overbooking limit' })).toBeNull();
  });
});
