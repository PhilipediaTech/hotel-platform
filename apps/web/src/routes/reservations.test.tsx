import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../app/query-client.ts';
import { routes } from '../app/routes.tsx';
import { setApiPropertyId } from '../lib/api.ts';
import { addDays, localDate } from '@hotel/shared';
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
      roomNumber: null,
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

describe('Rooms for a stay (M3-07, M3-11; T-050)', () => {
  const R101 = '33333333-0000-4000-8000-000000000101';
  const R102 = '33333333-0000-4000-8000-000000000102';
  const withRoom = (status: string) =>
    reservation({
      status,
      stays: [{ ...reservation().stays[0], status, roomId: R101, roomNumber: '101' }],
    });
  beforeEach(() => {
    handlers[`GET /stays/${STAY}/rooms`] = () =>
      json(200, {
        data: [
          { id: R101, number: '101', floor: '1', hkStatus: 'CLEAN', problems: [] },
          { id: R102, number: '102', floor: '1', hkStatus: 'DIRTY', problems: ['NOT_CLEAN'] },
        ],
      });
  });

  it('gives a room, and sends a room that is not ready to a manager', async () => {
    permissions = [...permissions, 'room.assign'];
    // The server's state: the page reads it again after a change.
    let current = reservation();
    handlers[`GET /reservations/${RES}`] = () => json(200, current);
    handlers[`POST /stays/${STAY}/assign-room`] = (body) => {
      if ((body as { overrideReason?: string }).overrideReason) {
        return json(202, {
          approvalRequestId: '33333333-0000-4000-8000-000000000099',
          status: 'PENDING',
          expiresAt: '2026-11-10T09:30:00Z',
          approverRoles: ['General Manager'],
        });
      }
      current = withRoom('CONFIRMED');
      return json(200, current);
    };
    const user = userEvent.setup();
    renderAt(`/reservations/${RES}`);
    expect(await screen.findByText('No room yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose a room' }));
    const form = await screen.findByRole('form', { name: 'Choose a room' });
    const select = within(form).getByLabelText('Room');
    await within(form).findByRole('option', { name: '102 · Dirty · not clean yet' });
    await user.selectOptions(select, R101);
    expect(within(form).queryByLabelText(/A manager approves/)).not.toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Give this room' }));
    expect(await screen.findByText('Room 101')).toBeInTheDocument();
    expect(sent(`POST /stays/${STAY}/assign-room`)[0]?.body).toEqual({ roomId: R101 });

    await user.click(screen.getByRole('button', { name: 'Change room' }));
    const again = await screen.findByRole('form', { name: 'Choose a room' });
    await within(again).findByRole('option', { name: /^102/ });
    await user.selectOptions(within(again).getByLabelText('Room'), R102);
    const ask = within(again).getByRole('button', { name: 'Ask a manager' });
    expect(ask).toBeDisabled();
    await user.type(within(again).getByLabelText(/A manager approves/), 'VIP arriving now');
    await user.click(ask);
    expect(await screen.findByText(/Sent to a manager for approval/)).toBeInTheDocument();
    expect(sent(`POST /stays/${STAY}/assign-room`)[1]?.body).toEqual({
      roomId: R102,
      overrideReason: 'VIP arriving now',
    });
  });

  it('moves a checked-in guest with a reason', async () => {
    permissions = [...permissions, 'room.move'];
    let current: unknown = withRoom('CHECKED_IN');
    handlers[`GET /reservations/${RES}`] = () => json(200, current);
    handlers[`GET /stays/${STAY}/rooms`] = () =>
      json(200, {
        data: [{ id: R102, number: '102', floor: '1', hkStatus: 'CLEAN', problems: [] }],
      });
    handlers[`POST /stays/${STAY}/move`] = () => {
      current = reservation({
        status: 'CHECKED_IN',
        stays: [
          { ...reservation().stays[0], status: 'CHECKED_IN', roomId: R102, roomNumber: '102' },
        ],
      });
      return json(200, current);
    };
    const user = userEvent.setup();
    renderAt(`/reservations/${RES}`);
    expect(await screen.findByText('Room 101')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take the room back' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move guest' }));
    const form = await screen.findByRole('form', { name: 'Move guest' });
    await within(form).findByRole('option', { name: /^102/ });
    await user.selectOptions(within(form).getByLabelText('Room'), R102);
    await user.type(within(form).getByLabelText('Reason for the move'), 'Noisy air conditioner');
    await user.click(within(form).getByRole('button', { name: 'Move now' }));
    expect(await screen.findByText('Room 102')).toBeInTheDocument();
    const move = sent(`POST /stays/${STAY}/move`)[0];
    expect(move?.body).toEqual({ roomId: R102, reason: 'Noisy air conditioner' });
    expect(move?.headers.get('Idempotency-Key')).toBeTruthy();
  });
});

