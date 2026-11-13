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

// S16 Room board and S17 My rooms (PRD M5-01–M5-06; T-080, morning report T-081,
// inspection T-129).

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
  inspection: null,
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
  awaitingInspection: false,
  assignment: assignment(n),
  inspection: null,
  observed: null,
  discrepancy: null,
  ...extra,
});

const reported = (n: number, extra: object = {}) => ({
  roomId: id(n),
  number: String(100 + n),
  floor: '1',
  foStatus: 'VACANT',
  observed: null,
  reportedAt: null,
  discrepancy: null,
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
    'GET /housekeeping/status-reports': () =>
      json(200, { businessDate: '2026-11-10', floors: [], data: [] }),
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
          room(3, { observed: 'OCCUPIED', discrepancy: 'OCCUPIED_NO_FOLIO' }),
        ],
        attendants: [KEMI],
        settings: { inspectionRequired: false },
      });
    handlers['POST /housekeeping/assignments'] = () => json(200, { data: [] });
    const user = userEvent.setup();
    renderAt('/housekeeping');
    const rooms = await screen.findByRole('list', { name: 'Rooms' });
    expect(within(rooms).getByText(/occupied · due out/)).toBeInTheDocument();
    expect(within(rooms).getByText('Priority: guest arriving')).toBeInTheDocument();
    expect(within(rooms).getByText('Morning report: Occupied')).toBeInTheDocument();
    expect(
      within(rooms).getByText('Discrepancy: in use, but no guest is checked in'),
    ).toBeInTheDocument();
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

describe('Inspection (S16, M5-06)', () => {
  const SUPER = { id: id(91), name: 'Sola Super' };
  const board =
    (rooms: object[], inspectionRequired = false) =>
    () =>
      json(200, {
        businessDate: '2026-11-10',
        floors: ['1'],
        rooms,
        attendants: [KEMI],
        settings: { inspectionRequired },
      });

  it('fails a cleaned room with reasons, and passes another', async () => {
    permissions = ['hk.read', 'hk.inspect'];
    handlers['GET /housekeeping/board'] = board([
      room(1, { hkStatus: 'CLEAN', awaitingInspection: true }),
      room(2, { hkStatus: 'CLEAN', awaitingInspection: true }),
      room(3, {
        hkStatus: 'DIRTY',
        inspection: {
          id: id(70),
          roomId: id(3),
          passed: false,
          failReasons: ['Dust'],
          at: '2026-11-10T09:00:00Z',
          inspector: SUPER,
        },
      }),
    ]);
    handlers['POST /inspections'] = (body) =>
      json(201, {
        inspection: {
          id: id(71),
          ...(body as object),
          at: '2026-11-10T10:00:00Z',
          inspector: SUPER,
        },
        hkStatus: (body as { passed: boolean }).passed ? 'INSPECTED' : 'DIRTY',
        reopened: null,
      });
    const user = userEvent.setup();
    renderAt('/housekeeping');
    const rooms = await screen.findByRole('list', { name: 'Rooms' });
    expect(within(rooms).getAllByText('Waiting for inspection')).toHaveLength(2);
    expect(within(rooms).getByText('Failed inspection (Sola Super): Dust')).toBeInTheDocument();
    // A dirty room has nothing to inspect.
    expect(screen.queryByRole('button', { name: 'Inspect room 103' })).not.toBeInTheDocument();
    // Only rooms waiting.
    await user.click(
      screen.getByRole('checkbox', { name: 'Only the 2 rooms waiting for inspection' }),
    );
    expect(within(rooms).queryByText('103')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Inspect room 101' }));
    const form = screen.getByRole('form', { name: 'Inspection of room 101' });
    const fail = within(form).getByRole('button', { name: 'Fail and send back' });
    expect(fail).toBeDisabled();
    await user.click(within(form).getByRole('checkbox', { name: 'Bathroom not clean' }));
    await user.type(within(form).getByLabelText('Something else'), 'Hair on the pillow');
    await user.click(fail);
    await waitFor(() => expect(sent('POST /inspections')).toHaveLength(1));
    expect(sent('POST /inspections')[0]?.body).toEqual({
      roomId: id(1),
      passed: false,
      failReasons: ['Bathroom not clean', 'Hair on the pillow'],
    });

    await user.click(screen.getByRole('button', { name: 'Inspect room 102' }));
    const form2 = screen.getByRole('form', { name: 'Inspection of room 102' });
    await user.click(within(form2).getByRole('button', { name: 'Pass' }));
    await waitFor(() => expect(sent('POST /inspections')).toHaveLength(2));
    expect(sent('POST /inspections')[1]?.body).toEqual({
      roomId: id(2),
      passed: true,
      failReasons: [],
    });
  }, 15_000);

  it('lets the manager require inspection; others only see that it is on', async () => {
    permissions = ['hk.read', 'property.setup'];
    let required = false;
    handlers['GET /housekeeping/board'] = () =>
      board([room(1, { hkStatus: 'CLEAN', awaitingInspection: true })], required)();
    handlers['PUT /housekeeping/settings'] = (body) => {
      required = (body as { inspectionRequired: boolean }).inspectionRequired;
      return json(200, body);
    };
    const user = userEvent.setup();
    renderAt('/housekeeping');
    const box = await screen.findByRole('checkbox', {
      name: 'Rooms must pass inspection before a guest gets them',
    });
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() => expect(sent('PUT /housekeeping/settings')).toHaveLength(1));
    expect(sent('PUT /housekeeping/settings')[0]?.body).toEqual({ inspectionRequired: true });
    expect(
      await screen.findByText('Waiting for inspection: not ready for a guest yet'),
    ).toBeInTheDocument();
    await waitFor(() => expect(box).toBeChecked());
  }, 15_000);
});

