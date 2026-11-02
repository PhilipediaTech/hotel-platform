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

// S15 Night audit (PRD M4 rule 8; T-073a).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RUN = id(1);
const SHIFT = id(2);
const NAMES = [
  'OPEN_SHIFTS',
  'ARRIVALS_DEPARTURES',
  'ROOM_STATUS',
  'ROOM_AND_TAX',
  'PACKAGES',
  'NO_SHOWS',
  'FX_LOCK',
  'LEAKAGE',
  'REPORTS',
  'CLOSE_DAY',
];

const run = (status: string, statuses: string[], extra: object = {}) => ({
  id: RUN,
  businessDate: '2026-11-10',
  status,
  currentStep: status === 'COMPLETED' ? 10 : 1,
  startedBy: 'Night Auditor',
  startedAt: '2026-11-10T22:00:00Z',
  finishedAt: status === 'COMPLETED' ? '2026-11-10T22:05:00Z' : null,
  error: status === 'FAILED' ? 'Step 1 has exceptions to resolve; then resume.' : null,
  steps: NAMES.map((name, i) => ({
    step: i + 1,
    name,
    status: statuses[i] ?? 'PENDING',
    exceptions:
      i === 0 && statuses[0] === 'BLOCKED'
        ? [
            {
              type: 'SHIFT_OPEN',
              blocking: true,
              message: 'Bola Desk’s shift is still open: close it with a count',
              shiftId: SHIFT,
            },
          ]
        : [],
    result: {},
    startedAt: null,
    finishedAt: null,
  })),
  reports:
    status === 'COMPLETED'
      ? ['flash', 'trial-balance', 'cashier', 'high-balance', 'discrepancy']
      : [],
  ...extra,
});

let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['audit.run'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /business-day': () =>
      json(200, { date: '2026-11-10', status: 'OPEN', openedAt: null, nightAuditId: null }),
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

function renderPage(path = '/night-audit') {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Night audit (S15)', () => {
  it('runs for the business date, shows what blocks it, and resumes to the end', async () => {
    handlers['POST /night-audits'] = () => json(202, run('FAILED', ['BLOCKED']));
    handlers[`GET /night-audits/${RUN}`] = () => json(200, run('FAILED', ['BLOCKED']));
    handlers[`POST /night-audits/${RUN}/resume`] = () =>
      json(
        202,
        run('COMPLETED', [
          'DONE',
          'DONE',
          'DONE',
          'DONE',
          'DONE',
          'DONE',
          'DONE',
          'DONE',
          'DONE',
          'DONE',
        ]),
      );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Run night audit' }));
    await waitFor(() => expect(sent('POST /night-audits')).toHaveLength(1));
    expect(sent('POST /night-audits')[0]?.body).toEqual({ businessDate: '2026-11-10' });

    const steps = await screen.findByRole('list', { name: 'Night audit steps' });
    const first = within(steps).getAllByRole('listitem')[0] as HTMLElement;
    expect(within(first).getByText('1. Check open shifts')).toBeInTheDocument();
    expect(within(first).getByText('Exceptions')).toBeInTheDocument();
    expect(within(first).getByText(/shift is still open/)).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/shift');
    expect(screen.getByText('Step 1 has exceptions to resolve; then resume.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume at step 1' }));
    expect(await screen.findByText(/is complete: the day is closed/)).toBeInTheDocument();
    expect(screen.getAllByText('Done')).toHaveLength(10);
    const reports = screen.getByRole('heading', { name: 'Reports of the closed day' })
      .parentElement as HTMLElement;
    expect(
      within(reports)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'Flash report',
      'Trial balance',
      'Cashier summary',
      'High balance',
      'Discrepancies',
    ]);
  }, 15_000);

  it('lists only the steps with exceptions in the exceptions view', async () => {
    handlers['GET /business-day'] = () =>
      json(200, { date: '2026-11-10', status: 'OPEN', openedAt: null, nightAuditId: RUN });
    handlers[`GET /night-audits/${RUN}`] = () => json(200, run('FAILED', ['BLOCKED']));
    renderPage('/night-audit?view=exceptions');
    const steps = await screen.findByRole('list', { name: 'Night audit steps' });
    expect(within(steps).getByText('1. Check open shifts')).toBeInTheDocument();
    expect(within(steps).queryByText('4. Post room and tax')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run night audit' })).not.toBeInTheDocument();
  });
});
