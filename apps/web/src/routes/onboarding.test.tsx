import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../app/query-client.ts';
import { routes } from '../app/routes.tsx';
import { setApiPropertyId } from '../lib/api.ts';
import { LAGOS, LAGOS_PROPERTY, ORG, makeMe, membership } from '../test/me-fixture.ts';

// S02 setup wizard (PRD M1-02; T-030): checklist, step forms and go-live.

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

type Status = 'DONE' | 'TODO' | 'LATER';
const step = (id: string, status: Status, ticket: string | null = null, required = true) => ({
  id,
  status,
  required,
  ticket,
});

function detail(over: { status?: string; paymentMethods?: string[]; details?: Status } = {}) {
  const details = over.details ?? 'TODO';
  const payments = (over.paymentMethods ?? []).length > 0 ? 'DONE' : 'TODO';
  return {
    id: LAGOS,
    organisationId: ORG,
    code: 'LAG',
    name: 'Lagos Hotel',
    status: over.status ?? 'SETUP',
    timeZone: 'Africa/Lagos',
    baseCurrency: 'NGN',
    locale: 'en-NG',
    address: {
      line1: details === 'DONE' ? '12 Admiralty Way' : null,
      line2: null,
      city: 'Lagos',
      state: details === 'DONE' ? 'Lagos' : null,
      postalCode: null,
      country: 'NG',
    },
    phone: details === 'DONE' ? '+2348031234567' : null,
    email: null,
    taxRegistration: { tin: null, vatNumber: null },
    checkInTime: '14:00',
    checkOutTime: '12:00',
    nightAuditTime: '03:00',
    paymentMethods: over.paymentMethods ?? [],
    checklist: {
      steps: [
        step('organisation', 'DONE'),
        step('details', details),
        step('region', 'DONE'),
        step('tax', 'LATER', 'T-032'),
        step('room-types', 'LATER', 'T-031'),
        step('rooms', 'LATER', 'T-031'),
        step('rates', 'LATER', 'T-033'),
        step('payment-methods', payments),
        step('staff', 'TODO', null, false),
      ],
      ready: details === 'DONE' && payments === 'DONE',
    },
  };
}

const SETUP_PERMISSIONS = ['property.setup', 'owner.read', 'user.invite'];

let property: ReturnType<typeof detail>;
let permissions: string[];
let handlers: Record<string, (body: unknown) => Response>;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  property = detail();
  permissions = SETUP_PERMISSIONS;
  const path = `/properties/${LAGOS}`;
  handlers = {
    'GET /me': () =>
      json(
        200,
        makeMe({
          properties: [{ ...LAGOS_PROPERTY, status: property.status as 'SETUP' }],
          memberships: [membership(null, permissions)],
        }),
      ),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /approvals': () => json(200, { data: [], nextCursor: null }),
    [`GET ${path}`]: () => json(200, property),
    [`PATCH ${path}`]: (body) => {
      const b = body as { paymentMethods?: string[]; address?: unknown };
      property = detail({
        paymentMethods: b.paymentMethods ?? property.paymentMethods,
        details: b.address ? 'DONE' : property.checklist.steps[1]?.status,
      });
      return json(200, property);
    },
    [`POST ${path}/go-live`]: () => {
      property = { ...property, status: 'LIVE' };
      return json(200, property);
    },
    'GET /organisation': () =>
      json(200, { id: ORG, name: 'Obi Hotels', legalName: null, country: 'NG' }),
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
  return router;
}

