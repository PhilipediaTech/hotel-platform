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

// Lost and found (PRD M5-13; T-133).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOLU = { id: id(90), name: 'Tolu Attendant' };
const SADE = { id: id(91), name: 'Sade Supervisor' };
const R101 = { id: id(60), number: '101' };

const item = (n: number, extra: object = {}) => ({
  id: id(n),
  number: n,
  description: 'Black iPhone 13',
  category: 'Phone',
  valuable: true,
  foundAt: '2026-11-10T11:00:00Z',
  foundWhere: null,
  room: R101,
  owner: { stayId: id(70), guestName: 'Ada Obi', phone: '+2348000000000', checkedOutAt: null },
  foundBy: TOLU,
  storageLocation: 'Housekeeping office',
  custodian: TOLU,
  status: 'HELD',
  keepUntil: '2027-05-09',
  canDispose: false,
  returnedToName: null,
  disposal: null,
  closedAt: null,
  ...extra,
});

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['lostfound.manage', 'hk.work'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /lost-found': () =>
      json(200, {
        data: [item(1)],
        categories: ['Phone', 'Other'],
        custodians: [SADE, TOLU],
        rooms: [R101],
      }),
    [`GET /lost-found/${id(1)}`]: () =>
      json(200, {
        ...item(1),
        returnedToPhone: null,
        returnedIdNote: null,
        closedBy: null,
        events: [
          {
            kind: 'LOGGED',
            note: null,
            storageLocation: 'Housekeeping office',
            custodian: TOLU,
            by: TOLU,
            at: '2026-11-10T11:00:00Z',
          },
        ],
      }),
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
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Lost and found', () => {
  it('logs a found item in a room', async () => {
    handlers['POST /lost-found'] = () => json(201, { ...item(2), events: [] });
    const user = userEvent.setup();
    renderAt('/lost-found');
    const list = await screen.findByRole('list', { name: 'Found items' });
    expect(await within(list).findByText(/Likely owner: Ada Obi/)).toBeInTheDocument();
    expect(within(list).getByText('Valuable')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Log a found item' }));
    const form = screen.getByRole('form', { name: 'Found item' });
    await user.type(within(form).getByLabelText('What is it'), 'Blue umbrella');
    await user.type(within(form).getByLabelText('Category'), 'Other');
    await user.selectOptions(within(form).getByLabelText('Found in room'), R101.id);
    await user.type(within(form).getByLabelText('Kept in'), 'Housekeeping office');
    await user.click(within(form).getByRole('button', { name: 'Log item' }));
    await waitFor(() => expect(sent('POST /lost-found')).toHaveLength(1));
    expect(sent('POST /lost-found')[0]?.body).toEqual({
      description: 'Blue umbrella',
      category: 'Other',
      valuable: false,
      roomId: R101.id,
      foundWhere: '',
      storageLocation: 'Housekeeping office',
      custodianId: null,
      note: '',
    });
  }, 15_000);

  it('returns an item to its owner', async () => {
    handlers[`POST /lost-found/${id(1)}/return`] = () =>
      json(200, { ...item(1, { status: 'RETURNED' }), events: [] });
    const user = userEvent.setup();
    renderAt('/lost-found');
    await user.click(await screen.findByRole('button', { name: 'LF-1 · Black iPhone 13' }));
    expect(await screen.findByRole('list', { name: 'Custody trail' })).toHaveTextContent('Logged');
    await user.click(screen.getByRole('button', { name: 'Return to owner' }));
    const form = screen.getByRole('form', { name: 'Return to owner' });
    // The likely owner is filled in.
    expect(within(form).getByLabelText('Given to')).toHaveValue('Ada Obi');
    await user.type(
      within(form).getByLabelText('How they were identified'),
      'Passport ending 4567',
    );
    await user.click(within(form).getByRole('button', { name: 'Return item' }));
    await waitFor(() => expect(sent(`POST /lost-found/${id(1)}/return`)).toHaveLength(1));
    expect(sent(`POST /lost-found/${id(1)}/return`)[0]?.body).toEqual({
      toName: 'Ada Obi',
      toPhone: '+2348000000000',
      idNote: 'Passport ending 4567',
      note: '',
    });
  }, 15_000);
});
