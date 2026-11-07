import { useQueryClient } from '@tanstack/react-query';
import { CloudUpload } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ME_QUERY_KEY, useSession, type MeResponse } from '../app/session.ts';
import { Button } from '../components/ui/button.tsx';
import { discard, loadQueue, replay, useQueuedActions } from './queue.ts';
import { SNAPSHOT_REFRESH_MS } from './snapshots.ts';
import { useOnlineStatus } from './use-online-status.ts';

// What is waiting on this device (T-093): sent on reconnect, every minute while online, or
// with "Send now"; refusals stay as conflicts until the person reads and discards them.

export function PendingChanges() {
  const { t } = useTranslation();
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const session = useSession();
  const userId = queryClient.getQueryData<MeResponse>(ME_QUERY_KEY)?.user.id ?? null;
  const propertyId = session.currentPropertyId;
  const actions = useQueuedActions().filter((a) => a.userId === userId);

  useEffect(() => {
    void loadQueue();
  }, []);

  useEffect(() => {
    if (!online || !userId || !propertyId || session.preview) return;
    const send = async () => {
      const sent = await replay({ userId, propertyId });
      if (sent > 0) await queryClient.invalidateQueries();
    };
    void send();
    const timer = setInterval(() => void send(), SNAPSHOT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [online, userId, propertyId, queryClient, session.preview]);

  if (actions.length === 0 || !userId || !propertyId) return null;
  const waiting = actions.filter((a) => a.status === 'pending');
  const conflicts = actions.filter((a) => a.status === 'conflict');
  return (
    <section
      aria-label={t('offline.pending.title')}
      className="border-b border-border bg-surface px-4 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <CloudUpload aria-hidden className="size-4 text-brand" />
        {waiting.length > 0 && (
          <span>{t('offline.pending.waiting', { count: waiting.length })}</span>
        )}
        {conflicts.length > 0 && (
          <span className="text-critical">
            {t('offline.pending.conflicts', { count: conflicts.length })}
          </span>
        )}
        {online && waiting.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void replay({ userId, propertyId }).then(() => queryClient.invalidateQueries())
            }
          >
            {t('offline.pending.sendNow')}
          </Button>
        )}
      </div>
      <ul className="mt-1 flex flex-col gap-1">
        {actions.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2">
            <span>{a.label}</span>
            {a.status === 'conflict' ? (
              <>
                <span className="text-critical">
                  {t('offline.pending.refused', { reason: a.error ?? '' })}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void discard(a.id)}>
                  {t('offline.pending.discard')}
                </Button>
              </>
            ) : (
              <span className="text-text-muted">{t('offline.pending.queued')}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
