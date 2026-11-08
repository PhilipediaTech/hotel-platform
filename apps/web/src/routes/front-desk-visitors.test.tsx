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

// The front desk's Visitors tab (PRD M14-04; T-057): sign in against a checked-in guest,
// sign out, who is still in and who has left.

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TODAY = '2026-11-10';

const stay = {
  stayId: id(1),
  reservationId: id(2),
  confirmationNo: 'LAG-00001',
  status: 'CHECKED_IN',
  source: 'PHONE',
  guarantee: 'NONE',
  guest: { id: id(3), firstName: 'Ada', lastName: 'Obi', phone: null },
  roomTypeName: 'Standard',
  roomId: id(4),
  roomNumber: '101',
  hkStatus: 'CLEAN',
  ratePlanCode: 'BAR',
  arrival: TODAY,
  departure: '2026-11-12',
  nights: 2,
  adults: 1,
  children: 0,
  dayUse: null,
  checkedInAt: '2026-11-10T09:00:00Z',
  checkedOutAt: null,
  totalMinor: '100',
  depositDueMinor: '0',
  balanceMinor: '0',
  flags: [],
  notes: null,
  version: 1,
};

const visitor = (n: number, name: string, extra: object = {}) => ({
  id: id(100 + n),
  stayId: id(1),
  reservationId: id(2),
  guestName: 'Ada Obi',
  roomNumber: '101',
  name,
  phone: null,
  note: null,
  idFileId: null,
  signedInAt: '2026-11-10T14:00:00Z',
  signedInBy: 'Desk',
  signedOutAt: null,
  ...extra,
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['frontdesk.read', 'visitor.log'];
  const list = (date: string, data: unknown[] = []) => json(200, { date, data });
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /front-desk/alerts': () =>
      json(200, { date: TODAY, lateCheckOutFeeMinor: null, data: [] }),
    'GET /front-desk/arrivals': () => list(TODAY),
    'GET /front-desk/departures': () => list(TODAY),
    'GET /front-desk/in-house': () => list(TODAY, [stay]),
    'GET /visitors': (_b, url) =>
      list(url.searchParams.get('date') ?? TODAY, [
        visitor(1, 'Tunde Bakare', { phone: '+2348031234567', idFileId: id(50) }),
        visitor(2, 'Gone Home', { signedOutAt: '2026-11-10T15:30:00Z' }),
      ]),
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

describe('Front desk visitors (M14-04)', { timeout: 20_000 }, () => {
  it('shows who is still in and who has left, with the way to add them to the booking', async () => {
    renderAt('/front-desk?tab=visitors');
    const stillIn = await screen.findByRole('region', { name: 'Still in' });
    expect(await within(stillIn).findByText(/Tunde Bakare/)).toBeInTheDocument();
    expect(stillIn).toHaveTextContent('Visiting Ada Obi, room 101');
    expect(
      within(stillIn).getByRole('link', { name: 'Add Tunde Bakare to the booking of Ada Obi' }),
    ).toHaveAttribute('href', `/reservations/${id(2)}`);
    expect(
      within(stillIn).getByRole('button', { name: 'View the ID photo of Tunde Bakare' }),
    ).toBeInTheDocument();
    const left = screen.getByRole('region', { name: 'Left' });
    expect(left).toHaveTextContent('Gone Home');
    expect(within(left).queryByRole('button', { name: /Sign out/ })).not.toBeInTheDocument();
  });

  it('signs a visitor in against the chosen guest', async () => {
    let body: unknown = null;
    handlers['POST /visitors'] = (b) => {
      body = b;
      return json(201, visitor(3, 'Bola Obi'));
    };
    renderAt('/front-desk?tab=visitors');
    const form = await screen.findByRole('form', { name: 'Sign a visitor in' });
    const guest = within(form).getByLabelText('Visiting');
    await within(form).findByRole('option', { name: '101 · Ada Obi' });
    await userEvent.selectOptions(guest, id(1));
    await userEvent.type(within(form).getByLabelText('Visitor’s name'), 'Bola Obi');
    await userEvent.type(within(form).getByLabelText('Note (optional)'), 'Sister');
    await userEvent.click(within(form).getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(body).toEqual({
        stayId: id(1),
        name: 'Bola Obi',
        phone: null,
        note: 'Sister',
        idFileId: null,
      }),
    );
    // The form clears and the list refreshes.
    await waitFor(() => expect(within(form).getByLabelText('Visitor’s name')).toHaveValue(''));
    await waitFor(() => expect(sent('GET /visitors').length).toBeGreaterThan(1));
  });

  it('signs a visitor out', async () => {
    handlers[`POST /visitors/${id(101)}/sign-out`] = () =>
      json(200, visitor(1, 'Tunde Bakare', { signedOutAt: '2026-11-10T16:00:00Z' }));
    renderAt('/front-desk?tab=visitors');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out Tunde Bakare' }));
    await waitFor(() => expect(sent(`POST /visitors/${id(101)}/sign-out`)).toHaveLength(1));
  });

  it('shows no Visitors tab without visitor.log', async () => {
    permissions = ['frontdesk.read'];
    renderAt('/front-desk?tab=visitors');
    expect(await screen.findByRole('tab', { name: /^Arrivals/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('tab', { name: 'Visitors' })).not.toBeInTheDocument();
    expect(sent('GET /visitors')).toHaveLength(0);
  });
});
