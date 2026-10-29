import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../app/query-client.ts';
import { routes } from '../app/routes.tsx';
import { setApiPropertyId } from '../lib/api.ts';
import { LAGOS, makeMe, membership } from '../test/me-fixture.ts';
import { lanes } from './calendar.tsx';

// S07 Reservation calendar (T-044).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const STD = '55555555-0000-4000-8000-000000000001';
const R101 = '55555555-0000-4000-8000-000000000002';
const R102 = '55555555-0000-4000-8000-000000000003';
const RES_A = '55555555-0000-4000-8000-000000000004';
const RES_B = '55555555-0000-4000-8000-000000000005';
const RES_C = '55555555-0000-4000-8000-000000000006';
const TODAY = '2026-11-10';

const stay = (
  n: number,
  reservationId: string,
  arrival: string,
  departure: string,
  extra = {},
) => ({
  id: `55555555-0000-4000-8000-00000000010${n}`,
  reservationId,
  confirmationNo: `LAG-0000${n}`,
  status: 'CONFIRMED',
  roomTypeId: STD,
  roomId: null,
  rooms: [],
  arrival,
  departure,
  guestName: `Guest ${n}`,
  adults: 1,
  children: 0,
  ...extra,
});
const room = (id: string, number: string, blocks: object[] = []) => ({
  id,
  number,
  roomTypeId: STD,
  floor: null,
  building: null,
  features: [],
  connectingRoomId: null,
  hkStatus: 'CLEAN',
  qrToken: 'tok',
  active: true,
  version: 0,
  blocks,
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; url: URL; body: unknown; headers: Headers }[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T09:00:00Z`));
  calls.length = 0;
  permissions = ['frontdesk.read', 'reservation.create', 'availability.read'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /room-types': () =>
      json(200, {
        data: [
          {
            id: STD,
            code: 'STD',
            name: 'Standard',
            description: null,
            baseOccupancy: 2,
            maxOccupancy: 2,
            bedType: null,
            sizeSqm: null,
            amenities: [],
            photos: [],
            sortOrder: 0,
            active: true,
            version: 0,
          },
        ],
      }),
    'GET /rooms': () =>
      json(200, {
        data: [
          room(R101, '101'),
          room(R102, '102', [
            {
              id: '55555555-0000-4000-8000-000000000201',
              roomId: R102,
              kind: 'OUT_OF_ORDER',
              startDate: '2026-11-11',
              endDate: '2026-11-13',
              reason: 'Leaking pipe',
              createdBy: { id: R101, name: 'Gm' },
              createdAt: '2026-11-09T09:00:00Z',
              releasedAt: null,
            },
          ]),
        ],
      }),
    'GET /calendar': () =>
      json(200, {
        data: [
          stay(1, RES_A, '2026-11-12', '2026-11-14'),
          stay(2, RES_B, '2026-11-13', '2026-11-15', { status: 'TENTATIVE' }),
          stay(3, RES_C, '2026-11-14', '2026-11-16'),
        ],
      }),
    'GET /inventory': (_b, url) =>
      json(200, {
        days: Array.from({ length: 14 }, (_, i) => {
          const date = new Date(Date.parse(`${url.searchParams.get('from')}T00:00:00Z`) + i * 864e5)
            .toISOString()
            .slice(0, 10);
          return {
            roomTypeId: STD,
            date,
            capacity: 2,
            outOfOrder: 0,
            sold: 0,
            held: 0,
            overbookLimit: 0,
            available: date === '2026-11-13' ? 0 : 2,
          };
        }),
      }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, url, body, headers: new Headers(init.headers) });
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

describe('lanes', () => {
  it('packs stays that do not overlap onto the same row', () => {
    const a = stay(1, RES_A, '2026-11-12', '2026-11-14');
    const b = stay(2, RES_B, '2026-11-13', '2026-11-15');
    const c = stay(3, RES_C, '2026-11-14', '2026-11-16');
    expect(lanes([c, b, a] as never).map((row) => row.map((s) => s.reservationId))).toEqual([
      [RES_A, RES_C],
      [RES_B],
    ]);
  });
});

describe('Calendar (S07)', () => {
  it('shows unassigned stays per type, blocks on rooms and rooms left', async () => {
    renderAt('/calendar');
    const grid = await screen.findByRole('grid', { name: 'Reservation calendar' });
    expect(calls.find((c) => c.key === 'GET /calendar')?.url.search).toBe(
      '?from=2026-11-10&to=2026-11-24',
    );
    const standard = within(grid).getByRole('rowgroup', { name: 'Standard' });
    const rows = within(standard).getAllByRole('row');
    // Type row, two unassigned rows (stays 1 and 3 share one), rooms 101 and 102.
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      'Standard',
      'Unassigned',
      'Unassigned',
      '101 Clean',
      '102 Clean',
    ]);
    const first = within(rows[1] as HTMLElement).getByRole('link', {
      name: 'Guest 1, LAG-00001, Confirmed',
    });
    expect(first).toHaveAttribute('href', `/reservations/${RES_A}`);
    // Arrival 12 Nov in a window from 10 Nov: columns 4 to 6 (column 1 is the label).
    expect(first.style.gridColumnStart).toBe('4');
    expect(first.style.gridColumnEnd).toBe('6');
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: /Guest 3/ })).toBeVisible();
    expect(
      within(rows[2] as HTMLElement).getByRole('link', { name: /Guest 2, LAG-00002, Tentative/ }),
    ).toBeVisible();
    expect(rows[4]).toHaveTextContent('Out of order: Leaking pipe');
    await waitFor(() => expect(rows[0]).toHaveTextContent('0 left'));
    expect(screen.getByRole('link', { name: 'Walk-in' })).toHaveAttribute(
      'href',
      '/bookings/new?mode=walk-in',
    );
    // Blocking needs room.block.
    expect(screen.queryByLabelText('Block a room')).not.toBeInTheDocument();
  });

  it('moves a week at a time', async () => {
    const user = userEvent.setup();
    renderAt('/calendar');
    await screen.findByRole('grid', { name: 'Reservation calendar' });
    await user.click(screen.getByRole('button', { name: 'Later dates' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.key === 'GET /calendar').at(-1)?.url.search).toBe(
        '?from=2026-11-17&to=2026-12-01',
      ),
    );
    expect(await screen.findByText('17 Nov 2026 – 30 Nov 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Today' }));
    // The first window is still cached: shown again without asking the server.
    expect(await screen.findByText('10 Nov 2026 – 23 Nov 2026')).toBeInTheDocument();
  });

  it('users with room.block block a room from the calendar', async () => {
    permissions = [...permissions, 'room.block'];
    const user = userEvent.setup();
    renderAt('/calendar');
    await screen.findByRole('grid', { name: 'Reservation calendar' });
    await user.selectOptions(screen.getByLabelText('Block a room'), R101);
    await user.click(screen.getByRole('button', { name: 'Block' }));
    expect(screen.getByRole('form', { name: /101/ })).toBeInTheDocument();
  });
});

describe('Calendar rooms (T-050)', () => {
  const assignCalls = () => calls.filter((c) => c.key.endsWith('/assign-room'));
  let bodies: unknown[];
  beforeEach(() => {
    bodies = [];
    permissions = [...permissions, 'room.assign'];
  });

  it('assigns by dragging a booking onto a room; a room not ready goes to a manager', async () => {
    const stayId = '55555555-0000-4000-8000-000000000101';
    handlers[`POST /stays/${stayId}/assign-room`] = (body) => {
      bodies.push(body);
      return (body as { overrideReason?: string }).overrideReason
        ? json(202, {
            approvalRequestId: '55555555-0000-4000-8000-000000000999',
            status: 'PENDING',
            expiresAt: '2026-11-10T09:30:00Z',
            approverRoles: ['General Manager'],
          })
        : json(409, {
            error: {
              code: 'ROOM_NOT_READY',
              message: 'Room 101 is not ready for a guest yet',
              requestId: 'r',
              details: { problems: ['NOT_CLEAN'] },
            },
          });
    };
    const user = userEvent.setup();
    renderAt('/calendar');
    const grid = await screen.findByRole('grid', { name: 'Reservation calendar' });
    const rows = within(within(grid).getByRole('rowgroup', { name: 'Standard' })).getAllByRole(
      'row',
    );
    const bar = within(rows[1] as HTMLElement).getByRole('link', { name: /Guest 1/ });
    fireEvent.dragStart(bar);
    fireEvent.dragOver(rows[3] as HTMLElement);
    fireEvent.drop(rows[3] as HTMLElement);
    expect(await screen.findByText('Room 101 is not ready for a guest yet')).toBeInTheDocument();
    expect(bodies[0]).toEqual({ roomId: R101 });

    const form = screen.getByRole('form', { name: 'Give room 101 although it is not ready' });
    await user.type(within(form).getByLabelText(/A manager approves/), 'Guest waits in lounge');
    await user.click(within(form).getByRole('button', { name: 'Ask a manager' }));
    expect(await screen.findByText(/Sent to a manager: room 101/)).toBeInTheDocument();
    expect(bodies[1]).toEqual({ roomId: R101, overrideReason: 'Guest waits in lounge' });
    expect(assignCalls()).toHaveLength(2);
  });

  it('shows a moved guest on both rooms and drags a booking back to Unassigned', async () => {
    handlers['GET /calendar'] = () =>
      json(200, {
        data: [
          stay(1, RES_A, '2026-11-12', '2026-11-16', {
            status: 'CHECKED_IN',
            roomId: R102,
            rooms: [
              { roomId: R101, startDate: '2026-11-12', endDate: '2026-11-14' },
              { roomId: R102, startDate: '2026-11-14', endDate: '2026-11-16' },
            ],
          }),
          stay(2, RES_B, '2026-11-13', '2026-11-15', {
            roomId: R101,
            rooms: [{ roomId: R101, startDate: '2026-11-14', endDate: '2026-11-15' }],
          }),
        ],
      });
    const stayId = '55555555-0000-4000-8000-000000000102';
    handlers[`POST /stays/${stayId}/assign-room`] = (body) => {
      bodies.push(body);
      return json(200, { id: RES_B, version: 1 });
    };
    renderAt('/calendar');
    const grid = await screen.findByRole('grid', { name: 'Reservation calendar' });
    const rows = within(within(grid).getByRole('rowgroup', { name: 'Standard' })).getAllByRole(
      'row',
    );
    // Type row, room 101, room 102: nobody is unassigned.
    expect(rows).toHaveLength(3);
    const in101 = within(rows[1] as HTMLElement).getAllByRole('link');
    expect(in101.map((l) => l.textContent)).toEqual([
      'Guest 1 · Checked in',
      'Guest 2 · Confirmed',
    ]);
    expect(in101[0]?.style.gridColumnEnd).toBe('6');
    expect(within(rows[2] as HTMLElement).getByRole('link').style.gridColumnStart).toBe('6');

    // A checked-in guest is moved on the reservation page, not by dragging.
    fireEvent.dragStart(in101[0] as HTMLElement);
    fireEvent.drop(rows[2] as HTMLElement);
    expect(await screen.findByText(/move them from the reservation page/)).toBeInTheDocument();

    fireEvent.dragStart(in101[1] as HTMLElement);
    const unassigned = await within(grid).findByRole('rowheader', { name: 'Unassigned' });
    fireEvent.drop(unassigned.parentElement as HTMLElement);
    expect(await screen.findByText('Guest 2 is unassigned again.')).toBeInTheDocument();
    expect(bodies).toEqual([{ roomId: null }]);
  });

  it('housekeeping sets a room’s status from its row', async () => {
    permissions = ['frontdesk.read', 'hk.work'];
    handlers[`PATCH /rooms/${R101}/hk-status`] = () => json(200, room(R101, '101'));
    const user = userEvent.setup();
    renderAt('/calendar');
    const select = await screen.findByLabelText('Housekeeping status of room 101');
    expect(within(select).queryByRole('option', { name: 'Inspected' })).not.toBeInTheDocument();
    await user.selectOptions(select, 'DIRTY');
    await waitFor(() =>
      expect(calls.find((c) => c.key === `PATCH /rooms/${R101}/hk-status`)).toBeTruthy(),
    );
    const patch = calls.find((c) => c.key === `PATCH /rooms/${R101}/hk-status`);
    expect(patch?.headers.get('If-Match')).toBe('"0"');
    expect(patch?.body).toEqual({ hkStatus: 'DIRTY' });
  });
});
