import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/query-client.ts';
import { routes } from '../../app/routes.tsx';
import { setApiPropertyId } from '../../lib/api.ts';
import {
  ABUJA,
  ABUJA_PROPERTY,
  LAGOS,
  LAGOS_PROPERTY,
  makeMe,
  membership,
} from '../../test/me-fixture.ts';

// The real router, session gate and screens; only the network is fake.

type Handler = (body: unknown, init: RequestInit) => Response | Promise<Response>;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const apiError = (status: number, code: string, message: string, details?: object) =>
  json(status, {
    error: { code, message, requestId: 'req_test', ...(details ? { details } : {}) },
  });

let handlers: Record<string, Handler>;
const calls: { key: string; body: unknown; headers: Headers }[] = [];

beforeEach(() => {
  calls.length = 0;
  handlers = { 'GET /me': () => apiError(401, 'UNAUTHENTICATED', 'Sign in to continue.') };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const key = `${init.method} ${new URL(url, 'http://app.test').pathname.replace('/api/v1', '')}`;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ key, body, headers: new Headers(init.headers) });
      const handler = handlers[key];
      if (!handler) throw new Error(`Unexpected request ${key}`);
      return handler(body, init);
    }),
  );
  window.localStorage.clear();
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

const sent = (key: string) => calls.filter((c) => c.key === key);

