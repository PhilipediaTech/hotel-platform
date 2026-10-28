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

// Approvals inbox (S21 in the nav; tab 5 "Approvals inbox") and S26 approval policies.

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const ID = '33333333-0000-4000-8000-000000000001';
const OWNER_ROLE = '44444444-0000-4000-8000-000000000001';
const GM_ROLE = '44444444-0000-4000-8000-000000000002';
const request = (extra: object = {}) => ({
  id: ID,
  action: 'folio.discount',
  status: 'PENDING',
  payload: { folioId: 'F-1', bps: 2000 },
  amountMinor: null,
  reason: 'Loyal corporate guest',
  requestedBy: { id: '55555555-0000-4000-8000-000000000001', name: 'Chidi Eze' },
  createdAt: '2026-10-28T09:00:00Z',
  expiresAt: '2026-10-28T09:30:00Z',
  decidedBy: null,
  decidedAt: null,
  decisionChannel: null,
  decisionNote: null,
  resultRef: null,
  canDecide: true,
  ...extra,
});
const policy = (action: string, extra: object = {}) => ({
  action,
  active: true,
  thresholdMinor: null,
  thresholdBps: null,
  approverRoleIds: [OWNER_ROLE, GM_ROLE],
  expiryMinutes: 30,
  ...extra,
});

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
          memberships: [
            membership(LAGOS, ['approval.decide', 'approval.policy.manage', 'role.assign']),
          ],
        }),
      ),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /approvals': (_b, url) =>
      json(200, {
        data:
          url.searchParams.get('status') === 'PENDING'
            ? [request()]
            : [
                request(),
                request({
                  id: '33333333-0000-4000-8000-000000000002',
                  action: 'payment.refund',
                  amountMinor: '500000',
                  status: 'EXECUTED',
                  canDecide: false,
                  decidedBy: { id: '6', name: 'Ada Obi' },
                  decidedAt: '2026-10-28T09:10:00Z',
                  decisionChannel: 'WHATSAPP_OTP',
                }),
              ],
        nextCursor: null,
      }),
    'GET /approval-policies': () =>
      json(200, {
        data: [
          policy('folio.discount', { thresholdBps: 1500 }),
          policy('payment.refund', { expiryMinutes: 2880 }),
          policy('room.comp', { active: false, approverRoleIds: [] }),
        ],
      }),
    'GET /roles': () =>
      json(200, {
        data: [
          {
            id: OWNER_ROLE,
            name: 'Owner',
            isSystem: true,
            requiresMfa: true,
            permissions: ['approval.decide'],
            limits: {},
            memberCount: 1,
          },
          {
            id: GM_ROLE,
            name: 'General Manager',
            isSystem: true,
            requiresMfa: true,
            permissions: ['approval.decide'],
            limits: {},
            memberCount: 1,
          },
          {
            id: '44444444-0000-4000-8000-000000000003',
            name: 'Front Desk / Cashier',
            isSystem: true,
            requiresMfa: false,
            permissions: ['folio.read'],
            limits: {},
            memberCount: 2,
          },
        ],
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
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

describe('Approvals inbox', () => {
  it('lists pending requests with their context and counts them on the bell', async () => {
    renderAt('/approvals');
    const list = await screen.findByRole('list', { name: 'Requests' });
    const row = within(list).getByRole('listitem');
    expect(row).toHaveTextContent('Discount above the limit');
    expect(row).toHaveTextContent('Requested by Chidi Eze');
    expect(row).toHaveTextContent('“Loyal corporate guest”');
    expect(row).toHaveTextContent(/bps\s*2000/);
    // 09:30 UTC = 10:30 in Lagos.
    expect(row).toHaveTextContent(/Expires .*10:30/);
    expect(await screen.findByRole('link', { name: 'Approvals, 1 pending' })).toBeInTheDocument();
  });

  it('approves with an optional note and code', async () => {
    handlers[`POST /approvals/${ID}/approve`] = () =>
      json(200, { status: 'EXECUTED', resultRef: 'fl_1' });
    renderAt('/approvals');
    await userEvent.type(await screen.findByLabelText('Note (needed to reject)'), 'OK');
    await userEvent.type(screen.getByLabelText('WhatsApp code'), '48a2913');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(sent(`POST /approvals/${ID}/approve`)[0]?.body).toEqual({ note: 'OK', otp: '482913' });
    });
  });

  it('rejects only with a note, and shows server refusals', async () => {
    handlers[`POST /approvals/${ID}/reject`] = () =>
      json(422, {
        error: {
          code: 'APPROVAL_EXPIRED',
          message: 'This request has expired.',
          requestId: 'req_1',
        },
      });
    renderAt('/approvals');
    const reject = await screen.findByRole('button', { name: 'Reject' });
    expect(reject).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Note (needed to reject)'), 'Too generous');
    await userEvent.click(reject);
    expect(await screen.findByRole('alert')).toHaveTextContent('This request has expired.');
    expect(sent(`POST /approvals/${ID}/reject`)[0]?.body).toEqual({ note: 'Too generous' });
  });

  it('shows decided requests with who decided and how', async () => {
    renderAt('/approvals');
    await userEvent.click(await screen.findByRole('tab', { name: 'Decided' }));
    const list = await screen.findByRole('list', { name: 'Requests' });
    const row = within(list).getByRole('listitem');
    expect(row).toHaveTextContent(/Refund · ₦\s?5,000\.00/);
    expect(row).toHaveTextContent('Approved and done');
    expect(row).toHaveTextContent('Decided by Ada Obi');
    expect(row).toHaveTextContent('by WhatsApp code');
    expect(within(row).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});

describe('Approval policies (S26, M1-12)', () => {
  it('edits thresholds in everyday units, approvers and expiry, and saves all', async () => {
    handlers['PUT /approval-policies'] = (body) =>
      json(200, { data: (body as { policies: unknown[] }).policies });
    renderAt('/settings/access');
    await userEvent.click(await screen.findByRole('tab', { name: 'Approval policies' }));
    const discount = await screen.findByRole('listitem', { name: 'Discount above the limit' });
    const threshold = within(discount).getByRole('textbox', { name: /Above/ });
    expect(threshold).toHaveValue('15');
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '20');
    await userEvent.click(within(discount).getByRole('checkbox', { name: 'General Manager' }));
    const comp = screen.getByRole('listitem', { name: 'Complimentary room' });
    await userEvent.click(within(comp).getByRole('checkbox', { name: 'Complimentary room' }));
    await userEvent.click(within(comp).getByRole('checkbox', { name: 'Owner' }));
    // Front desk holds no approval.decide, so it is never offered as an approver.
    expect(within(discount).queryByRole('checkbox', { name: 'Front Desk / Cashier' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save policies' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const policies = (sent('PUT /approval-policies')[0]?.body as { policies: unknown[] }).policies;
    expect(policies).toEqual([
      policy('folio.discount', { thresholdBps: 2000, approverRoleIds: [OWNER_ROLE] }),
      policy('payment.refund', { expiryMinutes: 2880 }),
      policy('room.comp', { active: true, approverRoleIds: [OWNER_ROLE] }),
    ]);
  });
});
