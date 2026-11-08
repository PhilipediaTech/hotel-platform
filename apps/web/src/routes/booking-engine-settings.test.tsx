import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../app/query-client.ts';
import { routes } from '../app/routes.tsx';
import { setApiPropertyId } from '../lib/api.ts';
import { LAGOS, makeMe, membership } from '../test/me-fixture.ts';

// S40 Booking engine settings (PRD M11-03; T-112).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const SAVED = {
  slug: 'demo-lagos',
  enabled: true,
  headline: 'Stay in Lagos',
  description: null,
  policies: null,
  photoFileIds: [],
  allowPayFull: true,
  allowDeposit: true,
  depositBps: 3000,
  allowPayAtHotel: true,
  pageUrl: 'https://book.test/demo-lagos',
  embedSnippet: '<iframe src="https://book.test/demo-lagos"></iframe>',
};

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key).map((c) => c.body);
let saveAnswer: () => Response;

beforeEach(() => {
  calls.length = 0;
  saveAnswer = () => json(200, SAVED);
  const handlers: Record<string, (body: unknown) => Response> = {
    'GET /me': () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['bookingengine.manage'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /booking-engine/settings': () => json(200, SAVED),
    'PUT /booking-engine/settings': () => saveAnswer(),
    'GET /booking-engine/promo-codes': () => json(200, { data: [] }),
    'POST /booking-engine/promo-codes': () =>
      json(201, {
        id: '88888888-0000-4000-8000-000000000001',
        code: 'WELCOME',
        discountBps: 1000,
        validFrom: null,
        validTo: null,
        maxUses: null,
        usedCount: 0,
        active: true,
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

function renderPage() {
  const router = createMemoryRouter(routes, { initialEntries: ['/settings/booking-engine'] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Booking page settings (S40)', { timeout: 20_000 }, () => {
  it('shows the embed snippet and saves changes', async () => {
    const user = userEvent.setup();
    renderPage();
    const headline = await screen.findByLabelText('Headline', {}, { timeout: 10_000 });
    expect(screen.getByText(/<iframe src="https:\/\/book.test\/demo-lagos"/)).toBeInTheDocument();
    await user.clear(headline);
    await user.type(headline, 'Your home in Lagos');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT /booking-engine/settings')).toHaveLength(1));
    expect(sent('PUT /booking-engine/settings')[0]).toMatchObject({
      slug: 'demo-lagos',
      headline: 'Your home in Lagos',
      depositBps: 3000,
    });
  });

  it('puts a taken address against its field', async () => {
    const user = userEvent.setup();
    saveAnswer = () =>
      json(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: {
            issues: [
              {
                path: 'body.slug',
                code: 'custom',
                message: 'Another hotel already uses this address',
              },
            ],
          },
        },
      });
    renderPage();
    await screen.findByLabelText('Headline', {}, { timeout: 10_000 });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Another hotel already uses this address')).toBeInTheDocument();
  });

  it('adds a promo code', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Code', {}, { timeout: 10_000 }), 'WELCOME');
    await user.type(screen.getByLabelText('% off'), '10');
    await user.click(screen.getByRole('button', { name: 'Add code' }));
    await waitFor(() =>
      expect(sent('POST /booking-engine/promo-codes')).toEqual([
        { code: 'WELCOME', discountBps: 1000 },
      ]),
    );
  });
});
