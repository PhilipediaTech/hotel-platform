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

// S09 Reservations (PRD M3-01–M3-05; T-042).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const RES = '33333333-0000-4000-8000-000000000001';
const STAY = '33333333-0000-4000-8000-000000000002';
const GUEST = '33333333-0000-4000-8000-000000000003';
const TYPE = '33333333-0000-4000-8000-000000000004';
const PLAN = '33333333-0000-4000-8000-000000000005';
const QUOTE = '33333333-0000-4000-8000-000000000006';

const ada = { id: GUEST, firstName: 'Ada', lastName: 'Obi', phone: '+2348000000000', email: null };
const reservation = (extra: object = {}) => ({
  id: RES,
  confirmationNo: 'LAG-00001',
  status: 'CONFIRMED',
  source: 'PHONE',
  guarantee: 'DEPOSIT',
  holdExpiresAt: null,
  booker: ada,
  company: null,
  notes: 'Late arrival',
  cancelReason: null,
  cancelledAt: null,
  currency: 'NGN',
  totalMinor: '11092500',
  depositDueMinor: '4500000',
  stays: [
    {
      id: STAY,
      status: 'CONFIRMED',
      guest: ada,
      roomTypeId: TYPE,
      roomTypeName: 'Standard',
      roomId: null,
      ratePlanId: PLAN,
      ratePlanCode: 'BAR',
      arrival: '2026-11-12',
      departure: '2026-11-14',
      adults: 2,
      children: 0,
      folioId: null,
      nights: [],
      totalMinor: '11092500',
      version: 0,
    },
  ],
  createdAt: '2026-11-10T09:00:00Z',
  updatedAt: '2026-11-10T09:00:00Z',
  version: 3,
  ...extra,
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL; headers: Headers }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['frontdesk.read', 'reservation.modify', 'reservation.cancel', 'availability.read'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /reservations': () =>
      json(200, {
        data: [
          {
            id: RES,
            confirmationNo: 'LAG-00001',
            status: 'CONFIRMED',
            source: 'PHONE',
            bookerName: 'Ada Obi',
            arrival: '2026-11-12',
            departure: '2026-11-14',
            rooms: 1,
            totalMinor: '11092500',
            holdExpiresAt: null,
          },
        ],
        nextCursor: null,
      }),
    [`GET /reservations/${RES}`]: () => json(200, reservation()),
    [`GET /reservations/${RES}/history`]: () =>
      json(200, {
        data: [
          {
            at: '2026-11-10T09:00:00Z',
            stayId: null,
            fromStatus: null,
            toStatus: 'CONFIRMED',
            reason: null,
            byName: 'Bola Desk',
          },
        ],
      }),
    'POST /quotes': () =>
      json(201, {
        quoteId: QUOTE,
        ratePlanId: PLAN,
        roomTypeId: TYPE,
        arrival: '2026-11-12',
        departure: '2026-11-15',
        currency: 'NGN',
        nights: [],
        taxes: [],
        netMinor: '13500000',
        totalMinor: '16638750',
        createdAt: '2026-11-10T09:00:00Z',
        expiresAt: '2026-11-10T09:30:00Z',
      }),
    [`PATCH /reservations/${RES}`]: () =>
      json(200, { ...reservation({ version: 4 }), differenceMinor: '5546250' }),
    [`POST /reservations/${RES}/cancel`]: () =>
      json(200, {
        ...reservation({ status: 'CANCELLED', cancelReason: 'GUEST_REQUEST', version: 4 }),
        feeMinor: '4500000',
      }),
    [`POST /reservations/${RES}/reinstate`]: () => json(200, reservation({ version: 5 })),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body, url, headers: new Headers(init.headers) });
      const handler = handlers[key];
      if (!handler) return Promise.reject(new Error(`Unexpected request ${key}`));
      return Promise.resolve(handler(body, url));
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
  return router;
}

describe('Reservations list', () => {
  it('finds reservations by text and status', async () => {
    const user = userEvent.setup();
    renderAt('/reservations');
    const table = await screen.findByRole('table', { name: 'Reservations found' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('LAG-00001Ada Obi');
    await user.type(screen.getByRole('textbox', { name: 'Search reservations' }), 'obi');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'TENTATIVE');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => {
      const query = sent('GET /reservations').at(-1)?.url.searchParams;
      expect([query?.get('q'), query?.get('status')]).toEqual(['obi', 'TENTATIVE']);
    });
  });
});

