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

// People added to a stay (PRD M14-02, M14-03; T-056) on the reservation page: the charge
// starts at the plan's suggestion, the desk may change it (0 = free) with a reason.

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const RES = '44444444-0000-4000-8000-000000000001';
const STAY = '44444444-0000-4000-8000-000000000002';
const GUEST = '44444444-0000-4000-8000-000000000003';
const BOLA = '44444444-0000-4000-8000-000000000009';
const ada = { id: GUEST, firstName: 'Ada', lastName: 'Obi', phone: null, email: null };

const reservation = {
  id: RES,
  confirmationNo: 'LAG-00001',
  status: 'CHECKED_IN',
  source: 'PHONE',
  guarantee: 'NONE',
  holdExpiresAt: null,
  booker: ada,
  company: null,
  notes: null,
  cancelReason: null,
  cancelledAt: null,
  currency: 'NGN',
  totalMinor: '11092500',
  depositDueMinor: '0',
  deposit: { heldMinor: '0', receivedMinor: '0', paymentMethods: ['CASH'], entries: [] },
  stays: [
    {
      id: STAY,
      status: 'CONFIRMED',
      guest: ada,
      roomTypeId: '44444444-0000-4000-8000-000000000004',
      roomTypeName: 'Family',
      roomId: null,
      roomNumber: null,
      ratePlanId: '44444444-0000-4000-8000-000000000005',
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
};

const view = (extra: object = {}) => ({
  stayId: STAY,
  status: 'CONFIRMED',
  isDayUse: false,
  adults: 2,
  children: 0,
  baseOccupancy: 2,
  maxOccupancy: 4,
  suggested: { ADULT: '500000', CHILD: '200000' },
  stayVersion: 1,
  data: [],
  ...extra,
});
const bola = {
  id: BOLA,
  stayId: STAY,
  firstName: 'Bola',
  lastName: 'Obi',
  kind: 'ADULT',
  phone: null,
  nightlyChargeMinor: '500000',
  chargeNote: null,
  addedBy: 'Desk',
  addedAt: '2026-11-10T09:00:00Z',
  removedAt: null,
  version: 0,
};

let permissions: string[];
let handlers: Record<string, (body: unknown) => Response>;
const calls: { key: string; body: unknown; headers: Headers }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['frontdesk.read', 'reservation.modify'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /front-desk/alerts': () =>
      json(200, { date: '2026-11-10', lateCheckOutFeeMinor: null, data: [] }),
    [`GET /reservations/${RES}`]: () => json(200, reservation),
    [`GET /reservations/${RES}/history`]: () => json(200, { data: [] }),
    [`GET /stays/${STAY}/occupants`]: () => json(200, view()),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body, headers: new Headers(init.headers) });
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

function renderPage() {
  const router = createMemoryRouter(routes, { initialEntries: [`/reservations/${RES}`] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('People added to a stay (M14-02, M14-03)', { timeout: 20_000 }, () => {
  it('adds a person at the suggested charge; another amount needs a reason', async () => {
    let added: unknown = null;
    handlers[`POST /stays/${STAY}/occupants`] = (body) => {
      added = body;
      return json(201, view({ adults: 3, data: [bola] }));
    };
    renderPage();
    const people = await screen.findByRole('region', { name: 'People added' });
    expect(people).toHaveTextContent('2 of 4 guests · 2 included in the price');
    expect(people).toHaveTextContent('Nobody added.');

    await userEvent.click(within(people).getByRole('button', { name: 'Add a person' }));
    const form = within(people).getByRole('form', { name: 'Add a person' });
    await userEvent.type(within(form).getByLabelText('First name'), 'Bola');
    await userEvent.type(within(form).getByLabelText('Last name'), 'Obi');
    const charge = within(form).getByLabelText('Charge per night');
    // The plan's suggestion for an adult, then for a child.
    expect(charge).toHaveValue('5000');
    expect(form).toHaveTextContent('The plan suggests ₦5,000.00.');
    await userEvent.selectOptions(within(form).getByLabelText('Adult or child'), 'CHILD');
    expect(charge).toHaveValue('2000');
    await userEvent.selectOptions(within(form).getByLabelText('Adult or child'), 'ADULT');
    // The same amount: no reason asked.
    expect(within(form).queryByLabelText('Why this charge?')).not.toBeInTheDocument();

    await userEvent.click(within(form).getByRole('button', { name: 'Add Bola Obi' }));
    await waitFor(() =>
      expect(added).toEqual({
        firstName: 'Bola',
        lastName: 'Obi',
        kind: 'ADULT',
        phone: null,
        nightlyChargeMinor: '500000',
        chargeNote: null,
      }),
    );
    expect(await within(people).findByText('Bola Obi · Adult')).toBeInTheDocument();
    expect(people).toHaveTextContent('₦5,000.00 per night');
  });

  it('a free child with the reason why', async () => {
    let added: unknown = null;
    handlers[`POST /stays/${STAY}/occupants`] = (body) => {
      added = body;
      return json(201, view({ children: 1 }));
    };
    renderPage();
    const people = await screen.findByRole('region', { name: 'People added' });
    await userEvent.click(within(people).getByRole('button', { name: 'Add a person' }));
    const form = within(people).getByRole('form', { name: 'Add a person' });
    await userEvent.type(within(form).getByLabelText('First name'), 'Dayo');
    await userEvent.type(within(form).getByLabelText('Last name'), 'Obi');
    await userEvent.selectOptions(within(form).getByLabelText('Adult or child'), 'CHILD');
    const charge = within(form).getByLabelText('Charge per night');
    await userEvent.clear(charge);
    await userEvent.type(charge, 'abc');
    await userEvent.click(within(form).getByRole('button', { name: 'Add Dayo Obi' }));
    expect(within(form).getByText('Enter an amount, e.g. 5000, or 0 for free')).toBeInTheDocument();
    expect(added).toBeNull();

    await userEvent.clear(charge);
    await userEvent.type(charge, '0');
    // Not the suggestion: the reason is asked for.
    await userEvent.type(within(form).getByLabelText('Why this charge?'), 'Under five: free');
    await userEvent.click(within(form).getByRole('button', { name: 'Add Dayo Obi' }));
    await waitFor(() =>
      expect(added).toMatchObject({
        kind: 'CHILD',
        nightlyChargeMinor: '0',
        chargeNote: 'Under five: free',
      }),
    );
  });

  it('changes a charge and removes a person; a full room offers no add', async () => {
    handlers[`GET /stays/${STAY}/occupants`] = () => json(200, view({ adults: 4, data: [bola] }));
    let patched: unknown = null;
    handlers[`PATCH /stays/${STAY}/occupants/${BOLA}`] = (body) => {
      patched = body;
      return json(
        200,
        view({
          adults: 4,
          data: [{ ...bola, nightlyChargeMinor: '350000', chargeNote: 'Agreed', version: 1 }],
        }),
      );
    };
    handlers[`POST /stays/${STAY}/occupants/${BOLA}/remove`] = () =>
      json(
        200,
        view({
          adults: 3,
          data: [{ ...bola, removedAt: '2026-11-10T10:00:00Z', version: 2 }],
        }),
      );
    renderPage();
    const people = await screen.findByRole('region', { name: 'People added' });
    expect(people).toHaveTextContent('The room holds 4 guests at most.');
    expect(within(people).queryByRole('button', { name: 'Add a person' })).not.toBeInTheDocument();

    await userEvent.click(
      within(people).getByRole('button', { name: 'Change the charge for Bola Obi' }),
    );
    const form = within(people).getByRole('form', { name: 'Change the charge for Bola Obi' });
    const amount = within(form).getByLabelText('New charge per night');
    await userEvent.clear(amount);
    await userEvent.type(amount, '3,500');
    await userEvent.type(within(form).getByLabelText('Why this charge?'), 'Agreed');
    await userEvent.click(within(form).getByRole('button', { name: 'Save charge' }));
    await waitFor(() =>
      expect(patched).toEqual({ nightlyChargeMinor: '350000', chargeNote: 'Agreed' }),
    );
    expect(sent(`PATCH /stays/${STAY}/occupants/${BOLA}`)[0]?.headers.get('If-Match')).toBe('"0"');
    expect(await within(people).findByText(/₦3,500.00 per night · Agreed/)).toBeInTheDocument();

    await userEvent.click(
      within(people).getByRole('button', { name: 'Remove Bola Obi from the stay' }),
    );
    expect(await within(people).findByText('Removed')).toBeInTheDocument();
    expect(sent(`POST /stays/${STAY}/occupants/${BOLA}/remove`)[0]?.headers.get('If-Match')).toBe(
      '"1"',
    );
  });

  it('without reservation.modify the list is read-only', async () => {
    permissions = ['frontdesk.read'];
    handlers[`GET /stays/${STAY}/occupants`] = () => json(200, view({ adults: 3, data: [bola] }));
    renderPage();
    const people = await screen.findByRole('region', { name: 'People added' });
    expect(await within(people).findByText('Bola Obi · Adult')).toBeInTheDocument();
    expect(within(people).queryByRole('button')).not.toBeInTheDocument();
  });
});
