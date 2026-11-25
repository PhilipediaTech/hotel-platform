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

// Rates across properties (PRD M2-13; T-162).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

const result = (dryRun: boolean) => ({
  dryRun,
  properties: [
    {
      propertyId: LAGOS,
      name: 'Lagos',
      currency: 'NGN',
      roomTypeCodes: ['STD'],
      changedDays: 7,
    },
  ],
  changedDays: 7,
});

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['rate.group.manage'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'POST /group/rate-changes': (body) => json(200, result((body as { dryRun: boolean }).dryRun)),
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

async function fill(user: ReturnType<typeof userEvent.setup>) {
  const form = await screen.findByRole('form', { name: 'Rate change' });
  await user.type(within(form).getByLabelText('From'), '2026-12-01');
  await user.type(within(form).getByLabelText('To (included)'), '2026-12-07');
  await user.type(within(form).getByLabelText('Percentage (e.g. 10 or -5)'), '10');
  return form;
}

describe('Rates across properties', () => {
  it('previews, then applies exactly what was previewed', async () => {
    const user = userEvent.setup();
    renderAt('/group-rates');
    const form = await fill(user);
    const apply = within(form).getByRole('button', { name: 'Apply to 1 properties' });
    expect(apply).toBeDisabled();
    await user.click(within(form).getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Would change 7 room-type days:')).toBeInTheDocument();
    expect(sent('POST /group/rate-changes')[0]?.body).toEqual({
      propertyIds: [LAGOS],
      ratePlanCode: 'BAR',
      from: '2026-12-01',
      to: '2026-12-07',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      price: { mode: 'PERCENT', bps: 1000 },
      dryRun: true,
    });
    // An edit after the preview needs a new one.
    await user.type(within(form).getByLabelText('Percentage (e.g. 10 or -5)'), '0');
    expect(apply).toBeDisabled();
    await user.clear(within(form).getByLabelText('Percentage (e.g. 10 or -5)'));
    await user.type(within(form).getByLabelText('Percentage (e.g. 10 or -5)'), '10');
    await user.click(within(form).getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(apply).toBeEnabled());
    await user.click(apply);
    expect(await screen.findByText('Changed 7 room-type days:')).toBeInTheDocument();
    expect(sent('POST /group/rate-changes').at(-1)?.body).toMatchObject({ dryRun: false });
  });

  it('lists each property’s problem when the change is refused', async () => {
    const user = userEvent.setup();
    handlers['POST /group/rate-changes'] = () =>
      json(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          requestId: 'r',
          details: {
            issues: [
              {
                path: 'body.propertyIds.0',
                code: 'custom',
                message: 'Lagos has no active rate plan CORP',
              },
            ],
          },
        },
      });
    renderAt('/group-rates');
    const form = await fill(user);
    await user.click(within(form).getByRole('button', { name: 'Preview' }));
    expect(await within(form).findByText('Lagos has no active rate plan CORP')).toBeInTheDocument();
  });
});
