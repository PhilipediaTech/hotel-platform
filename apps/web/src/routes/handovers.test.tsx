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

// S20 Handover (PRD M6-06; T-083).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HK = { id: id(80), code: 'HK', name: 'Housekeeping' };
const FO = { id: id(81), code: 'FO', name: 'Front office' };
const ME = 'u-me';

const snapshot = (extra: object = {}) => ({
  openTasks: {
    total: 3,
    items: [
      {
        id: id(1),
        number: 7,
        title: 'Restock linen store',
        status: 'ASSIGNED',
        priority: 'NORMAL',
        dueAt: '2026-11-10T13:00:00Z',
        overdue: true,
        assignee: 'Femi Fix',
        room: null,
      },
      {
        id: id(2),
        number: 8,
        title: 'Deep clean',
        status: 'REPORTED',
        priority: 'NORMAL',
        dueAt: null,
        overdue: false,
        assignee: null,
        room: '101',
      },
    ],
  },
  approvals: {
    total: 1,
    items: [
      {
        id: id(3),
        action: 'payment.refund',
        label: 'Refund',
        requestedBy: 'Desk Ade',
        amountMinor: '100000',
        createdAt: '2026-11-10T12:00:00Z',
      },
    ],
  },
  cash: {
    drawers: [
      {
        shiftId: id(4),
        cashier: 'Desk Ade',
        status: 'OPEN',
        openedAt: '2026-11-10T07:00:00Z',
        cash: [{ currency: 'NGN', amountMinor: '2500000' }],
      },
    ],
    totals: [{ currency: 'NGN', amountMinor: '2500000' }],
  },
  vips: {
    total: 1,
    items: [
      {
        guestId: id(5),
        name: 'Ada Obi',
        room: '101',
        status: 'IN_HOUSE',
        arrival: '2026-11-10',
        departure: '2026-11-12',
      },
    ],
  },
  ...extra,
});

const note = (n: number, extra: object = {}) => ({
  id: id(100 + n),
  businessDate: '2026-11-10',
  department: HK,
  writtenBy: { id: id(90), name: 'Ngozi Outgoing' },
  createdAt: '2026-11-10T14:00:00Z',
  notes: `Handover ${n}\nLinen delivery late.`,
  snapshot: snapshot(),
  acknowledgedBy: null,
  acknowledgedAt: null,
  canAcknowledge: true,
  ...extra,
});

