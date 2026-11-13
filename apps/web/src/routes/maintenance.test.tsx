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

// S34 maintenance and the work order on the task page (PRD M5-08, M5-09; T-130).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FEMI = { id: id(90), name: 'Femi Fix' };
const MNT = { id: id(80), code: 'MNT', name: 'Maintenance' };

const asset = (n: number, extra: object = {}) => ({
  id: id(n),
  tag: `AC-${n}`,
  name: `Split AC ${n}`,
  category: 'Air conditioning',
  location: null,
  room: { id: id(60), number: '101' },
  serial: 'LG-1',
  vendor: 'Cool Breeze Ltd',
  warrantyUntil: '2027-03-31',
  underWarranty: true,
  costMinor: '45000000',
  status: 'IN_SERVICE',
  openJobs: 0,
  ...extra,
});

const task = (n: number, extra: object = {}) => ({
  id: id(n),
  number: n,
  type: 'FAULT',
  template: null,
  title: `Fault: Split AC ${n}`,
  description: null,
  department: MNT,
  priority: 'HIGH',
  status: 'IN_PROGRESS',
  room: { id: id(60), number: '101' },
  asset: null,
  stayId: null,
  guest: null,
  reportedBy: FEMI,
  assignee: FEMI,
  dueAt: null,
  overdue: false,
  escalationLevel: 0,
  acknowledgedAt: null,
  resolvedAt: null,
  verifiedBy: null,
  createdAt: '2026-11-10T09:00:00Z',
  ...extra,
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['wo.work', 'task.work', 'asset.manage'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /tasks/form-options': () =>
      json(200, {
        departments: [MNT],
        rooms: [{ id: id(60), number: '101', floor: '1' }],
        assignees: [],
      }),
    'GET /assets': () =>
      json(200, {
        data: [asset(1), asset(2, { room: null, location: 'Store', underWarranty: false })],
        categories: ['Air conditioning', 'Generator'],
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
}

describe('Maintenance (S34)', () => {
  it('lists the open maintenance jobs', async () => {
    handlers['GET /tasks'] = () =>
      json(200, {
        data: [task(5, { asset: { id: id(1), tag: 'AC-1', name: 'Split AC 1' }, overdue: true })],
        nextCursor: null,
      });
    renderAt('/maintenance');
    const list = await screen.findByRole('list', { name: 'Open maintenance jobs' });
    expect(
      await within(list).findByRole('link', { name: '#5 Fault: Split AC 5' }),
    ).toBeInTheDocument();
    expect(within(list).getByText(/AC-1 · Split AC 1/)).toBeInTheDocument();
    expect(within(list).getByText('Overdue')).toBeInTheDocument();
    const url = sent('GET /tasks')[0]?.url;
    expect(url?.searchParams.get('status')).toBe('open');
    expect(url?.searchParams.get('departmentId')).toBe(MNT.id);
  }, 15_000);

  it('adds an asset and shows its service history', async () => {
    handlers['POST /assets'] = (body) =>
      json(201, {
        ...asset(3, body as object),
        history: [],
        totals: { jobs: 0, labourMinutes: 0, costMinor: '0' },
      });
    handlers[`GET /assets/${id(1)}`] = () =>
      json(200, {
        ...asset(1),
        history: [
          {
            taskId: id(5),
            number: 5,
            title: 'Fault: Split AC 1',
            type: 'FAULT',
            status: 'VERIFIED',
            createdAt: '2026-11-10T09:00:00Z',
            resolvedAt: '2026-11-10T11:00:00Z',
            assignee: FEMI,
            labourMinutes: 90,
            costMinor: '3550000',
          },
        ],
        totals: { jobs: 1, labourMinutes: 90, costMinor: '3550000' },
      });
    const user = userEvent.setup();
    renderAt('/maintenance?view=assets');
    const list = await screen.findByRole('list', { name: 'Assets' });
    expect(await within(list).findByText(/Room 101 · under warranty/)).toBeInTheDocument();
    expect(within(list).getByText(/Store/)).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'AC-1 · Split AC 1' }));
    const panel = await screen.findByRole('region', { name: 'Asset AC-1' });
    expect(await within(panel).findByText('1 job · 1 h 30 min · ₦35,500.00')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: '#5 Fault: Split AC 1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add asset' }));
    const form = screen.getByRole('form', { name: 'New asset' });
    await user.type(within(form).getByLabelText('Tag'), 'GEN-1');
    await user.type(within(form).getByLabelText('Name'), 'Perkins 60kVA');
    await user.type(within(form).getByLabelText('Category'), 'Generator');
    await user.type(within(form).getByLabelText('Other location'), 'Generator house');
    await user.type(within(form).getByLabelText('Cost (₦)'), '12,500,000');
    await user.click(within(form).getByRole('button', { name: 'Add asset' }));
    await waitFor(() => expect(sent('POST /assets')).toHaveLength(1));
    expect(sent('POST /assets')[0]?.body).toEqual({
      tag: 'GEN-1',
      name: 'Perkins 60kVA',
      category: 'Generator',
      roomId: null,
      location: 'Generator house',
      serial: '',
      vendor: '',
      warrantyUntil: null,
      costMinor: '1250000000',
      status: 'IN_SERVICE',
    });
  }, 20_000);
});

