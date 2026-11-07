import { WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSavedCopyTime } from './snapshots.ts';

/** "Offline: saved copy from 14:05" above a list shown from the device (T-093). */
export function SavedCopyNote({ savedAs }: { savedAs: string }) {
  const { t, i18n } = useTranslation();
  const savedAt = useSavedCopyTime(savedAs);
  if (savedAt === null) return null;
  const time = new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(savedAt);
  return (
    <p role="status" className="mt-2 flex items-center gap-2 text-sm text-warning">
      <WifiOff aria-hidden className="size-4" />
      {t('offline.savedCopy', { time })}
    </p>
  );
}
