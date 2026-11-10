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

// Groups and allotments (PRD M3-17, M2-12; T-123).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `88888888-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STD = { id: id(1), name: 'Standard' };
const BLOCK = {
  id: id(2),
  kind: 'GROUP',
  code: 'OBI-WED',
  name: 'Obi wedding guests',
  status: 'ACTIVE',
  company: null,
  ratePlan: { id: id(3), code: 'GRP', name: 'Group rate' },
  arrival: '2026-11-20',
  departure: '2026-11-22',
  releaseDate: '2026-11-15',
  releaseDays: null,
  notes: null,
  roomTypes: [{ id: STD.id, name: 'Standard', rooms: 3, pickedUp: 1 }],
  createdAt: '2026-11-10T09:00:00Z',
};
const DETAIL = {
  ...BLOCK,
  nights: [
    {
      roomTypeId: STD.id,
      date: '2026-11-20',
      rooms: 3,
      pickedUp: 1,
      remaining: 2,
      released: false,
    },
    {
      roomTypeId: STD.id,
      date: '2026-11-21',
      rooms: 3,
      pickedUp: 1,
      remaining: 2,
      released: false,
    },
  ],
  rooming: [
    {
      reservationId: id(4),
      confirmationNo: 'P1-00012',
      stayId: id(5),
      guestName: 'Ada Obi',
      roomTypeId: STD.id,
      roomNumber: null,
      arrival: '2026-11-20',
      departure: '2026-11-22',
      status: 'CONFIRMED',
    },
  ],
};

let permissions: string[];
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['group.manage', 'allotment.manage'];
  const handlers: Record<string, () => Response> = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /group-blocks': () => json(200, { data: [BLOCK] }),
    'GET /allotments': () => json(200, { data: [] }),
    'POST /group-blocks': () => json(201, DETAIL),
    [`GET /group-blocks/${BLOCK.id}`]: () => json(200, DETAIL),
    [`POST /group-blocks/${BLOCK.id}/rooming-list`]: () =>
      json(200, {
        booked: [{ line: 1, confirmationNo: 'P1-00013' }],
        failed: [{ line: 2, message: 'No Standard room is left on some nights' }],
        block: DETAIL,
      }),
    [`POST /group-blocks/${BLOCK.id}/release`]: () => json(200, { ...DETAIL, status: 'RELEASED' }),
    'GET /room-types': () => json(200, { data: [{ ...STD, active: true }] }),
    'GET /rate-plans': () => json(200, { data: [{ ...BLOCK.ratePlan, active: true }] }),
    'GET /companies': () => json(200, { data: [] }),
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

describe('Groups and allotments (M3-17, M2-12)', { timeout: 20_000 }, () => {
  it('shows pick-up per night and the rooming list', async () => {
    const user = userEvent.setup();
    renderAt('/groups');
    const row = (await screen.findByText('Obi wedding guests')).closest('li') as HTMLElement;
    expect(within(row).getByText('Standard 1/3')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Open' }));
    expect(await within(row).findAllByText('1/3 (2 left)')).toHaveLength(2);
    expect(within(row).getByText('Ada Obi')).toBeInTheDocument();
    expect(within(row).getByText('Rooms not booked go back on 2026-11-15.')).toBeInTheDocument();
  });

  it('books names from the rooming list and says which could not be booked', async () => {
    const user = userEvent.setup();
    renderAt('/groups');
    const row = (await screen.findByText('Obi wedding guests')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Open' }));
    const form = await within(row).findByRole('form', { name: 'Add names to the rooming list' });
    await user.type(
      within(form).getByLabelText('Names, one per line (first name, then last name)'),
      'Bayo Ade{enter}Chi Eze Okafor',
    );
    await user.click(within(form).getByRole('button', { name: 'Book these names' }));
    await waitFor(() =>
      expect(sent(`POST /group-blocks/${BLOCK.id}/rooming-list`)).toHaveLength(1),
    );
    expect(sent(`POST /group-blocks/${BLOCK.id}/rooming-list`)[0]?.body).toEqual({
      rooms: [
        { firstName: 'Bayo', lastName: 'Ade', roomTypeId: STD.id },
        { firstName: 'Chi', lastName: 'Eze Okafor', roomTypeId: STD.id },
      ],
    });
    expect(await within(form).findByText('1 booking made.')).toBeInTheDocument();
    expect(within(form).getByText(/Line 2: No Standard room/)).toBeInTheDocument();
  });

  it('holds rooms for a new group with its release date', async () => {
    const user = userEvent.setup();
    renderAt('/groups');
    await user.click(await screen.findByRole('button', { name: 'Hold rooms for a group' }));
    const form = await screen.findByRole('form', { name: 'New group block' });
    await user.type(within(form).getByLabelText('Code'), 'OBI-WED');
    await user.type(within(form).getByLabelText('Name'), 'Obi wedding guests');
    await user.type(await within(form).findByLabelText('Standard'), '3');
    await user.click(within(form).getByRole('button', { name: 'Hold rooms' }));
    await waitFor(() => expect(sent('POST /group-blocks')).toHaveLength(1));
    expect(sent('POST /group-blocks')[0]?.body).toMatchObject({
      code: 'OBI-WED',
      ratePlanId: BLOCK.ratePlan.id,
      releaseDays: null,
      rooms: [{ roomTypeId: STD.id, count: 3 }],
    });
  });

  it('shows only the kinds the user may manage', async () => {
    permissions = ['group.manage'];
    renderAt('/groups');
    expect(await screen.findByRole('tab', { name: 'Group blocks' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Allotments' })).not.toBeInTheDocument();
  });
});
