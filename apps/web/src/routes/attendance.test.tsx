import { DEFAULT_ATTENDANCE_SETTINGS } from '@hotel/shared';
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

// S36 attendance (PRD M7-04; T-138).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BISI = { id: id(1), number: 1, name: 'Bisi Cook' };
const me = {
  staff: BISI,
  channel: 'PHONE',
  inSince: null,
  blocked: null,
  needsPhoto: false,
  locationCheck: false,
  networkCheck: true,
  consentGiven: false,
  privacyNotice: DEFAULT_ATTENDANCE_SETTINGS.privacyNotice,
  recent: [],
};
const event = {
  id: id(20),
  staff: BISI,
  kind: 'IN',
  at: '2026-11-18T07:00:00Z',
  channel: 'TABLET',
  deviceLabel: 'Front desk tablet',
  ip: null,
  located: false,
  photoFileId: id(30),
  note: null,
  recordedBy: { id: BISI.id, name: BISI.name },
};

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

function stub(permissions: string[]) {
  handlers['GET /me'] = () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] }));
}

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
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
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Attendance (S36)', () => {
  it('explains a phone refused outside the hotel network', async () => {
    stub(['attendance.clock']);
    handlers['GET /attendance/me'] = () => json(200, me);
    handlers['POST /attendance/clock'] = () =>
      json(403, {
        error: {
          code: 'FORBIDDEN',
          message:
            "You can clock in on your phone only on the hotel's network. Connect to it, or use the shared tablet.",
          requestId: 'req_1',
          details: { reason: 'OUTSIDE_NETWORK' },
        },
      });
    const user = userEvent.setup();
    renderAt('/attendance');
    expect(
      await screen.findByText("Your phone must be on the hotel's network."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clock in' }));
    expect(await screen.findByText(/only on the hotel's network/)).toBeInTheDocument();
    expect(sent('POST /attendance/clock')[0]?.body).toEqual({
      kind: 'IN',
      photoFileId: null,
      location: null,
    });
    // Nothing for managers without their permissions.
    expect(screen.queryByRole('form', { name: 'Attendance settings' })).not.toBeInTheDocument();
  }, 15_000);

  it('asks for consent after the privacy notice before the location check', async () => {
    stub(['attendance.clock']);
    handlers['GET /attendance/me'] = () =>
      json(200, { ...me, networkCheck: false, locationCheck: true });
    handlers['POST /attendance/consent'] = () =>
      json(200, { ...me, networkCheck: false, locationCheck: true, consentGiven: true });
    const user = userEvent.setup();
    renderAt('/attendance');
    expect(await screen.findByText(/we check your location against the hotel/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I agree to the location check' }));
    await waitFor(() => expect(sent('POST /attendance/consent')).toHaveLength(1));
    expect(sent('POST /attendance/consent')[0]?.body).toEqual({ consent: true });
  }, 15_000);

  it('takes a photo on the shared tablet before clocking', async () => {
    stub(['attendance.clock']);
    handlers['GET /attendance/me'] = () =>
      json(200, { ...me, channel: 'TABLET', needsPhoto: true, networkCheck: false });
    handlers['POST /files/upload-url'] = () =>
      json(201, {
        fileId: id(30),
        method: 'PUT',
        url: 'https://storage.test/incoming/photo',
        headers: {},
        expiresAt: '2026-11-18T07:15:00Z',
      });
    handlers['PUT /incoming/photo'] = () => new Response(null, { status: 200 });
    handlers['POST /attendance/clock'] = () => json(201, event);
    const user = userEvent.setup();
    renderAt('/attendance');
    const clockIn = await screen.findByRole('button', { name: 'Clock in' });
    expect(clockIn).toBeDisabled();
    await user.upload(
      screen.getByLabelText('Photo for this clock'),
      new File(['x'], 'me.jpg', { type: 'image/jpeg' }),
    );
    await user.click(clockIn);
    await waitFor(() => expect(sent('POST /attendance/clock')).toHaveLength(1));
    expect(sent('POST /attendance/clock')[0]?.body).toEqual({
      kind: 'IN',
      photoFileId: id(30),
      location: null,
    });
  }, 15_000);

  it('lets a manager turn the network check on with this connection', async () => {
    stub(['staff.manage']);
    handlers['GET /attendance/settings'] = () =>
      json(200, { settings: DEFAULT_ATTENDANCE_SETTINGS, yourAddress: '102.89.4.10' });
    handlers['PUT /attendance/settings'] = (body) =>
      json(200, { settings: body, yourAddress: '102.89.4.10' });
    const user = userEvent.setup();
    renderAt('/attendance');
    const form = await screen.findByRole('form', { name: 'Attendance settings' });
    await user.click(within(form).getByLabelText('Phones must be on the hotel network'));
    await user.click(
      within(form).getByRole('button', { name: 'Add this connection (102.89.4.10)' }),
    );
    await user.click(within(form).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(sent('PUT /attendance/settings')).toHaveLength(1));
    expect(sent('PUT /attendance/settings')[0]?.body).toMatchObject({
      phoneAllowed: true,
      network: { enabled: true, addresses: ['102.89.4.10'] },
    });
  }, 15_000);
});

describe('Missed clocks (T-138a)', () => {
  it("lets a manager add a forgotten clock-out at the hotel's local time", async () => {
    stub(['timesheet.approve']);
    handlers['GET /attendance'] = () =>
      json(200, { date: '2026-11-10', events: [], inNow: [], staff: [BISI] });
    handlers['POST /attendance/corrections'] = () =>
      json(201, {
        ...event,
        kind: 'OUT',
        channel: 'MANUAL',
        photoFileId: null,
        deviceLabel: null,
        note: 'Forgot',
        recordedBy: { id: id(90), name: 'Grace Manager' },
      });
    const user = userEvent.setup();
    renderAt('/attendance');
    await user.click(await screen.findByRole('button', { name: 'Add a missed clock' }));
    const form = screen.getByRole('form', { name: 'Missed clock' });
    await user.selectOptions(within(form).getByLabelText('Staff member'), BISI.id);
    await user.type(within(form).getByLabelText('Time'), '16:00');
    await user.type(
      within(form).getByLabelText('Why it was missed (kept with the clock)'),
      'Forgot',
    );
    await user.click(within(form).getByRole('button', { name: 'Add the clock' }));
    await waitFor(() => expect(sent('POST /attendance/corrections')).toHaveLength(1));
    // Lagos is UTC+1.
    expect(sent('POST /attendance/corrections')[0]?.body).toEqual({
      staffId: BISI.id,
      kind: 'OUT',
      at: '2026-11-10T15:00:00Z',
      note: 'Forgot',
    });
  }, 15_000);
});
