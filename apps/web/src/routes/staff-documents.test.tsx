import { DEFAULT_STAFF_DOCUMENT_RETENTION } from '@hotel/shared';
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

// S36 staff documents (PRD M7-09; T-140).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bisi = {
  id: id(1),
  number: 1,
  name: 'Bisi Cook',
  jobTitle: 'Cook',
  department: null,
  manager: null,
  user: null,
  employmentType: 'MONTHLY_SALARY',
  startDate: '2026-01-05',
  endDate: '2026-11-01',
  status: 'LEFT',
  certsDue: 0,
  hasEmergencyContact: false,
};
const detail = {
  ...bisi,
  phone: null,
  email: null,
  payRateMinor: null,
  currency: 'NGN',
  certifications: [],
  createdAt: '2026-11-10T09:00:00Z',
};
const contract = {
  id: id(5),
  type: 'CONTRACT',
  title: 'Employment contract',
  notes: null,
  contentType: 'application/pdf',
  sizeBytes: 120_000,
  scan: 'CLEAN',
  uploadedBy: { id: id(90), name: 'Grace Manager' },
  createdAt: '2026-11-10T09:00:00Z',
  keptUntil: '2032-11-01',
};

const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);
let handlers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['staff.manage', 'staff.docs'])] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /staff': () =>
      json(200, { data: [bisi], departments: [], people: [], today: '2026-11-10' }),
    [`GET /staff/${id(1)}`]: () => json(200, detail),
    [`GET /staff/${id(1)}/documents`]: () =>
      json(200, { data: [contract], retention: DEFAULT_STAFF_DOCUMENT_RETENTION }),
    'GET /staff-documents/settings': () =>
      json(200, { retention: DEFAULT_STAFF_DOCUMENT_RETENTION }),
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

describe('Staff documents (S36)', () => {
  it('lists documents with their deletion date, opens one, and files a new one', async () => {
    handlers[`GET /staff/${id(1)}/documents/${id(5)}/download-url`] = () =>
      json(200, {
        url: 'https://storage.test/doc',
        contentType: 'application/pdf',
        expiresAt: '2026-11-10T09:05:00Z',
      });
    handlers['POST /files/upload-url'] = () =>
      json(201, {
        fileId: id(6),
        method: 'PUT',
        url: 'https://storage.test/incoming/doc',
        headers: {},
        expiresAt: '2026-11-10T09:15:00Z',
      });
    handlers['PUT /incoming/doc'] = () => new Response(null, { status: 200 });
    handlers[`POST /staff/${id(1)}/documents`] = () =>
      json(201, { ...contract, id: id(7), type: 'ID', title: 'National ID', scan: 'PENDING' });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const user = userEvent.setup();
    renderAt('/staff?status=LEFT');
    await user.click(await screen.findByRole('button', { name: 'ST-1 · Bisi Cook' }));
    const docs = await screen.findByRole('region', { name: 'Documents' });
    expect(await within(docs).findByText('Employment contract')).toBeInTheDocument();
    expect(within(docs).getByText(/deleted after/)).toBeInTheDocument();
    await user.click(within(docs).getByRole('button', { name: 'Open' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://storage.test/doc', '_blank', 'noopener'),
    );

    await user.click(within(docs).getByRole('button', { name: 'Add a document' }));
    const form = screen.getByRole('form', { name: 'Document' });
    await user.selectOptions(within(form).getByLabelText('Type'), 'ID');
    await user.type(within(form).getByLabelText('Title'), 'National ID');
    await user.upload(
      within(form).getByLabelText('File (PDF or photo)'),
      new File(['%PDF'], 'id.pdf', { type: 'application/pdf' }),
    );
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(`POST /staff/${id(1)}/documents`)).toHaveLength(1));
    expect(sent(`POST /staff/${id(1)}/documents`)[0]?.body).toEqual({
      type: 'ID',
      title: 'National ID',
      fileId: id(6),
    });
    // The retention settings sit on the page.
    expect(screen.getByRole('form', { name: 'How long documents are kept' })).toBeInTheDocument();
  }, 20_000);

  it('shows no documents without staff.docs', async () => {
    handlers['GET /me'] = () =>
      json(200, makeMe({ memberships: [membership(LAGOS, ['staff.manage'])] }));
    const user = userEvent.setup();
    renderAt('/staff?status=LEFT');
    await user.click(await screen.findByRole('button', { name: 'ST-1 · Bisi Cook' }));
    expect(await screen.findByRole('region', { name: 'Certifications' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Documents' })).not.toBeInTheDocument();
    expect(sent(`GET /staff/${id(1)}/documents`)).toHaveLength(0);
  }, 15_000);
});
