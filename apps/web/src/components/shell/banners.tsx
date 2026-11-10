import { Lock, RefreshCw, ShieldAlert, WifiOff } from 'lucide-react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useSession } from '../../app/session.ts';
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
