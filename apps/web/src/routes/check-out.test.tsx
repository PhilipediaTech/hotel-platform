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

// S12 Check-out (PRD M3 check-out story, M3 rules 3–4; T-064).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STAY = id(1);
const FOLIO = id(2);

const preview = (extra: object = {}) => ({
  stayId: STAY,
  status: 'CHECKED_IN',
  guestName: 'Ada Obi',
  roomNumber: '101',
  arrival: '2026-11-10',
  departure: '2026-11-12',
  dayUse: null,
  businessDate: '2026-11-12',
  leavesOn: '2026-11-12',
  folio: {
    id: FOLIO,
    number: 'F00001',
    balanceMinor: '0',
    windows: [{ number: 1, payerName: 'Ada Obi', balanceMinor: '0' }],
  },
  warnings: [{ code: 'KEYS_NOT_RETURNED', count: 2 }],
  blockers: [],
  version: 4,
  ...extra,
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL, init: RequestInit) => Response>;
const calls: { key: string; body: unknown; init: RequestInit }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['frontdesk.read', 'reservation.checkout', 'folio.read', 'folio.invoice'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    [`GET /stays/${STAY}/check-out`]: () => json(200, preview()),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body, init });
      const handler = handlers[key];
      if (!handler) return Promise.reject(new Error(`Unexpected request ${key}`));
      return Promise.resolve(handler(body, url, init));
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

describe('Check-out (S12)', () => {
  it('shows the bill, warns about keys, and checks out with the stay’s version', async () => {
    let out = false;
    handlers[`GET /stays/${STAY}/check-out`] = () =>
      json(200, out ? preview({ status: 'CHECKED_OUT' }) : preview());
    handlers[`POST /stays/${STAY}/check-out`] = () => {
      out = true;
      return json(200, {});
    };
    const user = userEvent.setup();
    renderAt(`/stays/${STAY}/check-out`);
    expect(await screen.findByRole('heading', { name: 'Check out Ada Obi' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Balance per window' })).toHaveTextContent(
      'Window 1: Ada Obi',
    );
    expect(screen.getByText('2 key cards have not been returned.')).toBeInTheDocument();
    await user.click(screen.getByLabelText('The keys came back'));
    await user.click(screen.getByRole('button', { name: 'Check out' }));
    await waitFor(() => expect(sent(`POST /stays/${STAY}/check-out`)).toHaveLength(1));
    const call = sent(`POST /stays/${STAY}/check-out`)[0];
    expect(call?.body).toEqual({ keysReturned: false });
    expect(new Headers(call?.init.headers).get('If-Match')).toBe('"4"');
    expect(
      await screen.findByText('Ada Obi has checked out. The room is now dirty.'),
    ).toBeInTheDocument();
  });

  it('blocks on a balance and says where to pay', async () => {
    handlers[`GET /stays/${STAY}/check-out`] = () =>
      json(
        200,
        preview({
          folio: {
            id: FOLIO,
            number: 'F00001',
            balanceMinor: '12325000',
            windows: [{ number: 1, payerName: 'Ada Obi', balanceMinor: '12325000' }],
          },
          warnings: [],
          blockers: ['FOLIO_BALANCE_OUTSTANDING'],
        }),
      );
    renderAt(`/stays/${STAY}/check-out`);
    expect(await screen.findByText(/The bill has a balance/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check out' })).toBeDisabled();
    const table = screen.getByRole('table', { name: 'Balance per window' });
    expect(within(table).getAllByText('₦123,250.00')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Open the folio to take payment' })).toHaveAttribute(
      'href',
      `/folios/${FOLIO}`,
    );
  });

  it('warns that an early departure gives the later nights back, and still checks out', async () => {
    handlers[`GET /stays/${STAY}/check-out`] = () =>
      json(
        200,
        preview({
          businessDate: '2026-11-11',
          leavesOn: '2026-11-11',
          warnings: [{ code: 'EARLY_DEPARTURE', count: 1 }],
        }),
      );
    renderAt(`/stays/${STAY}/check-out`);
    expect(
      await screen.findByText(
        'Leaving 1 night early (booked until 12 Nov 2026): the stay ends on 11 Nov 2026 and that night is given back.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check out' })).toBeEnabled();
  });
});
