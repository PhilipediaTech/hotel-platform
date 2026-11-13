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

// S18 Tasks queue and detail, S19 QR fault report (PRD M6-01–M6-05, M5-07; T-082).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `66666666-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FEMI = { id: id(90), name: 'Femi Fix' };
const MNT = { id: id(80), code: 'MNT', name: 'Maintenance' };
const FO = { id: id(81), code: 'FO', name: 'Front office' };
const inMinutes = (m: number) =>
  new Date(Date.now() + m * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const task = (n: number, extra: object = {}) => ({
  id: id(n),
  number: n,
  type: 'FAULT',
  template: { id: id(70), name: 'Fault' },
  title: `Tap drips ${n}`,
  description: null,
  department: MNT,
  priority: 'NORMAL',
  status: 'ASSIGNED',
  room: { id: id(60), number: '102' },
  asset: null,
  stayId: null,
  guest: null,
  reportedBy: { id: id(91), name: 'Desk Ade' },
  assignee: FEMI,
  dueAt: inMinutes(25),
  overdue: false,
  escalationLevel: 0,
  acknowledgedAt: null,
  resolvedAt: null,
  verifiedBy: null,
  createdAt: '2026-11-10T09:00:00Z',
  ...extra,
});

const detail = (n: number, extra: object = {}) => ({
  ...task(n),
  events: [
    {
      id: '1',
      kind: 'STATUS',
      fromStatus: null,
      toStatus: 'REPORTED',
      note: 'Under the sink',
      fileIds: [],
      by: { id: id(91), name: 'Desk Ade' },
      at: '2026-11-10T09:00:00Z',
    },
  ],
  actions: ['acknowledge'],
  canComment: true,
  workOrder: null,
  canLogWork: false,
  ...extra,
});

const templates = [
  {
    id: id(70),
    type: 'FAULT',
    name: 'Fault',
    department: MNT,
    priority: 'NORMAL',
    slaMinutes: 240,
    active: true,
  },
  {
    id: id(71),
    type: 'GUEST_REQUEST',
    name: 'Guest request',
    department: FO,
    priority: 'NORMAL',
    slaMinutes: 30,
    active: true,
  },
];

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['task.work', 'task.report'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /task-templates': () => json(200, { data: templates }),
    'GET /tasks/form-options': () =>
      json(200, {
        departments: [MNT, FO],
        rooms: [{ id: id(60), number: '102', floor: '1' }],
        assignees: [{ ...FEMI, department: 'Maintenance' }],
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

describe('Tasks queue (S18)', () => {
  it('lists open tasks with their SLA timers, and switches to mine', async () => {
    handlers['GET /tasks'] = (_b, url) =>
      json(200, {
        data:
          url.searchParams.get('assignee') === 'me'
            ? [task(3)]
            : [
                task(3),
                task(2, {
                  dueAt: inMinutes(-65),
                  overdue: true,
                  escalationLevel: 1,
                  priority: 'HIGH',
                }),
              ],
        nextCursor: null,
      });
    const user = userEvent.setup();
    renderAt('/tasks');
    const list = await screen.findByRole('list', { name: 'Task list' });
    const [first, second] = await within(list).findAllByRole('listitem');
    expect(
      within(first as HTMLElement).getByRole('link', { name: '#3 Tap drips 3' }),
    ).toHaveAttribute('href', `/tasks/${id(3)}`);
    expect(within(first as HTMLElement).getByText(/Due in 2[45] min/)).toBeInTheDocument();
    expect(within(second as HTMLElement).getByText('Overdue by 1 h 5 min')).toBeInTheDocument();
    expect(within(second as HTMLElement).getByText('Escalated: level 1')).toBeInTheDocument();
    expect(sent('GET /tasks')[0]?.url.searchParams.get('status')).toBe('open');

    await user.click(screen.getByRole('button', { name: 'Mine' }));
    await waitFor(() =>
      expect(sent('GET /tasks').at(-1)?.url.searchParams.get('assignee')).toBe('me'),
    );
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
  });

  it('pages on with the cursor', async () => {
    handlers['GET /tasks'] = (_b, url) =>
      json(
        200,
        url.searchParams.get('cursor') === '3'
          ? { data: [task(2)], nextCursor: null }
          : { data: [task(4), task(3)], nextCursor: '3' },
      );
    const user = userEvent.setup();
    renderAt('/tasks');
    const list = await screen.findByRole('list', { name: 'Task list' });
    await user.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });
});

describe('New task (S18, M6-01)', () => {
  it('takes two taps: what it is, then create', async () => {
    handlers['POST /tasks'] = () => json(201, detail(5, { type: 'GUEST_REQUEST' }));
    handlers[`GET /tasks/${id(5)}`] = () => json(200, detail(5));
    const user = userEvent.setup();
    const router = renderAt('/tasks/new');
    await user.click(await screen.findByRole('radio', { name: /Guest request/ }));
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(sent('POST /tasks')).toHaveLength(1));
    expect(sent('POST /tasks')[0]?.body).toEqual({ templateId: id(71) });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${id(5)}`));
    // Staff report; only managers see the assignee and deadline.
    expect(screen.queryByLabelText('Give it to')).not.toBeInTheDocument();
  });

  it('opens on the fault template from Report fault, with manager fields for managers', async () => {
    permissions = ['task.create', 'task.assign'];
    handlers['POST /tasks'] = () => json(201, detail(6));
    handlers[`GET /tasks/${id(6)}`] = () => json(200, detail(6));
    const user = userEvent.setup();
    renderAt('/tasks/new?type=FAULT');
    expect(await screen.findByRole('radio', { name: /Fault/ })).toBeChecked();
    await user.selectOptions(await screen.findByLabelText('Room'), id(60));
    await user.selectOptions(screen.getByLabelText('Give it to'), FEMI.id);
    await user.selectOptions(screen.getByLabelText('Priority'), 'HIGH');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(sent('POST /tasks')).toHaveLength(1));
    expect(sent('POST /tasks')[0]?.body).toEqual({
      templateId: id(70),
      roomId: id(60),
      priority: 'HIGH',
      assigneeId: FEMI.id,
    });
  });
});

describe('Task detail (S18, M6-02–M6-04)', () => {
  it('offers only the allowed actions and shows the timeline', async () => {
    handlers[`GET /tasks/${id(7)}`] = () => json(200, detail(7));
    handlers[`POST /tasks/${id(7)}/acknowledge`] = () =>
      json(
        200,
        detail(7, {
          status: 'ACKNOWLEDGED',
          actions: ['start'],
          events: [
            ...detail(7).events,
            {
              id: '2',
              kind: 'STATUS',
              fromStatus: 'ASSIGNED',
              toStatus: 'ACKNOWLEDGED',
              note: null,
              fileIds: [],
              by: FEMI,
              at: '2026-11-10T09:05:00Z',
            },
          ],
        }),
      );
    const user = userEvent.setup();
    renderAt(`/tasks/${id(7)}`);
    expect(await screen.findByRole('heading', { name: '#7 Tap drips 7' })).toBeInTheDocument();
    const timeline = screen.getByRole('list', { name: 'Timeline' });
    expect(within(timeline).getByText(/Desk Ade reported it/)).toBeInTheDocument();
    expect(within(timeline).getByText('Under the sink')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(within(timeline).getByText(/Femi Fix: Assigned → Acknowledged/)).toBeInTheDocument();
  });

  it('resolves with what was done', async () => {
    handlers[`GET /tasks/${id(8)}`] = () =>
      json(200, detail(8, { status: 'IN_PROGRESS', actions: ['hold', 'resolve'] }));
    handlers[`POST /tasks/${id(8)}/resolve`] = () =>
      json(200, detail(8, { status: 'RESOLVED', actions: [] }));
    const user = userEvent.setup();
    renderAt(`/tasks/${id(8)}`);
    await user.type(await screen.findByLabelText('What was done?'), 'Replaced the washer');
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(sent(`POST /tasks/${id(8)}/resolve`)).toHaveLength(1));
    expect(sent(`POST /tasks/${id(8)}/resolve`)[0]?.body).toEqual({ note: 'Replaced the washer' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument(),
    );
  });

  it('lets a manager reopen with a reason or reassign', async () => {
    permissions = ['task.assign', 'task.verify'];
    handlers[`GET /tasks/${id(9)}`] = () =>
      json(200, detail(9, { status: 'RESOLVED', actions: ['verify', 'reopen'] }));
    handlers[`POST /tasks/${id(9)}/reopen`] = () =>
      json(200, detail(9, { status: 'ASSIGNED', actions: ['assign'] }));
    const user = userEvent.setup();
    renderAt(`/tasks/${id(9)}`);
    expect(await screen.findByRole('button', { name: 'Verify' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Why is it reopened?'), 'Still dripping');
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() =>
      expect(sent(`POST /tasks/${id(9)}/reopen`)[0]?.body).toEqual({ reason: 'Still dripping' }),
    );
    expect(await screen.findByRole('form', { name: 'Assign' })).toBeInTheDocument();
  });
});

describe('QR fault report (S19, M5-07)', () => {
  beforeEach(() => {
    handlers['GET /qr/sticker-102-token'] = () =>
      json(200, {
        roomId: id(60),
        number: '102',
        floor: '1',
        roomType: 'Standard',
        hkStatus: 'CLEAN',
        today: '2026-11-10',
      });
  });

  it('reports a critical fault and takes the room out of order', async () => {
    handlers['POST /qr/sticker-102-token/report'] = () =>
      json(201, {
        task: detail(10, { priority: 'CRITICAL' }),
        outOfOrder: { blocked: true, until: '2026-11-11', reason: null },
      });
    const user = userEvent.setup();
    renderAt('/q/sticker-102-token');
    expect(await screen.findByText('Room 102 · Standard · Floor 1')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('What is wrong?'), 'ELECTRICAL');
    await user.selectOptions(screen.getByLabelText('How serious?'), 'CRITICAL');
    expect(
      screen.getByText('A critical fault tells the general manager at once.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Take the room out of order now' }));
    await user.type(screen.getByLabelText('Details'), 'Sparks from the socket');
    await user.click(screen.getByRole('button', { name: 'Report fault' }));
    await waitFor(() => expect(sent('POST /qr/sticker-102-token/report')).toHaveLength(1));
    expect(sent('POST /qr/sticker-102-token/report')[0]?.body).toEqual({
      category: 'ELECTRICAL',
      severity: 'CRITICAL',
      description: 'Sparks from the socket',
      outOfOrderUntil: '2026-11-11',
    });
    expect(await screen.findByText('Fault reported as task #10.')).toBeInTheDocument();
    expect(screen.getByText(/Room 102 is out of order until/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the task' })).toHaveAttribute(
      'href',
      `/tasks/${id(10)}`,
    );
  });

  it('says why the room stays on sale (opened from a printed /qr/ sticker)', async () => {
    handlers['POST /qr/sticker-102-token/report'] = () =>
      json(201, {
        task: detail(11),
        outOfOrder: { blocked: false, until: '2026-11-11', reason: 'A guest is in the room' },
      });
    const user = userEvent.setup();
    renderAt('/qr/sticker-102-token');
    await user.selectOptions(await screen.findByLabelText('How serious?'), 'CRITICAL');
    await user.click(screen.getByRole('checkbox', { name: 'Take the room out of order now' }));
    await user.click(screen.getByRole('button', { name: 'Report fault' }));
    expect(
      await screen.findByText('The room is still on sale: A guest is in the room'),
    ).toBeInTheDocument();
  });

  it('says so when the sticker is not a room here', async () => {
    handlers['GET /qr/unknown-sticker'] = () =>
      json(404, {
        error: {
          code: 'NOT_FOUND',
          message: 'This QR code does not belong to a room here.',
          requestId: 'req_1',
        },
      });
    renderAt('/q/unknown-sticker');
    expect(
      await screen.findByText('This QR code does not belong to a room here.'),
    ).toBeInTheDocument();
  });
});
