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
  confirmedByOverride: false,
};

const QUOTE = {
  currentVersion: 1,
  versions: [
    {
      id: id(5),
      version: 1,
      lines: [
        {
          kind: 'SPACE',
          description: 'Hall, full day',
          quantity: 1,
          unitMinor: '80000000',
          amountMinor: '80000000',
          revenueCode: 'MISC',
          taxMinor: '6000000',
          totalMinor: '86000000',
          minimumHire: false,
        },
      ],
      netMinor: '80000000',
      taxMinor: '6000000',
      totalMinor: '86000000',
      notes: null,
      createdAt: '2026-11-10T09:00:00Z',
    },
  ],
  rates: [{ id: id(6), name: 'Weekend full day', unit: 'FULL_DAY', amountMinor: '80000000' }],
  minimumHireMinor: '50000000',
  expectedGuests: 100,
};
const NO_CONTRACT = { contract: null, missing: ['NO_CONTRACT', 'DEPOSIT_NOT_PAID'] };
const CONTRACT = {
  id: id(7),
  number: 'EC00001',
  status: 'ISSUED',
  quoteVersion: 1,
  clientName: 'Adaeze Obi',
  clientEmail: 'adaeze@example.com',
  clientPhone: '+2348011111111',
  terms: 'Terms',
  totalMinor: '86000000',
  damageDepositMinor: '0',
  issuedAt: '2026-11-10T09:00:00Z',
  signedByName: null,
  signedOn: null,
  folio: { id: id(8), number: 'F00001' },
  account: { bankName: 'Fake Bank', accountNumber: '9900000001', accountName: 'HOTEL/OBI' },
  schedule: [
    {
      id: id(9),
      sequence: 1,
      kind: 'DEPOSIT',
      dueDate: '2026-11-12',
      amountMinor: '43000000',
      paidMinor: '43000000',
      status: 'PAID',
    },
  ],
  overpaidMinor: '0',
};

const PAST = { ...HOLD, status: 'CONFIRMED', holdExpiresAt: null, endsAt: '2020-01-01T15:00:00Z' };
const BRIEF = {
  sections: [
    {
      department: { id: id(11), code: 'FB', name: 'Food and beverage' },
      instructions: '',
      version: 0,
      updatedAt: null,
    },
  ],
};
const NOT_INSPECTED = {
  status: 'CONFIRMED',
  inspection: null,
  folio: null,
  damageDepositHeldMinor: '0',
  damageDepositRetainedMinor: '0',
  blockers: ['NOT_INSPECTED'],
  closedAt: null,
};
const INSPECTED = {
  ...NOT_INSPECTED,
  inspection: {
    at: '2020-01-01T16:00:00Z',
    notes: 'A cracked table',
    damageDescription: 'Table',
    damageTotalMinor: '2150000',
  },
  folio: { id: id(8), number: 'F00001', status: 'OPEN', balanceMinor: '-7850000' },
  damageDepositHeldMinor: '10000000',
  damageDepositRetainedMinor: '2150000',
  blockers: ['CREDIT_TO_RETURN'],
};

const CANCELLABLE = {
  allowed: true,
  reason: null,
  bookedAt: '2026-11-10T09:00:00Z',
  keepBps: 3000,
  depositPaidMinor: '40000000',
  feeMinor: '12000000',
  receivedMinor: '40000000',
};