describe('Setup wizard', () => {
  it('sends an owner to setup while the property is in setup', async () => {
    const router = renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Set up Lagos Hotel' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/onboarding');
  });

  it('sends staff who cannot set up to their own home screen', async () => {
    permissions = ['frontdesk.read'];
    const router = renderAt('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/front-desk'));
  });

  it('shows the checklist: progress, later steps and what blocks go-live', async () => {
    renderAt('/onboarding');
    const checklist = await screen.findByRole('navigation', { name: 'Setup checklist' });
    expect(within(checklist).getByText('2 of 4 required steps done')).toBeInTheDocument();
    expect(
      within(checklist).getByRole('button', { name: /Taxes.*Arrives with T-032/ }),
    ).toBeVisible();
    expect(
      within(checklist).getByRole('button', { name: /Rates.*Arrives with T-033/ }),
    ).toBeVisible();
    expect(within(checklist).getByRole('button', { name: /Invite staff.*Optional/ })).toBeVisible();
    // The first open step is shown first.
    expect(screen.getByRole('heading', { name: 'Property details' })).toBeInTheDocument();

    await userEvent.click(within(checklist).getByRole('button', { name: /Go live/ }));
    const goLive = screen.getByRole('region', { name: 'Go live' });
    expect(within(goLive).getByRole('button', { name: 'Go live' })).toBeDisabled();
    const panel = screen.getByText('Finish these steps first:').parentElement as HTMLElement;
    expect(within(panel).getByRole('button', { name: 'Property details' })).toBeVisible();
    expect(within(panel).getByRole('button', { name: 'Payment methods' })).toBeVisible();
  });

  it('saves property details, sending blanks as none', async () => {
    const user = userEvent.setup();
    renderAt('/onboarding?step=details');
    await user.type(await screen.findByLabelText('Address'), '12 Admiralty Way');
    await user.type(screen.getByLabelText('State'), 'Lagos');
    await user.type(screen.getByLabelText('Phone'), '+2348031234567');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent(`PATCH /properties/${LAGOS}`)).toHaveLength(1));
    expect(sent(`PATCH /properties/${LAGOS}`)[0]?.body).toEqual({
      name: 'Lagos Hotel',
      code: 'LAG',
      address: {
        line1: '12 Admiralty Way',
        line2: null,
        city: 'Lagos',
        state: 'Lagos',
        postalCode: null,
        country: 'NG',
      },
      phone: '+2348031234567',
      email: null,
      taxRegistration: { tin: null, vatNumber: null },
    });
    const checklist = screen.getByRole('navigation', { name: 'Setup checklist' });
    expect(await within(checklist).findByText('3 of 4 required steps done')).toBeInTheDocument();
  });

  it('checks a phone number before sending it', async () => {
    const user = userEvent.setup();
    renderAt('/onboarding?step=details');
    await user.type(await screen.findByLabelText('Phone'), '0803 123 4567');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/international format/i)).toBeInTheDocument();
    expect(sent(`PATCH /properties/${LAGOS}`)).toHaveLength(0);
  });

  it('chooses the payment methods taken at the desk', async () => {
    const user = userEvent.setup();
    renderAt('/onboarding?step=payment-methods');
    await user.click(await screen.findByRole('checkbox', { name: 'POS terminal (card)' }));
    await user.click(screen.getByRole('checkbox', { name: 'Cash' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent(`PATCH /properties/${LAGOS}`)[0]?.body).toEqual({
        paymentMethods: ['CASH', 'POS_TERMINAL'],
      }),
    );
  });

  it('goes live once ready', async () => {
    property = detail({ details: 'DONE', paymentMethods: ['CASH'] });
    const user = userEvent.setup();
    renderAt('/onboarding?step=go-live');
    expect(await screen.findByText(/Everything required is done/)).toBeInTheDocument();
    expect(screen.getByText(/Still to come in later updates: Taxes, Room types/)).toBeVisible();
    const panel = screen.getByRole('region', { name: 'Go live' });
    await user.click(within(panel).getByRole('button', { name: 'Go live' }));
    expect(await screen.findByText('This property is live and taking bookings.')).toBeVisible();
    expect(sent(`POST /properties/${LAGOS}/go-live`)).toHaveLength(1);
  });

  it('keeps time zone and currency fixed once live', async () => {
    property = detail({ status: 'LIVE', details: 'DONE', paymentMethods: ['CASH'] });
    const user = userEvent.setup();
    renderAt('/onboarding?step=region');
    expect(await screen.findByLabelText('Time zone')).toBeDisabled();
    expect(screen.getByLabelText('Base currency')).toBeDisabled();
    await user.clear(screen.getByLabelText('Check-out by'));
    await user.type(screen.getByLabelText('Check-out by'), '11:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(`PATCH /properties/${LAGOS}`)).toHaveLength(1));
    const body = sent(`PATCH /properties/${LAGOS}`)[0]?.body as Record<string, unknown>;
    expect(body['checkOutTime']).toBe('11:00');
    expect(body).not.toHaveProperty('timeZone');
    expect(body).not.toHaveProperty('baseCurrency');
  });
});
