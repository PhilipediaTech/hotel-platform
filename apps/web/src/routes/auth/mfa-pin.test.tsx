import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/query-client.ts';
import { routes } from '../../app/routes.tsx';
import type { MeResponse } from '../../app/session.ts';
import { setApiPropertyId } from '../../lib/api.ts';
import { makeMe } from '../../test/me-fixture.ts';

// MFA (M1-06) and PIN switch (M1-07) screens with the real router and gate; fake network.

type Handler = (body: unknown) => Response;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const apiError = (status: number, code: string, message: string, details?: object) =>
  json(status, {
    error: { code, message, requestId: 'req_test', ...(details ? { details } : {}) },
  });

const pendingMe = (mfaEnabled: boolean): MeResponse => {
  const me = makeMe();
  return { ...me, user: { ...me.user, mfaEnabled }, session: { ...me.session, mfaPassed: false } };
};
const sharedDeviceMe = (): MeResponse => {
  const me = makeMe();
  return { ...me, session: { ...me.session, pinSwitchAvailable: true } };
};

let handlers: Record<string, Handler>;
const calls: { key: string; body: unknown }[] = [];
const sent = (key: string) => calls.filter((c) => c.key === key);

beforeEach(() => {
  calls.length = 0;
  handlers = {
    'GET /me': () => apiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'),
    'GET /auth/device': () => json(200, { pinSwitchAvailable: false, deviceLabel: null }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const key = `${init.method} ${new URL(url, 'http://app.test').pathname.replace('/api/v1', '')}`;
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
  return router;
}

describe('MFA at sign-in', () => {
  it('sends a session that still needs MFA to the code screen', async () => {
    handlers['GET /me'] = () => json(200, pendingMe(true));
    const router = renderAt('/folios');
    await screen.findByRole('heading', { name: 'Enter your sign-in code' });
    expect(router.state.location.pathname).toBe('/mfa');
    expect(router.state.location.search).toBe('?next=%2Ffolios');
  });

  it('goes to the code screen straight after a password sign-in', async () => {
    handlers['POST /auth/sign-in'] = () => json(200, pendingMe(true));
    handlers['GET /me'] = () => json(200, pendingMe(true));
    const router = renderAt('/sign-in?next=%2Ffolios');
    await userEvent.type(await screen.findByLabelText('Email or phone'), 'ada@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Enter your sign-in code' });
    expect(router.state.location.search).toBe('?next=%2Ffolios');
  });

  it('passes MFA with the app code and continues', async () => {
    handlers['GET /me'] = () => json(200, pendingMe(true));
    handlers['POST /auth/mfa/verify'] = () => json(200, makeMe());
    const router = renderAt('/mfa?next=%2Ffolios');
    await userEvent.type(await screen.findByLabelText('6-digit code'), '482916');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Folios' });
    expect(router.state.location.pathname).toBe('/folios');
    expect(sent('POST /auth/mfa/verify')[0]?.body).toEqual({ code: '482916' });
  });

  it('shows a wrong code on the field', async () => {
    handlers['GET /me'] = () => json(200, pendingMe(true));
    handlers['POST /auth/mfa/verify'] = () =>
      apiError(400, 'VALIDATION_ERROR', 'That code is not right.', {
        reason: 'MFA_CODE_INVALID',
        issues: [
          {
            path: 'body.code',
            code: 'custom',
            message: 'That code is not right. Try the newest one.',
          },
        ],
      });
    renderAt('/mfa');
    await userEvent.type(await screen.findByLabelText('6-digit code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText('That code is not right. Try the newest one.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('6-digit code')).toHaveAttribute('aria-invalid', 'true');
  });

  it('accepts a recovery code instead', async () => {
    handlers['GET /me'] = () => json(200, pendingMe(true));
    handlers['POST /auth/mfa/verify'] = () => json(200, makeMe());
    renderAt('/mfa');
    await userEvent.click(await screen.findByRole('button', { name: /Use a recovery code/ }));
    await userEvent.type(screen.getByLabelText('Recovery code'), 'AB2C-D3EF');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Front desk' });
    expect(sent('POST /auth/mfa/verify')[0]?.body).toEqual({ recoveryCode: 'AB2C-D3EF' });
  });

  it('checks the code format before calling the API', async () => {
    handlers['GET /me'] = () => json(200, pendingMe(true));
    renderAt('/mfa');
    await userEvent.type(await screen.findByLabelText('6-digit code'), '12ab');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter the 6 digits from the app')).toBeInTheDocument();
    expect(sent('POST /auth/mfa/verify')).toHaveLength(0);
  });
});

describe('MFA set-up', () => {
  it('shows a QR code and key, confirms, then shows the recovery codes once', async () => {
    let me = pendingMe(false);
    handlers['GET /me'] = () => json(200, me);
    handlers['POST /me/mfa/enrol'] = () =>
      json(201, {
        secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        otpauthUri:
          'otpauth://totp/Hotel%20Platform:ada?secret=JBSWY3DPEHPK3PXP&issuer=Hotel%20Platform',
      });
    const codes = [
      'AB2C-D3EF',
      'GH4J-K5MN',
      'PQ6R-S7TU',
      'VW8X-Y9ZA',
      'BC2D-E3FG',
      'HJ4K-M5NP',
      'QR6S-T7UV',
      'WX8Y-Z9AB',
      'CD2E-F3GH',
      'JK4M-N5PQ',
    ];
    handlers['POST /me/mfa/confirm'] = () => {
      me = makeMe({ user: { ...makeMe().user, mfaEnabled: true } });
      return json(200, { recoveryCodes: codes });
    };

    const router = renderAt('/mfa?next=%2Ffolios');
    await userEvent.click(await screen.findByRole('button', { name: 'Set up now' }));
    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('6-digit code'), '482916');
    await userEvent.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));
    const list = await screen.findByRole('list');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(codes);

    await userEvent.click(screen.getByRole('button', { name: 'I have saved them' }));
    await screen.findByRole('heading', { name: 'Folios' });
    expect(router.state.location.pathname).toBe('/folios');
  });
});

