import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import channelStrings from '../i18n/en/channels.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(channelStrings);

// S41 Channel manager (PRD M11-07; T-151): connect the property to Channex, choose which rate
// plans are sold online, see what is set up and the recent activity, pause or resume.
// T-152: how prices and availability are being sent, and sending everything again.

const card = 'rounded-md border border-border bg-surface p-4';

export function ChannelsPage() {
  const { t } = useTranslation();
  const f = useFormats();
  const { currentPropertyId } = useSession();
  const queryClient = useQueryClient();
  const key = ['channels', currentPropertyId ?? ''];
  const view = useQuery({ queryKey: key, queryFn: () => api.call('getChannelConnection', {}) });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });
  const data = view.data;
  const selected =
    picked ?? new Set(data?.ratePlans.filter((p) => p.selected).map((p) => p.id) ?? []);
  const connect = useMutation({
    mutationFn: () => api.call('connectChannel', { body: { ratePlanIds: [...selected] } }),
    onSuccess: () => {
      setPicked(null);
      refresh();
    },
    onError: refresh,
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.call('pauseChannel', { body: { paused } }),
    onSuccess: refresh,
  });
  const fullSync = useMutation({
    mutationFn: () => api.call('requestChannelFullSync', {}),
    onSuccess: refresh,
  });
  const status = data?.connection?.status ?? 'NONE';
  const c = data?.connection;
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('channels.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('channels.intro')}</p>
      {view.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(view.error)}
        </Alert>
      )}
      {data?.provider === 'OFF' && (
        <Alert tone="info" className="mt-3">
          {t('channels.off')}
        </Alert>
      )}
      {data?.provider === 'FAKE' && (
        <Alert tone="info" className="mt-3">
          {t('channels.fake')}
        </Alert>
      )}
      {data && (
        <div className="mt-4 flex flex-col gap-4">
          <div className={cn(card, 'flex flex-wrap items-center justify-between gap-2')}>
            <p className="font-medium">{t(`channels.status.${status}`)}</p>
            {(status === 'ACTIVE' || status === 'PAUSED') && (
              <Button
                variant="secondary"
                disabled={pause.isPending}
                onClick={() => pause.mutate(status === 'ACTIVE')}
              >
                {status === 'ACTIVE' ? t('channels.pause') : t('channels.resume')}
              </Button>
            )}
            {data.connection?.lastError && (
              <Alert tone="critical" className="w-full">
                {t('channels.lastError', { message: data.connection.lastError })}
              </Alert>
            )}
          </div>

          {c && status !== 'CONNECTING' && (
            <div className={card}>
              <h2 className="font-semibold">{t('channels.sync.title')}</h2>
              <ul
                aria-label={t('channels.sync.title')}
                className="mt-2 flex flex-col gap-1 text-sm"
              >
                <li>
                  {c.checkedAt
                    ? t('channels.sync.checked', { when: f.when(c.checkedAt) })
                    : t('channels.sync.notYet')}
                </li>
                <li>
                  {c.fullSyncPending
                    ? t('channels.sync.fullPending')
                    : c.fullSyncAt
                      ? t('channels.sync.fullAt', { when: f.when(c.fullSyncAt) })
                      : null}
                </li>
              </ul>
              {c.syncError && (
                <Alert tone="critical" className="mt-2">
                  {c.retryAt
                    ? t('channels.sync.errorRetry', {
                        message: c.syncError,
                        when: f.when(c.retryAt),
                      })
                    : t('channels.sync.error', { message: c.syncError })}
                </Alert>
              )}
              {fullSync.error && (
                <Alert tone="critical" className="mt-2">
                  {errorMessage(fullSync.error)}
                </Alert>
              )}
              <Button
                variant="secondary"
                className="mt-3"
                disabled={fullSync.isPending || c.fullSyncPending || status !== 'ACTIVE'}
                onClick={() => fullSync.mutate()}
              >
                {t('channels.sync.full')}
              </Button>
            </div>
          )}

          <div className={card}>
            <h2 className="font-semibold">{t('channels.roomTypes')}</h2>
            <ul aria-label={t('channels.roomTypes')} className="mt-2 flex flex-col gap-1 text-sm">
              {data.roomTypes.map((rt) => (
                <li key={rt.id} className="flex justify-between gap-2">
                  <span>
                    {rt.name} ·{' '}
                    {rt.rooms > 0
                      ? t('channels.rooms', { count: rt.rooms })
                      : t('channels.noRooms')}
                  </span>
                  <span className={rt.mapped ? 'text-success' : 'text-text-muted'}>
                    {rt.mapped ? t('channels.mapped') : t('channels.notMapped')}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <form
            aria-label={t('channels.plans')}
            className={card}
            onSubmit={(e) => {
              e.preventDefault();
              connect.mutate();
            }}
          >
            <h2 className="font-semibold">{t('channels.plans')}</h2>
            <p className="text-sm text-text-muted">{t('channels.plansHint')}</p>
            <ul className="mt-2 flex flex-col gap-2">
              {data.ratePlans.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-sm">
                  <input
                    id={`plan-${p.id}`}
                    type="checkbox"
                    className="size-5"
                    checked={selected.has(p.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      setPicked(next);
                    }}
                  />
                  <label htmlFor={`plan-${p.id}`}>
                    {t('channels.plan', { name: p.name, code: p.code })}
                  </label>
                  {p.mappedRoomTypes > 0 && (
                    <span className="text-text-muted">
                      {t('channels.planMapped', { count: p.mappedRoomTypes })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {connect.error && (
              <Alert tone="critical" className="mt-2">
                {errorMessage(connect.error)}
              </Alert>
            )}
            <Button
              type="submit"
              className="mt-3 h-11"
              disabled={connect.isPending || selected.size === 0 || data.provider === 'OFF'}
            >
              {status === 'NONE' ? t('channels.connect') : t('channels.save')}
            </Button>
          </form>

          <div className={card}>
            <h2 className="font-semibold">{t('channels.log')}</h2>
            {data.logs.length === 0 && (
              <p className="text-sm text-text-muted">{t('channels.noLog')}</p>
            )}
            <ul aria-label={t('channels.log')} className="mt-2 flex flex-col gap-1 text-sm">
              {data.logs.map((l, i) => (
                <li key={`${l.at}-${i}`}>
                  <span className={l.status === 'FAILED' ? 'text-critical' : undefined}>
                    {f.when(l.at)} · {t('channels.logLine', { kind: l.kind, items: l.items })} ·{' '}
                    {t(`channels.logStatus.${l.status}`)}
                  </span>
                  {l.message && <span className="text-text-muted"> · {l.message}</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
