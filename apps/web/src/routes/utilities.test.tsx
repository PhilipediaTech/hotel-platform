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
import { litresToMilli } from './utilities.tsx';

// S35 utilities (PRD M5-11, M5-12, M5 rule 4; T-132).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `88888888-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FEMI = { id: id(90), name: 'Femi Fix' };

const generator = (extra: object = {}) => ({
  id: id(1),
  name: 'Main generator',
  asset: { id: id(2), tag: 'GEN-1', name: 'Perkins 60kVA' },
  tankLitresMilli: 1_000_000,
  serviceEveryMinutes: null,
  running: null,
  minutesToday: 90,
  totalMinutes: 600,
  lastCheck: { litresMilli: 800_000, at: '2026-11-10T07:00:00Z' },
  receivedMilli: 500_000,
  issuedMilli: 400_000,
  expectedMilli: 900_000,
  ...extra,
});

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['utility.log'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /generators': () => json(200, { data: [generator()] }),
    [`GET /generators/${id(1)}`]: () => json(200, { ...generator(), runs: [], fuel: [] }),
    'GET /meter-readings': () =>
      json(200, {
        meters: ['GRID', 'WATER', 'GAS'],
        data: [
          {
            id: id(20),
            meter: 'GRID',
            reading: '10500',
            usage: null,
            hoursSincePrevious: null,
            by: FEMI,
            at: '2026-11-10T07:00:00Z',
          },
        ],
      }),
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

describe('litres', () => {
  it('reads litres as millilitres', () => {
    expect(litresToMilli('1,250.5')).toBe(1_250_500);
    expect(litresToMilli('80')).toBe(80_000);
    expect(litresToMilli('2.1234')).toBeNull();
    expect(litresToMilli('abc')).toBeNull();
  });
});

describe('Utilities (S35)', () => {
  it('logs a start and a fuel check with its variance', async () => {
    handlers[`POST /generators/${id(1)}/runs`] = () =>
      json(201, { ...generator(), runs: [], fuel: [] });
    handlers['POST /fuel-movements'] = () =>
      json(201, {
        generator: generator(),
        movement: {
          id: id(30),
          kind: 'LEVEL_CHECK',
          litresMilli: 820_000,
          costMinor: null,
          supplier: null,
          by: FEMI,
          at: '2026-11-10T09:00:00Z',
          variance: {
            openingMilli: 800_000,
            receivedMilli: 500_000,
            issuedMilli: 400_000,
            closingMilli: 820_000,
            varianceMilli: 80_000,
            accountableMilli: 1_300_000,
            varianceBps: 620,
            alerted: true,
          },
        },
      });
    const user = userEvent.setup();
    renderAt('/utilities');
    const card = await screen.findByRole('listitem', { name: 'Main generator' });
    expect(within(card).getByText(/expected now 900 L/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Log start' }));
    await waitFor(() => expect(sent(`POST /generators/${id(1)}/runs`)).toHaveLength(1));

    await user.click(within(card).getByRole('button', { name: 'Fuel and log' }));
    const form = within(card).getByRole('form', { name: 'Log fuel' });
    await user.type(within(form).getByLabelText('Litres in the tank'), '820');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByRole('status')).toHaveTextContent(
      '80 L missing (6.2%) Leakage alert raised.',
    );
    expect(sent('POST /fuel-movements')[0]?.body).toEqual({
      generatorId: id(1),
      kind: 'LEVEL_CHECK',
      litresMilli: 820_000,
    });
  }, 15_000);

  it('records a meter reading and shows the usage', async () => {
    handlers['POST /meter-readings'] = (body) =>
      json(201, {
        id: id(21),
        meter: 'GRID',
        reading: (body as { reading: string }).reading,
        usage: '120',
        hoursSincePrevious: 12,
        by: FEMI,
        at: '2026-11-10T19:00:00Z',
      });
    const user = userEvent.setup();
    renderAt('/utilities?view=meters');
    const form = await screen.findByRole('form', { name: 'Record a meter reading' });
    expect(await screen.findByRole('table', { name: 'Meter readings' })).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Reading'), '10,620');
    await user.click(within(form).getByRole('button', { name: 'Save reading' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Electricity (grid): 120 used in 12 h.',
    );
    expect(sent('POST /meter-readings')[0]?.body).toEqual({ meter: 'GRID', reading: '10620' });
  }, 15_000);
});
