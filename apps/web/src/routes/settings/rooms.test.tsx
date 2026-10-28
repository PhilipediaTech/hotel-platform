import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/query-client.ts';
import { routes } from '../../app/routes.tsx';
import { setApiPropertyId } from '../../lib/api.ts';
import { LAGOS, makeMe, membership } from '../../test/me-fixture.ts';

// S24 Rooms and room types (PRD M2-01–M2-03; T-031).

const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const STD = '77777777-0000-4000-8000-000000000001';
const DLX = '77777777-0000-4000-8000-000000000002';
const R101 = '88888888-0000-4000-8000-000000000101';
const R102 = '88888888-0000-4000-8000-000000000102';
const BLOCK = '99999999-0000-4000-8000-000000000001';

const type = (id: string, code: string, name: string, roomCount: number) => ({
  id,
  code,
  name,
  baseOccupancy: 2,
  maxOccupancy: code === 'DLX' ? 3 : 2,
  description: null,
  amenities: [],
  photoFileIds: [],
  sortOrder: 0,
  active: true,
  roomCount,
});

const room = (id: string, number: string, extra: object = {}) => ({
  id,
  number,
  roomTypeId: STD,
  floor: '1',
  building: null,
  features: [],
  connectingRoomId: null,
  hkStatus: 'CLEAN',
  qrToken: `token-${number}`,
  active: true,
  version: 3,
  blocks: [],
  ...extra,
});

const ALL = ['room.manage', 'roomtype.manage', 'room.block'];

let permissions: string[];
let handlers: Record<string, (body: unknown) => Response>;
const calls: { key: string; body: unknown; headers: Headers }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ALL;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /room-types': () =>
      json(200, { data: [type(STD, 'STD', 'Standard', 2), type(DLX, 'DLX', 'Deluxe', 0)] }),
    'GET /rooms': () =>
      json(200, {
        data: [
          room(R101, '101', {
            hkStatus: 'OUT_OF_ORDER',
            blocks: [
              {
                id: BLOCK,
                roomId: R101,
                kind: 'OUT_OF_ORDER',
                startDate: '2026-11-10',
                endDate: '2026-11-13',
                reason: 'AC leaking',
                createdBy: { id: '1', name: 'Ada' },
                createdAt: '2026-11-10T09:00:00Z',
                releasedAt: null,
              },
            ],
          }),
          room(R102, '102'),
        ],
      }),
    'POST /room-types': (b) => json(201, { ...type(STD, 'X', 'X', 0), ...(b as object) }),
    'POST /rooms': (b) => json(201, room(R102, (b as { number: string }).number)),
    [`PATCH /rooms/${R102}`]: () => json(200, room(R102, '102'), { ETag: '"4"' }),
    'POST /room-blocks': () => json(201, {}),
    [`POST /room-blocks/${BLOCK}/release`]: () => json(200, {}),
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

