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

// S22 Leakage alerts (PRD M6-07–M6-09, M6 rule 3; T-090).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `88888888-0000-4000-8000-${String(n).padStart(12, '0')}`;

const rule = (code: string, label: string, extra: object = {}) => ({
  code,
  label,
  trigger: `When ${label.toLowerCase()} happens`,
  enabled: true,
  canDisable: true,
  notifyInstant: false,
  params: [],
  open: 0,
  reviewed: 0,
  recoveredMinor: '0',
  ...extra,
});

const RULES = {
  currency: 'NGN',
  rules: [
    rule('OCCUPIED_NO_FOLIO', 'Occupied without folio', {
      canDisable: false,
      open: 1,
      reviewed: 1,
      recoveredMinor: '2500000',
    }),
    rule('RATE_OVERRIDE', 'Rate override', { enabled: false }),
    rule('REVERSAL_PATTERN', 'Void/reversal pattern', {
      open: 1,
      params: [
        { key: 'maxCount', label: 'More than (reversals)', kind: 'count', value: 3, default: 3 },
        {
          key: 'maxAmountMinor',
          label: 'Or more than (amount)',
          kind: 'amount',
          value: '5000000',
          default: '5000000',
        },
      ],
    }),
    rule('SHIFT_VARIANCE', 'Cash variance', { canDisable: false }),
    rule('UNMATCHED_TRANSFER', 'Unmatched transfer'),
  ],
  totals: { open: 2, reviewed: 1, recoveredMinor: '2500000' },
};

const alert = (n: number, extra: object = {}) => ({
  id: id(n),
  ruleCode: 'OCCUPIED_NO_FOLIO',
  rule: 'OCCUPIED_NO_FOLIO',
  label: 'Occupied without folio',
  businessDate: '2026-11-10',
  severity: 'HIGH',
  entityType: 'room',
  entityId: id(50),
  subject: null,
  evidence: {
    roomNumber: '102',
    observed: 'OCCUPIED',
    frontOffice: 'VACANT',
    stayId: null,
    reportedById: id(51),
  },
  status: 'OPEN',
  raisedAt: '2026-11-10T09:00:00Z',
  outcomes: 0,
  recoveredMinor: '0',
  ...extra,
});

const reversal = alert(2, {
  ruleCode: 'REVERSAL_PATTERN',
  rule: 'REVERSAL_PATTERN',
  label: 'Reversal pattern',
  severity: 'NORMAL',
  subject: { id: id(52), name: 'Desk Ade' },
  evidence: { reversals: 4, totalMinor: '400000', lineIds: [id(60), id(61)] },
});

const FOLIO = {
  id: id(70),
  number: 'F-0007',
  kind: 'GUEST',
  status: 'OPEN',
  name: 'Ada Obi',
  currency: 'NGN',
  reservationId: null,
  confirmationNo: null,
  stay: null,
  company: null,
  windows: [
    {
      number: 1,
      payerType: 'GUEST',
      payerName: 'Ada Obi',
      balanceMinor: '2500000',
      lines: [
        {
          id: id(71),
          windowNumber: 1,
          businessDate: '2026-11-10',
          postedAt: '2026-11-10T10:00:00Z',
          kind: 'CHARGE',
          revenueCode: 'ROOM',
          revenueCodeName: 'Room',
          description: 'Day-use, room 102',
          quantity: 1,
          unitAmountMinor: '2500000',
          amountMinor: '2500000',
          parentLineId: null,
          reversesLineId: null,
          reversedByLineId: null,
          postedBy: 'Desk Ade',
          reason: null,
        },
      ],
      payments: [],
    },
  ],
  routingRules: [],
  revenueCodes: [],
  balanceMinor: '2500000',
  paymentMethods: ['CASH'],
  version: 1,
};

let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown; url: URL }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () =>
      json(
        200,
        makeMe({
          memberships: [membership(LAGOS, ['leakage.review', 'leakage.notify', 'folio.read'])],
        }),
      ),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /leakage/rules': () => json(200, RULES),
    'GET /leakage/alerts': (_b, url) =>
      json(200, {
        data:
          url.searchParams.get('rule') === 'REVERSAL_PATTERN' ? [reversal] : [alert(1), reversal],
        nextCursor: null,
      }),
    [`GET /leakage/alerts/${id(1)}`]: () => json(200, { ...alert(1), outcomeList: [] }),
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