describe('PIN switch on a shared device', () => {
  it('offers PIN switching on the sign-in screen of a shared device', async () => {
    handlers['GET /auth/device'] = () =>
      json(200, { pinSwitchAvailable: true, deviceLabel: 'Front desk tablet' });
    renderAt('/sign-in?next=%2Ffolios');
    const link = await screen.findByRole('link', { name: 'Switch user with PIN' });
    expect(link).toHaveAttribute('href', '/pin?next=%2Ffolios');
  });

  it('switches in with login and PIN', async () => {
    handlers['GET /auth/device'] = () =>
      json(200, { pinSwitchAvailable: true, deviceLabel: 'Front desk tablet' });
    handlers['POST /auth/pin'] = () => json(200, sharedDeviceMe());
    const router = renderAt('/pin');
    expect(await screen.findByText('Shared device: Front desk tablet')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email or phone'), '+2348012345678');
    await userEvent.type(screen.getByLabelText('PIN'), '482916');
    await userEvent.click(screen.getByRole('button', { name: 'Switch' }));
    await screen.findByRole('heading', { name: 'Front desk' });
    expect(router.state.location.pathname).toBe('/front-desk');
    expect(sent('POST /auth/pin')[0]?.body).toEqual({ login: '+2348012345678', pin: '482916' });
  });

  it('explains that PINs need a shared device', async () => {
    renderAt('/pin');
    expect(await screen.findByText(/PIN switching works on shared devices/)).toBeInTheDocument();
    expect(screen.queryByLabelText('PIN')).not.toBeInTheDocument();
  });

  it('shows the server’s answer for a wrong PIN', async () => {
    handlers['GET /auth/device'] = () => json(200, { pinSwitchAvailable: true, deviceLabel: null });
    handlers['POST /auth/pin'] = () =>
      apiError(401, 'UNAUTHENTICATED', 'Email, phone or PIN is incorrect.');
    renderAt('/pin');
    await userEvent.type(await screen.findByLabelText('Email or phone'), 'ada@example.test');
    await userEvent.type(screen.getByLabelText('PIN'), '111222');
    await userEvent.click(screen.getByRole('button', { name: 'Switch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email, phone or PIN is incorrect.');
  });

  it('“Switch user” ends this session and opens the PIN screen', async () => {
    handlers['GET /me'] = () => json(200, sharedDeviceMe());
    handlers['POST /auth/sign-out'] = () => json(204);
    handlers['GET /auth/device'] = () => json(200, { pinSwitchAvailable: true, deviceLabel: null });
    const router = renderAt('/front-desk');
    await userEvent.click(await screen.findByRole('button', { name: 'Account menu' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Switch user' }));
    await screen.findByRole('heading', { name: 'Switch user' });
    expect(router.state.location.pathname).toBe('/pin');
    expect(sent('POST /auth/sign-out')).toEqual([
      expect.objectContaining({ body: { keepDevice: true } }),
    ]);
  });

  it('hides “Switch user” on a personal device', async () => {
    handlers['GET /me'] = () => json(200, makeMe());
    renderAt('/front-desk');
    await userEvent.click(await screen.findByRole('button', { name: 'Account menu' }));
    expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Switch user' })).not.toBeInTheDocument();
  });
});

describe('setting my PIN', () => {
  async function fill(pin: string, confirm: string, password = 'correct horse battery') {
    await userEvent.type(await screen.findByLabelText('New 6-digit PIN'), pin);
    await userEvent.type(screen.getByLabelText('Repeat the PIN'), confirm);
    await userEvent.type(screen.getByLabelText('Password'), password);
    await userEvent.click(screen.getByRole('button', { name: 'Save PIN' }));
  }

  it('refuses easy and mismatched PINs before calling the API', async () => {
    handlers['GET /me'] = () => json(200, makeMe());
    renderAt('/account/pin');
    await fill('123456', '654321');
    expect(await screen.findByText(/Too easy to guess/)).toBeInTheDocument();
    expect(screen.getByText('The two PINs are different')).toBeInTheDocument();
    expect(sent('PUT /me/pin')).toHaveLength(0);
  });

  it('saves the PIN with my password', async () => {
    handlers['GET /me'] = () => json(200, makeMe());
    handlers['PUT /me/pin'] = () => json(204);
    renderAt('/account/pin');
    await fill('482916', '482916');
    expect(await screen.findByText('Your PIN is saved.')).toBeInTheDocument();
    expect(sent('PUT /me/pin')[0]?.body).toEqual({
      pin: '482916',
      password: 'correct horse battery',
    });
  });

  it('shows a wrong password on the password field', async () => {
    handlers['GET /me'] = () => json(200, makeMe());
    handlers['PUT /me/pin'] = () =>
      apiError(400, 'VALIDATION_ERROR', 'The password is incorrect.', {
        issues: [{ path: 'body.password', code: 'custom', message: 'The password is incorrect.' }],
      });
    renderAt('/account/pin');
    await fill('482916', '482916', 'wrong one');
    expect(await screen.findByText('The password is incorrect.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
  });
});
