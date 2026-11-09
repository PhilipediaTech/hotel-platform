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

// The two-way WhatsApp inbox (PRD M11-04; T-115).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const THREAD_ID = '99999999-0000-4000-8000-000000000001';
const THREAD = {
  id: THREAD_ID,
  phone: '+2348031234567',
  guest: { id: '99999999-0000-4000-8000-000000000002', name: 'Ada Obi' },
  reservation: {
    id: '99999999-0000-4000-8000-000000000003',
    confirmationNo: 'LAG-00042',
    status: 'CONFIRMED',
  },
  lastMessageAt: '2026-11-10T09:00:00Z',
  lastPreview: 'Can I check out late?',
  unreadCount: 1,
  windowOpen: true,
  needsStaff: false,
  assistantPaused: false,
};
const MESSAGE = {
  id: '99999999-0000-4000-8000-000000000004',
  direction: 'IN',
  kind: 'TEXT',
  body: 'Can I check out late?',
  status: 'RECEIVED',
  sentBy: null,
  createdAt: '2026-11-10T09:00:00Z',
};

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key).map((c) => c.body);
let thread = THREAD;

beforeEach(() => {
  calls.length = 0;
  thread = THREAD;
  const handlers: Record<string, () => Response> = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['message.send'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /message-threads': () => json(200, { data: [thread] }),
    [`GET /message-threads/${THREAD_ID}`]: () => json(200, { ...thread, messages: [MESSAGE] }),
    [`POST /message-threads/${THREAD_ID}/read`]: () => json(200, { unreadCount: 0 }),
    [`POST /message-threads/${THREAD_ID}/messages`]: () =>
      json(201, { ...MESSAGE, direction: 'OUT', body: 'Yes', status: 'SENT' }),
    [`POST /message-threads/${THREAD_ID}/follow-up`]: () =>
      json(201, { ...MESSAGE, direction: 'OUT', kind: 'TEMPLATE', status: 'QUEUED' }),
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
      return Promise.resolve(handler());
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setApiPropertyId(null);
});

function renderInbox() {
  const router = createMemoryRouter(routes, { initialEntries: ['/inbox'] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('WhatsApp inbox (M11-04)', { timeout: 20_000 }, () => {
  it('opens a conversation, links the booking, marks it read and replies', async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByRole('button', { name: /Ada Obi/ }, { timeout: 10_000 }));
    expect(await screen.findByRole('link', { name: 'Booking LAG-00042' })).toBeInTheDocument();
    await waitFor(() => expect(sent(`POST /message-threads/${THREAD_ID}/read`)).toHaveLength(1));
    await user.type(screen.getByLabelText('Your reply'), 'Yes');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(sent(`POST /message-threads/${THREAD_ID}/messages`)).toEqual([{ body: 'Yes' }]),
    );
  });

  it('after 24 hours offers only the approved follow-up', async () => {
    const user = userEvent.setup();
    thread = { ...THREAD, windowOpen: false, unreadCount: 0 };
    renderInbox();
    await user.click(await screen.findByRole('button', { name: /Ada Obi/ }, { timeout: 10_000 }));
    expect(await screen.findByText(/more than 24 hours ago/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Your reply')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send follow-up message' }));
    expect(await screen.findByText(/Follow-up sent/)).toBeInTheDocument();
  });

  it('says so when there is nothing yet', async () => {
    thread = THREAD;
    vi.mocked(fetch).mockImplementation(((input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init?.method ?? 'GET'} ${url.pathname.replace('/api/v1', '')}`;
      if (key === 'GET /me') {
        return Promise.resolve(
          json(200, makeMe({ memberships: [membership(LAGOS, ['message.send'])] })),
        );
      }
      if (key === 'GET /message-threads') return Promise.resolve(json(200, { data: [] }));
      return Promise.resolve(json(200, { pinSwitchAvailable: false, deviceLabel: null }));
    }) as unknown as typeof fetch);
    renderInbox();
    expect(await screen.findByText(/No conversations yet/, {}, { timeout: 10_000 })).toBeTruthy();
  });
});
