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

// S16 Room board and S17 My rooms (PRD M5-01–M5-04; T-080).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`;
const KEMI = { id: id(90), name: 'Kemi Clean' };

const assignment = (n: number, extra: object = {}) => ({
  id: id(n + 50),
  businessDate: '2026-11-10',
  roomId: id(n),
  roomNumber: String(100 + n),
  floor: '1',
  kind: 'DEPARTURE',
  status: 'PENDING',
  attendant: null,
  startedAt: null,
  completedAt: null,
  checklist: [
    { item: 'Make the beds', done: false },
    { item: 'Fresh towels', done: false },
  ],
  minibar: [],
  notes: null,
  hkStatus: 'DIRTY',
  ...extra,
});

const room = (n: number, extra: object = {}) => ({
  roomId: id(n),
  number: String(100 + n),
  floor: '1',
  roomType: 'Standard',
  hkStatus: 'DIRTY',
  foStatus: 'VACANT',
  dueOut: false,
  arrival: false,
  priority: 'NORMAL',
  assignment: assignment(n),
  ...extra,
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['hk.read', 'hk.assign'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
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

describe('Room board (S16)', () => {
  it('shows rooms with their statuses and assigns the selected ones', async () => {
    handlers['GET /housekeeping/board'] = () =>
      json(200, {
        businessDate: '2026-11-10',
        floors: ['1'],
        rooms: [
          room(1, { foStatus: 'OCCUPIED', dueOut: true }),
          room(2, { arrival: true, priority: 'HIGH' }),
        ],
        attendants: [KEMI],
      });
    handlers['POST /housekeeping/assignments'] = () => json(200, { data: [] });
    const user = userEvent.setup();
    renderAt('/housekeeping');
    const rooms = await screen.findByRole('list', { name: 'Rooms' });
    expect(within(rooms).getByText(/occupied · due out/)).toBeInTheDocument();
    expect(within(rooms).getByText('Priority: guest arriving')).toBeInTheDocument();
    await user.click(within(rooms).getByRole('checkbox', { name: 'Select room 101' }));
    await user.click(within(rooms).getByRole('checkbox', { name: 'Select room 102' }));
    await user.selectOptions(screen.getByLabelText('Attendant'), KEMI.id);
    await user.click(screen.getByRole('button', { name: 'Assign 2 selected' }));
    await waitFor(() => expect(sent('POST /housekeeping/assignments')).toHaveLength(1));
    expect(sent('POST /housekeeping/assignments')[0]?.body).toEqual({
      roomIds: [id(1), id(2)],
      attendantId: KEMI.id,
    });
  }, 15_000);
});

describe('My rooms (S17)', () => {
  it('starts a room, ticks the checklist and completes it', async () => {
    permissions = ['hk.work'];
    let current = assignment(1, { attendant: KEMI });
    handlers['GET /housekeeping/my-assignments'] = () =>
      json(200, { businessDate: '2026-11-10', data: [current] });
    handlers[`PATCH /housekeeping/assignments/${id(51)}`] = (body) => {
      const b = body as { action?: string; checklist?: { item: string; done: boolean }[] };
      if (b.action === 'START')
        current = { ...current, status: 'IN_PROGRESS', hkStatus: 'CLEANING' };
      if (b.checklist) current = { ...current, checklist: b.checklist };
      if (b.action === 'COMPLETE') current = { ...current, status: 'DONE', hkStatus: 'CLEAN' };
      return json(200, current);
    };
    const user = userEvent.setup();
    renderAt('/my-rooms');
    const card = await screen.findByRole('listitem', { name: 'Room 101' });
    await user.click(within(card).getByRole('button', { name: 'Start' }));
    const done = await within(card).findByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(within(card).getByRole('checkbox', { name: 'Make the beds' }));
    await waitFor(() =>
      expect(within(card).getByRole('checkbox', { name: 'Make the beds' })).toBeChecked(),
    );
    await user.click(within(card).getByRole('checkbox', { name: 'Fresh towels' }));
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Done' })).toBeEnabled());
    await user.click(within(card).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(within(card).getByText('Done')).toBeInTheDocument());
    expect(
      sent(`PATCH /housekeeping/assignments/${id(51)}`).map(
        (c) => (c.body as { action?: string }).action ?? 'checklist',
      ),
    ).toEqual(['START', 'checklist', 'checklist', 'COMPLETE']);
  }, 15_000);
});
