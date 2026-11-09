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

// S38 Events and spaces (PRD M9-01–M9-03; T-119).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `66666666-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SPACE = {
  id: id(1),
  code: 'HALL',
  name: 'Marina Hall',
  description: null,
  setupMinutes: 60,
  cleanupMinutes: 30,
  minimumHireMinor: '50000000',
  active: true,
  layouts: [{ id: id(2), name: 'Banquet', capacity: 120 }],
  rateRules: [],
};
const ENQUIRY = {
  id: id(3),
  status: 'OPEN',
  contactName: 'Adaeze Obi',
  contactPhone: null,
  contactEmail: null,
  eventType: 'Wedding',
  eventDate: '2026-12-05',
  expectedGuests: 100,
  notes: null,
  lostReason: null,
  createdAt: '2026-11-10T09:00:00Z',
  bookings: [],
};
const HOLD = {
  id: id(4),
  title: 'Wedding: Adaeze Obi',
  status: 'HOLD',
  space: { id: SPACE.id, name: SPACE.name },
  layout: { id: id(2), name: 'Banquet' },
  enquiryId: ENQUIRY.id,
  startsAt: '2026-12-05T09:00:00Z',
  endsAt: '2026-12-05T15:00:00Z',
  blockedFrom: '2026-12-05T08:00:00Z',
  blockedUntil: '2026-12-05T15:30:00Z',
  expectedGuests: 100,
  holdExpiresAt: '2026-11-13T16:00:00Z',
};

let permissions: string[];
const calls: { key: string; body: unknown; search: string }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['event.enquiry', 'event.hold', 'space.manage'];
  const handlers: Record<string, (body: unknown) => Response> = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /event-bookings': () => json(200, { data: [HOLD] }),
    'GET /event-enquiries': () => json(200, { data: [ENQUIRY] }),
    'POST /event-enquiries': () => json(201, ENQUIRY),
    'GET /spaces': () => json(200, { data: [SPACE] }),
    'POST /spaces': () => json(201, SPACE),
    'GET /spaces/availability': () =>
      json(200, {
        data: [
          {
            space: { id: SPACE.id, name: SPACE.name },
            available: true,
            blockedFrom: '2026-12-05T08:00:00Z',
            blockedUntil: '2026-12-05T15:30:00Z',
            minimumHireMinor: '50000000',
            layouts: SPACE.layouts,
            conflicts: [],
          },
        ],
      }),
    'POST /event-bookings': () => json(201, HOLD),
    [`POST /event-bookings/${HOLD.id}/release`]: () => json(200, { ...HOLD, status: 'RELEASED' }),
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

describe('Events and spaces (S38)', { timeout: 20_000 }, () => {
  it('the calendar shows holds and releases one', async () => {
    const user = userEvent.setup();
    renderAt('/events');
    const row = (await screen.findByText('Wedding: Adaeze Obi')).closest('li') as HTMLElement;
    expect(within(row).getByText('On hold')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(sent(`POST /event-bookings/${HOLD.id}/release`)).toHaveLength(1));
  });

  it('an enquiry checks availability in hotel time and holds a space', async () => {
    const user = userEvent.setup();
    renderAt('/events');
    await user.click(await screen.findByRole('tab', { name: 'Enquiries' }));
    const card = (await screen.findByText('Adaeze Obi')).closest('li') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Find a space' }));
    await user.click(within(card).getByRole('button', { name: 'Check availability' }));
    await waitFor(() => expect(sent('GET /spaces/availability')).toHaveLength(1));
    // 10:00 in Lagos is 09:00 UTC.
    expect(sent('GET /spaces/availability')[0]?.search).toContain('2026-12-05T09%3A00%3A00Z');
    expect(await within(card).findByText('Free')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(sent('POST /event-bookings')).toHaveLength(1));
    expect(sent('POST /event-bookings')[0]?.body).toMatchObject({
      enquiryId: ENQUIRY.id,
      spaceId: SPACE.id,
      layoutId: id(2),
      startsAt: '2026-12-05T09:00:00Z',
      endsAt: '2026-12-05T15:00:00Z',
      expectedGuests: 100,
    });
  });

  it('adds a space with its layout', async () => {
    const user = userEvent.setup();
    renderAt('/events');
    await user.click(await screen.findByRole('tab', { name: 'Spaces' }));
    await user.click(await screen.findByRole('button', { name: 'Add a space' }));
    const form = screen.getByRole('form', { name: 'New space' });
    await user.type(within(form).getByLabelText('Code'), 'POOL');
    await user.type(within(form).getByLabelText('Name'), 'Poolside');
    await user.type(within(form).getByLabelText('Layout'), 'Cocktail');
    await user.type(within(form).getByLabelText('Capacity'), '80');
    await user.click(within(form).getByRole('button', { name: 'Save space' }));
    await waitFor(() => expect(sent('POST /spaces')).toHaveLength(1));
    expect(sent('POST /spaces')[0]?.body).toMatchObject({
      code: 'POOL',
      setupMinutes: 60,
      minimumHireMinor: '0',
      layouts: [{ name: 'Cocktail', capacity: 80 }],
    });
  });

  it('without space.manage the spaces can be seen but not changed', async () => {
    permissions = ['event.enquiry'];
    const user = userEvent.setup();
    renderAt('/events');
    await user.click(await screen.findByRole('tab', { name: 'Spaces' }));
    expect(await screen.findByText('Marina Hall')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a space' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});