function renderAt(path: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

describe('Rooms tab', () => {
  it('lists rooms with type, status and current blocks', async () => {
    renderAt('/settings/rooms');
    const row = (await screen.findByText('101')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('Standard');
    expect(row).toHaveTextContent('Out of order');
    expect(row).toHaveTextContent(/10 Nov – back 13 Nov/);
    expect(row).toHaveTextContent('“AC leaking”');
  });

  it('adds a room, checking the number with the API schema first', async () => {
    const user = userEvent.setup();
    renderAt('/settings/rooms');
    await user.click(await screen.findByRole('button', { name: 'Add room' }));
    const form = screen.getByRole('form', { name: 'Add room' });
    await user.type(within(form).getByLabelText('Room'), '1 01');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/Letters, digits and dashes/)).toBeVisible();
    expect(sent('POST /rooms')).toHaveLength(0);

    await user.clear(within(form).getByLabelText('Room'));
    await user.type(within(form).getByLabelText('Room'), '103');
    await user.type(within(form).getByLabelText('Features'), 'Balcony, Sea view');
    await user.selectOptions(within(form).getByLabelText('Room type'), DLX);
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST /rooms')).toHaveLength(1));
    expect(sent('POST /rooms')[0]?.body).toEqual({
      number: '103',
      roomTypeId: DLX,
      floor: null,
      building: null,
      features: ['Balcony', 'Sea view'],
      connectingRoomId: null,
    });
  });

  it('edits a room with its version as If-Match', async () => {
    const user = userEvent.setup();
    renderAt('/settings/rooms');
    await user.click(await screen.findByRole('button', { name: 'Edit room 102' }));
    const form = screen.getByRole('form', { name: 'Edit room 102' });
    await user.selectOptions(within(form).getByLabelText('Connecting room'), R101);
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(`PATCH /rooms/${R102}`)).toHaveLength(1));
    const call = sent(`PATCH /rooms/${R102}`)[0];
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(call?.body).toMatchObject({ connectingRoomId: R101, active: true });
  });

  it('blocks a room with kind, dates and reason, and releases a block', async () => {
    const user = userEvent.setup();
    renderAt('/settings/rooms');
    await user.click(await screen.findByRole('button', { name: 'Take room 102 out of use' }));
    const form = screen.getByRole('form', { name: 'Take room 102 out of use' });
    await user.click(within(form).getByRole('radio', { name: /Out of service/ }));
    await user.clear(within(form).getByLabelText('From'));
    await user.type(within(form).getByLabelText('From'), '2099-01-10');
    await user.clear(within(form).getByLabelText('Back in use on'));
    await user.type(within(form).getByLabelText('Back in use on'), '2099-01-12');
    await user.type(within(form).getByLabelText('Reason'), 'Repainting');
    await user.click(within(form).getByRole('button', { name: 'Block room' }));
    await waitFor(() =>
      expect(sent('POST /room-blocks')[0]?.body).toEqual({
        roomId: R102,
        kind: 'OUT_OF_SERVICE',
        startDate: '2099-01-10',
        endDate: '2099-01-12',
        reason: 'Repainting',
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Release now' }));
    await waitFor(() => expect(sent(`POST /room-blocks/${BLOCK}/release`)).toHaveLength(1));
  });

  it('shows no edit or block buttons without the permissions', async () => {
    permissions = ['frontdesk.read', 'room.manage'];
    renderAt('/settings/rooms');
    await screen.findByText('101');
    expect(screen.queryByRole('button', { name: /out of use/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release now' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit room 101' })).toBeVisible();
  });
});

describe('Room types tab', () => {
  it('lists types and adds one, refusing max below base before sending', async () => {
    const user = userEvent.setup();
    renderAt('/settings/rooms?tab=types');
    const row = (await screen.findByText('Deluxe')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('2 (up to 3)');

    await user.click(screen.getByRole('button', { name: 'Add room type' }));
    const form = screen.getByRole('form', { name: 'Add room type' });
    await user.type(within(form).getByLabelText('Code'), 'ste');
    await user.type(within(form).getByLabelText('Name'), 'Suite');
    await user.clear(within(form).getByLabelText('Base occupancy'));
    await user.type(within(form).getByLabelText('Base occupancy'), '4');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/at least the base occupancy/)).toBeVisible();
    expect(sent('POST /room-types')).toHaveLength(0);

    await user.clear(within(form).getByLabelText('Maximum occupancy'));
    await user.type(within(form).getByLabelText('Maximum occupancy'), '4');
    await user.type(within(form).getByLabelText('Beds and amenities'), 'King bed, Jacuzzi');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent('POST /room-types')[0]?.body).toEqual({
        code: 'STE',
        name: 'Suite',
        baseOccupancy: 4,
        maxOccupancy: 4,
        description: null,
        amenities: ['King bed', 'Jacuzzi'],
        photoFileIds: [],
        sortOrder: 0,
      }),
    );
  });
});

describe('QR codes tab', () => {
  it('shows one labelled QR code per active room, linking to the room report', async () => {
    renderAt('/settings/rooms?tab=qr');
    const sheet = await screen.findByRole('list', { name: 'Room QR codes' });
    expect(within(sheet).getAllByRole('img')).toHaveLength(2);
    expect(within(sheet).getByRole('img', { name: 'QR code for room 101' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Print' })).toBeVisible();
  });
});
