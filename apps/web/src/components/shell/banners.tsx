import { useQuery } from '@tanstack/react-query';
import { Lock, RefreshCw, ShieldAlert, Sparkles, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useSession } from '../../app/session.ts';
import { api } from '../../lib/api.ts';
import { useOnlineStatus } from '../../offline/use-online-status.ts';
import { Button } from '../ui/button.tsx';

export function OfflineBanner() {
  const online = useOnlineStatus();
  const { t } = useTranslation();
  if (online) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 bg-warning-subtle px-4 py-2 text-sm text-warning"
    >
      <WifiOff aria-hidden className="size-4 shrink-0" />
      <span>{t('offline.banner')}</span>
    </div>
  );
}

/** Shown when a new service worker is waiting; the user chooses when to reload. */
export function UpdateBanner() {
  const { t } = useTranslation();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div role="status" className="flex items-center gap-3 bg-brand-subtle px-4 py-2 text-sm">
      <RefreshCw aria-hidden className="size-4 shrink-0 text-brand" />
      <span>{t('update.available')}</span>
      <Button size="sm" onClick={() => void updateServiceWorker(true)}>
        {t('update.reload')}
      </Button>
    </div>
  );
}

/** The group is suspended for an unpaid invoice (M13-06): it can read, export and pay. */
export function SuspendedBanner() {
  const { t } = useTranslation();
  const { suspended, permissions } = useSession();
  if (!suspended) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 bg-critical-subtle px-4 py-2 text-sm text-critical"
    >
      <Lock aria-hidden className="size-4 shrink-0" />
      <span>{t('suspended.banner')}</span>
      {permissions.includes('subscription.read') && (
        <Link className="font-medium underline" to="/settings/billing">
          {t('suspended.pay')}
        </Link>
      )}
    </div>
  );
}

/** A platform admin reading this hotel through a support session (T-100): read-only. */
export function SupportBanner() {
  const { t, i18n } = useTranslation();
  const { support } = useSession();
  if (!support) return null;
  const time = new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(
    new Date(support.expiresAt),
  );
  return (
    <div
      role="status"
      className="flex items-center gap-2 bg-critical-subtle px-4 py-2 text-sm text-critical"
    >
      <ShieldAlert aria-hidden className="size-4 shrink-0" />
      <span>{t('support.banner', { org: support.organisationName, time })}</span>
    </div>
  );
}

const hiddenKey = (user: string) => `gettingStartedHidden:${user}`;

function readHidden(user: string): boolean {
  try {
    return window.localStorage.getItem(hiddenKey(user)) === '1';
  } catch {
    return false;
  }
}

/** First steps not all done yet (T-172); each person may hide it on their device. */
export function GettingStartedBanner() {
  const { t } = useTranslation();
  const { currentPropertyId, userName, support } = useSession();
  const [hidden, setHidden] = useState(() => readHidden(userName));
  const q = useQuery({
    queryKey: ['getting-started', 'mine'],
    queryFn: () => api.call('listGettingStarted'),
    enabled: currentPropertyId !== null && !support && !hidden,
  });
  const data: unknown = q.data;
  if (hidden || !data || typeof data !== 'object') return null;
  const { done, total } = data as { done?: unknown; total?: unknown };
  if (typeof done !== 'number' || typeof total !== 'number' || total === 0 || done >= total) {
    return null;
  }
  const hide = () => {
    try {
      window.localStorage.setItem(hiddenKey(userName), '1');
    } catch {
      // Private window: hidden for this visit only.
    }
    setHidden(true);
  };
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 bg-brand-subtle px-4 py-2 text-sm"
    >
      <Sparkles aria-hidden className="size-4 shrink-0 text-brand" />
      <span>{t('shell.gettingStarted', { done, total })}</span>
      <Link className="font-medium underline" to="/support#getting-started">
        {t('shell.gettingStartedOpen')}
      </Link>
      <Button size="sm" variant="ghost" onClick={hide}>
        {t('shell.gettingStartedHide')}
      </Button>
    </div>
  );
}
