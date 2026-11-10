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

// Services (PRD M9-09; T-122).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SPA = {
  id: id(1),
  code: 'SPA',
  name: 'Massage',
  category: 'SPA',
  description: null,
  priceMinor: '2500000',
  pricing: 'PER_PERSON',
  durationMinutes: 60,
  capacity: 2,
  opensAt: '09:00',
  closesAt: '18:00',
  minNoticeMinutes: 60,
  maxAdvanceDays: 14,
  chargeToFolio: true,
  revenueCode: 'MISC',
  active: true,
};
const BOOKING = {
  id: id(2),
  service: { id: SPA.id, name: 'Massage', category: 'SPA' },
  status: 'BOOKED',
  startsAt: '2026-11-10T09:00:00Z',
  endsAt: '2026-11-10T10:00:00Z',
  quantity: 2,
  guestName: 'Adaeze Obi',
  stay: { id: id(3), roomNumber: '101' },
  amountMinor: '5000000',
  charged: false,
  notes: null,
};
const SLOTS = {
  service: { id: SPA.id, name: 'Massage', capacity: 2 },
  slots: [
    { startsAt: '2026-11-10T08:00:00Z', endsAt: '2026-11-10T09:00:00Z', left: 2, bookable: false },
    { startsAt: '2026-11-10T09:00:00Z', endsAt: '2026-11-10T10:00:00Z', left: 0, bookable: true },
    { startsAt: '2026-11-10T10:00:00Z', endsAt: '2026-11-10T11:00:00Z', left: 2, bookable: true },
  ],
};
const IN_HOUSE = {
  data: [
    {
      stayId: id(3),
      guest: { id: id(4), firstName: 'Adaeze', lastName: 'Obi', phone: null },
      roomNumber: '101',
    },
  ],
};

let permissions: string[];
const calls: { key: string; body: unknown; search: string }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['folio.charge', 'frontdesk.read', 'service.manage'];
  const handlers: Record<string, () => Response> = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /services': () => json(200, { data: [SPA] }),
    'POST /services': () => json(201, SPA),
    [`GET /services/${SPA.id}/slots`]: () => json(200, SLOTS),
    'GET /service-bookings': () => json(200, { data: [BOOKING] }),
    'POST /service-bookings': () => json(201, BOOKING),
    [`POST /service-bookings/${BOOKING.id}/complete`]: () =>
      json(200, { ...BOOKING, status: 'COMPLETED', charged: true }),
    [`POST /service-bookings/${BOOKING.id}/cancel`]: () =>
      json(200, { ...BOOKING, status: 'NO_SHOW' }),
    'GET /front-desk/in-house': () => json(200, IN_HOUSE),
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

describe('Services (M9-09)', { timeout: 20_000 }, () => {
  it('lists the day’s bookings and marks one delivered or missed', async () => {
    const user = userEvent.setup();
    renderAt('/services');
    const row = (await screen.findByText(/Adaeze Obi/)).closest('li') as HTMLElement;
    expect(within(row).getByText(/room 101/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(sent(`POST /service-bookings/${BOOKING.id}/complete`)).toHaveLength(1),
    );
    await user.click(within(row).getByRole('button', { name: 'Did not come' }));
    await waitFor(() =>
      expect(sent(`POST /service-bookings/${BOOKING.id}/cancel`)).toHaveLength(1),
    );
    expect(sent(`POST /service-bookings/${BOOKING.id}/cancel`)[0]?.body).toEqual({ noShow: true });
  });

  it('books a free time for an in-house guest; full and closed times cannot be picked', async () => {
    const user = userEvent.setup();
    renderAt('/services');
    await user.click(await screen.findByRole('tab', { name: 'Book a service' }));
    const form = await screen.findByRole('form', { name: 'Book a service' });
    const times = await within(form).findByRole('group', { name: 'Start times' });
    const buttons = within(times).getAllByRole('button');
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();
    await user.click(buttons[2] as HTMLElement);
    await user.selectOptions(within(form).getByLabelText('Guest'), id(3));
    await user.clear(within(form).getByLabelText('How many (people, cars, items)'));
    await user.type(within(form).getByLabelText('How many (people, cars, items)'), '2');
    await user.click(within(form).getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(sent('POST /service-bookings')).toHaveLength(1));
    expect(sent('POST /service-bookings')[0]?.body).toMatchObject({
      serviceId: SPA.id,
      startsAt: '2026-11-10T10:00:00Z',
      quantity: 2,
      stayId: id(3),
    });
  });

  it('a manager sets up a service', async () => {
    const user = userEvent.setup();
    renderAt('/services');
    await user.click(await screen.findByRole('tab', { name: 'Setup' }));
    await user.click(await screen.findByRole('button', { name: 'Add a service' }));
    const form = screen.getByRole('form', { name: 'New service' });
    await user.type(within(form).getByLabelText('Code'), 'LAUNDRY');
    await user.type(within(form).getByLabelText('Name'), 'Laundry, per bag');
    await user.selectOptions(within(form).getByLabelText('Kind'), 'LAUNDRY');
    await user.type(within(form).getByLabelText('Price (₦)'), '5000');
    await user.type(within(form).getByLabelText('How many at once (blank for no limit)'), '10');
    await user.click(within(form).getByRole('button', { name: 'Save service' }));
    await waitFor(() => expect(sent('POST /services')).toHaveLength(1));
    expect(sent('POST /services')[0]?.body).toMatchObject({
      code: 'LAUNDRY',
      category: 'LAUNDRY',
      priceMinor: '500000',
      capacity: 10,
      chargeToFolio: true,
      revenueCode: 'MISC',
    });
  });

  it('without service.manage there is no Setup tab', async () => {
    permissions = ['folio.charge'];
    renderAt('/services');
    expect(await screen.findByRole('tab', { name: 'Bookings' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Setup' })).not.toBeInTheDocument();
  });
});
