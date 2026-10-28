import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/query-client.ts';
import { routes } from '../../app/routes.tsx';
import { setApiPropertyId } from '../../lib/api.ts';
import { LAGOS, makeMe, membership } from '../../test/me-fixture.ts';
import { ImportsPage } from './imports.tsx';

// S03 Imports (PRD M1-03; T-034).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const FILE = '44444444-0000-4000-8000-000000000001';
const JOB = '44444444-0000-4000-8000-000000000002';

const job = (status: string, extra: object = {}) => ({
  id: JOB,
  kind: 'ROOMS',
  status,
  fileId: FILE,
  createdAt: '2026-11-10T09:00:00Z',
  createdBy: { id: '1', name: 'Ada Obi' },
  report: {
    total: 3,
    errorCount: 0,
    errors: [],
    summary: { roomTypesNew: 1, roomTypesUpdated: 0, roomsNew: 3, roomsUpdated: 0 },
    preview: [
      { row: 2, roomNumber: '101', roomTypeCode: 'STD', features: [] },
      { row: 3, roomNumber: '102', roomTypeCode: 'STD', features: ['Balcony', 'Sea view'] },
    ],
    applied: null,
    ...extra,
  },
});

let handlers: Record<string, (body: unknown) => Response>;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, ['import.run'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'POST /files/upload-url': () =>
      json(201, {
        fileId: FILE,
        method: 'PUT',
        url: 'http://storage.test/upload',
        headers: { 'Content-Type': 'text/csv' },
        expiresAt: '2026-11-10T09:15:00Z',
      }),
    'PUT /upload': () => new Response(null, { status: 200 }),
    'POST /imports': () => json(201, job('VALIDATED')),
    [`POST /imports/${JOB}/apply`]: () =>
      json(200, job('APPLIED', { applied: { roomsWritten: 3 } })),
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

const csv = (text = 'room_number,room_type_code\n101,STD\n') =>
  new File([text], 'rooms.csv', { type: 'text/csv' });

function renderAt(path: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

describe('Imports', () => {
  it('downloads the template of the chosen kind', async () => {
    const user = userEvent.setup();
    const created: Blob[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (b: Blob) => {
          created.push(b);
          return 'blob:template';
        },
        revokeObjectURL: () => undefined,
      }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderAt('/settings/imports');
    await user.click(await screen.findByRole('radio', { name: 'Rates' }));
    expect(screen.getByText('rate_plan_code *')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Download template' }));
    expect(click).toHaveBeenCalledOnce();
    expect((await created[0]?.text())?.split('\r\n')[0]).toBe(
      'rate_plan_code,room_type_code,from,to,price,min_stay,max_stay,closed_to_arrival,closed_to_departure,stop_sell',
    );
    click.mockRestore();
  });

  it('uploads, shows the preview and imports only on confirm', async () => {
    const user = userEvent.setup();
    renderAt('/settings/imports');
    await user.upload(await screen.findByLabelText('Choose file'), csv());
    const report = await screen.findByRole('region', { name: 'Rooms and room types: 3 rows' });
    expect(within(report).getByText(/No problems found\. Nothing has changed yet\./)).toBeVisible();
    expect(report).toHaveTextContent('1 new room type · 3 new rooms');
    expect(within(report).getByRole('table', { name: 'Preview' })).toHaveTextContent(
      'Balcony, Sea view',
    );
    expect(sent('POST /imports')[0]?.body).toEqual({ kind: 'ROOMS', fileId: FILE });
    expect(sent(`POST /imports/${JOB}/apply`)).toHaveLength(0);

    await user.click(within(report).getByRole('button', { name: 'Import 3 rows' }));
    expect(await within(report).findByText(/Imported\. 3 rooms saved/)).toBeVisible();
    expect(sent(`POST /imports/${JOB}/apply`)).toHaveLength(1);
  });

  it('lists every problem and offers no import', async () => {
    handlers['POST /imports'] = () =>
      json(
        201,
        job('FAILED', {
          errorCount: 2,
          errors: [
            { row: 11, column: 'base_occupancy', message: 'Use a whole number' },
            { row: 51, column: 'room_number', message: 'Required' },
          ],
        }),
      );
    const user = userEvent.setup();
    renderAt('/settings/imports');
    await user.upload(await screen.findByLabelText('Choose file'), csv());
    const problems = await screen.findByRole('table', { name: 'Problems' });
    expect(
      within(problems)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.textContent),
    ).toEqual(['11base_occupancyUse a whole number', '51room_numberRequired']);
    expect(screen.getByText(/2 problems found/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Import/ })).toBeNull();
  });

  it('waits while the uploaded file is still being scanned', async () => {
    let tries = 0;
    handlers['POST /imports'] = () =>
      ++tries < 3
        ? json(409, {
            error: {
              code: 'FILE_NOT_READY',
              message: 'Still checking',
              details: { scan: 'PENDING' },
              requestId: 'r',
            },
          })
        : json(201, job('VALIDATED'));
    setApiPropertyId(LAGOS);
    const router = createMemoryRouter([
      { path: '/', element: <ImportsPage wait={() => Promise.resolve()} /> },
    ]);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('Choose file'), csv());
    await waitFor(() => expect(router.state.location.search).toBe(`?job=${JOB}`));
    expect(tries).toBe(3);
  });
});
