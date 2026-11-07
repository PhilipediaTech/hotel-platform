import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../app/query-client.ts';
import { routes } from '../app/routes.tsx';
import { setApiPropertyId } from '../lib/api.ts';
import { LAGOS, makeMe, membership } from '../test/me-fixture.ts';

// My phone (T-091b).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let phone: string | null;
let handlers: Record<string, (body: unknown) => Response>;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key).map((c) => c.body);

beforeEach(() => {
  calls.length = 0;
  phone = null;
  handlers = {
    'GET /me': () => {
      const me = makeMe({ memberships: [membership(LAGOS, ['owner.read'])] });
      return json(200, { ...me, user: { ...me.user, phone } });
    },
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'POST /me/phone': () =>
      json(201, { challenge: 'claim.signature-0123456789', expiresAt: '2026-11-12T09:10:00Z' }),
    'POST /me/phone/confirm': () => {
      phone = '+2348031112222';
      return json(200, { phone });
    },
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

describe('My phone (T-091b)', () => {
  it('sends a code to the new number, then the code saves it', async () => {
    const user = userEvent.setup();
    renderAt('/account/phone');
    expect(await screen.findByText('No number yet.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/New number/), '+2348031112222');
    await user.type(screen.getByLabelText('Password'), 'secret-password');
    await user.click(screen.getByRole('button', { name: 'Send code by WhatsApp' }));
    expect(await screen.findByText(/We sent a 6-digit code by WhatsApp/)).toBeInTheDocument();
    expect(sent('POST /me/phone')).toEqual([
      { phone: '+2348031112222', password: 'secret-password' },
    ]);
    await user.type(screen.getByLabelText('Code from WhatsApp'), '482913');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('Saved. Your number is now +2348031112222.'),
    ).toBeInTheDocument();
    expect(sent('POST /me/phone/confirm')).toEqual([
      { challenge: 'claim.signature-0123456789', code: '482913' },
    ]);
  });

  it('shows the API’s message beside the field it is about', async () => {
    const user = userEvent.setup();
    handlers['POST /me/phone'] = () =>
      json(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'This number belongs to another account.',
          details: {
            issues: [
              {
                path: 'body.phone',
                code: 'custom',
                message: 'This number belongs to another account.',
              },
            ],
          },
          requestId: 'req_1',
        },
      });
    renderAt('/account/phone');
    await user.type(await screen.findByLabelText(/New number/), '+2348031112222');
    await user.type(screen.getByLabelText('Password'), 'secret-password');
    await user.click(screen.getByRole('button', { name: 'Send code by WhatsApp' }));
    expect(await screen.findByText('This number belongs to another account.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Code from WhatsApp')).not.toBeInTheDocument();
  });
});