describe('Work order on the task page (M5-08)', () => {
  it('logs parts, time and the vendor, and puts the job on an asset', async () => {
    let workOrder: unknown = null;
    let onAsset: unknown = null;
    const detail = () => ({
      ...task(5),
      asset: onAsset,
      events: [],
      actions: ['hold', 'resolve'],
      canComment: true,
      workOrder,
      canLogWork: true,
    });
    handlers[`GET /tasks/${id(5)}`] = () => json(200, detail());
    handlers[`POST /work-orders/${id(5)}/detail`] = () => {
      workOrder = {
        parts: [{ name: 'Capacitor', quantity: 1, costMinor: '850000' }],
        labourMinutes: 90,
        vendorName: 'Cool Breeze Ltd',
        partsCostMinor: '850000',
        vendorCostMinor: '1500000',
        costMinor: '2350000',
      };
      onAsset = { id: id(1), tag: 'AC-1', name: 'Split AC 1' };
      return json(200, { taskId: id(5), workOrder, asset: onAsset });
    };
    const user = userEvent.setup();
    renderAt(`/tasks/${id(5)}`);
    const panel = await screen.findByRole('region', { name: 'Work order' });
    expect(within(panel).getByText('No parts or time logged yet.')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Log parts and time' }));
    const form = within(panel).getByRole('form', { name: 'Parts, time and cost' });
    await user.selectOptions(await within(form).findByLabelText('Asset'), id(1));
    await user.click(within(form).getByRole('button', { name: 'Add a part' }));
    await user.type(within(form).getByLabelText('Part'), 'Capacitor');
    await user.type(within(form).getByLabelText('Cost (₦)'), '8,500');
    await user.clear(within(form).getByLabelText('Hours'));
    await user.type(within(form).getByLabelText('Hours'), '1');
    await user.clear(within(form).getByLabelText('Minutes'));
    await user.type(within(form).getByLabelText('Minutes'), '30');
    await user.type(within(form).getByLabelText('Vendor (if one was paid)'), 'Cool Breeze Ltd');
    await user.type(within(form).getByLabelText('Vendor charge (₦)'), '15000');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(`POST /work-orders/${id(5)}/detail`)).toHaveLength(1));
    expect(sent(`POST /work-orders/${id(5)}/detail`)[0]?.body).toEqual({
      parts: [{ name: 'Capacitor', quantity: 1, costMinor: '850000' }],
      labourMinutes: 90,
      vendorName: 'Cool Breeze Ltd',
      vendorCostMinor: '1500000',
      assetId: id(1),
    });
    expect(await within(panel).findByText('Outside cost: ₦23,500.00')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'AC-1 · Split AC 1' })).toBeInTheDocument();
  }, 20_000);
});

// S34 PM calendar (PRD M5-10; T-131).

const plan = (n: number, extra: object = {}) => ({
  id: id(n),
  title: `Plan ${n}`,
  instructions: null,
  asset: null,
  trigger: 'CALENDAR',
  everyDays: 30,
  everyHours: null,
  leadDays: 3,
  leadHours: 10,
  nextDueOn: '2026-11-12',
  lastDoneOn: null,
  meterHours: null,
  meterReadAt: null,
  lastServiceHours: null,
  hoursLeft: null,
  dueState: 'DUE_SOON',
  assignee: null,
  priority: 'NORMAL',
  active: true,
  openTask: null,
  ...extra,
});

