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

// S06 Front desk (PRD M3-06; T-053): arrivals, departures and in-house lists for the business
// date with balance and flags per row, quick check-in and quick day-use check-out.

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const TODAY = '2026-11-10';
const id = (n: number) => `66666666-0000-4000-8000-${String(n).padStart(12, '0')}`;

const row = (n: number, first: string, extra: object = {}) => ({
  stayId: id(n),
  reservationId: id(100 + n),
  confirmationNo: `LAG-0000${n}`,
  status: 'CONFIRMED',
  source: 'PHONE',
  guarantee: 'NONE',
  guest: { id: id(200 + n), firstName: first, lastName: 'Test', phone: '+2348000000000' },
  roomTypeName: 'Standard',
  roomId: null,
  roomNumber: null,
  hkStatus: null,
  ratePlanCode: 'BAR',
  arrival: TODAY,
  departure: '2026-11-12',
  nights: 2,
  adults: 1,
  children: 0,
  dayUse: null,
  checkedInAt: null,
  checkedOutAt: null,
  totalMinor: '11092500',
  depositDueMinor: '0',
  balanceMinor: null,
  flags: [],
  notes: null,
  version: 2,
  ...extra,
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL; headers: Headers }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T09:00:00Z`));
  calls.length = 0;
  permissions = ['frontdesk.read', 'reservation.checkin', 'reservation.checkout'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /front-desk/arrivals': (_b, url) =>
      json(200, {
        date: url.searchParams.get('date'),
        data:
          url.searchParams.get('date') === TODAY
            ? [
                row(1, 'Ada', {
                  flags: ['VIP', 'NO_ROOM', 'DEPOSIT_DUE'],
                  guarantee: 'DEPOSIT',
                  depositDueMinor: '4500000',
                }),
                row(2, 'Bola', {
                  roomId: id(301),
                  roomNumber: '102',
                  hkStatus: 'DIRTY',
                  flags: ['ROOM_NOT_READY'],
                }),
                row(3, 'Chi', {
                  status: 'CHECKED_IN',
                  roomId: id(303),
                  roomNumber: '103',
                  hkStatus: 'CLEAN',
                  checkedInAt: '2026-11-10T08:30:00Z',
                }),
              ]
            : [row(4, 'Efe', { arrival: url.searchParams.get('date') })],
      }),
    'GET /front-desk/departures': () =>
      json(200, {
        date: TODAY,
        data: [
          row(5, 'Kemi', {
            status: 'CHECKED_IN',
            roomId: id(305),
            roomNumber: '105',
            hkStatus: 'CLEAN',
            departure: TODAY,
            nights: 0,
            dayUse: { startsAt: '2026-11-10T09:00:00Z', endsAt: '2026-11-10T13:00:00Z' },
            flags: ['DAY_USE'],
          }),
          row(6, 'Musa', {
            status: 'CHECKED_IN',
            roomId: id(306),
            roomNumber: '106',
            hkStatus: 'CLEAN',
            arrival: '2026-11-08',
            departure: TODAY,
          }),
          row(7, 'Ngozi', {
            status: 'CHECKED_OUT',
            arrival: '2026-11-08',
            departure: TODAY,
            checkedOutAt: '2026-11-10T08:00:00Z',
          }),
        ],
      }),
    'GET /front-desk/in-house': () =>
      json(200, {
        date: TODAY,
        data: [row(6, 'Musa', { status: 'CHECKED_IN', roomNumber: '106', flags: ['OVERDUE'] })],
      }),
    [`POST /stays/${id(5)}/check-out`]: () => json(200, {}),
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
  vi.useRealTimers();
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

const rowOf = (table: HTMLElement, name: string) =>
  within(table)
    .getAllByRole('row')
    .find((r) => r.textContent?.includes(name)) as HTMLElement;

describe('Front desk (S06)', () => {
  it('lists today’s arrivals with flags, balance and quick check-in', async () => {
    renderAt('/front-desk');
    const table = await screen.findByRole('table', { name: 'Arrivals' });
    expect(sent('GET /front-desk/arrivals')[0]?.url.search).toBe(`?date=${TODAY}`);
    // Tab counts from the three lists.
    expect(await screen.findByRole('tab', { name: 'Arrivals (3)' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByRole('tab', { name: 'Departures (3)' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'In-house (1)' })).toBeInTheDocument();

    const ada = rowOf(table, 'Ada Test');
    expect(within(ada).getByLabelText('Flags for Ada Test')).toHaveTextContent(
      'VIPNo roomDeposit due',
    );
    expect(ada).toHaveTextContent('No room yet');
    expect(ada).toHaveTextContent('₦110,925.00');
    // No folios yet: the balance is a dash.
    expect(
      within(ada).getByTitle('Balances show once guest bills (folios) arrive'),
    ).toBeInTheDocument();
    expect(within(ada).getByRole('link', { name: 'Check in Ada Test' })).toHaveAttribute(
      'href',
      `/reservations/${id(101)}?checkIn=${id(1)}`,
    );
    const bola = rowOf(table, 'Bola Test');
    expect(bola).toHaveTextContent('Room not ready');
    expect(bola).toHaveTextContent('102');
    // Already in: no check-in, the status instead.
    const chi = rowOf(table, 'Chi Test');
    expect(within(chi).queryByRole('link', { name: /^Check in/ })).not.toBeInTheDocument();
    expect(chi).toHaveTextContent('Checked in');
  });

  it('opens another business date and finds a guest by name or room', async () => {
    const user = userEvent.setup();
    renderAt('/front-desk?tab=arrivals');
    const table = await screen.findByRole('table', { name: 'Arrivals' });
    await user.type(screen.getByLabelText('Find'), 'bola');
    expect(within(table).getAllByRole('row')).toHaveLength(2); // header + Bola
    await user.clear(screen.getByLabelText('Find'));
    await user.type(screen.getByLabelText('Find'), '103');
    // Typing "1" and "10" matched nothing on the way, so the table came back new.
    const byRoom = screen.getByRole('table', { name: 'Arrivals' });
    expect(rowOf(byRoom, 'Chi Test')).toBeTruthy();
    expect(within(byRoom).getAllByRole('row')).toHaveLength(2);
    await user.clear(screen.getByLabelText('Find'));

    const date = screen.getByLabelText('Business date');
    await user.clear(date);
    await user.type(date, '2026-11-11');
    expect(await screen.findByText('Efe Test')).toBeInTheDocument();
    expect(sent('GET /front-desk/arrivals').at(-1)?.url.search).toBe('?date=2026-11-11');
    // Not today: guests can't be checked in yet.
    expect(screen.queryByRole('link', { name: 'Check in Efe Test' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(await screen.findByText('Ada Test')).toBeInTheDocument();
    // Much typing: slow when the whole suite runs at once.
  }, 15_000);

  it('ends a day-use from departures; overnight check-out waits for bills', async () => {
    const user = userEvent.setup();
    renderAt('/front-desk?tab=departures');
    const table = await screen.findByRole('table', { name: 'Departures' });
    const kemi = rowOf(table, 'Kemi Test');
    expect(kemi).toHaveTextContent('10:00–14:00');
    expect(rowOf(table, 'Musa Test')).toHaveTextContent('Check-out comes with guest bills');
    expect(rowOf(table, 'Ngozi Test')).toHaveTextContent('Left at 09:00');

    await user.click(within(kemi).getByRole('button', { name: 'End day-use for Kemi Test' }));
    await waitFor(() => expect(sent(`POST /stays/${id(5)}/check-out`)).toHaveLength(1));
    const call = sent(`POST /stays/${id(5)}/check-out`)[0];
    expect(call?.body).toEqual({ keysReturned: true });
    expect(call?.headers.get('If-Match')).toBe('"2"');
    // The lists are read again.
    await waitFor(() => expect(sent('GET /front-desk/departures').length).toBeGreaterThan(1));
  });

  it('shows in-house guests and hides the date there', async () => {
    renderAt('/front-desk?tab=in-house');
    const table = await screen.findByRole('table', { name: 'In-house' });
    expect(rowOf(table, 'Musa Test')).toHaveTextContent('Overdue');
    expect(screen.queryByLabelText('Business date')).not.toBeInTheDocument();
  });
});
