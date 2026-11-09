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

// Questions about the figures on the owner home (PRD M14-12; T-116).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let permissions: string[];
let answer: () => Response;
const asked: unknown[] = [];

beforeEach(() => {
  asked.length = 0;
  permissions = ['owner.read', 'report.dashboard'];
  answer = () =>
    json(200, {
      answer: 'Occupancy was 70%.',
      sources: [{ report: 'Flash report', detail: '2026-11-10' }],
      grounded: true,
    });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const key = `${init.method} ${url.pathname.replace('/api/v1', '')}`;
      if (key === 'GET /me') {
        return Promise.resolve(
          json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
        );
      }
      if (key === 'GET /auth/device') {
        return Promise.resolve(json(200, { pinSwitchAvailable: false, deviceLabel: null }));
      }
      if (key === 'GET /owner/home') return Promise.resolve(json(200, { properties: [] }));
      if (key === 'POST /reports/ask') {
        asked.push(JSON.parse(init.body as string));
        return Promise.resolve(answer());
      }
      return Promise.reject(new Error(`Unexpected request ${key}`));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setApiPropertyId(null);
});

function renderOwner() {
  const router = createMemoryRouter(routes, { initialEntries: ['/owner'] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Ask about your figures (M14-12)', { timeout: 20_000 }, () => {
  it('shows the answer and the report it came from', async () => {
    const user = userEvent.setup();
    renderOwner();
    await user.type(
      await screen.findByLabelText('Your question', {}, { timeout: 10_000 }),
      'How was last night?',
    );
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Occupancy was 70%.')).toBeInTheDocument();
    expect(screen.getByText('From: Flash report (2026-11-10)')).toBeInTheDocument();
    await waitFor(() => expect(asked).toEqual([{ question: 'How was last night?' }]));
  });

  it('warns when no report was used', async () => {
    const user = userEvent.setup();
    answer = () => json(200, { answer: 'I can’t say.', sources: [], grounded: false });
    renderOwner();
    await user.type(
      await screen.findByLabelText('Your question', {}, { timeout: 10_000 }),
      'What is the weather?',
    );
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText(/No report was used/)).toBeInTheDocument();
  });

  it('is hidden without the permission', async () => {
    permissions = ['owner.read'];
    renderOwner();
    await screen.findByRole('heading', { level: 1 }, { timeout: 10_000 });
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument();
  });
});
