import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../app/query-client.ts';
import { routes } from '../app/routes.tsx';
import { setApiPropertyId } from '../lib/api.ts';
import { makeMe } from '../test/me-fixture.ts';
import { CountryPackForm } from './platform.tsx';

// Referral partners: the partner's own page, the staff panel and the sign-up code (T-110).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const PARTNER_ID = '66666666-0000-4000-8000-000000000001';
const LINE = {
  id: '66666666-0000-4000-8000-000000000002',
  hotel: 'Obi Hotels',
  periodStart: '2026-10-01',
  commissionBps: 2000,
  amountMinor: '2000000',
  currency: 'NGN',
  earnedAt: '2026-11-10T09:00:00Z',
  paid: false,
};
const TOTALS = [{ currency: 'NGN', earnedMinor: '2000000', paidMinor: '0', owedMinor: '2000000' }];
const PARTNER = {
  id: PARTNER_ID,
  name: 'Nairobi Hospitality',
  country: 'KE',
  contactName: null,
  email: 'w@partner.test',
  phone: null,
  commissionBps: 2000,
  durationMonths: 12,
  code: 'ABCD2345',
  signUpLink: 'https://app.test/sign-up?ref=ABCD2345',
  active: true,
  createdAt: '2026-11-01T09:00:00Z',
  hotels: 1,
  totals: TOTALS,
};

let me: unknown;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key).map((c) => c.body);

beforeEach(() => {
  calls.length = 0;
  me = makeMe({ partner: { id: PARTNER_ID, name: 'Nairobi Hospitality' }, memberships: [] });
  const handlers: Record<string, (body: unknown) => Response> = {
    'GET /me': () => json(200, me),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /partner/home': () =>
      json(200, {
        name: 'Nairobi Hospitality',
        code: 'ABCD2345',
        signUpLink: 'https://app.test/sign-up?ref=ABCD2345',
        active: true,
        commissionBps: 2000,
        durationMonths: 12,
        hotels: [{ name: 'Obi Hotels', plan: 'PROFESSIONAL', status: 'ACTIVE' }],
        totals: TOTALS,
        commissions: [LINE],
        payouts: [],
      }),
    'GET /platform/tenants': () => json(200, { data: [] }),
    'GET /platform/partners': () => json(200, { data: [PARTNER] }),
    [`GET /platform/partners/${PARTNER_ID}`]: () =>
      json(200, {
        ...PARTNER,
        payoutDetails: 'M-Pesa 254700000000',
        hotelList: [],
        commissions: [LINE],
        payouts: [],
      }),
    [`POST /platform/partners/${PARTNER_ID}/payouts`]: () =>
      json(201, {
        ...PARTNER,
        payoutDetails: null,
        hotelList: [],
        commissions: [],
        payouts: [],
      }),
    'POST /auth/sign-up': () => json(201, { verificationSent: true }),
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

describe('Referral partners', { timeout: 20_000 }, () => {
  it('a partner with no hotel of their own sees their code, hotels and earnings', async () => {
    renderAt('/partner');
    expect(await screen.findByText('ABCD2345', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText(/Obi Hotels · Professional, Active/)).toBeInTheDocument();
    expect(screen.getByText(/Owed .*20,000.* of .*20,000.* earned/)).toBeInTheDocument();
  });

  it('platform staff open a partner and mark what is owed as paid', async () => {
    const user = userEvent.setup();
    me = makeMe({ platformAdmin: true, memberships: [] });
    renderAt('/platform');
    await user.click(
      await screen.findByRole('button', { name: /Nairobi Hospitality/ }, { timeout: 10_000 }),
    );
    await screen.findByText(/M-Pesa 254700000000/);
    await user.type(screen.getByLabelText('Payment reference'), 'MPESA-1');
    await user.click(screen.getByRole('button', { name: /Mark .*20,000.* as paid/ }));
    await waitFor(() =>
      expect(sent(`POST /platform/partners/${PARTNER_ID}/payouts`)).toEqual([
        { currency: 'NGN', reference: 'MPESA-1' },
      ]),
    );
  });

  it('a sign-up link fills in the referral code', async () => {
    renderAt('/sign-up?ref=ABCD2345');
    expect(
      await screen.findByLabelText('Referral code (optional)', {}, { timeout: 10_000 }),
    ).toHaveValue('ABCD2345');
  });
});

describe('Country pack form (M14-09; T-111)', () => {
  it('sends the chosen pack and says what it did', async () => {
    const user = userEvent.setup();
    const org = '77777777-0000-4000-8000-000000000001';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(json(200, { pack: 'KE', applied: ['Mara View'], keptAsTheyAre: [] })),
      ),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <CountryPackForm tenant={{ id: org, countryPack: 'NG' }} />
      </QueryClientProvider>,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Country pack' }), 'KE');
    await user.click(screen.getByRole('button', { name: 'Apply pack' }));
    expect(await screen.findByText(/Kenya applied to Mara View/)).toBeInTheDocument();
  });
});
