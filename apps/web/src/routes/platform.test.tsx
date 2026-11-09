import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../app/query-client.ts';
import { routes } from '../app/routes.tsx';
import { setApiPropertyId } from '../lib/api.ts';
import { LAGOS, makeMe, membership, ORG } from '../test/me-fixture.ts';

// S30 Plan and billing, S31 Platform (PRD M13-01–M13-05; T-100).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUB = {
  plan: 'PROFESSIONAL',
  pricePerRoomMinor: '500000',
  minimumMinor: '2000000',
  currency: 'NGN',
  status: 'ACTIVE',
  currentPeriodEnd: '2026-11-30',
  aiAllowance: 100,
  whatsappAllowance: 12,
};
const INVOICE = {
  id: id(1),
  number: 'INV-202610-55555555',
  organisationId: ORG,
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  activeRooms: 3,
  lines: [],
  totalMinor: '2000000',
  currency: 'NGN',
  status: 'ISSUED',
  issuedAt: '2026-11-01T09:00:00Z',
};
const SESSION = {
  id: id(2),
  organisationId: ORG,
  admin: { id: id(3), name: 'Platform Ada', email: 'ada@platform.test' },
  reason: 'Owner reports the arrivals list is empty',
  startedAt: '2026-11-14T09:00:00Z',
  expiresAt: '2026-11-14T09:30:00Z',
  endedAt: null,
  active: true,
  views: 4,
};
const TENANT = {
  id: ORG,
  name: 'Obi Hotels',
  legalName: null,
  country: 'NG',
  createdAt: '2026-10-01T09:00:00Z',
  properties: 2,
  subscription: SUB,
  usage: { month: '2026-11', activeRooms: 3, whatsappMessages: 12, aiUses: 40 },
  activeSupportSession: null,
};

let permissions: string[];
let platformAdmin: boolean;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key).map((c) => c.body);

beforeEach(() => {
  calls.length = 0;
  permissions = ['subscription.read'];
  platformAdmin = false;
  const handlers: Record<string, (body: unknown) => Response> = {
    'GET /me': () =>
      json(200, makeMe({ platformAdmin, memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /subscription': () =>
      json(200, {
        organisation: { id: ORG, name: 'Obi Hotels', legalName: null },
        subscription: SUB,
        usage: {
          month: '2026-11',
          activeRooms: 3,
          whatsappMessages: 12,
          aiUses: 40,
          estimateMinor: '2000000',
        },
        invoices: [INVOICE],
        supportSessions: [SESSION],
      }),
    'PATCH /subscription/billing': (body) => json(200, body),
    'GET /platform/tenants': () => json(200, { data: [TENANT] }),
    [`GET /platform/tenants/${ORG}`]: () =>
      json(200, {
        ...TENANT,
        flags: [
          { module: 'leakage', label: 'Revenue Leakage Guard', enabled: true },
          { module: 'owner', label: 'Owner Remote Control', enabled: true },
        ],
        invoices: [INVOICE],
        supportSessions: [],
      }),
    [`PATCH /platform/tenants/${ORG}/flags`]: () => json(200, { flags: [] }),
    [`PUT /platform/tenants/${ORG}/subscription`]: () => json(200, SUB),
    'POST /platform/support-sessions': () => json(201, SESSION),
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

describe('Plan and billing (S30)', () => {
  it(
    'shows the plan, usage, invoices and every support session; saves the legal name',
    { timeout: 15_000 },
    async () => {
      const user = userEvent.setup();
      renderAt('/settings/billing');
      expect(await screen.findByText(/Professional · Active/)).toBeInTheDocument();
      expect(
        screen.getByText(/5,000\.00 per active room per month, minimum .*20,000\.00/),
      ).toBeInTheDocument();
      // T-118: each measured against its allowance; only the one used up is called out.
      expect(screen.getByText('12 of 12')).toBeInTheDocument();
      expect(screen.getByText('40 of 100')).toBeInTheDocument();
      expect(screen.getByText(/WhatsApp allowance is used up/)).toBeInTheDocument();
      expect(screen.queryByText(/AI allowance is used up/)).not.toBeInTheDocument();
      const invoices = screen.getByRole('region', { name: 'Invoices' });
      expect(within(invoices).getByText('INV-202610-55555555')).toBeInTheDocument();
      const support = screen.getByRole('region', { name: 'Support sessions' });
      expect(
        within(support).getByText(/Owner reports the arrivals list is empty/),
      ).toBeInTheDocument();
      expect(within(support).getByText(/4 records opened/)).toBeInTheDocument();

      const form = screen.getByRole('form', { name: 'Billing details' });
      await user.type(within(form).getByLabelText('Legal name on invoices'), 'Obi Hotels Ltd');
      await user.click(within(form).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(sent('PATCH /subscription/billing')).toEqual([{ legalName: 'Obi Hotels Ltd' }]),
      );
    },
  );
});

describe('Platform (S31)', () => {
  it('appears for platform staff only', async () => {
    renderAt('/platform');
    // Not platform staff: the screen is not theirs.
    await waitFor(() => expect(sent('GET /me')).toHaveLength(1));
    expect(screen.queryByRole('navigation', { name: 'Hotel groups' })).not.toBeInTheDocument();
  });

  it('lists hotel groups; a group’s modules switch and a support session starts with a reason', async () => {
    platformAdmin = true;
    const user = userEvent.setup();
    renderAt('/platform');
    const list = await screen.findByRole('navigation', { name: 'Hotel groups' });
    expect(
      await within(list).findByText(/3 active rooms · 12 WhatsApp · 40 AI this month/),
    ).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: /Obi Hotels/ }));
    const detail = await screen.findByRole('article', { name: 'Obi Hotels' });

    // T-118: allowances are typed per hotel group; blank means no limit.
    const plan = within(detail).getByRole('form', { name: 'Plan and prices' });
    const ai = within(plan).getByLabelText('AI uses per month');
    await user.clear(ai);
    await user.type(ai, '250');
    await user.clear(within(plan).getByLabelText('WhatsApp messages per month'));
    await user.click(within(plan).getByRole('button', { name: 'Save plan' }));
    await waitFor(() =>
      expect(sent(`PUT /platform/tenants/${ORG}/subscription`)).toEqual([
        expect.objectContaining({ aiAllowance: 250, whatsappAllowance: null }),
      ]),
    );

    await user.click(within(detail).getByLabelText('Revenue Leakage Guard'));
    await waitFor(() =>
      expect(sent(`PATCH /platform/tenants/${ORG}/flags`)).toEqual([
        { flags: [{ module: 'leakage', enabled: false }] },
      ]),
    );

    await user.type(
      within(detail).getByLabelText('Reason (shown to the owner)'),
      'Owner reports the arrivals list is empty',
    );
    await user.click(within(detail).getByRole('button', { name: 'Start session' }));
    await waitFor(() =>
      expect(sent('POST /platform/support-sessions')).toEqual([
        { organisationId: ORG, reason: 'Owner reports the arrivals list is empty', minutes: 30 },
      ]),
    );
  });
});
