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

// S29 Messaging, templates (PRD M11-05; T-024).

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VARS = [
  { name: 'guest_name', label: 'Guest name', example: 'Ada Okafor' },
  { name: 'confirmation_no', label: 'Confirmation number', example: 'LAG-10234' },
];

const template = (extra: object) => ({
  code: 'BOOKING_CONFIRMED',
  label: 'Booking confirmation',
  audience: 'GUEST',
  channel: 'EMAIL',
  language: 'en',
  subject: 'Booking {{confirmation_no}}',
  body: 'Dear {{guest_name}}, see you soon.',
  editable: true,
  customised: false,
  providerTemplateName: null,
  category: null,
  variables: VARS,
  ...extra,
});

const TEMPLATES = {
  languages: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'French' },
  ],
  templates: [
    template({}),
    template({
      channel: 'WHATSAPP',
      subject: null,
      body: 'Hello {{guest_name}}, booking {{confirmation_no}} is confirmed.',
      editable: false,
      providerTemplateName: 'booking_confirmed',
      category: 'UTILITY',
    }),
    template({
      code: 'APPROVAL_OTP',
      label: 'Approval code',
      audience: 'STAFF',
      channel: 'WHATSAPP',
      subject: null,
      body: '{{code}} is your verification code.',
      editable: false,
      providerTemplateName: 'approval_code',
      category: 'AUTHENTICATION',
      variables: [{ name: 'code', label: 'One-time code', example: '482913' }],
    }),
  ],
};

const DELIVERY = {
  id: id(1),
  channel: 'WHATSAPP',
  templateCode: 'BOOKING_CONFIRMED',
  recipient: '+2348031234567',
  status: 'FAILED',
  attempts: 1,
  lastError: 'Meta 400 (131030): Recipient phone number not in allowed list',
  test: true,
  createdAt: '2026-11-11T09:00:00Z',
  sentAt: null,
};

let permissions: string[];
let handlers: Record<string, (body: unknown, url: URL) => Response>;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  permissions = ['template.manage', 'message.send'];
  handlers = {
    'GET /me': () => json(200, makeMe({ memberships: [membership(LAGOS, permissions)] })),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
    'GET /message-templates': () => json(200, TEMPLATES),
    'GET /message-deliveries': () => json(200, { data: [DELIVERY], nextCursor: null }),
    'POST /message-templates': (body) =>
      json(200, template({ ...(body as object), customised: true })),
    'POST /message-templates/test': () => json(201, { deliveryId: id(2), status: 'QUEUED' }),
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
}

describe('Messages (S29)', () => {
  it('lists templates by audience; WhatsApp wording is read-only, shown with sample values', async () => {
    renderAt('/messages');
    const nav = await screen.findByRole('navigation', { name: 'Templates' });
    expect(within(nav).getByRole('button', { name: 'Booking confirmation' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(nav).getByText('To staff')).toBeInTheDocument();
    const article = screen.getByRole('article', { name: 'Booking confirmation' });
    expect(within(article).getByLabelText('Subject')).toHaveValue('Booking {{confirmation_no}}');
    expect(within(article).getByText('Default wording')).toBeInTheDocument();
    expect(
      within(article).getByText('Hello Ada Okafor, booking LAG-10234 is confirmed.'),
    ).toBeInTheDocument();
    expect(within(article).getByText(/Approved by Meta as booking_confirmed/)).toBeInTheDocument();
  });

  it('saves the email wording in another language', async () => {
    const user = userEvent.setup();
    renderAt('/messages');
    const article = await screen.findByRole('article', { name: 'Booking confirmation' });
    await user.selectOptions(within(article).getByLabelText('Language'), 'fr');
    const subject = within(article).getByLabelText('Subject');
    await user.clear(subject);
    await user.type(subject, 'Réservation');
    await user.click(within(article).getByRole('button', { name: 'Save' }));
    expect(await within(article).findByText('Saved.')).toBeInTheDocument();
    expect(sent('POST /message-templates')[0]?.body).toEqual({
      code: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      language: 'fr',
      subject: 'Réservation',
      body: 'Dear {{guest_name}}, see you soon.',
    });
  });

  it('sends a WhatsApp test and lists recent messages with their status and error', async () => {
    const user = userEvent.setup();
    renderAt('/messages');
    const article = await screen.findByRole('article', { name: 'Booking confirmation' });
    const forms = within(article).getAllByRole('form', { name: 'Send a test' });
    const whatsappTest = forms[1];
    if (!whatsappTest) throw new Error('no WhatsApp test form');
    await user.type(within(whatsappTest).getByLabelText('Send to'), '+2348031234567');
    await user.click(within(whatsappTest).getByRole('button', { name: 'Send test' }));
    expect(await within(whatsappTest).findByText(/Test queued/)).toBeInTheDocument();
    expect(sent('POST /message-templates/test')[0]?.body).toEqual({
      code: 'BOOKING_CONFIRMED',
      channel: 'WHATSAPP',
      language: 'en',
      to: '+2348031234567',
    });
    const list = screen.getByRole('list', { name: 'Recent messages' });
    expect(within(list).getByText('Failed')).toBeInTheDocument();
    expect(within(list).getByText(/not in allowed list/)).toBeInTheDocument();
  });

  it('approval codes cannot be test-sent', async () => {
    const user = userEvent.setup();
    renderAt('/messages');
    await user.click(await screen.findByRole('button', { name: 'Approval code' }));
    const article = screen.getByRole('article', { name: 'Approval code' });
    expect(within(article).getByText(/only with a real approval request/)).toBeInTheDocument();
    expect(within(article).queryByRole('button', { name: 'Send test' })).not.toBeInTheDocument();
  });

  it('without template.manage it explains, and asks the API nothing', async () => {
    permissions = ['message.send'];
    renderAt('/messages');
    expect(await screen.findByText(/Manage message templates/)).toBeInTheDocument();
    await waitFor(() => expect(sent('GET /me')).toHaveLength(1));
    expect(sent('GET /message-templates')).toHaveLength(0);
    expect(sent('GET /message-deliveries')).toHaveLength(0);
  });
});