describe('Maintenance plans (S34, M5-10)', () => {
  beforeEach(() => {
    permissions = ['wo.work', 'task.work', 'asset.manage', 'pm.manage'];
    handlers['GET /preventive-plans'] = () =>
      json(200, {
        today: '2026-11-10',
        data: [
          plan(1, {
            title: 'Clean AC filters',
            asset: { id: id(1), tag: 'AC-1', name: 'Split AC 1' },
            openTask: { id: id(5), number: 5, status: 'ASSIGNED' },
          }),
          plan(2, { title: 'Test fire alarms', nextDueOn: '2026-11-05', dueState: 'OVERDUE' }),
          plan(3, {
            title: 'Change oil',
            trigger: 'RUN_HOURS',
            everyDays: null,
            everyHours: 250,
            nextDueOn: null,
            meterHours: 1100,
            lastServiceHours: 1000,
            hoursLeft: 150,
            dueState: 'OK',
            asset: { id: id(2), tag: 'GEN-1', name: 'Generator' },
          }),
        ],
      });
  });

  it('shows the plans tab only with pm.manage', async () => {
    permissions = ['wo.work', 'task.work', 'asset.manage'];
    handlers['GET /tasks'] = () => json(200, { data: [], nextCursor: null });
    renderAt('/maintenance');
    await screen.findByRole('tab', { name: 'Assets' });
    expect(screen.queryByRole('tab', { name: 'Plans' })).not.toBeInTheDocument();
  }, 15_000);

  it('shows the PM calendar and takes a meter reading', async () => {
    handlers[`POST /preventive-plans/${id(3)}/hours`] = (body) =>
      json(200, plan(3, { trigger: 'RUN_HOURS', ...(body as object) }));
    const user = userEvent.setup();
    renderAt('/maintenance?view=plans');
    const agenda = await screen.findByRole('list', { name: 'Preventive maintenance by date' });
    // Every 30 days from 12 November: two dates in the six weeks shown.
    expect(within(agenda).getAllByText(/Clean AC filters/)).toHaveLength(2);
    expect(within(agenda).getByRole('link', { name: 'Job #5 · Assigned' })).toBeInTheDocument();
    const overdue = screen.getByRole('list', { name: 'Overdue' });
    expect(within(overdue).getByText('Test fire alarms')).toBeInTheDocument();
    const hours = screen.getByRole('list', { name: 'By run hours' });
    expect(within(hours).getByText(/150 h to go/)).toBeInTheDocument();

    await user.type(within(hours).getByLabelText('Meter reading (hours)'), '1245');
    await user.click(within(hours).getByRole('button', { name: 'Save reading' }));
    await waitFor(() => expect(sent(`POST /preventive-plans/${id(3)}/hours`)).toHaveLength(1));
    expect(sent(`POST /preventive-plans/${id(3)}/hours`)[0]?.body).toEqual({ hours: 1245 });
  }, 15_000);

  it('plans maintenance by run hours', async () => {
    handlers['POST /preventive-plans'] = (body) => json(201, plan(9, body as object));
    const user = userEvent.setup();
    renderAt('/maintenance?view=plans');
    await user.click(await screen.findByRole('button', { name: 'Plan maintenance' }));
    const form = screen.getByRole('form', { name: 'New maintenance plan' });
    await user.type(within(form).getByLabelText('What to do'), 'Change oil and filter');
    await within(form).findByRole('option', { name: 'AC-2 · Split AC 2' });
    await user.selectOptions(within(form).getByLabelText('Asset'), id(2));
    await user.click(within(form).getByLabelText('Run hours'));
    await user.type(within(form).getByLabelText('Meter at last service (hours)'), '1000');
    await user.click(within(form).getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(sent('POST /preventive-plans')).toHaveLength(1));
    expect(sent('POST /preventive-plans')[0]?.body).toEqual({
      title: 'Change oil and filter',
      instructions: '',
      assetId: id(2),
      trigger: 'RUN_HOURS',
      everyHours: 250,
      lastServiceHours: 1000,
      meterHours: null,
      leadHours: 10,
      assigneeId: null,
      priority: 'NORMAL',
    });
  }, 15_000);
});