let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['handover.manage', 'task.assign'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /handovers/draft': (_b, url) =>
      json(200, {
        businessDate: '2026-11-10',
        departments: [FO, HK],
        departmentId: url.searchParams.get('departmentId') ?? HK.id,
        snapshot:
          url.searchParams.get('departmentId') === FO.id
            ? snapshot({ openTasks: { total: 0, items: [] } })
            : snapshot(),
      }),
    'GET /handovers': () => json(200, { data: [], nextCursor: null }),
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

describe('Handover (S20)', () => {
  it('shows what is open now for the supervisor’s department', async () => {
    renderAt('/handovers');
    const form = await screen.findByRole('form', { name: 'Write a handover' });
    expect(await within(form).findByLabelText('Department')).toHaveValue(HK.id);
    const tasks = within(form).getByRole('region', { name: 'Open tasks (3)' });
    expect(within(tasks).getByRole('link', { name: '#7 Restock linen store' })).toHaveAttribute(
      'href',
      `/tasks/${id(1)}`,
    );
    expect(within(tasks).getByText('Overdue')).toBeInTheDocument();
    expect(within(tasks).getByText('and 1 more')).toBeInTheDocument();
    const approvals = within(form).getByRole('region', { name: 'Approvals waiting (1)' });
    expect(within(approvals).getByText(/Refund/)).toBeInTheDocument();
    const cash = within(form).getByRole('region', { name: 'Cash in drawers' });
    expect(within(cash).getByText('Desk Ade')).toBeInTheDocument();
    expect(within(cash).getAllByText(/25,000\.00/)).toHaveLength(2);
    const vips = within(form).getByRole('region', { name: 'VIP guests (1)' });
    expect(within(vips).getByText(/Ada Obi/)).toBeInTheDocument();
    expect(within(vips).getByText(/In house, leaves/)).toBeInTheDocument();
  });

  it('switches department and writes the handover with the notes', async () => {
    let written: unknown = null;
    handlers['POST /handovers'] = (body) => {
      written = body;
      return json(201, note(1));
    };
    const user = userEvent.setup();
    renderAt('/handovers');
    const form = await screen.findByRole('form', { name: 'Write a handover' });
    const submit = within(form).getByRole('button', { name: 'Write handover' });
    await user.selectOptions(await within(form).findByLabelText('Department'), FO.id);
    await waitFor(() =>
      expect(sent('GET /handovers/draft').at(-1)?.url.searchParams.get('departmentId')).toBe(FO.id),
    );
    expect(await within(form).findByText('No open tasks.')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.type(
      within(form).getByLabelText('Notes for the incoming supervisor'),
      '  Room 101 asked for extra pillows.  ',
    );
    await user.click(submit);
    await waitFor(() =>
      expect(written).toEqual({ departmentId: FO.id, notes: 'Room 101 asked for extra pillows.' }),
    );
    expect(await within(form).findByText(/Handover written/)).toBeInTheDocument();
    expect(within(form).getByLabelText('Notes for the incoming supervisor')).toHaveValue('');
    // The list is fetched again.
    await waitFor(() => expect(sent('GET /handovers').length).toBeGreaterThan(1));
  });

  it('lists handovers and lets the incoming supervisor acknowledge one', async () => {
    let acked = false;
    handlers['GET /handovers'] = () =>
      json(200, {
        data: [
          acked
            ? note(2, {
                acknowledgedBy: { id: ME, name: 'Tunde Incoming' },
                acknowledgedAt: '2026-11-10T15:00:00Z',
                canAcknowledge: false,
              })
            : note(2),
          note(1, {
            writtenBy: { id: ME, name: 'Me Myself' },
            canAcknowledge: false,
          }),
        ],
        nextCursor: null,
      });
    handlers[`POST /handovers/${id(102)}/acknowledge`] = () => {
      acked = true;
      return json(200, note(2));
    };
    const user = userEvent.setup();
    renderAt('/handovers');
    const list = await screen.findByRole('list', { name: 'Handover list' });
    // The cards, not the snapshot rows inside them.
    await waitFor(() => expect(list.children).toHaveLength(2));
    const [theirs, mine] = [...list.children];
    const first = theirs as HTMLElement;
    expect(within(first).getByText('Waiting for acknowledgement')).toBeInTheDocument();
    expect(within(first).getByText(/Written by Ngozi Outgoing/)).toBeInTheDocument();
    expect(within(first).getByText(/Linen delivery late/)).toBeInTheDocument();
    expect(within(first).getByText('What was open then')).toBeInTheDocument();
    // Your own handover waits for someone else.
    expect(within(mine as HTMLElement).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(
      within(mine as HTMLElement).getByText('Another supervisor acknowledges your handover.'),
    ).toBeInTheDocument();

    await user.click(within(first).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(sent(`POST /handovers/${id(102)}/acknowledge`)).toHaveLength(1));
    expect(await within(list).findByText(/Acknowledged by Tunde Incoming/)).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  });

  it('filters to handovers waiting for acknowledgement', async () => {
    const user = userEvent.setup();
    renderAt('/handovers');
    expect(await screen.findByText('No handovers here.')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Waiting for acknowledgement only'));
    await waitFor(() =>
      expect(sent('GET /handovers').at(-1)?.url.searchParams.get('pending')).toBe('true'),
    );
  });

  it('shows the API’s refusal when acknowledging fails', async () => {
    handlers['GET /handovers'] = () => json(200, { data: [note(2)], nextCursor: null });
    handlers[`POST /handovers/${id(102)}/acknowledge`] = () =>
      json(409, {
        error: {
          code: 'STATE_TRANSITION_INVALID',
          message: 'This handover was already acknowledged by Tunde Incoming.',
          requestId: 'r1',
        },
      });
    const user = userEvent.setup();
    renderAt('/handovers');
    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(
      await screen.findByText('This handover was already acknowledged by Tunde Incoming.'),
    ).toBeInTheDocument();
  });
});
