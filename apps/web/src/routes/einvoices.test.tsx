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

// E-invoicing (PRD M4-24; T-160).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const FOLIO = '99999999-0000-4000-8000-000000000001';
const item = (over: object = {}) => ({
  folioId: FOLIO,
  folioNumber: 'F00042',
  windowNumber: 2,
  invoiceNumber: 'F00042-2',
  billTo: 'Dangote Group',
  buyerTin: '87654321-0001',
  totalMinor: '6162500',
  currency: 'NGN',
  status: 'NOT_SENT',
  irn: null,
  reasons: [],
  attempts: 0,
  submittedAt: null,
  submittedBy: null,
  acceptedAt: null,
  ...over,
});
const COUNTS = { NOT_SENT: 1, QUEUED: 0, ACCEPTED: 3, REJECTED: 1, FAILED: 0 };
const SETTINGS = {
  enabled: true,
  providerReady: true,
  sellerTin: '12345678-0001',
  enabledAt: '2026-11-01T09:00:00Z',
};

const calls: { key: string; body: unknown; search: string }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown, search: string) => Response>;

function signedIn(permissions: string[]) {
  handlers['GET /me'] = () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] }));
}

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /einvoicing/settings': () => json(200, SETTINGS),
    'GET /einvoices': (_b, search) =>
      json(200, {
        data: search.includes('REJECTED')
          ? [item({ status: 'REJECTED', reasons: ['Buyer TIN not found'], attempts: 1 })]
          : [item()],
        counts: COUNTS,
      }),
  };
  signedIn(['einvoice.submit', 'tax.manage']);
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body, search: url.search });
      const handler = handlers[key];
      if (!handler) return Promise.reject(new Error(`Unexpected request ${key}`));
      return Promise.resolve(handler(body, url.search));
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

describe('E-invoicing', () => {
  it('lists invoices not sent yet and sends one', async () => {
    const user = userEvent.setup();
    handlers[`POST /folios/${FOLIO}/windows/2/einvoice`] = () =>
      json(200, item({ status: 'QUEUED' }));
    renderAt('/einvoices');
    const list = await screen.findByRole('list', { name: 'Invoices' });
    expect(sent('GET /einvoices')[0]?.search).toBe('?status=NOT_SENT');
    await within(list).findByText(/F00042-2/);
    expect(within(list).getByText('Bill to Dangote Group · TIN 87654321-0001')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Accepted (3)' })).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Send invoice F00042-2' }));
    await waitFor(() => expect(sent(`POST /folios/${FOLIO}/windows/2/einvoice`)).toHaveLength(1));
  });

  it('shows why the provider rejected an invoice, and sends it again', async () => {
    const user = userEvent.setup();
    renderAt('/einvoices');
    await user.click(await screen.findByRole('tab', { name: 'Rejected (1)' }));
    const list = screen.getByRole('list', { name: 'Invoices' });
    expect(await within(list).findByText('Buyer TIN not found')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Send invoice F00042-2' })).toHaveTextContent(
      'Send again',
    );
  });

  it('says what switching on needs, and only tax managers switch it', async () => {
    handlers['GET /einvoicing/settings'] = () =>
      json(200, { enabled: false, providerReady: false, sellerTin: null, enabledAt: null });
    renderAt('/einvoices');
    const group = await screen.findByRole('group', { name: 'E-invoicing for this property' });
    expect(
      within(group).getByText(
        'No e-invoicing provider is set up on the platform yet, so it can’t be switched on.',
      ),
    ).toBeInTheDocument();
    expect(within(group).queryByRole('button')).toBeNull();
  });

  it('switches on when the provider and TIN are there', async () => {
    const user = userEvent.setup();
    handlers['GET /einvoicing/settings'] = () =>
      json(200, { ...SETTINGS, enabled: false, enabledAt: null });
    handlers['PUT /einvoicing/settings'] = () => json(200, SETTINGS);
    renderAt('/einvoices');
    const group = await screen.findByRole('group', { name: 'E-invoicing for this property' });
    await user.click(within(group).getByRole('button', { name: 'Switch on' }));
    await waitFor(() =>
      expect(sent('PUT /einvoicing/settings')[0]?.body).toEqual({ enabled: true }),
    );
    expect(await within(group).findByRole('button', { name: 'Switch off' })).toBeInTheDocument();
  });

  it('finance without the tax permission can send but not switch', async () => {
    signedIn(['einvoice.submit']);
    renderAt('/einvoices');
    const group = await screen.findByRole('group', { name: 'E-invoicing for this property' });
    expect(within(group).queryByRole('button')).toBeNull();
  });
});