describe('Check-in (M3-08, M3-19; T-051)', () => {
  const today = localDate(new Date(), 'Africa/Lagos');
  const R101 = '33333333-0000-4000-8000-000000000101';
  const staying = (status: string) =>
    reservation({
      status,
      stays: [
        {
          ...reservation().stays[0],
          status,
          arrival: today,
          departure: addDays(today, 2),
          roomId: R101,
          roomNumber: '101',
        },
      ],
    });

  it('checks a guest in with the fields the property requires', async () => {
    permissions = [...permissions, 'reservation.checkin'];
    let current: unknown = staying('CONFIRMED');
    handlers[`GET /reservations/${RES}`] = () => json(200, current);
    handlers[`POST /stays/${STAY}/check-in`] = () => {
      current = staying('CHECKED_IN');
      return json(200, {
        stayId: STAY,
        status: 'CHECKED_IN',
        folioId: null,
        roomId: R101,
        version: 1,
      });
    };
    handlers[`GET /stays/${STAY}/keys`] = () =>
      json(200, {
        data: [
          {
            id: '33333333-0000-4000-8000-000000000201',
            roomNumber: '101',
            count: 1,
            issuedBy: 'Bola Desk',
            issuedAt: '2026-11-10T14:00:00Z',
          },
        ],
      });
    const user = userEvent.setup();
    renderAt(`/reservations/${RES}`);
    await user.click(await screen.findByRole('button', { name: 'Check in' }));
    const form = screen.getByRole('form', { name: 'Check in Ada Obi' });
    expect(within(form).getByText('Room 101')).toBeInTheDocument();
    // The property asks for nationality, purpose, ID type and number (the fixture's fields).
    expect(within(form).queryByLabelText('Home address')).not.toBeInTheDocument();
    const submit = within(form).getByRole('button', { name: 'Check in now' });
    expect(submit).toBeDisabled();
    await user.type(within(form).getByLabelText('Nationality'), 'NG');
    await user.selectOptions(within(form).getByLabelText('Purpose of stay'), 'BUSINESS');
    await user.selectOptions(within(form).getByLabelText('ID type'), 'PASSPORT');
    await user.type(within(form).getByLabelText('ID number'), 'A12345678');
    await user.clear(within(form).getByLabelText('Key cards given'));
    await user.type(within(form).getByLabelText('Key cards given'), '2');
    await user.click(submit);

    expect(await screen.findByText('1 key card issued')).toBeInTheDocument();
    const call = sent(`POST /stays/${STAY}/check-in`)[0];
    expect(call?.body).toEqual({
      registration: {
        nationality: 'NG',
        purpose: 'BUSINESS',
        idType: 'PASSPORT',
        idNumber: 'A12345678',
      },
      keysIssued: 2,
    });
    expect(call?.headers.get('If-Match')).toBe('"0"');
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Registration card' })).toHaveAttribute(
      'href',
      `/stays/${STAY}/card`,
    );
  });

  it('does not offer check-in before the arrival day or without the permission', async () => {
    handlers[`GET /reservations/${RES}`] = () => json(200, staying('CONFIRMED'));
    renderAt(`/reservations/${RES}`);
    await screen.findByText('Room 101');
    expect(screen.queryByRole('button', { name: 'Check in' })).not.toBeInTheDocument();
  });

  it('opens check-in only on the arrival day', async () => {
    permissions = [...permissions, 'reservation.checkin'];
    const tomorrow = reservation({
      stays: [
        {
          ...reservation().stays[0],
          arrival: addDays(today, 1),
          departure: addDays(today, 3),
        },
      ],
    });
    handlers[`GET /reservations/${RES}`] = () => json(200, tomorrow);
    renderAt(`/reservations/${RES}`);
    await screen.findByText('No room yet');
    expect(screen.queryByRole('button', { name: 'Check in' })).not.toBeInTheDocument();
  });

  it('issues another key to a checked-in guest', async () => {
    permissions = [...permissions, 'key.issue'];
    handlers[`GET /reservations/${RES}`] = () => json(200, staying('CHECKED_IN'));
    const log: object[] = [];
    handlers[`GET /stays/${STAY}/keys`] = () => json(200, { data: log });
    handlers[`POST /stays/${STAY}/keys`] = () => {
      const k = {
        id: `33333333-0000-4000-8000-00000000030${log.length}`,
        roomNumber: '101',
        count: 1,
        issuedBy: 'Bola Desk',
        issuedAt: '2026-11-10T15:00:00Z',
      };
      log.unshift(k);
      return json(201, k);
    };
    const user = userEvent.setup();
    renderAt(`/reservations/${RES}`);
    expect(await screen.findByText('0 key cards issued')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Issue another key' }));
    expect(await screen.findByText('1 key card issued')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Key log' })).toHaveTextContent(
      '1 card for room 101 by Bola Desk',
    );
    expect(sent(`POST /stays/${STAY}/keys`)[0]?.body).toEqual({ count: 1 });
  });

  it('extends a checked-in stay and shows how much the total changed (M3-12)', async () => {
    permissions = [...permissions, 'reservation.checkin'];
    let current: unknown = staying('CHECKED_IN');
    handlers[`GET /reservations/${RES}`] = () => json(200, current);
    handlers[`GET /stays/${STAY}/keys`] = () => json(200, { data: [] });
    handlers[`POST /stays/${STAY}/extend`] = () => {
      const longer = staying('CHECKED_IN');
      current = {
        ...longer,
        stays: [{ ...longer.stays[0], departure: addDays(today, 3), version: 1 }],
      };
      return json(200, { ...(current as object), differenceMinor: '5546250' });
    };
    const user = userEvent.setup();
    renderAt(`/reservations/${RES}`);
    await user.click(await screen.findByRole('button', { name: 'Change departure' }));
    const form = screen.getByRole('form', { name: 'Change departure' });
    const date = within(form).getByLabelText('New departure');
    expect(date).toHaveValue(addDays(today, 2));
    // Same date: nothing to save.
    expect(within(form).getByRole('button', { name: 'Shorten stay' })).toBeDisabled();
    await user.clear(date);
    await user.type(date, addDays(today, 3));
    await user.type(within(form).getByLabelText('Reason (optional)'), 'Meeting moved');
    await user.click(within(form).getByRole('button', { name: 'Extend stay' }));

    expect(await screen.findByRole('status')).toHaveTextContent('₦55,462.50');
    const call = sent(`POST /stays/${STAY}/extend`)[0];
    expect(call?.body).toEqual({ departure: addDays(today, 3), reason: 'Meeting moved' });
    expect(call?.headers.get('If-Match')).toBe('"0"');
  }, 15_000);

  it('offers no departure change before check-in or without reservation.modify', async () => {
    handlers[`GET /reservations/${RES}`] = () => json(200, staying('CONFIRMED'));
    renderAt(`/reservations/${RES}`);
    await screen.findByText('Room 101');
    expect(screen.queryByRole('button', { name: 'Change departure' })).not.toBeInTheDocument();
  });

  it('prints the registration card with the ID number masked', async () => {
    handlers[`GET /stays/${STAY}/registration-card`] = () =>
      json(200, {
        stayId: STAY,
        confirmationNo: 'LAG-00001',
        property: { name: 'Lagos Hotel', address: '12 Admiralty Way, Lekki, Lagos' },
        guest: { firstName: 'Ada', lastName: 'Obi', phone: '+2348000000000', email: null },
        roomNumber: '101',
        roomTypeName: 'Standard',
        arrival: '2026-11-12',
        departure: '2026-11-14',
        adults: 2,
        children: 0,
        nationality: 'NG',
        address: null,
        purpose: 'BUSINESS',
        idType: 'PASSPORT',
        idNumberMasked: '•••• 5678',
        idExpiry: null,
        signature: 'PAPER',
        signatureFileId: null,
        checkedInAt: '2026-11-12T14:00:00Z',
        checkedInBy: 'Bola Desk',
      });
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const user = userEvent.setup();
    renderAt(`/stays/${STAY}/card`);
    expect(await screen.findByText('Confirmation LAG-00001 · Room 101')).toBeInTheDocument();
    expect(screen.getByText('•••• 5678')).toBeInTheDocument();
    expect(screen.getByText('Passport')).toBeInTheDocument();
    expect(screen.queryByText('Home address')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalled();
  });
});

describe('Proforma invoice (T-062)', () => {
  it('opens the booking’s proforma as a PDF for holders of folio.invoice', async () => {
    permissions = [...permissions, 'folio.invoice'];
    handlers[`GET /reservations/${RES}/proforma.pdf`] = () =>
      new Response('%PDF-1.3', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.stubGlobal(
      'open',
      vi.fn(() => tab),
    );
    URL.createObjectURL = vi.fn(() => 'blob:proforma');
    URL.revokeObjectURL = vi.fn();
    const user = userEvent.setup();
    renderAt(`/reservations/${RES}`);
    await user.click(await screen.findByRole('button', { name: 'Proforma invoice' }));
    await waitFor(() => expect(tab.location.href).toBe('blob:proforma'));
    expect(sent(`GET /reservations/${RES}/proforma.pdf`)).toHaveLength(1);
  });

  it('offers no proforma without folio.invoice', async () => {
    renderAt(`/reservations/${RES}`);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Proforma invoice' })).not.toBeInTheDocument();
  });
});