let cancellation: unknown;
let listed: unknown;
let closeOut: unknown;
let contractView: unknown;
let confirmReply: () => Response;
let permissions: string[];
const calls: { key: string; body: unknown; search: string }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  listed = HOLD;
  cancellation = { ...CANCELLABLE, allowed: false, reason: 'NOTHING_TO_CANCEL' };
  closeOut = NOT_INSPECTED;
  contractView = NO_CONTRACT;
  confirmReply = () => json(200, { ...HOLD, status: 'CONFIRMED', holdExpiresAt: null });
  permissions = [
    'event.enquiry',
    'event.hold',
    'space.manage',
    'event.quote',
    'event.contract',
    'event.confirm',
    'event.brief',
    'event.close',
  ];
  const handlers: Record<string, (body: unknown) => Response> = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /event-bookings': () => json(200, { data: [listed] }),
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
    [`GET /event-bookings/${HOLD.id}/brief`]: () => json(200, BRIEF),
    [`GET /event-bookings/${HOLD.id}/cancellation`]: () => json(200, cancellation),
    [`POST /event-bookings/${HOLD.id}/cancel`]: () => json(200, { ...HOLD, status: 'CANCELLED' }),
    [`PUT /event-bookings/${HOLD.id}/brief`]: () => json(200, BRIEF),
    [`GET /event-bookings/${HOLD.id}/close-out`]: () => json(200, closeOut),
    [`POST /event-bookings/${HOLD.id}/inspection`]: () => json(201, closeOut),
    [`POST /event-bookings/${HOLD.id}/close`]: () => json(200, { ...HOLD, status: 'CLOSED' }),
    [`GET /event-bookings/${HOLD.id}/quotes`]: () => json(200, QUOTE),
    [`POST /event-bookings/${HOLD.id}/quotes`]: () => json(201, QUOTE),
    [`GET /event-bookings/${HOLD.id}/contract`]: () => json(200, contractView),
    [`POST /event-bookings/${HOLD.id}/contract`]: () => json(201, contractView),
    [`POST /event-bookings/${HOLD.id}/contract/sign`]: () => json(200, contractView),
    [`POST /event-bookings/${HOLD.id}/confirm`]: () => confirmReply(),
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

  async function openFile(user: ReturnType<typeof userEvent.setup>) {
    renderAt('/events');
    const row = (await screen.findByText('Wedding: Adaeze Obi')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Quote and contract' }));
    return row;
  }

  it('saves a new quote version, offering the prices for the day (M9-04)', async () => {
    const user = userEvent.setup();
    const row = await openFile(user);
    expect(await within(row).findByText('Hall, full day')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'New version' }));
    await user.click(within(row).getByRole('button', { name: /Weekend full day/ }));
    await user.click(within(row).getByRole('button', { name: 'Add catering for the guests' }));
    const form = within(row).getByRole('form', { name: 'New quote version' });
    const amounts = within(form).getAllByLabelText('Amount (₦)');
    await user.type(amounts[2] as HTMLElement, '10000');
    await user.click(within(form).getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(sent(`POST /event-bookings/${HOLD.id}/quotes`)).toHaveLength(1));
    expect(sent(`POST /event-bookings/${HOLD.id}/quotes`)[0]?.body).toMatchObject({
      lines: [
        { kind: 'SPACE', quantity: 1, unitMinor: '80000000' },
        { kind: 'SPACE', description: 'Weekend full day', unitMinor: '80000000' },
        { kind: 'CATERING', quantity: 100, unitMinor: '1000000' },
      ],
    });
  });

  it('issues a contract whose schedule starts as the quote total (M9-05)', async () => {
    const user = userEvent.setup();
    const row = await openFile(user);
    await within(row).findByText('No contract yet.');
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: 'Issue contract' })).toBeInTheDocument(),
    );
    await user.click(within(row).getByRole('button', { name: 'Issue contract' }));
    const form = within(row).getByRole('form', { name: 'New contract' });
    await user.type(within(form).getByLabelText('Contact name'), 'Adaeze Obi');
    await user.type(within(form).getByLabelText('Email'), 'adaeze@example.com');
    await user.type(within(form).getByLabelText('Phone'), '+2348011111111');
    await user.type(within(form).getByLabelText('Terms'), 'Deposit is not refundable.');
    await user.click(within(form).getByRole('button', { name: 'Issue contract' }));
    await waitFor(() => expect(sent(`POST /event-bookings/${HOLD.id}/contract`)).toHaveLength(1));
    const body = sent(`POST /event-bookings/${HOLD.id}/contract`)[0]?.body as {
      schedule: { kind: string; amountMinor: string }[];
    };
    expect(body.schedule.map((s) => [s.kind, s.amountMinor])).toEqual([
      ['DEPOSIT', '43000000'],
      ['INSTALMENT', '43000000'],
    ]);
  });

  it('shows the event account and what was paid, and confirms when nothing is missing (M9-06)', async () => {
    contractView = { contract: CONTRACT, missing: [] };
    const user = userEvent.setup();
    const row = await openFile(user);
    expect(await within(row).findByText(/9900000001/)).toBeInTheDocument();
    expect(within(row).getByText(/Paid$/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Confirm booking' }));
    await waitFor(() => expect(sent(`POST /event-bookings/${HOLD.id}/confirm`)).toHaveLength(1));
    expect(sent(`POST /event-bookings/${HOLD.id}/confirm`)[0]?.body).toMatchObject({
      override: false,
    });
  });

  it('with something missing, says what and asks a manager for an override (M9-06)', async () => {
    confirmReply = () =>
      json(202, {
        approvalRequestId: id(10),
        status: 'PENDING',
        expiresAt: '2026-11-12T09:00:00Z',
        approverRoles: ['General Manager'],
      });
    const user = userEvent.setup();
    const row = await openFile(user);
    expect(await within(row).findByText('No contract has been issued')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Confirm booking' })).not.toBeInTheDocument();
    const form = within(row).getByRole('form', { name: 'Ask to confirm anyway' });
    await user.type(within(form).getByLabelText('Why confirm without these?'), 'Regular client');
    await user.click(within(form).getByRole('button', { name: 'Ask to confirm anyway' }));
    expect(await within(row).findByText(/Sent to a manager/)).toBeInTheDocument();
    expect(sent(`POST /event-bookings/${HOLD.id}/confirm`)[0]?.body).toMatchObject({
      override: true,
      reason: 'Regular client',
    });
  });

  it('writes the brief for each department of a confirmed booking (M9-07)', async () => {
    listed = PAST;
    const user = userEvent.setup();
    const row = await openFile(user);
    const form = await within(row).findByRole('form', { name: 'Event brief' });
    await user.type(within(form).getByLabelText('Food and beverage'), 'Buffet at 13:00');
    await user.click(within(form).getByRole('button', { name: 'Save brief' }));
    await waitFor(() => expect(sent(`PUT /event-bookings/${HOLD.id}/brief`)).toHaveLength(1));
    expect(sent(`PUT /event-bookings/${HOLD.id}/brief`)[0]?.body).toEqual({
      sections: [{ departmentId: id(11), instructions: 'Buffet at 13:00' }],
    });
  });

  it('records the inspection with its damage and extras (M9-08)', async () => {
    listed = PAST;
    const user = userEvent.setup();
    const row = await openFile(user);
    const form = await within(row).findByRole('form', { name: 'Inspection' });
    await user.type(within(form).getByLabelText('What did you find?'), 'A cracked table');
    await user.type(within(form).getByLabelText('What was damaged (if anything)'), 'Table');
    await user.type(within(form).getByLabelText('Cost of the damage, before tax (₦)'), '20000');
    await user.click(within(form).getByRole('button', { name: /Save inspection/ }));
    await waitFor(() => expect(sent(`POST /event-bookings/${HOLD.id}/inspection`)).toHaveLength(1));
    expect(sent(`POST /event-bookings/${HOLD.id}/inspection`)[0]?.body).toMatchObject({
      notes: 'A cracked table',
      damageMinor: '2000000',
      damageDescription: 'Table',
    });
  });

  it('after inspection, says what is left of the deposit and blocks closing until settled', async () => {
    listed = PAST;
    closeOut = INSPECTED;
    const user = userEvent.setup();
    const row = await openFile(user);
    expect(await within(row).findByText(/Money is due back/)).toBeInTheDocument();
    expect(within(row).getByText(/The client is owed/)).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Open bill F00001' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Close event' })).toBeDisabled();
  });

  it('closes once nothing is left to settle (M9-08)', async () => {
    listed = PAST;
    closeOut = {
      ...INSPECTED,
      folio: { ...INSPECTED.folio, balanceMinor: '0' },
      blockers: [],
    };
    const user = userEvent.setup();
    const row = await openFile(user);
    await user.click(await within(row).findByRole('button', { name: 'Close event' }));
    await waitFor(() => expect(sent(`POST /event-bookings/${HOLD.id}/close`)).toHaveLength(1));
  });

  it('cancels a confirmed booking, saying what the client keeps and loses (T-121b)', async () => {
    listed = { ...HOLD, status: 'CONFIRMED', holdExpiresAt: null };
    cancellation = CANCELLABLE;
    const user = userEvent.setup();
    const row = await openFile(user);
    expect(
      await within(row).findByText(/120,000\.00 of the .{0,6}400,000\.00 deposit paid is kept/),
    ).toBeInTheDocument();
    const form = within(row).getByRole('form', { name: 'Cancel booking' });
    await user.type(within(form).getByLabelText('Reason for cancelling'), 'Postponed');
    await user.click(within(form).getByRole('button', { name: 'Cancel booking' }));
    await waitFor(() => expect(sent(`POST /event-bookings/${HOLD.id}/cancel`)).toHaveLength(1));
    expect(sent(`POST /event-bookings/${HOLD.id}/cancel`)[0]?.body).toEqual({
      reason: 'Postponed',
    });
  });

  it('within 24 hours of the event says it can no longer be cancelled', async () => {
    listed = { ...HOLD, status: 'CONFIRMED', holdExpiresAt: null };
    cancellation = { ...CANCELLABLE, allowed: false, reason: 'TOO_CLOSE' };
    const user = userEvent.setup();
    const row = await openFile(user);
    expect(
      await within(row).findByText(/can no longer be cancelled; it will be invoiced/),
    ).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Cancel booking' })).not.toBeInTheDocument();
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
