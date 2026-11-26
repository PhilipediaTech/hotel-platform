import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../app/query-client.ts';
import { routes } from '../app/routes.tsx';
import { setApiPropertyId } from '../lib/api.ts';
import { LAGOS, ORG, makeMe, membership } from '../test/me-fixture.ts';
import { SupportQueue } from './platform-support.tsx';

// Help and the S31 support queue (Versions V2 "support tooling"; T-170).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const T1 = '55555555-0000-4000-8000-000000000001';
const ADA = { id: '55555555-0000-4000-8000-0000000000a1', name: 'Ada Obi' };
const CHIDI = { id: '55555555-0000-4000-8000-0000000000c1', name: 'Chidi Support' };

const ticket = (extra: object = {}) => ({
  id: T1,
  subject: 'Cannot check guests in',
  urgency: 'BLOCKER',
  status: 'ANSWERED',
  page: '/front-desk',
  propertyName: 'Lagos Hotel',
  openedBy: ADA,
  createdAt: '2026-11-10T09:00:00Z',
  lastMessageAt: '2026-11-10T09:07:00Z',
  firstResponseAt: '2026-11-10T09:07:00Z',
  resolvedAt: null,
  unread: true,
  ...extra,
});
const messages = [
  {
    id: '55555555-0000-4000-8000-0000000000m1',
    fromPlatform: false,
    author: ADA,
    body: 'The check-in button does nothing.',
    createdAt: '2026-11-10T09:00:00Z',
  },
  {
    id: '55555555-0000-4000-8000-0000000000m2',
    fromPlatform: true,
    author: CHIDI,
    body: 'Fixed: please refresh.',
    createdAt: '2026-11-10T09:07:00Z',
  },
];

let handlers: Record<string, (body: unknown) => Response>;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key).map((c) => c.body);

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['frontdesk.read'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /support/tickets': () =>
      json(200, {
        contact: { name: 'Chidi Support', email: 'chidi@platform.test' },
        seesAll: false,
        data: [ticket()],
      }),
    'POST /support/tickets': () =>
      json(201, ticket({ id: T1, status: 'OPEN', unread: false, messages: [messages[0]] })),
    [`GET /support/tickets/${T1}`]: () => json(200, { ...ticket({ unread: false }), messages }),
    [`POST /support/tickets/${T1}/messages`]: () =>
      json(200, { ...ticket({ status: 'OPEN', unread: false }), messages }),
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
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

describe('Help', () => {
  it('shows new replies on the Help button and opens the conversation', async () => {
    const user = userEvent.setup();
    renderAt('/support');
    expect(await screen.findByRole('link', { name: 'Help: 1 new reply' })).toBeVisible();
    expect(
      await screen.findByText('Your onboarding contact: Chidi Support (chidi@platform.test)'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Cannot check guests in/ }));
    const conversation = await screen.findByRole('list', { name: 'Conversation' });
    expect(within(conversation).getByText(/Chidi Support · Support team/)).toBeVisible();
    await user.type(screen.getByLabelText('Your reply'), 'Still stuck on room 204.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(sent(`POST /support/tickets/${T1}/messages`)).toEqual([
        { message: 'Still stuck on room 204.' },
      ]),
    );
  }, 15_000);

  it('sends a blocker with the page it was asked from', async () => {
    const user = userEvent.setup();
    renderAt('/support?from=%2Ffront-desk');
    expect(await screen.findByText('Asked from /front-desk')).toBeVisible();
    await user.type(screen.getByLabelText('Subject'), 'Cannot check guests in');
    await user.click(screen.getByRole('radio', { name: 'The front desk can’t work' }));
    expect(screen.getByText('Blockers also reach the team by WhatsApp.')).toBeVisible();
    await user.type(screen.getByLabelText('What happened?'), 'The button does nothing.');
    await user.click(screen.getByRole('button', { name: 'Send to support' }));
    await waitFor(() =>
      expect(sent('POST /support/tickets')).toEqual([
        {
          subject: 'Cannot check guests in',
          message: 'The button does nothing.',
          urgency: 'BLOCKER',
          page: '/front-desk',
        },
      ]),
    );
  }, 15_000);
});

describe('the S31 support queue', () => {
  it('marks a request waiting past 15 minutes and answers it', async () => {
    handlers['GET /platform/support/tickets'] = () =>
      json(200, {
        data: [
          {
            ...ticket({ status: 'OPEN', firstResponseAt: null }),
            organisation: { id: ORG, name: 'Obi Hotels' },
            assignedAdmin: null,
          },
        ],
      });
    handlers['GET /platform/admins'] = () =>
      json(200, { data: [{ ...CHIDI, email: 'chidi@platform.test', phone: null }] });
    handlers[`GET /platform/support/tickets/${T1}`] = () =>
      json(200, {
        ...ticket({ status: 'OPEN', firstResponseAt: null }),
        organisation: { id: ORG, name: 'Obi Hotels' },
        assignedAdmin: null,
        messages: [messages[0]],
      });
    handlers[`POST /platform/support/tickets/${T1}/messages`] = () =>
      json(200, {
        ...ticket(),
        organisation: { id: ORG, name: 'Obi Hotels' },
        assignedAdmin: CHIDI,
        messages,
      });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider
          router={createMemoryRouter([
            {
              path: '/',
              element: <SupportQueue now={Date.parse('2026-11-10T09:20:00Z')} />,
            },
          ])}
        />
      </QueryClientProvider>,
    );
    const item = await screen.findByRole('button', { name: /Obi Hotels: Cannot check guests in/ });
    expect(item).toHaveTextContent('over 15 min: answer first');
    await user.click(item);
    await user.type(await screen.findByLabelText('Your answer'), 'Fixed: please refresh.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(sent(`POST /platform/support/tickets/${T1}/messages`)).toEqual([
        { message: 'Fixed: please refresh.' },
      ]),
    );
  }, 15_000);
});
