import { addDays, isoWeekday, localDate } from '@hotel/shared';
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

// S36 duties, rota and leave (PRD M7-02, M7-03, M7-05; T-137).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BISI = { id: id(1), number: 1, name: 'Bisi Cook' };
const OJO = { id: id(2), number: 2, name: 'Ojo Porter' };
const FB = { id: id(80), name: 'Food and beverage' };
const MORNING = { id: id(30), name: 'Morning', startTime: '07:00', endTime: '15:00', active: true };
const today = localDate(new Date(), 'Africa/Lagos');
const monday = addDays(today, 1 - isoWeekday(today));
const tuesday = addDays(monday, 1);

const leave = {
  id: id(50),
  staff: { ...BISI, department: FB.name },
  type: 'ANNUAL',
  startDate: '2026-11-17',
  endDate: '2026-11-18',
  days: 2,
  reason: 'Family wedding',
  status: 'PENDING',
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  shiftsRemoved: 0,
  createdAt: '2026-11-10T09:00:00Z',
};

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

function stub(permissions: string[]) {
  handlers['GET /me'] = () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] }));
}

beforeEach(() => {
  calls.length = 0;
  handlers = {
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

describe('Leave (S36)', () => {
  it('shows my shifts and duties, and sends a leave request', async () => {
    stub(['leave.request']);
    handlers['GET /leave-requests/mine'] = () =>
      json(200, {
        staff: BISI,
        today: '2026-11-10',
        duties: [
          {
            id: id(60),
            staff: { ...BISI, jobTitle: 'Cook' },
            title: 'Open the bar store',
            notes: null,
            weekdays: [1, 6],
            startTime: '08:00',
            endTime: null,
            active: true,
          },
        ],
        shifts: [
          {
            id: id(70),
            date: '2026-11-16',
            shift: 'Morning',
            startTime: '07:00',
            endTime: '15:00',
            department: FB.name,
          },
        ],
        leave: [],
      });
    handlers['POST /leave-requests'] = () => json(201, leave);
    const user = userEvent.setup();
    renderAt('/leave');
    expect(await screen.findByText('Open the bar store · Mon, Sat · 08:00')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'My shifts (next four weeks)' })).toHaveTextContent(
      'Morning 07:00–15:00',
    );
    // No approvals without leave.approve.
    expect(screen.queryByRole('heading', { name: 'To decide' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Request leave' }));
    const form = screen.getByRole('form', { name: 'Leave request' });
    await user.clear(within(form).getByLabelText('First day'));
    await user.type(within(form).getByLabelText('First day'), '2026-11-17');
    await user.clear(within(form).getByLabelText('Last day'));
    await user.type(within(form).getByLabelText('Last day'), '2026-11-18');
    await user.type(within(form).getByLabelText('Reason (optional)'), 'Family wedding');
    await user.click(within(form).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(sent('POST /leave-requests')).toHaveLength(1));
    expect(sent('POST /leave-requests')[0]?.body).toEqual({
      type: 'ANNUAL',
      startDate: '2026-11-17',
      endDate: '2026-11-18',
      reason: 'Family wedding',
    });
  }, 15_000);

  it('lets a manager approve a pending request', async () => {
    stub(['leave.approve']);
    handlers['GET /leave-requests'] = () => json(200, { data: [leave] });
    handlers[`POST /leave-requests/${leave.id}/decision`] = () =>
      json(200, { ...leave, status: 'APPROVED', shiftsRemoved: 2 });
    const user = userEvent.setup();
    renderAt('/leave');
    const list = await screen.findByRole('list', { name: 'Leave requests' });
    expect(await within(list).findByText(/ST-1 Bisi Cook · Annual/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'My work' })).not.toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(sent(`POST /leave-requests/${leave.id}/decision`)).toHaveLength(1));
    expect(sent(`POST /leave-requests/${leave.id}/decision`)[0]?.body).toEqual({
      decision: 'APPROVE',
      note: '',
    });
  }, 15_000);
});

describe('Rota (S36)', () => {
  it('shows the week, adds someone to a shift and publishes', async () => {
    stub(['rota.manage']);
    handlers['GET /rotas'] = () =>
      json(200, {
        department: FB,
        from: monday,
        to: addDays(monday, 6),
        shifts: [MORNING],
        assignments: [
          {
            id: id(40),
            shiftId: MORNING.id,
            staff: BISI,
            date: monday,
            status: 'PUBLISHED',
            leaveRequestId: null,
          },
          {
            id: id(41),
            shiftId: MORNING.id,
            staff: BISI,
            date: tuesday,
            status: 'REMOVED',
            leaveRequestId: leave.id,
          },
        ],
        staff: [
          { ...BISI, departmentId: FB.id },
          { ...OJO, departmentId: FB.id },
        ],
        leave: [{ staffId: BISI.id, startDate: tuesday, endDate: tuesday, type: 'ANNUAL' }],
        departments: [{ ...FB, hasRota: true }],
      });
    handlers['POST /rotas/assignments'] = () =>
      json(201, {
        id: id(42),
        shiftId: MORNING.id,
        staff: OJO,
        date: tuesday,
        status: 'DRAFT',
        leaveRequestId: null,
      });
    handlers[`POST /rotas/${FB.id}/publish`] = () =>
      json(200, { from: monday, to: addDays(monday, 6), published: 1 });
    const user = userEvent.setup();
    renderAt('/rota');
    const grid = await screen.findByRole('table', { name: 'Rota for the week' });
    expect(await within(grid).findByText('Bisi Cook (on leave)')).toBeInTheDocument();
    // Someone on leave that day is not offered.
    const add = within(grid).getAllByRole('combobox')[1];
    if (!add) throw new Error('no add select for Tuesday');
    expect(within(add).queryByRole('option', { name: 'Bisi Cook' })).not.toBeInTheDocument();
    await user.selectOptions(add, OJO.id);
    await waitFor(() => expect(sent('POST /rotas/assignments')).toHaveLength(1));
    expect(sent('POST /rotas/assignments')[0]?.body).toEqual({
      shiftId: MORNING.id,
      staffId: OJO.id,
      date: tuesday,
    });
    await user.click(screen.getByRole('button', { name: 'Publish this week' }));
    await waitFor(() => expect(sent(`POST /rotas/${FB.id}/publish`)).toHaveLength(1));
    expect(sent(`POST /rotas/${FB.id}/publish`)[0]?.body).toEqual({
      from: monday,
      period: 'WEEKLY',
    });
    expect(await screen.findByText(/1 slot published/)).toBeInTheDocument();
  }, 15_000);
});

describe('Duties (S36)', () => {
  it('adds a standing duty', async () => {
    stub(['staff.duty']);
    handlers['GET /duties'] = () => json(200, { data: [], staff: [BISI] });
    handlers['POST /duties'] = () =>
      json(201, {
        id: id(60),
        staff: { ...BISI, jobTitle: 'Cook' },
        title: 'Open the bar store',
        notes: null,
        weekdays: [1],
        startTime: null,
        endTime: null,
        active: true,
      });
    const user = userEvent.setup();
    renderAt('/duties');
    await user.click(await screen.findByRole('button', { name: 'Add a duty' }));
    const form = screen.getByRole('form', { name: 'Duty' });
    await user.selectOptions(within(form).getByLabelText('Staff member'), BISI.id);
    await user.type(within(form).getByLabelText('Duty'), 'Open the bar store');
    await user.click(within(form).getByLabelText('Mon'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST /duties')).toHaveLength(1));
    expect(sent('POST /duties')[0]?.body).toEqual({
      staffId: BISI.id,
      title: 'Open the bar store',
      notes: '',
      weekdays: [1],
      startTime: null,
      endTime: null,
    });
  }, 15_000);
});
