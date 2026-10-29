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

// Day-use (PRD M3-10; T-052): sell a room for a start time and duration, check the guest in,
// end the stay at the desk.

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const RES = '55555555-0000-4000-8000-000000000001';
const STAY = '55555555-0000-4000-8000-000000000002';
const STD = '55555555-0000-4000-8000-000000000003';
const DAY = '55555555-0000-4000-8000-000000000004';
const R101 = '55555555-0000-4000-8000-000000000005';
const R102 = '55555555-0000-4000-8000-000000000006';
const GUEST = '55555555-0000-4000-8000-000000000007';
const TODAY = '2026-11-10';

const offers = {
  date: TODAY,
  startsAt: '2026-11-10T09:00:00Z',
  endsAt: '2026-11-10T13:00:00Z',
  currency: 'NGN',
  roomTypes: [
    {
      roomTypeId: STD,
      code: 'STD',
      name: 'Standard',
      maxOccupancy: 2,
      plans: [
        {
          ratePlanId: DAY,
          code: 'DAY',
          name: 'Day use',
          guarantee: 'NONE',
          maxMinutes: 360,
          totalMinor: '1848750',
          sellable: true,
          violations: [],
        },
      ],
      rooms: [
        { id: R101, number: '101', floor: '1', hkStatus: 'CLEAN' },
        { id: R102, number: '102', floor: '1', hkStatus: 'DIRTY' },
      ],
    },
  ],
};

const kemi = { id: GUEST, firstName: 'Kemi', lastName: 'Ade', phone: null, email: null };
const dayUseReservation = (status: string, endsAt = '2026-11-10T13:00:00Z') => ({
  id: RES,
  confirmationNo: 'LAG-00003',
  status,
  source: 'WALK_IN',
  guarantee: 'NONE',
  holdExpiresAt: null,
  booker: kemi,
  company: null,
  notes: null,
  cancelReason: null,
  cancelledAt: null,
  currency: 'NGN',
  totalMinor: '1848750',
  depositDueMinor: '0',
  stays: [
    {
      id: STAY,
      status,
      guest: kemi,
      roomTypeId: STD,
      roomTypeName: 'Standard',
      roomId: R102,
      roomNumber: '102',
      ratePlanId: DAY,
      ratePlanCode: 'DAY',
      arrival: TODAY,
      departure: TODAY,
      adults: 1,
      children: 0,
      folioId: null,
      dayUse: { startsAt: '2026-11-10T09:00:00Z', endsAt },
      nights: [{ date: TODAY, amountMinor: '1500000' }],
      totalMinor: '1848750',
      version: status === 'CONFIRMED' ? 0 : 1,
    },
  ],
  createdAt: '2026-11-10T09:00:00Z',
  updatedAt: '2026-11-10T09:00:00Z',
  version: 0,
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL; headers: Headers }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T09:00:00Z`));
  calls.length = 0;
  permissions = [
    'frontdesk.read',
    'reservation.create',
    'reservation.dayuse',
    'reservation.checkin',
    'reservation.checkout',
    'availability.read',
  ];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /day-use/availability': () => json(200, offers),
    'POST /day-use': () => json(201, dayUseReservation('CONFIRMED')),
    [`GET /reservations/${RES}`]: () => json(200, dayUseReservation('CONFIRMED')),
    [`GET /reservations/${RES}/history`]: () => json(200, { data: [] }),
    [`GET /stays/${STAY}/keys`]: () => json(200, { data: [] }),
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

describe('Day-use (M3-10)', () => {
  it('sells a room for a start time and duration, then opens check-in', async () => {
    const user = userEvent.setup();
    const router = renderAt('/bookings/day-use');
    const form = await screen.findByRole('form', { name: 'When and who' });
    // Today, from now at the property (10:00 in Lagos), three hours by default.
    expect(within(form).getByLabelText('Date')).toHaveValue(TODAY);
    expect(within(form).getByLabelText('Start time')).toHaveValue('10:00');
    await user.selectOptions(within(form).getByLabelText('How long'), '240');
    await user.click(within(form).getByRole('button', { name: 'Find rooms' }));

    expect(await screen.findByText('Day-use from 10:00 to 14:00')).toBeInTheDocument();
    expect(sent('GET /day-use/availability')[0]?.url.search).toBe(
      `?date=${TODAY}&start=10%3A00&minutes=240&adults=1&children=0`,
    );
    const plans = screen.getByRole('table', { name: 'Plans for Standard' });
    expect(plans).toHaveTextContent('up to 6 hours');
    expect(plans).toHaveTextContent('₦18,487.50');
    expect(screen.getByText(/2 rooms free/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add Standard on Day use' }));

    const details = screen.getByRole('form', { name: 'Room and guest' });
    const room = within(details).getByLabelText('Room');
    expect(room).toHaveValue(R101);
    await user.selectOptions(room, R102);
    await user.type(within(details).getByLabelText('First name'), 'Kemi');
    await user.type(within(details).getByLabelText('Last name'), 'Ade');
    await user.click(within(details).getByRole('button', { name: 'Sell day-use · ₦18,487.50' }));

    await waitFor(() => expect(sent('POST /day-use')).toHaveLength(1));
    expect(sent('POST /day-use')[0]?.body).toEqual({
      date: TODAY,
      start: '10:00',
      minutes: 240,
      adults: 1,
      children: 0,
      roomTypeId: STD,
      ratePlanId: DAY,
      roomId: R102,
      source: 'WALK_IN',
      guarantee: 'NONE',
      booker: { guestId: null, firstName: 'Kemi', lastName: 'Ade', phone: null, email: null },
      notes: null,
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/reservations/${RES}`));
    expect(router.state.location.search).toBe(`?checkIn=${STAY}`);
    expect(await screen.findByRole('form', { name: 'Check in Kemi Ade' })).toBeInTheDocument();
    expect(screen.getByText(/10:00–14:00 · Day-use/)).toBeInTheDocument();
  }, 15_000);

  it('ends a checked-in day-use: the stay closes and the room needs cleaning', async () => {
    let current = dayUseReservation('CHECKED_IN');
    handlers[`GET /reservations/${RES}`] = () => json(200, current);
    handlers[`POST /stays/${STAY}/check-out`] = () => {
      current = dayUseReservation('CHECKED_OUT');
      return json(200, current);
    };
    const user = userEvent.setup();
    renderAt(`/reservations/${RES}`);
    expect(await screen.findByText('Room 102')).toBeInTheDocument();
    // A day-use keeps the room it was sold with: no change or move here.
    expect(screen.queryByRole('button', { name: 'Move guest' })).not.toBeInTheDocument();
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'End day-use' }));

    await waitFor(() => expect(sent(`POST /stays/${STAY}/check-out`)).toHaveLength(1));
    const call = sent(`POST /stays/${STAY}/check-out`)[0];
    expect(call?.body).toEqual({ keysReturned: true });
    expect(call?.headers.get('If-Match')).toBe('"1"');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'End day-use' })).not.toBeInTheDocument(),
    );
  });

  it('marks a guest still in the room after the end time as overdue', async () => {
    handlers[`GET /reservations/${RES}`] = () =>
      json(200, dayUseReservation('CHECKED_IN', '2026-11-10T08:00:00Z'));
    renderAt(`/reservations/${RES}`);
    expect(await screen.findByText('Overdue')).toBeInTheDocument();
  });
});
