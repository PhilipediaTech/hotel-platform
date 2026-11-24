import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import kitchenStrings from '../i18n/en/kitchen.json';
import { registerStrings } from '../i18n/index.ts';

registerStrings(kitchenStrings);

// S44 Kitchen display (PRD M8-06; T-156): a station's tickets, oldest first, with how long each
// has waited; a big Done button bumps one, and one bumped by mistake can be recalled. It reads
// again every few seconds, so new tickets appear by themselves.

const REFRESH_MS = 5_000;
/** Minutes after which a ticket shows as late, then very late. */
const LATE = 10;
const VERY_LATE = 20;

type Board = Awaited<ReturnType<typeof boardOf>>;
type Ticket = Board['waiting'][number];
const boardOf = (outletId: string | null, station: string | null) =>
  api.call('getKitchenBoard', {
    query: { ...(outletId ? { outletId } : {}), ...(station ? { station } : {}) },
  });

/** Re-renders every 30 seconds, so the waiting minutes move on. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function KitchenPage() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const [outletId, setOutletId] = useState<string | null>(null);
  const [station, setStation] = useState<string | null>(null);
  const key = ['kitchen', currentPropertyId ?? '', outletId, station];
  const board = useQuery({
    queryKey: key,
    queryFn: () => boardOf(outletId, station),
    refetchInterval: REFRESH_MS,
  });
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['kitchen'] });
  const bump = useMutation({
    mutationFn: (ticketId: string) => api.call('bumpKitchenTicket', { params: { ticketId } }),
    onSuccess: refresh,
  });
  const recall = useMutation({
    mutationFn: (ticketId: string) => api.call('recallKitchenTicket', { params: { ticketId } }),
    onSuccess: refresh,
  });
  const now = useNow();
  const data = board.data;
  const outlet = data?.outlets.find((o) => o.id === outletId) ?? data?.outlets[0];
  const current = station ?? outlet?.stations[0] ?? null;
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">
          {current ? t('kitchen.titleAt', { station: current }) : t('kitchen.title')}
        </h1>
        {data && data.outlets.length > 0 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('kitchen.choose')}>
            {data.outlets.flatMap((o) =>
              o.stations.map((s) => {
                const on = o.id === outlet?.id && s === current;
                return (
                  <Button
                    key={`${o.id}-${s}`}
                    variant={on ? 'primary' : 'secondary'}
                    aria-pressed={on}
                    onClick={() => {
                      setOutletId(o.id);
                      setStation(s);
                    }}
                  >
                    {data.outlets.length > 1 ? `${o.name} · ${s}` : s}
                  </Button>
                );
              }),
            )}
          </div>
        )}
      </div>
      {board.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(board.error)}
        </Alert>
      )}
      {(bump.error ?? recall.error) && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(bump.error ?? recall.error)}
        </Alert>
      )}
      {data && data.outlets.length === 0 && (
        <Alert tone="info" className="mt-3">
          {t('kitchen.noStations')}
        </Alert>
      )}
      {data && data.outlets.length > 0 && data.waiting.length === 0 && (
        <p className="mt-6 text-lg text-text-muted">{t('kitchen.clear')}</p>
      )}
      <ul
        aria-label={t('kitchen.waiting')}
        className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        {data?.waiting.map((ticket) => (
          <TicketCard
            key={ticket.id}
            ticket={ticket}
            now={now}
            action={
              <Button
                className="h-14 w-full text-lg"
                disabled={bump.isPending}
                onClick={() => bump.mutate(ticket.id)}
              >
                {t('kitchen.bump')}
              </Button>
            }
          />
        ))}
      </ul>
      {data && data.bumped.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-medium">
            {t('kitchen.bumped', { count: data.bumped.length })}
          </summary>
          <ul aria-label={t('kitchen.bumpedList')} className="mt-2 flex flex-col gap-2">
            {data.bumped.map((ticket) => (
              <li
                key={ticket.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface p-2 text-sm"
              >
                <span>
                  {t('kitchen.ticketName', { label: ticket.label, number: ticket.number })} ·{' '}
                  {ticket.lines.map((l) => `${l.quantity} × ${l.name}`).join(', ')}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={recall.isPending}
                  onClick={() => recall.mutate(ticket.id)}
                >
                  {t('kitchen.recall')}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function TicketCard({
  ticket,
  now,
  action,
}: {
  ticket: Ticket;
  now: number;
  action: React.ReactNode;
}) {
  const { t } = useTranslation();
  const minutes = Math.max(0, Math.floor((now - Date.parse(ticket.sentAt)) / 60_000));
  const tone =
    minutes >= VERY_LATE ? 'border-critical' : minutes >= LATE ? 'border-warning' : 'border-border';
  return (
    <li
      aria-label={t('kitchen.ticketName', { label: ticket.label, number: ticket.number })}
      className={cn('flex flex-col gap-2 rounded-md border-2 bg-surface p-3', tone)}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-lg font-semibold">{ticket.label}</p>
        <p
          className={cn(
            'text-sm',
            minutes >= VERY_LATE
              ? 'font-semibold text-critical'
              : minutes >= LATE
                ? 'text-warning'
                : 'text-text-muted',
          )}
        >
          {t('kitchen.minutes', { count: minutes })}
        </p>
      </div>
      <p className="text-xs text-text-muted">
        {ticket.orderNumber}
        {ticket.number > 1 && ` · ${t('kitchen.round', { number: ticket.number })}`} ·{' '}
        {ticket.sentBy}
      </p>
      {ticket.cancelled && <p className="font-semibold text-critical">{t('kitchen.cancelled')}</p>}
      <ul className="flex flex-col gap-1 text-base">
        {ticket.lines.map((l) => (
          <li key={l.id} className={cn(l.voided && 'text-text-muted line-through')}>
            <span className="font-semibold">{l.quantity} ×</span> {l.name}
            {l.voided && <span className="ml-1 text-xs no-underline">{t('kitchen.voided')}</span>}
            {l.note && <span className="block text-sm text-warning">{l.note}</span>}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-1">{action}</div>
    </li>
  );
}
