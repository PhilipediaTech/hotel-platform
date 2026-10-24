import { RefreshCw, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useRegisterSW } from 'virtual:pwa-register/react';
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