describe('Reservation detail', () => {
  it('shows stays, deposit and history', async () => {
    renderAt(`/reservations/${RES}`);
    expect(await screen.findByRole('heading', { name: /LAG-00001/ })).toHaveTextContent(
      'Confirmed',
    );
    expect(screen.getByText(/Ada Obi · Standard · BAR/)).toBeVisible();
    expect(await screen.findByText(/Bola Desk/)).toBeVisible();
  });

  it('changes the dates through a new quote and shows the difference', async () => {
    const user = userEvent.setup();
    renderAt(`/reservations/${RES}`);
    await user.click(await screen.findByRole('button', { name: 'Change dates or guests' }));
    const form = screen.getByRole('form', { name: 'Change dates or guests' });
    const leave = within(form).getByLabelText('Departure');
    await user.clear(leave);
    await user.type(leave, '2026-11-15');
    await user.click(within(form).getByRole('button', { name: 'Price and save' }));
    await waitFor(() => expect(sent(`PATCH /reservations/${RES}`)).toHaveLength(1));
    expect(sent('POST /quotes')[0]?.body).toEqual({
      roomTypeId: TYPE,
      ratePlanId: PLAN,
      arrival: '2026-11-12',
      departure: '2026-11-15',
      adults: 2,
      children: 0,
    });
    const patch = sent(`PATCH /reservations/${RES}`)[0];
    expect(patch?.headers.get('If-Match')).toBe('"3"');
    expect(patch?.body).toEqual({
      stays: [{ stayId: STAY, quoteId: QUOTE, adults: 2, children: 0 }],
    });
    expect(await screen.findByText(/The total changed by/)).toHaveTextContent('55,462.50');
  });

  it('confirms a tentative hold', async () => {
    const user = userEvent.setup();
    handlers[`GET /reservations/${RES}`] = () =>
      json(200, reservation({ status: 'TENTATIVE', holdExpiresAt: '2026-11-10T12:00:00Z' }));
    renderAt(`/reservations/${RES}`);
    await user.click(await screen.findByRole('button', { name: 'Confirm booking' }));
    await waitFor(() =>
      expect(sent(`PATCH /reservations/${RES}`)[0]?.body).toEqual({ confirm: true }),
    );
  });

  it('cancels with a reason after a second click and shows the fee', async () => {
    const user = userEvent.setup();
    renderAt(`/reservations/${RES}`);
    const panel = await screen.findByRole('region', { name: 'Cancel reservation' });
    await user.selectOptions(within(panel).getByLabelText('Reason'), 'CHANGE_OF_PLANS');
    await user.type(within(panel).getByLabelText('Note (optional)'), 'Trip moved');
    await user.click(within(panel).getByRole('button', { name: 'Cancel reservation' }));
    expect(sent(`POST /reservations/${RES}/cancel`)).toHaveLength(0);
    await user.click(within(panel).getByRole('button', { name: 'Yes, cancel it' }));
    await waitFor(() =>
      expect(sent(`POST /reservations/${RES}/cancel`)[0]?.body).toEqual({
        reason: 'CHANGE_OF_PLANS',
        note: 'Trip moved',
      }),
    );
    expect(
      sent(`POST /reservations/${RES}/cancel`)[0]?.headers.get('Idempotency-Key'),
    ).toBeTruthy();
  });

  it('reinstates a cancelled reservation', async () => {
    const user = userEvent.setup();
    handlers[`GET /reservations/${RES}`] = () =>
      json(200, reservation({ status: 'CANCELLED', cancelReason: 'GUEST_REQUEST' }));
    renderAt(`/reservations/${RES}`);
    expect(screen.queryByRole('region', { name: 'Cancel reservation' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Reinstate' }));
    await waitFor(() => expect(sent(`POST /reservations/${RES}/reinstate`)).toHaveLength(1));
  });

  it('shows no actions to a role that only views the desk', async () => {
    permissions = ['frontdesk.read'];
    renderAt(`/reservations/${RES}`);
    await screen.findByRole('heading', { name: /LAG-00001/ });
    expect(screen.queryByRole('button', { name: 'Change dates or guests' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Cancel reservation' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Details' })).toBeNull();
  });
});
