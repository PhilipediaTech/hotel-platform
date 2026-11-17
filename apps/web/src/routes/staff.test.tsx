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

// S36 Staff (PRD M7-01, M7-10; T-136).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FB = { id: id(80), name: 'Food and beverage' };
const GM = { id: id(90), name: 'Grace Manager', email: 'gm@hotel.test', linked: false };
const COOK_LOGIN = { id: id(91), name: 'Bisi Cook', email: 'bisi@hotel.test', linked: false };

const bisi = {
  id: id(1),
  number: 1,
  name: 'Bisi Cook',
  jobTitle: 'Cook',
  department: FB,
  manager: { id: GM.id, name: GM.name },
  user: { id: COOK_LOGIN.id, email: COOK_LOGIN.email },
  employmentType: 'MONTHLY_SALARY',
  startDate: '2026-01-05',
  endDate: null,
  status: 'ACTIVE',
  certsDue: 1,
  hasEmergencyContact: true,
};
const detail = {
  ...bisi,
  phone: null,
  email: null,
  payRateMinor: '15000000',
  currency: 'NGN',
  certifications: [
    {
      id: id(5),
      name: 'Food handler',
      issuer: null,
      reference: 'FH-123',
      issuedOn: null,
      expiresOn: '2026-11-30',
      state: 'EXPIRING',
    },
  ],
  createdAt: '2026-11-10T09:00:00Z',
};

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['staff.manage'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /staff': () =>
      json(200, { data: [bisi], departments: [FB], people: [GM, COOK_LOGIN], today: '2026-11-10' }),
    [`GET /staff/${id(1)}`]: () => json(200, detail),
    [`GET /staff/${id(1)}/emergency-contact`]: () =>
      json(200, { name: 'Kemi Cook', phone: '+2348011111111', relation: 'Sister' }),
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

describe('Staff (S36)', () => {
  it('shows a profile, its certifications and the emergency contact only on request', async () => {
    const user = userEvent.setup();
    renderAt('/staff');
    const list = await screen.findByRole('list', { name: 'Staff directory' });
    expect(await within(list).findByText('1 certification due')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'ST-1 · Bisi Cook' }));
    const certs = await screen.findByRole('region', { name: 'Certifications' });
    expect(certs).toHaveTextContent('Food handler');
    expect(certs).toHaveTextContent('Expiring soon');
    // Not fetched until asked.
    expect(sent(`GET /staff/${id(1)}/emergency-contact`)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Show emergency contact' }));
    expect(await screen.findByText('Kemi Cook · Sister · +2348011111111')).toBeInTheDocument();
    expect(sent(`GET /staff/${id(1)}/emergency-contact`)).toHaveLength(1);
  }, 15_000);

  it('adds a staff member without a login', async () => {
    handlers['POST /staff'] = () => json(201, detail);
    const user = userEvent.setup();
    renderAt('/staff');
    await user.click(await screen.findByRole('button', { name: 'Add a staff member' }));
    const form = screen.getByRole('form', { name: 'Staff profile' });
    await user.type(within(form).getByLabelText('Full name'), 'Ojo Gardener');
    await user.type(within(form).getByLabelText('Job title'), 'Gardener');
    await user.selectOptions(within(form).getByLabelText('Employment type'), 'DAILY_PAID');
    await user.type(within(form).getByLabelText('Start date'), '2026-03-01');
    await user.type(within(form).getByLabelText('Pay rate (optional)'), '5,000');
    await user.selectOptions(within(form).getByLabelText('Manager'), GM.id);
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST /staff')).toHaveLength(1));
    expect(sent('POST /staff')[0]?.body).toEqual({
      name: 'Ojo Gardener',
      userId: null,
      phone: null,
      email: null,
      departmentId: null,
      jobTitle: 'Gardener',
      managerId: GM.id,
      employmentType: 'DAILY_PAID',
      startDate: '2026-03-01',
      payRateMinor: '500000',
    });
  }, 15_000);
});
