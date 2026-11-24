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

// Reviews (PRD M14-15; T-155).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const review = (over: object = {}) => ({
  id: id(1),
  status: 'WAITING',
  guest: { id: id(2), name: 'Ada Obi' },
  confirmationNo: 'LAG-00001',
  arrival: '2026-11-10',
  departure: '2026-11-12',
  channel: 'EMAIL',
  requestedAt: '2026-11-12T12:00:00.000Z',
  rating: 4,
  comment: 'Lovely staff, slow lift.',
  submittedAt: '2026-11-12T15:00:00.000Z',
  draft: 'Thank you, Ada! We are looking at the lift.',
  reply: null,
  repliedAt: null,
  repliedBy: null,
  ...over,
});
const list = (data: unknown[]) => ({
  data,
  summary: { requested: 5, answered: 3, averageRating: 4.3, waiting: 1 },
});

const calls: { key: string; body: unknown; search: string }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown, search: string) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['review.manage'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /review-settings': () =>
      json(200, { enabled: false, delayHours: 3, publicReviewUrl: null }),
    'GET /reviews': () => json(200, list([review()])),
  };
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

describe('Reviews', () => {
  it('shows a review with its drafted reply, which the GM edits and sends', async () => {
    const user = userEvent.setup();
    handlers[`POST /reviews/${id(1)}/reply`] = (body) =>
      json(200, review({ status: 'REPLIED', reply: (body as { reply: string }).reply }));
    renderAt('/reviews');
    await screen.findByText('Lovely staff, slow lift.');
    const reviews = screen.getByRole('list', { name: 'Reviews' });
    expect(sent('GET /reviews')[0]?.search).toBe('?status=WAITING');
    expect(
      screen.getByText(/Average 4.3 stars from 3 reviews \(5 guests asked, last 90 days\)/),
    ).toBeInTheDocument();
    expect(within(reviews).getByLabelText('4 stars out of 5')).toBeInTheDocument();
    expect(within(reviews).getByText('Lovely staff, slow lift.')).toBeInTheDocument();
    const box = within(reviews).getByLabelText('Your reply (drafted for you: check and change it)');
    expect(box).toHaveValue('Thank you, Ada! We are looking at the lift.');
    await user.clear(box);
    await user.type(box, 'Thank you, Ada. The lift is being serviced.');
    await user.click(within(reviews).getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(sent(`POST /reviews/${id(1)}/reply`)).toHaveLength(1));
    expect(sent(`POST /reviews/${id(1)}/reply`)[0]?.body).toEqual({
      reply: 'Thank you, Ada. The lift is being serviced.',
    });
  });

  it('drafts again, and says so when AI is not available', async () => {
    const user = userEvent.setup();
    handlers[`POST /reviews/${id(1)}/draft`] = () =>
      json(503, {
        error: {
          code: 'AI_UNAVAILABLE',
          message:
            'A draft isn’t available right now: write the reply yourself, or try again later.',
          requestId: 'r',
        },
      });
    renderAt('/reviews');
    await user.click(await screen.findByRole('button', { name: 'Draft again' }));
    expect(
      await screen.findByText(
        'A draft isn’t available right now: write the reply yourself, or try again later.',
      ),
    ).toBeInTheDocument();
  });

  it('switches review requests on with the public link', async () => {
    const user = userEvent.setup();
    handlers['PUT /review-settings'] = (body) => json(200, body);
    renderAt('/reviews');
    const form = await screen.findByRole('form', { name: 'Review requests' });
    await user.click(within(form).getByLabelText('Ask guests for a review after check-out'));
    await user.type(
      within(form).getByLabelText('Your public review page (optional)'),
      'https://g.page/r/obi/review',
    );
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT /review-settings')).toHaveLength(1));
    expect(sent('PUT /review-settings')[0]?.body).toEqual({
      enabled: true,
      delayHours: 3,
      publicReviewUrl: 'https://g.page/r/obi/review',
    });
  });
});
