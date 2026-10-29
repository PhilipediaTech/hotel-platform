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

// S08 Availability search and new booking (PRD M3-01, M3-02, M3-05, M3 rule 8; T-044).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const failure = (status: number, code: string, message: string, details?: object) =>
  json(status, { error: { code, message, requestId: 'req-1', details } });

const RES = '44444444-0000-4000-8000-000000000001';
const STD = '44444444-0000-4000-8000-000000000002';
const DLX = '44444444-0000-4000-8000-000000000003';
const BAR = '44444444-0000-4000-8000-000000000004';
const CORP = '44444444-0000-4000-8000-000000000005';
const GUEST = '44444444-0000-4000-8000-000000000006';
const APPROVAL = '44444444-0000-4000-8000-000000000007';
const STAY = '44444444-0000-4000-8000-000000000008';
const TODAY = '2026-11-10';

const plan = (id: string, code: string, name: string, total: string | null, extra = {}) => ({
  ratePlanId: id,
  code,
  name,
  kind: 'BAR',
  mealPlan: 'ROOM_ONLY',
  guarantee: 'DEPOSIT',
  roomMinor: total,
  totalMinor: total,
  sellable: total !== null,
  violations: [],
  ...extra,
});
const availability = (arrival: string, departure: string, nights: number) => ({
  arrival,
  departure,
  nights,
  currency: 'NGN',
  roomTypes: [
    {
      roomTypeId: STD,
      code: 'STD',
      name: 'Standard',
      maxOccupancy: 2,
      available: 3,
      plans: [
        plan(BAR, 'BAR', 'Best available', '11092500'),
        plan(CORP, 'CORP', 'Corporate', null, {
          kind: 'DERIVED',
          violations: [{ rule: 'MIN_STAY', date: arrival, limit: 3 }],
        }),
      ],
    },
    {
      roomTypeId: DLX,
      code: 'DLX',
      name: 'Deluxe',
      maxOccupancy: 3,
      available: 0,
      plans: [plan(BAR, 'BAR', 'Best available', '16000000', { sellable: false })],
    },
  ],
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let quoteN = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T09:00:00Z`));
  calls.length = 0;
  quoteN = 0;
  permissions = ['frontdesk.read', 'reservation.create', 'availability.read', 'guest.manage'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /availability': (_b, url) =>
      json(
        200,
        availability(
          url.searchParams.get('arrival') ?? '',
          url.searchParams.get('departure') ?? '',
          2,
        ),
      ),
    'POST /quotes': (body) => {
      quoteN += 1;
      const b = body as { roomTypeId: string; ratePlanId: string; arrival: string };
      return json(201, {
        quoteId: `44444444-0000-4000-8000-00000000010${quoteN}`,
        ratePlanId: b.ratePlanId,
        roomTypeId: b.roomTypeId,
        arrival: b.arrival,
        departure: '2026-11-14',
        currency: 'NGN',
        nights: [],
        taxes: [],
        netMinor: '9000000',
        totalMinor: '11092500',
        createdAt: '2026-11-10T09:00:00Z',
        expiresAt: '2026-11-10T09:30:00Z',
      });
    },
    'POST /reservations': () => json(201, { id: RES, version: 0, stays: [{ id: STAY }] }),
    [`GET /reservations/${RES}`]: () => failure(404, 'NOT_FOUND', 'Not found'),
    [`GET /reservations/${RES}/history`]: () => json(200, { data: [] }),
    'GET /guests': () =>
      json(200, {
        data: [
          {
            id: GUEST,
            firstName: 'Ada',
            lastName: 'Obi',
            email: null,
            phone: '+2348031234567',
            nationality: null,
            preferences: { notes: null, tags: [] },
            marketingConsent: false,
            consentAt: null,
            flags: { vip: false, doNotRent: true, reason: 'Unpaid bill' },
            mergedIntoId: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        nextCursor: null,
      }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body, url });
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

async function searchFor(user: ReturnType<typeof userEvent.setup>, departure = '2026-11-14') {
  const form = await screen.findByRole('form', { name: 'Dates and guests' });
  const arrival = within(form).getByLabelText('Arrival');
  if (!(arrival as HTMLInputElement).disabled) {
    await user.clear(arrival);
    await user.type(arrival, '2026-11-12');
  }
  const leave = within(form).getByLabelText('Departure');
  await user.clear(leave);
  await user.type(leave, departure);
  const adults = within(form).getByLabelText('Adults');
  await user.clear(adults);
  await user.type(adults, '2');
  await user.click(within(form).getByRole('button', { name: 'Find rooms' }));
}

describe('New booking (S08)', () => {
  it('searches, shows prices per plan, and books a room for a new guest', async () => {
    const user = userEvent.setup();
    const router = renderAt('/bookings/new');
    await searchFor(user);

    expect(await screen.findByText('Rooms for 2 nights')).toBeInTheDocument();
    expect(sent('GET /availability')[0]?.url.search).toBe(
      '?arrival=2026-11-12&departure=2026-11-14&adults=2&children=0',
    );
    const std = screen.getByRole('table', { name: 'Plans for Standard' });
    expect(within(std).getAllByRole('row')[0]).toHaveTextContent('Best available');
    expect(within(std).getAllByRole('row')[0]).toHaveTextContent('₦110,925.00');
    // A plan a restriction stops shows why and can't be added; a sold-out type neither.
    expect(within(std).getAllByRole('row')[1]).toHaveTextContent('At least 3 nights from');
    expect(screen.getByRole('button', { name: 'Add Standard on Corporate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add Deluxe on Best available' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Add Standard on Best available' }));
    const details = screen.getByRole('form', { name: 'Booking details' });
    const book = within(details).getByRole('button', { name: 'Book 1 room · ₦110,925.00' });
    expect(book).toBeDisabled();
    await user.type(within(details).getAllByLabelText('First name')[0] as HTMLElement, 'Ada');
    await user.type(within(details).getAllByLabelText('Last name')[0] as HTMLElement, 'Obi');
    await user.type(within(details).getAllByLabelText('Phone')[0] as HTMLElement, '+2348031234567');
    await user.type(within(details).getByLabelText('Notes'), 'Late arrival');
    // The plan asks for a deposit, so that is the default guarantee.
    expect(within(details).getByLabelText('Guarantee')).toHaveValue('DEPOSIT');
    await user.click(book);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/reservations/${RES}`));
    expect(sent('POST /quotes')[0]?.body).toEqual({
      roomTypeId: STD,
      ratePlanId: BAR,
      arrival: '2026-11-12',
      departure: '2026-11-14',
      adults: 2,
      children: 0,
    });
    expect(sent('POST /reservations')[0]?.body).toEqual({
      source: 'PHONE',
      guarantee: 'DEPOSIT',
      holdUntil: null,
      booker: {
        guestId: null,
        firstName: 'Ada',
        lastName: 'Obi',
        phone: '+2348031234567',
        email: null,
      },
      companyId: null,
      stays: [
        {
          quoteId: '44444444-0000-4000-8000-000000000101',
          adults: 2,
          children: 0,
          guest: { sameAsBooker: true, guestId: null, phone: null, email: null },
          roomId: null,
        },
      ],
      notes: 'Late arrival',
    });
    // Much typing: slow when the whole suite runs at once.
  }, 15_000);

  it('books two rooms with a second guest as a tentative hold (M3-02, M3-05)', async () => {
    const user = userEvent.setup();
    renderAt('/bookings/new');
    await searchFor(user);
    const add = await screen.findByRole('button', { name: 'Add Standard on Best available' });
    await user.click(add);
    await user.click(add);
    const details = screen.getByRole('form', { name: 'Booking details' });
    const firsts = within(details).getAllByLabelText('First name');
    const lasts = within(details).getAllByLabelText('Last name');
    await user.type(firsts[0] as HTMLElement, 'Chidi');
    await user.type(lasts[0] as HTMLElement, 'Eze');
    // Room 2 is for someone else by default.
    await user.type(firsts[1] as HTMLElement, 'Ngozi');
    await user.type(lasts[1] as HTMLElement, 'Eze');
    await user.selectOptions(within(details).getByLabelText('Source'), 'EMAIL');
    await user.selectOptions(within(details).getByLabelText('Tentative hold'), '24');
    await user.click(within(details).getByRole('button', { name: 'Hold 2 rooms · ₦221,850.00' }));

    await waitFor(() => expect(sent('POST /reservations')).toHaveLength(1));
    expect(sent('POST /quotes')).toHaveLength(2);
    const body = sent('POST /reservations')[0]?.body as {
      source: string;
      holdUntil: string;
      stays: { quoteId: string; guest: object }[];
    };
    expect(body.source).toBe('EMAIL');
    expect(body.holdUntil).toBe('2026-11-11T09:00:00.000Z');
    expect(body.stays.map((s) => s.quoteId)).toEqual([
      '44444444-0000-4000-8000-000000000101',
      '44444444-0000-4000-8000-000000000102',
    ]);
    expect(body.stays[1]?.guest).toEqual({
      sameAsBooker: false,
      guestId: null,
      firstName: 'Ngozi',
      lastName: 'Eze',
      phone: null,
      email: null,
    });
  });

  it('walk-in: books from today and checks the guest in within six steps (M3-09)', async () => {
    permissions = [...permissions, 'reservation.checkin', 'room.assign'];
    const R101 = '44444444-0000-4000-8000-000000000301';
    const walkInStay = (status: string) => ({
      id: STAY,
      status,
      guest: { id: GUEST, firstName: 'Musa', lastName: 'Bello', phone: null, email: null },
      roomTypeId: STD,
      roomTypeName: 'Standard',
      roomId: status === 'CHECKED_IN' ? R101 : null,
      roomNumber: status === 'CHECKED_IN' ? '101' : null,
      ratePlanId: BAR,
      ratePlanCode: 'BAR',
      arrival: TODAY,
      departure: '2026-11-11',
      adults: 2,
      children: 0,
      folioId: null,
      dayUse: null,
      nights: [],
      totalMinor: '5546250',
      version: status === 'CHECKED_IN' ? 1 : 0,
    });
    let status = 'CONFIRMED';
    handlers[`GET /reservations/${RES}`] = () =>
      json(200, {
        id: RES,
        confirmationNo: 'LAG-00002',
        status,
        source: 'WALK_IN',
        guarantee: 'DEPOSIT',
        holdExpiresAt: null,
        booker: walkInStay(status).guest,
        company: null,
        notes: null,
        cancelReason: null,
        cancelledAt: null,
        currency: 'NGN',
        totalMinor: '5546250',
        depositDueMinor: '0',
        stays: [walkInStay(status)],
        createdAt: '2026-11-10T09:00:00Z',
        updatedAt: '2026-11-10T09:00:00Z',
        version: 0,
      });
    handlers[`GET /stays/${STAY}/rooms`] = () =>
      json(200, {
        data: [{ id: R101, number: '101', floor: '1', hkStatus: 'CLEAN', problems: [] }],
      });
    handlers[`POST /stays/${STAY}/check-in`] = () => {
      status = 'CHECKED_IN';
      return json(200, {
        stayId: STAY,
        status: 'CHECKED_IN',
        folioId: null,
        roomId: R101,
        version: 1,
      });
    };
    handlers[`GET /stays/${STAY}/keys`] = () => json(200, { data: [] });

    // A step is one thing the desk does on a screen; the test counts them as it goes.
    let steps = 0;
    const user = userEvent.setup();
    const router = renderAt('/bookings/new?mode=walk-in');
    expect(await screen.findByRole('heading', { name: 'Walk-in' })).toBeInTheDocument();
    const arrival = screen.getByLabelText('Arrival');
    expect(arrival).toBeDisabled();
    expect(arrival).toHaveValue(TODAY);

    // 1. Departure and guests, then search.
    await searchFor(user, '2026-11-11');
    steps += 1;
    expect(sent('GET /availability')[0]?.url.searchParams.get('arrival')).toBe(TODAY);
    // 2. Room type and plan.
    await user.click(await screen.findByRole('button', { name: 'Add Standard on Best available' }));
    steps += 1;
    const details = screen.getByRole('form', { name: 'Booking details' });
    expect(within(details).queryByLabelText('Source')).not.toBeInTheDocument();
    expect(within(details).queryByLabelText('Tentative hold')).not.toBeInTheDocument();
    // 3. The guest's name.
    await user.type(within(details).getByLabelText('First name'), 'Musa');
    await user.type(within(details).getByLabelText('Last name'), 'Bello');
    steps += 1;
    // 4. Book.
    await user.click(within(details).getByRole('button', { name: /^Book 1 room/ }));
    steps += 1;
    await waitFor(() => expect(sent('POST /reservations')).toHaveLength(1));
    expect(sent('POST /reservations')[0]?.body).toMatchObject({
      source: 'WALK_IN',
      holdUntil: null,
    });

    // The reservation opens with the check-in form already open: no extra click.
    await waitFor(() => expect(router.state.location.search).toBe(`?checkIn=${STAY}`));
    const form = await screen.findByRole('form', { name: 'Check in Musa Bello' });
    // 5. Room and the registration fields the property requires.
    await user.selectOptions(await within(form).findByLabelText('Room'), R101);
    await user.type(within(form).getByLabelText('Nationality'), 'NG');
    await user.selectOptions(within(form).getByLabelText('Purpose of stay'), 'LEISURE');
    await user.selectOptions(within(form).getByLabelText('ID type'), 'NATIONAL_ID');
    await user.type(within(form).getByLabelText('ID number'), '12345678901');
    steps += 1;
    // 6. Check in.
    await user.click(within(form).getByRole('button', { name: 'Check in now' }));
    steps += 1;

    await waitFor(() => expect(sent(`POST /stays/${STAY}/check-in`)).toHaveLength(1));
    expect(sent(`POST /stays/${STAY}/check-in`)[0]?.body).toMatchObject({ roomId: R101 });
    expect(await screen.findByText('Room 101')).toBeInTheDocument();
    expect(steps).toBeLessThanOrEqual(6);
  }, 20_000);

  it('a do-not-rent guest needs a reason, then goes to a manager (M3 rule 8)', async () => {
    let attempt = 0;
    handlers['POST /reservations'] = () => {
      attempt += 1;
      return attempt === 1
        ? failure(400, 'VALIDATION_ERROR', 'Flagged do-not-rent', { doNotRent: true })
        : json(202, {
            approvalRequestId: APPROVAL,
            status: 'PENDING',
            expiresAt: '2026-11-10T09:30:00Z',
            approverRoles: ['Owner', 'General Manager'],
          });
    };
    const user = userEvent.setup();
    renderAt('/bookings/new');
    await searchFor(user);
    await user.click(await screen.findByRole('button', { name: 'Add Standard on Best available' }));
    const details = screen.getByRole('form', { name: 'Booking details' });
    await user.type(within(details).getByLabelText('Find a guest'), 'obi');
    await user.click(within(details).getByRole('button', { name: 'Find' }));
    const found = await within(details).findByRole('list', { name: 'Guests found' });
    expect(found).toHaveTextContent('Do not rent');
    await user.click(within(found).getByRole('button', { name: 'Use Ada Obi' }));
    expect(details).toHaveTextContent('Ada Obi +2348031234567');
    await user.click(within(details).getByRole('button', { name: /^Book 1 room/ }));

    expect(await within(details).findByText(/flagged do not rent/)).toBeInTheDocument();
    const send = within(details).getByRole('button', { name: 'Send for approval' });
    expect(send).toBeDisabled();
    await user.type(within(details).getByLabelText('Reason for the manager'), 'Bill settled');
    await user.click(send);

    expect(await screen.findByText(/Sent for approval/)).toHaveTextContent(
      'Owner, General Manager can approve it until',
    );
    const second = sent('POST /reservations')[1]?.body as {
      booker: object;
      approvalReason: string;
    };
    expect(second.booker).toEqual({ guestId: GUEST, phone: null, email: null });
    expect(second.approvalReason).toBe('Bill settled');
  });

  it('shows the server’s answer when the last room went meanwhile', async () => {
    handlers['POST /reservations'] = () =>
      failure(409, 'BOOKING_CONFLICT', 'No room of this type is left on some nights');
    const user = userEvent.setup();
    renderAt('/bookings/new');
    await searchFor(user);
    await user.click(await screen.findByRole('button', { name: 'Add Standard on Best available' }));
    const details = screen.getByRole('form', { name: 'Booking details' });
    await user.type(within(details).getByLabelText('First name'), 'Ada');
    await user.type(within(details).getByLabelText('Last name'), 'Obi');
    await user.click(within(details).getByRole('button', { name: /^Book 1 room/ }));
    expect(await within(details).findByRole('alert')).toBeInTheDocument();
  });

  it('keeps working while a date is cleared', async () => {
    const user = userEvent.setup();
    renderAt('/bookings/new');
    const form = await screen.findByRole('form', { name: 'Dates and guests' });
    await user.clear(within(form).getByLabelText('Arrival'));
    expect(within(form).getByLabelText('Departure')).toHaveAttribute('min', TODAY);
  });
});