describe('My rooms (S17)', () => {
  it('shows why the inspector sent a room back', async () => {
    permissions = ['hk.work'];
    handlers['GET /housekeeping/my-assignments'] = () =>
      json(200, {
        businessDate: '2026-11-10',
        data: [
          assignment(1, {
            attendant: KEMI,
            inspection: {
              id: id(70),
              roomId: id(1),
              passed: false,
              failReasons: ['Dust', 'No towels'],
              at: '2026-11-10T09:00:00Z',
              inspector: { id: id(91), name: 'Sola Super' },
            },
          }),
        ],
      });
    renderAt('/my-rooms');
    const card = await screen.findByRole('listitem', { name: 'Room 101' });
    expect(
      within(card).getByText('Sent back by the inspector: Dust; No towels'),
    ).toBeInTheDocument();
  }, 15_000);

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

describe('Morning report (S17)', () => {
  it('sends what the attendant saw and says when a discrepancy is raised', async () => {
    permissions = ['hk.work'];
    handlers['GET /housekeeping/my-assignments'] = () =>
      json(200, { businessDate: '2026-11-10', data: [] });
    let rows = [reported(1, { foStatus: 'OCCUPIED' }), reported(2)];
    handlers['GET /housekeeping/status-reports'] = () =>
      json(200, { businessDate: '2026-11-10', floors: ['1'], data: rows });
    handlers['POST /housekeeping/status-reports'] = () => {
      rows = [
        reported(1, { foStatus: 'OCCUPIED', observed: 'SLEPT_OUT' }),
        reported(2, { observed: 'OCCUPIED', discrepancy: 'OCCUPIED_NO_FOLIO' }),
      ];
      return json(201, { businessDate: '2026-11-10', data: rows, alertsRaised: 1 });
    };
    const user = userEvent.setup();
    renderAt('/my-rooms');
    const send = await screen.findByRole('button', { name: 'Send report (0)' });
    expect(send).toBeDisabled();
    expect(screen.getByText('Front desk: occupied')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Room 101 status'), 'SLEPT_OUT');
    await user.selectOptions(screen.getByLabelText('Room 102 status'), 'OCCUPIED');
    await user.click(screen.getByRole('button', { name: 'Send report (2)' }));
    expect(
      await screen.findByText('Report sent. 1 discrepancy raised for the front desk.'),
    ).toBeInTheDocument();
    expect(sent('POST /housekeeping/status-reports')[0]?.body).toEqual({
      entries: [
        { roomId: id(1), observed: 'SLEPT_OUT' },
        { roomId: id(2), observed: 'OCCUPIED' },
      ],
    });
    expect(
      await screen.findByText('Discrepancy: in use, but no guest is checked in'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send report (0)' })).toBeDisabled();
  }, 15_000);
});
