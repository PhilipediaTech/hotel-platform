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
import { amountMinor } from './shift.tsx';

// S14 Cashier shift (PRD M4-10–M4-12; T-061).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `88888888-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHIFT = id(1);
const BOLA = id(2);

const openShift = (extra: object = {}) => ({
  id: SHIFT,
  status: 'OPEN',
  openedAt: '2026-11-10T08:00:00Z',
  floatMinor: '2000000',
  currency: 'NGN',
  handoversOut: [],
  handoversIn: [],
  paymentCounts: [],
  ...extra,
});

const current = (extra: object = {}) => ({
  shift: openShift(),
  awaitingSignOff: [],
  incoming: [],
  colleagues: [{ userId: BOLA, name: 'Bola Desk' }],
  ...extra,
});

const counted = (extra: object = {}) => ({
  id: SHIFT,
  userId: id(9),
  cashier: 'Ada Cashier',
  status: 'CLOSING',
  openedAt: '2026-11-10T08:00:00Z',
  closedAt: '2026-11-10T17:00:00Z',
  floatMinor: '12550000',
  currency: 'NGN',
  lines: [
    {
      method: 'CASH',
      currency: 'NGN',
      expectedMinor: '12550000',
      countedMinor: '12350000',
      varianceMinor: '-200000',
    },
  ],
  toleranceMinor: '50000',
  requiresSignOff: true,
  varianceNote: null,
  signedOffBy: null,
  ...extra,
});

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['shift.open', 'shift.close', 'shift.handover'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /shifts/current': () => json(200, current()),
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

function renderShift() {
  const router = createMemoryRouter(routes, { initialEntries: ['/shift'] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('amountMinor', () => {
  it.each([
    ['20,000', '2000000'],
    ['0', '0'],
    ['₦ 1,500.5', '150050'],
    ['12.345', null],
    ['-5', null],
    ['', null],
  ])('%j → %j', (text, minor) => {
    expect(amountMinor(text)).toBe(minor);
  });
});

describe('Cashier shift (S14)', () => {
  it('opens a shift with the counted float', async () => {
    let open = false;
    handlers['GET /shifts/current'] = () =>
      json(200, open ? current() : current({ shift: null, colleagues: [] }));
    handlers['POST /shifts'] = () => {
      open = true;
      return json(201, current());
    };
    const user = userEvent.setup();
    renderShift();
    const form = await screen.findByRole('form', { name: 'Open shift' });
    await user.type(within(form).getByLabelText('Float (₦)'), '20,000');
    await user.click(within(form).getByRole('button', { name: 'Open shift' }));
    await waitFor(() => expect(sent('POST /shifts')).toHaveLength(1));
    expect(sent('POST /shifts')[0]?.body).toEqual({ floatMinor: '2000000' });
    expect(await screen.findByRole('form', { name: 'Close shift' })).toBeInTheDocument();
  });

  it('counts blind, confirms, then shows the variance and takes the reason', async () => {
    handlers[`POST /shifts/${SHIFT}/close`] = () => json(200, counted());
    handlers[`POST /shifts/${SHIFT}/variance-note`] = () =>
      json(200, counted({ varianceNote: 'Change given' }));
    const user = userEvent.setup();
    renderShift();
    const form = await screen.findByRole('form', { name: 'Close shift' });
    // Blind: nothing on screen says what the drawer should hold.
    expect(screen.queryByRole('columnheader', { name: 'Expected' })).not.toBeInTheDocument();
    expect(screen.getByText('₦20,000.00')).toBeInTheDocument();

    await user.type(within(form).getByLabelText('Cash'), '123,500');
    await user.type(within(form).getByLabelText('POS terminal'), '84,000');
    await user.click(within(form).getByRole('button', { name: 'Submit count' }));
    // The first click asks for confirmation: a count is final.
    expect(sent(`POST /shifts/${SHIFT}/close`)).toHaveLength(0);
    await user.click(within(form).getByRole('button', { name: 'Yes, submit this count' }));
    await waitFor(() => expect(sent(`POST /shifts/${SHIFT}/close`)).toHaveLength(1));
    expect(sent(`POST /shifts/${SHIFT}/close`)[0]?.body).toEqual({
      counts: [
        { method: 'CASH', currency: 'NGN', countedMinor: '12350000' },
        { method: 'POS_TERMINAL', currency: 'NGN', countedMinor: '8400000' },
      ],
      varianceNote: null,
    });

    const result = await screen.findByRole('table', { name: 'Count for Ada Cashier' });
    expect(result).toHaveTextContent('₦125,500.00');
    expect(result).toHaveTextContent('-₦2,000.00');
    expect(screen.getByText(/more than ₦500.00/)).toBeInTheDocument();
    await user.type(
      screen.getByRole('textbox', { name: 'Reason for the difference' }),
      'Change given',
    );
    await user.click(screen.getByRole('button', { name: 'Save reason' }));
    await waitFor(() => expect(sent(`POST /shifts/${SHIFT}/variance-note`)).toHaveLength(1));
    expect(sent(`POST /shifts/${SHIFT}/variance-note`)[0]?.body).toEqual({ note: 'Change given' });
  }, 15_000);

  it('hands cash to a colleague or the safe, and confirms cash handed over', async () => {
    handlers['GET /shifts/current'] = () =>
      json(
        200,
        current({
          incoming: [
            {
              id: id(5),
              from: 'Bola Desk',
              to: 'Ada Cashier',
              amountMinor: '1000000',
              currency: 'NGN',
              at: '2026-11-10T10:00:00Z',
              confirmedAt: null,
            },
          ],
        }),
      );
    handlers['POST /cash-handovers'] = () => json(201, current());
    handlers[`POST /cash-handovers/${id(5)}/confirm`] = () => json(200, current());
    const user = userEvent.setup();
    renderShift();
    const incoming = await screen.findByRole('region', { name: 'Cash handed to you' });
    expect(incoming).toHaveTextContent('Bola Desk handed you ₦10,000.00');
    await user.click(within(incoming).getByRole('button', { name: 'Confirm received' }));
    await waitFor(() => expect(sent(`POST /cash-handovers/${id(5)}/confirm`)).toHaveLength(1));

    const form = screen.getByRole('form', { name: 'Hand over cash' });
    await user.selectOptions(within(form).getByLabelText('To'), BOLA);
    await user.type(within(form).getByLabelText('Amount (₦)'), '5,000');
    await user.click(within(form).getByRole('button', { name: 'Hand over' }));
    await waitFor(() => expect(sent('POST /cash-handovers')).toHaveLength(1));
    expect(sent('POST /cash-handovers')[0]?.body).toEqual({
      toUserId: BOLA,
      amountMinor: '500000',
    });
  }, 15_000);

  it('lets a supervisor sign off a shift once the cashier has given a reason', async () => {
    permissions = ['shift.open', 'shift.signoff'];
    handlers['GET /shifts/current'] = () => json(200, current({ shift: null }));
    handlers['GET /shifts'] = () =>
      json(200, {
        data: [
          counted({ varianceNote: 'Change given' }),
          counted({ id: id(3), cashier: 'Bola Desk' }),
        ],
      });
    handlers[`POST /shifts/${SHIFT}/sign-off`] = () =>
      json(200, counted({ status: 'CLOSED', requiresSignOff: false }));
    const user = userEvent.setup();
    renderShift();
    const list = await screen.findByRole('region', { name: 'Shifts (supervisor)' });
    await within(list).findByText('Reason: Change given');
    expect(within(list).getByText('Waiting for the cashier’s reason.')).toBeInTheDocument();
    expect(within(list).getAllByRole('button', { name: /^Sign off/ })).toHaveLength(1);
    await user.click(within(list).getByRole('button', { name: 'Sign off Ada Cashier’s shift' }));
    await waitFor(() => expect(sent(`POST /shifts/${SHIFT}/sign-off`)).toHaveLength(1));
    expect(sent(`POST /shifts/${SHIFT}/sign-off`)[0]?.body).toEqual({ note: null });
    expect(sent('GET /shifts')[0]?.url.searchParams.get('status')).toBe('CLOSING');
  });

  it('shows no supervisor list and no handover form without those permissions', async () => {
    permissions = ['shift.open', 'shift.close'];
    renderShift();
    await screen.findByRole('form', { name: 'Close shift' });
    expect(screen.queryByRole('region', { name: 'Shifts (supervisor)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Hand over cash' })).not.toBeInTheDocument();
  });
});