describe('session gate', () => {
  it('sends a signed-out visitor to sign in, remembering where they were going', async () => {
    const router = renderAt('/front-desk?tab=arrivals');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(router.state.location.search).toBe(
      `?next=${encodeURIComponent('/front-desk?tab=arrivals')}`,
    );
  });

  it('shows the shell for a signed-in user with their name and property', async () => {
    handlers['GET /me'] = () => json(200, makeMe());
    renderAt('/front-desk');
    expect(await screen.findByRole('heading', { name: 'Front desk' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Property' })).toHaveTextContent('Lagos Hotel');
    expect(screen.queryByText(/Preview data/)).not.toBeInTheDocument();
  });

  it('offers a retry when the server cannot be reached', async () => {
    let attempts = 0;
    handlers['GET /me'] = () => {
      attempts += 1;
      return attempts === 1 ? apiError(400, 'VALIDATION_ERROR', 'Odd.') : json(200, makeMe());
    };
    renderAt('/front-desk');
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Front desk' })).toBeInTheDocument();
  });
});

describe('sign in (S01)', () => {
  it('checks the form before calling the API', async () => {
    renderAt('/sign-in');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Use at least 3 characters')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(sent('POST /auth/sign-in')).toHaveLength(0);
  });

  it('signs in and goes where the user was heading', async () => {
    handlers['POST /auth/sign-in'] = () => json(200, makeMe());
    const router = renderAt('/sign-in?next=%2Ffolios');
    await userEvent.type(await screen.findByLabelText('Email or phone'), 'ADA@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByLabelText(/shared device/));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Folios' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/folios');
    expect(sent('POST /auth/sign-in')[0]?.body).toEqual({
      login: 'ADA@example.test',
      password: 'correct horse battery',
      sharedDevice: true,
    });
    // The answer to sign-in already is "me": no extra request.
    expect(sent('GET /me')).toHaveLength(0);
  });

  it('shows the server’s message for a wrong password', async () => {
    handlers['POST /auth/sign-in'] = () =>
      apiError(401, 'UNAUTHENTICATED', 'Email, phone or password is incorrect.');
    renderAt('/sign-in');
    await userEvent.type(await screen.findByLabelText('Email or phone'), 'ada@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Email, phone or password is incorrect.',
    );
  });

  it('offers to resend the link when the email is not confirmed', async () => {
    handlers['POST /auth/sign-in'] = () =>
      apiError(403, 'FORBIDDEN', 'Confirm your email address first.', {
        reason: 'EMAIL_NOT_VERIFIED',
      });
    handlers['POST /auth/email/resend'] = () => json(202, { accepted: true });
    renderAt('/sign-in');
    await userEvent.type(await screen.findByLabelText('Email or phone'), 'ada@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send the link again' }));
    expect(await screen.findByText(/new link is on its way/)).toBeInTheDocument();
    expect(sent('POST /auth/email/resend')[0]?.body).toEqual({ email: 'ada@example.test' });
  });

  it('explains a rate limit in plain words', async () => {
    handlers['POST /auth/sign-in'] = () => apiError(429, 'RATE_LIMITED', 'Too many requests.');
    renderAt('/sign-in');
    await userEvent.type(await screen.findByLabelText('Email or phone'), 'ada@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait a minute and try again.');
  });
});

describe('sign up (S02)', () => {
  async function fillSignUp(password = 'correct horse battery') {
    await userEvent.type(await screen.findByLabelText('Your name'), 'Ada Obi');
    await userEvent.type(screen.getByLabelText('Email'), 'Ada@Example.test');
    await userEvent.type(screen.getByLabelText('New password'), password);
    await userEvent.type(screen.getByLabelText('Company name'), 'Obi Hotels');
    await userEvent.selectOptions(screen.getByLabelText('Country'), 'GH');
    await userEvent.type(screen.getByLabelText('Hotel name'), 'Obi Accra');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
  }

  it('creates the account and asks the owner to check their email', async () => {
    handlers['POST /auth/sign-up'] = () => json(201, { verificationSent: true });
    renderAt('/sign-up');
    await fillSignUp();
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('ada@example.test');
    expect(sent('POST /auth/sign-up')[0]?.body).toEqual({
      name: 'Ada Obi',
      email: 'ada@example.test',
      password: 'correct horse battery',
      organisationName: 'Obi Hotels',
      country: 'GH',
      propertyName: 'Obi Accra',
    });
  });

  it('enforces the shared password rule in the browser', async () => {
    renderAt('/sign-up');
    await fillSignUp('short');
    expect(await screen.findByText('Use at least 10 characters')).toBeInTheDocument();
    expect(sent('POST /auth/sign-up')).toHaveLength(0);
  });

  it('puts server validation messages on the right field', async () => {
    handlers['POST /auth/sign-up'] = () =>
      apiError(400, 'VALIDATION_ERROR', 'Request validation failed.', {
        issues: [{ path: 'body.propertyName', code: 'custom', message: 'Name already used' }],
      });
    renderAt('/sign-up');
    await fillSignUp();
    expect(await screen.findByText('Name already used')).toBeInTheDocument();
    expect(screen.getByLabelText('Hotel name')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('email links', () => {
  it('confirms the email once from the link', async () => {
    handlers['POST /auth/email/verify'] = () => json(204);
    renderAt('/verify-email?token=abcdefghijklmnopqrstuvwxyz');
    expect(await screen.findByRole('heading', { name: 'Email confirmed' })).toBeInTheDocument();
    expect(sent('POST /auth/email/verify')).toEqual([
      expect.objectContaining({ body: { token: 'abcdefghijklmnopqrstuvwxyz' } }),
    ]);
  });

  it('explains an expired link and offers a new one', async () => {
    handlers['POST /auth/email/verify'] = () =>
      apiError(400, 'VALIDATION_ERROR', 'This link is invalid or has expired.', {
        reason: 'TOKEN_INVALID',
      });
    handlers['POST /auth/email/resend'] = () => json(202, { accepted: true });
    renderAt('/verify-email?token=abcdefghijklmnopqrstuvwxyz');
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid or has expired');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send the link again' }));
    expect(await screen.findByText(/new link is on its way/)).toBeInTheDocument();
  });

  it('sends a reset link without saying whether the account exists', async () => {
    handlers['POST /auth/password/reset-request'] = () => json(202, { accepted: true });
    renderAt('/forgot-password');
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If ada@example.test has an account/)).toBeInTheDocument();
  });

  it('sets a new password, checking both entries match', async () => {
    handlers['POST /auth/password/reset'] = () => json(204);
    renderAt('/reset-password?token=abcdefghijklmnopqrstuvwxyz');
    await userEvent.type(await screen.findByLabelText('New password'), 'a brand new passphrase');
    await userEvent.type(
      screen.getByLabelText('Repeat the new password'),
      'a different passphrase',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('The two passwords are different')).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Repeat the new password'));
    await userEvent.type(
      screen.getByLabelText('Repeat the new password'),
      'a brand new passphrase',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(sent('POST /auth/password/reset')[0]?.body).toEqual({
      token: 'abcdefghijklmnopqrstuvwxyz',
      password: 'a brand new passphrase',
    });
  });
});

describe('signed-in actions', () => {
  it('signs out from the account menu', async () => {
    handlers['GET /me'] = () => json(200, makeMe());
    handlers['POST /auth/sign-out'] = () => json(204);
    const router = renderAt('/front-desk');
    await userEvent.click(await screen.findByRole('button', { name: 'Account menu' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(sent('POST /auth/sign-out')).toHaveLength(1);
  });

  it('switches property, remembering the choice and changing permissions', async () => {
    handlers['GET /me'] = () =>
      json(
        200,
        makeMe({
          properties: [LAGOS_PROPERTY, ABUJA_PROPERTY],
          memberships: [membership(LAGOS, ['frontdesk.read']), membership(ABUJA, ['hk.read'])],
        }),
      );
    renderAt('/front-desk');
    const rail = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(rail).getByRole('link', { name: 'Front desk' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Property' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Abuja Hotel/ }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Property' })).toHaveTextContent('Abuja Hotel'),
    );
    expect(within(rail).queryByRole('link', { name: 'Front desk' })).not.toBeInTheDocument();
    expect(within(rail).getByRole('link', { name: 'Room board' })).toBeInTheDocument();
    expect(
      window.localStorage.getItem('hotel.currentProperty.11111111-1111-4111-8111-111111111111'),
    ).toBe(ABUJA);
  });
});
