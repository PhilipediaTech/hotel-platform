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

// S13 Guest and company profiles (PRD M3-15, M3-18, M3-16 basic; T-043).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const ADA = '22222222-0000-4000-8000-000000000001';
const DUP = '22222222-0000-4000-8000-000000000002';
const NEW = '22222222-0000-4000-8000-000000000003';
const CO = '22222222-0000-4000-8000-000000000004';

const guest = (id: string, extra: object = {}) => ({
  id,
  firstName: 'Ada',
  lastName: 'Obi',
  email: null,
  phone: '+2348031234567',
  nationality: 'NG',
  preferences: { notes: 'High floor', tags: ['quiet'] },
  marketingConsent: false,
  consentAt: null,
  flags: { vip: true, doNotRent: false, reason: 'CEO' },
  mergedIntoId: null,
  createdAt: '2026-11-10T09:00:00Z',
  updatedAt: '2026-11-10T09:00:00Z',
  ...extra,
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['guest.manage', 'guest.flag', 'company.manage'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /guests': (_b, url) =>
      json(200, {
        data:
          url.searchParams.get('q') === 'ada'
            ? [guest(ADA), guest(DUP, { flags: null, phone: null, email: 'ada@x.ng' })]
            : [guest(ADA)],
        nextCursor: null,
      }),
    'POST /guests': () => json(201, guest(NEW)),
    [`GET /guests/${ADA}`]: () => json(200, guest(ADA)),
    [`GET /guests/${NEW}`]: () => json(200, guest(NEW)),
    [`PATCH /guests/${ADA}`]: () =>
      json(200, guest(ADA, { lastName: 'Obi-Eze', updatedAt: '2026-11-10T10:00:00Z' })),
    [`POST /guests/${ADA}/flags`]: () => json(200, guest(ADA)),
    [`POST /guests/${ADA}/merge`]: () => json(200, guest(ADA)),
    'GET /companies': () => json(200, { data: [] }),
    'POST /companies': () =>
      json(201, {
        id: CO,
        kind: 'COMPANY',
        name: 'Dangote Group',
        contacts: [],
        taxId: null,
        active: true,
      }),
    [`GET /companies/${CO}`]: () =>
      json(200, {
        id: CO,
        kind: 'COMPANY',
        name: 'Dangote Group',
        contacts: [],
        taxId: null,
        active: true,
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
  return router;
}

describe('Guests', () => {
  it('searches and shows flags to those allowed', async () => {
    const user = userEvent.setup();
    renderAt('/guests');
    await user.type(await screen.findByRole('textbox', { name: 'Search guests' }), 'ada');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    const table = await screen.findByRole('table', { name: 'Guests found' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Ada ObiVIP');
    expect(sent('GET /guests').at(-1)?.url.searchParams.get('q')).toBe('ada');
  });

  it('adds a guest and opens the profile', async () => {
    const user = userEvent.setup();
    const router = renderAt('/guests');
    await user.click(await screen.findByRole('button', { name: 'Add guest' }));
    const form = screen.getByRole('form', { name: 'Add guest' });
    await user.type(within(form).getByLabelText('First name'), 'Bola');
    await user.type(within(form).getByLabelText('Last name'), 'Ade');
    await user.type(within(form).getByLabelText('Phone'), '+2348012345678');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/guests/${NEW}`));
    expect(sent('POST /guests')[0]?.body).toEqual({
      firstName: 'Bola',
      lastName: 'Ade',
      phone: '+2348012345678',
      email: null,
      nationality: null,
      preferences: { notes: null, tags: [] },
      marketingConsent: false,
    });
  });

  it('edits the profile and sets flags with a reason', async () => {
    const user = userEvent.setup();
    renderAt(`/guests/${ADA}`);
    const details = await screen.findByRole('form', { name: 'Details' });
    await user.clear(within(details).getByLabelText('Last name'));
    await user.type(within(details).getByLabelText('Last name'), 'Obi-Eze');
    await user.click(within(details).getByRole('checkbox', { name: /marketing/ }));
    await user.click(within(details).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent(`PATCH /guests/${ADA}`)[0]?.body).toMatchObject({
        lastName: 'Obi-Eze',
        marketingConsent: true,
        preferences: { notes: 'High floor', tags: ['quiet'] },
      }),
    );
    const flags = await screen.findByRole('form', { name: 'Flags' });
    await user.click(within(flags).getByRole('checkbox', { name: 'Do not rent' }));
    await user.click(within(flags).getByRole('button', { name: 'Save flags' }));
    await waitFor(() =>
      expect(sent(`POST /guests/${ADA}/flags`)[0]?.body).toEqual({
        vip: true,
        doNotRent: true,
        reason: 'CEO',
      }),
    );
  });

  it('hides flags from roles without guest.flag', async () => {
    permissions = ['guest.manage'];
    handlers[`GET /guests/${ADA}`] = () => json(200, guest(ADA, { flags: null }));
    renderAt(`/guests/${ADA}`);
    await screen.findByRole('form', { name: 'Details' });
    expect(screen.queryByRole('form', { name: 'Flags' })).toBeNull();
    expect(screen.queryByText('VIP')).toBeNull();
  });

  it('merges a duplicate after confirmation', async () => {
    const user = userEvent.setup();
    renderAt(`/guests/${ADA}`);
    const panel = await screen.findByRole('region', { name: 'Merge a duplicate' });
    await user.type(within(panel).getByRole('textbox', { name: 'Find the duplicate' }), 'ada');
    await user.click(within(panel).getByRole('button', { name: 'Find' }));
    await user.click(await within(panel).findByRole('button', { name: 'Merge with this guest' }));
    expect(within(panel).getByText(/This cannot be undone/)).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Merge' }));
    await waitFor(() =>
      expect(sent(`POST /guests/${ADA}/merge`)[0]?.body).toEqual({ otherGuestId: DUP }),
    );
  });
});

describe('Companies', () => {
  it('adds a company with a contact', async () => {
    const user = userEvent.setup();
    const router = renderAt('/companies');
    await user.click(await screen.findByRole('button', { name: 'Add company' }));
    const form = screen.getByRole('form', { name: 'Add company' });
    await user.type(within(form).getByLabelText('Name'), 'Dangote Group');
    await user.click(within(form).getByRole('button', { name: 'Add contact' }));
    await user.type(within(form).getByLabelText('Contact name'), 'Bola Ade');
    await user.type(within(form).getByLabelText('Phone'), '+2348012345678');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/companies/${CO}`));
    expect(sent('POST /companies')[0]?.body).toEqual({
      kind: 'COMPANY',
      name: 'Dangote Group',
      taxId: null,
      contacts: [{ name: 'Bola Ade', role: null, phone: '+2348012345678', email: null }],
    });
  });
});
