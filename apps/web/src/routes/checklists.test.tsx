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

// Recurring checklists (PRD M6-13; T-134).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SEGUN = { id: id(90), name: 'Segun Staff' };
const MNT = { id: id(80), name: 'Maintenance' };
const POOL = ['Chlorine 1–3 ppm', 'pH 7.2–7.8', 'Lifebuoy in place'];

const run = {
  id: id(1),
  checklist: { id: id(2), name: 'Pool checks', department: 'Maintenance' },
  dueOn: '2026-11-10',
  dueAt: '2099-11-10T08:00:00Z',
  items: POOL,
  assignee: SEGUN,
  status: 'PENDING',
  results: [],
  problems: 0,
  task: null,
  completedBy: null,
  completedAt: null,
  overdue: false,
  canComplete: true,
};

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;
let permissions: string[];

beforeEach(() => {
  calls.length = 0;
  permissions = ['task.work'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /checklist-runs': () =>
      json(200, { data: [run], date: '2026-11-10', today: '2026-11-10' }),
    'GET /checklists': () =>
      json(200, { data: [], departments: [MNT], assignees: [SEGUN], today: '2026-11-10' }),
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

describe('Checklists', () => {
  it('answers every check, with a note for a problem', async () => {
    handlers[`POST /checklist-runs/${id(1)}/complete`] = () =>
      json(200, { ...run, status: 'DONE', canComplete: false });
    const user = userEvent.setup();
    renderAt('/checklists');
    const list = await screen.findByRole('list', { name: 'Checklist runs' });
    expect(within(list).getByText('Pool checks')).toBeInTheDocument();
    // People who only do checklists have no set-up tab.
    expect(screen.queryByRole('tab', { name: 'Set up' })).not.toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'Do it' }));
    const form = screen.getByRole('form', { name: 'Checklist answers' });
    const answer = (item: string, name: string) =>
      user.click(
        within(within(form).getByRole('group', { name: item })).getByRole('button', { name }),
      );
    await answer(POOL[0] ?? '', 'OK');
    await user.click(within(form).getByRole('button', { name: 'Submit' }));
    expect(screen.getByText('Answer every check first.')).toBeInTheDocument();
    await answer(POOL[1] ?? '', 'Problem');
    await user.type(within(form).getByLabelText('What is wrong'), 'pH 8.1');
    await answer(POOL[2] ?? '', 'OK');
    await user.click(within(form).getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(sent(`POST /checklist-runs/${id(1)}/complete`)).toHaveLength(1));
    expect(sent(`POST /checklist-runs/${id(1)}/complete`)[0]?.body).toEqual({
      results: [
        { ok: true, note: '' },
        { ok: false, note: 'pH 8.1' },
        { ok: true, note: '' },
      ],
    });
  }, 15_000);

  it('lets a manager create a weekly checklist', async () => {
    permissions = ['checklist.manage', 'task.work'];
    handlers['POST /checklists'] = () => json(201, {});
    const user = userEvent.setup();
    renderAt('/checklists?view=manage');
    await user.click(await screen.findByRole('button', { name: 'New checklist' }));
    const form = screen.getByRole('form', { name: 'Checklist' });
    await user.type(within(form).getByLabelText('Name'), 'Fire extinguishers');
    await user.selectOptions(within(form).getByLabelText('Department'), MNT.id);
    await user.type(
      within(form).getByLabelText('Checks, one per line'),
      'Gauge in green{enter}Pin and seal intact',
    );
    await user.selectOptions(within(form).getByLabelText('How often'), 'WEEKLY');
    await user.selectOptions(within(form).getByLabelText('Day of the week'), 'Friday');
    await user.selectOptions(within(form).getByLabelText('Given to'), SEGUN.id);
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST /checklists')).toHaveLength(1));
    expect(sent('POST /checklists')[0]?.body).toEqual({
      name: 'Fire extinguishers',
      departmentId: MNT.id,
      items: ['Gauge in green', 'Pin and seal intact'],
      frequency: 'WEEKLY',
      weekday: 5,
      monthDay: null,
      dueTime: '09:00',
      assigneeId: SEGUN.id,
    });
  }, 15_000);
});
