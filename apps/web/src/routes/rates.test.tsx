import { addDays, localDate } from '@hotel/shared';
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

// S23 Rate calendar and plans (PRD M2-04–M2-08; T-033).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const TODAY = localDate(new Date(), 'Africa/Lagos');
const id = (n: number) => `55555555-0000-4000-8000-00000000000${n}`;
const [BAR, CORP, BB, STD, POLICY, FNB] = [id(1), id(2), id(3), id(4), id(5), id(6)];

const plan = (planId: string, code: string, name: string, kind: string, extra: object = {}) => ({
  id: planId,
  code,
  name,
  kind,
  parentRatePlanId: null,
  derivationBps: null,
  derivationAmountMinor: null,
  roundingMinor: '10000',
  floorMinor: null,
  mealPlan: 'ROOM_ONLY',
  cancellationPolicyId: POLICY,
  guarantee: 'NONE',
  currency: 'NGN',
  isPublic: false,
  dayUseMaxMinutes: null,
  roomTypeIds: [],
  active: true,
  version: 2,
  components: [],
  ...extra,
});

let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['rate.manage', 'frontdesk.read'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /rate-plans': () =>
      json(200, {
        data: [
          plan(BAR, 'BAR', 'Best available', 'BAR'),
          plan(CORP, 'CORP', 'Corporate', 'DERIVED', {
            parentRatePlanId: BAR,
            derivationBps: -1000,
          }),
          plan(BB, 'BB', 'Bed and breakfast', 'PACKAGE', {
            components: [
              {
                id: id(7),
                name: 'Breakfast',
                revenueCodeId: FNB,
                amountMinor: '500000',
                perPerson: true,
              },
            ],
          }),
        ],
      }),
    'GET /room-types': () =>
      json(200, {
        data: [
          {
            id: STD,
            code: 'STD',
            name: 'Standard',
            baseOccupancy: 2,
            maxOccupancy: 2,
            description: null,
            amenities: [],
            photoFileIds: [],
            sortOrder: 0,
            active: true,
            roomCount: 15,
          },
        ],
      }),
    'GET /cancellation-policies': () =>
      json(200, {
        data: [
          {
            id: POLICY,
            name: 'Flexible',
            rules: [{ daysBefore: 1, feeType: 'NIGHTS', value: 1 }],
            noShowFee: { feeType: 'NIGHTS', value: 1 },
          },
        ],
      }),
    'GET /rate-calendar': (_b, url) => {
      const derived = url.searchParams.get('ratePlanId') === CORP;
      return json(200, {
        ratePlanId: url.searchParams.get('ratePlanId'),
        days: Array.from({ length: 14 }, (_, i) => ({
          roomTypeId: STD,
          date: addDays(TODAY, i),
          amountMinor: derived ? '4500000' : '5000000',
          ownAmountMinor: derived ? null : '5000000',
          minStay: i === 0 ? 2 : null,
          maxStay: null,
          closedToArrival: i === 1,
          closedToDeparture: false,
          stopSell: i === 2,
          ruleVersion: 1,
        })),
      });
    },
    'GET /revenue-codes': () =>
      json(200, {
        data: [
          {
            id: FNB,
            code: 'FNB',
            name: 'Food and beverage',
            group: 'FNB',
            taxRuleIds: [],
            active: true,
          },
        ],
      }),
    'PUT /rate-calendar': () => json(200, { changedDays: 4 }),
    'POST /rate-plans': (b) => json(201, plan(id(8), 'X', 'X', (b as { kind: string }).kind)),
    'POST /packages': () => json(200, plan(BB, 'BB', 'Bed and breakfast', 'PACKAGE')),
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
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

describe('Rate calendar', () => {
  it('shows two weeks of prices with restrictions for the chosen plan', async () => {
    renderAt('/rates');
    const grid = await screen.findByRole('table', { name: 'Prices for Best available' });
    const row = await within(grid).findByRole('row', { name: /Standard/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells).toHaveLength(14);
    expect(cells[0]).toHaveTextContent('50,000');
    expect(cells[0]).toHaveTextContent('Min 2');
    expect(cells[1]).toHaveTextContent('No arrivals');
    expect(cells[2]).toHaveTextContent('Stop sell');
    expect(sent('GET /rate-calendar')[0]?.url.searchParams.get('to')).toBe(addDays(TODAY, 13));
  });

  it('explains a derived plan and shows its worked-out prices', async () => {
    const user = userEvent.setup();
    renderAt('/rates');
    await user.click(await screen.findByRole('tab', { name: /Corporate/ }));
    expect(await screen.findByText('Follows Best available: 10% off.')).toBeVisible();
    const grid = await screen.findByRole('table', { name: 'Prices for Corporate' });
    expect(within(grid).getAllByRole('cell')[0]).toHaveTextContent('45,000');
  });
});

describe('Bulk edit', () => {
  it('sets a weekend price and stop-sell by weekday', async () => {
    const user = userEvent.setup();
    renderAt('/rates');
    await user.click(await screen.findByRole('button', { name: 'Edit prices and restrictions' }));
    const form = screen.getByRole('form', { name: 'Edit Best available' });
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Sun']) {
      await user.click(within(form).getByRole('checkbox', { name: day }));
    }
    await user.type(within(form).getByLabelText('Price per night (NGN)'), '60,000');
    await user.selectOptions(within(form).getByLabelText('Stop sell'), 'off');
    await user.click(within(form).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(sent('PUT /rate-calendar')).toHaveLength(1));
    expect(sent('PUT /rate-calendar')[0]?.body).toEqual({
      ratePlanId: BAR,
      roomTypeIds: [STD],
      from: TODAY,
      to: addDays(TODAY, 6),
      weekdays: [5, 6],
      set: { amountMinor: '6000000', stopSell: false },
    });
    expect(await within(form).findByText('4 days changed.')).toBeVisible();
  });

  it('offers no price on a derived plan', async () => {
    const user = userEvent.setup();
    renderAt(`/rates?plan=${CORP}`);
    await user.click(await screen.findByRole('button', { name: 'Edit prices and restrictions' }));
    const form = screen.getByRole('form', { name: 'Edit Corporate' });
    expect(within(form).queryByLabelText(/Price per night/)).toBeNull();
    expect(within(form).getByText(/Prices follow the parent plan/)).toBeVisible();
  });
});

describe('Plans and packages', () => {
  it('adds a derived plan: 10% off BAR', async () => {
    const user = userEvent.setup();
    renderAt('/rates');
    await user.click(await screen.findByRole('button', { name: 'Add rate plan' }));
    const form = screen.getByRole('form', { name: 'Add rate plan' });
    await user.selectOptions(within(form).getByLabelText('Kind'), 'DERIVED');
    await user.type(within(form).getByLabelText('Code'), 'gov');
    await user.type(within(form).getByLabelText('Name'), 'Government');
    await user.type(within(form).getByLabelText('% off'), '10');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST /rate-plans')).toHaveLength(1));
    expect(sent('POST /rate-plans')[0]?.body).toMatchObject({
      code: 'GOV',
      name: 'Government',
      kind: 'DERIVED',
      parentRatePlanId: BAR,
      derivationBps: -1000,
      derivationAmountMinor: null,
      roundingMinor: '10000',
      cancellationPolicyId: POLICY,
    });
  });

  it('edits what a package includes', async () => {
    const user = userEvent.setup();
    renderAt(`/rates?plan=${BB}`);
    await user.click(await screen.findByRole('button', { name: 'Package contents' }));
    const form = screen.getByRole('form', { name: 'What Bed and breakfast includes' });
    expect(within(form).getByLabelText('Item')).toHaveValue('Breakfast');
    await user.clear(within(form).getByLabelText('Amount per night'));
    await user.type(within(form).getByLabelText('Amount per night'), '6000');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent('POST /packages')[0]?.body).toEqual({
        ratePlanId: BB,
        components: [
          { name: 'Breakfast', revenueCodeId: FNB, amountMinor: '600000', perPerson: true },
        ],
      }),
    );
  });
});
