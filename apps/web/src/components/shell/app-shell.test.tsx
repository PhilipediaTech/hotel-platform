import type { ReactNode } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { buildRoutes } from '../../app/routes.tsx';
import { PREVIEW_SESSION, SessionContext, type ShellSession } from '../../app/session.ts';
import { swState, updateServiceWorker } from '../../test/pwa-register-stub.ts';
import { formatBusinessDate } from './top-bar.tsx';

// The shell tests supply the session themselves instead of loading GET /me.
function PassThroughGate({ children }: { children: ReactNode }) {
  return children;
}

function renderApp(path: string, session: Partial<ShellSession> = {}) {
  const router = createMemoryRouter(buildRoutes(PassThroughGate), { initialEntries: [path] });
  render(
    <SessionContext value={{ ...PREVIEW_SESSION, ...session }}>
      <RouterProvider router={router} />
    </SessionContext>,
  );
  return router;
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

afterEach(() => {
  setOnline(true);
  swState.needRefresh = false;
});

describe('app shell landmarks', () => {
  it('has a banner, main navigation, quick navigation and main region', async () => {
    renderApp('/front-desk');
    expect(await screen.findByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Quick navigation' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('offers a skip link to the main content', async () => {
    renderApp('/front-desk');
    expect(await screen.findByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#main',
    );
  });
});

describe('routing', () => {
  it('sends "/" to the role home screen', async () => {
    const router = renderApp('/', { permissions: ['frontdesk.read'] });
    await screen.findByRole('heading', { name: 'Front desk' });
    expect(router.state.location.pathname).toBe('/front-desk');
  });

  it('shows which ticket builds a screen', async () => {
    renderApp('/night-audit');
    expect(await screen.findByText('Screen S15 arrives with T-073.')).toBeInTheDocument();
  });

  it('shows a not-found page for unknown paths', async () => {
    renderApp('/no-such-screen');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('navigation by permission', () => {
  it('lists only permitted items in the left rail', async () => {
    renderApp('/my-rooms', { permissions: ['hk.read', 'hk.work'] });
    const rail = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(
      within(rail)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Room board', 'My rooms']);
  });

  it('shows the role bottom bar on phones', async () => {
    renderApp('/front-desk', { permissions: ['frontdesk.read', 'folio.read'] });
    const bar = await screen.findByRole('navigation', { name: 'Quick navigation' });
    expect(
      within(bar)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Arrivals', 'In-house', 'Calendar', 'Folios']);
  });
});

describe('top bar', () => {
  it('shows the current property and lists properties in the switcher', async () => {
    const user = userEvent.setup();
    renderApp('/front-desk', {
      properties: [
        {
          id: 'p1',
          code: 'LAG',
          name: 'Lagos Hotel',
          timeZone: 'Africa/Lagos',
          baseCurrency: 'NGN',
          locale: 'en-NG',
        },
        {
          id: 'p2',
          code: 'ABJ',
          name: 'Abuja Hotel',
          timeZone: 'Africa/Lagos',
          baseCurrency: 'NGN',
          locale: 'en-NG',
        },
      ],
      currentPropertyId: 'p1',
    });
    const switcher = await screen.findByRole('button', { name: 'Property' });
    expect(switcher).toHaveTextContent('Lagos Hotel');
    await user.click(switcher);
    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((o) => o.textContent)).toEqual(['✓Lagos Hotel', 'Abuja Hotel']);
  });

  // The chip renders twice (top bar on wider screens, strip on phones; CSS picks one).
  const contextChips = () => screen.findAllByLabelText('Business date, currency and time zone');

  it('shows business date, currency and time zone in the property locale (rule 8)', async () => {
    renderApp('/front-desk', { businessDate: '2026-11-12' });
    const chips = await contextChips();
    expect(chips).toHaveLength(2);
    for (const chip of chips) expect(chip).toHaveTextContent('Thu, 12 Nov 2026 · NGN · WAT');
  });

  it('still shows currency and time zone when no business day is open', async () => {
    renderApp('/front-desk', { businessDate: null });
    for (const chip of await contextChips()) {
      expect(chip).toHaveTextContent('Business date not set · NGN · WAT');
    }
  });

  it('labels the approvals and alerts bells with their counts', async () => {
    renderApp('/front-desk', { pendingApprovals: 3, openAlerts: 120 });
    expect(await screen.findByRole('link', { name: 'Approvals, 3 pending' })).toHaveTextContent(
      '3',
    );
    expect(screen.getByRole('link', { name: 'Alerts, 120 open' })).toHaveTextContent('99+');
  });
});

describe('banners', () => {
  it('shows the offline banner while disconnected and hides it on reconnect', async () => {
    renderApp('/front-desk');
    await screen.findByRole('banner');
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();
    setOnline(false);
    expect(screen.getByRole('status')).toHaveTextContent(/payments, check-in, check-out/i);
    setOnline(true);
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();
  });

  it('asks before reloading for a new version', async () => {
    swState.needRefresh = true;
    const user = userEvent.setup();
    renderApp('/front-desk');
    await user.click(await screen.findByRole('button', { name: 'Reload' }));
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it('marks preview data clearly until sign-in exists', async () => {
    renderApp('/front-desk', { preview: true });
    expect(await screen.findByText(/Preview data/)).toBeInTheDocument();
  });
});

describe('formatBusinessDate', () => {
  it('formats the date itself, ignoring the device time zone', () => {
    expect(formatBusinessDate('2026-01-01', 'en-NG')).toBe('Thu, 1 Jan 2026');
  });
});

describe('timeZoneLabel', () => {
  it('uses the property locale abbreviation', async () => {
    const { timeZoneLabel } = await import('./top-bar.tsx');
    expect(timeZoneLabel('Africa/Lagos', 'en-NG', new Date('2026-11-12T12:00:00Z'))).toBe('WAT');
  });
});