describe('Leakage alerts (S22)', () => {
  it('shows the totals, alerts by rule, and the open alerts', async () => {
    renderAt('/leakage');
    expect(await screen.findByRole('heading', { name: 'Leakage alerts' })).toBeInTheDocument();
    const byRule = await screen.findByRole('table', { name: 'By rule' });
    const rows = within(byRule).getAllByRole('row');
    expect(rows).toHaveLength(6);
    expect(within(rows[1] as HTMLElement).getByText(/25,000\.00/)).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Off')).toBeInTheDocument();
    expect(screen.getAllByText(/25,000\.00/).length).toBeGreaterThanOrEqual(2); // and the total
    const list = await screen.findByRole('list', { name: 'Alerts' });
    await waitFor(() => expect(list.children).toHaveLength(2));
    expect(within(list).getByText('About Desk Ade', { exact: false })).toBeInTheDocument();
    expect(sent('GET /leakage/alerts')[0]?.url.searchParams.get('status')).toBe('OPEN');
  });

  it('filters by rule from the table', async () => {
    const user = userEvent.setup();
    renderAt('/leakage');
    const byRule = await screen.findByRole('table', { name: 'By rule' });
    await user.click(within(byRule).getByRole('button', { name: 'Void/reversal pattern' }));
    await waitFor(() => {
      const last = sent('GET /leakage/alerts').at(-1)?.url.searchParams;
      expect(last?.get('rule')).toBe('REVERSAL_PATTERN');
      expect(last?.get('status')).toBeNull();
    });
    expect(screen.getByLabelText('Rule')).toHaveValue('REVERSAL_PATTERN');
    const list = screen.getByRole('list', { name: 'Alerts' });
    await waitFor(() => expect(list.children).toHaveLength(1));
  });

  it('opens the evidence and records a recovered amount linked to a charge', async () => {
    let added: unknown = null;
    handlers[`POST /leakage/alerts/${id(1)}/outcomes`] = (body) => {
      added = body;
      return json(201, { alertId: id(1), outcomeId: id(99), status: 'REVIEWED' });
    };
    handlers['GET /folios'] = () =>
      json(200, {
        data: [
          {
            id: FOLIO.id,
            number: FOLIO.number,
            name: FOLIO.name,
            status: 'OPEN',
            kind: 'GUEST',
            roomNumber: '102',
            confirmationNo: null,
            balanceMinor: '2500000',
          },
        ],
      });
    handlers[`GET /folios/${FOLIO.id}`] = () => json(200, FOLIO);
    const user = userEvent.setup();
    renderAt('/leakage');
    const list = await screen.findByRole('list', { name: 'Alerts' });
    await waitFor(() => expect(list.children).toHaveLength(2));
    await user.click(within(list).getAllByRole('button')[0] as HTMLElement);

    const panel = await screen.findByRole('complementary', { name: 'Alert' });
    expect(await within(panel).findByText('Housekeeping saw')).toBeInTheDocument();
    expect(within(panel).getByText('102')).toBeInTheDocument();
    expect(within(panel).queryByText('reportedById')).not.toBeInTheDocument();
    expect(within(panel).getByText('No outcome yet.')).toBeInTheDocument();

    const form = within(panel).getByRole('form', { name: 'Add an outcome' });
    await user.selectOptions(within(form).getByLabelText('Outcome'), 'RECOVERED');
    const submit = within(form).getByRole('button', { name: 'Add outcome' });
    await user.type(within(form).getByLabelText('Amount recovered'), '25,000');
    await user.type(within(form).getByLabelText('Folio that recovered it'), 'F-0007');
    await user.click(within(form).getByRole('button', { name: 'Find' }));
    await user.selectOptions(
      await within(form).findByRole('combobox', { name: 'Folio that recovered it' }),
      FOLIO.id,
    );
    await user.selectOptions(
      await within(form).findByLabelText('Charge or payment'),
      `line:${id(71)}`,
    );
    await user.type(within(form).getByLabelText('Note'), 'Room 102 day-use billed after review');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() =>
      expect(added).toEqual({
        outcome: 'RECOVERED',
        note: 'Room 102 day-use billed after review',
        recoveredMinor: '2500000',
        linkedLineId: id(71),
        linkedPaymentId: null,
      }),
    );
    expect(await within(form).findByText('Outcome added.')).toBeInTheDocument();
    // The list and totals are fetched again.
    await waitFor(() => expect(sent('GET /leakage/rules').length).toBeGreaterThan(1));
  });

  it('records a plain outcome and shows the server’s refusal', async () => {
    handlers[`POST /leakage/alerts/${id(1)}/outcomes`] = () =>
      json(403, {
        error: { code: 'FORBIDDEN', message: 'Someone else reviews an alert about you' },
      });
    const user = userEvent.setup();
    renderAt('/leakage');
    const list = await screen.findByRole('list', { name: 'Alerts' });
    await waitFor(() => expect(list.children).toHaveLength(2));
    await user.click(within(list).getAllByRole('button')[0] as HTMLElement);
    const panel = await screen.findByRole('complementary', { name: 'Alert' });
    const form = await within(panel).findByRole('form', { name: 'Add an outcome' });
    await user.type(within(form).getByLabelText('Note'), 'Guest moved rooms');
    await user.click(within(form).getByRole('button', { name: 'Add outcome' }));
    expect(await within(form).findByText(/Someone else reviews/)).toBeInTheDocument();
    expect(sent(`POST /leakage/alerts/${id(1)}/outcomes`)[0]?.body).toEqual({
      outcome: 'EXPLAINED',
      note: 'Guest moved rooms',
    });
  });

  it('saves a rule’s thresholds and instant alerts', async () => {
    let saved: unknown = null;
    handlers['PATCH /leakage/rules'] = (body) => {
      saved = body;
      return json(200, RULES);
    };
    const user = userEvent.setup();
    renderAt('/leakage');
    await user.click(await screen.findByText('Rule settings'));
    const form = screen.getByRole('form', { name: 'Void/reversal pattern' });
    expect(within(form).getByLabelText('Or more than (amount)')).toHaveValue('50000');
    const count = within(form).getByLabelText('More than (reversals)');
    await user.clear(count);
    await user.type(count, '5');
    await user.click(within(form).getByLabelText('Tell me at once'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toEqual({
        rules: [
          {
            code: 'REVERSAL_PATTERN',
            enabled: true,
            notifyInstant: true,
            params: { maxCount: 5, maxAmountMinor: '5000000' },
          },
        ],
      }),
    );
    // A rule other controls rely on has no switch.
    const cash = screen.getByRole('form', { name: 'Cash variance' });
    expect(within(cash).queryByLabelText('On')).not.toBeInTheDocument();
    expect(within(cash).getByText(/Always on/)).toBeInTheDocument();
  });
});
