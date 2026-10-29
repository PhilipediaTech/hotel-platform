import { localDate, type FrontDeskRow } from '@hotel/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { cn } from '../lib/cn.ts';
import { STATUS_TONE, useFormats } from './reservations.tsx';

// S06 Front desk (PRD M3-06; T-053): arrivals, departures and in-house guests for the business
// date, with balance and flags per row and quick check-in / check-out. The business date is
// today at the property until business days arrive (T-054); balances show once folios exist
// (T-060), and overnight check-out comes with them (T-064).

type Row = z.output<typeof FrontDeskRow>;
type Tab = 'arrivals' | 'departures' | 'in-house';

const TABS: Tab[] = ['arrivals', 'departures', 'in-house'];
const OPERATION = {
  arrivals: 'listArrivals',
  departures: 'listDepartures',
  'in-house': 'listInHouse',
} as const;
const FLAG_TONE: Record<string, string> = {
  VIP: 'bg-brand-subtle text-brand-strong',
  DO_NOT_RENT: 'bg-critical-subtle text-critical',
  OVERDUE: 'bg-critical-subtle text-critical',
  ROOM_NOT_READY: 'bg-warning-subtle text-warning',
  NO_ROOM: 'bg-warning-subtle text-warning',
  DEPOSIT_DUE: 'bg-warning-subtle text-warning',
};

const frontDeskKey = (propertyId: string | null) => ['front-desk', propertyId ?? ''];

function useList(tab: Tab, date: string) {
  const { currentPropertyId } = useSession();
  return useQuery({
    queryKey: [...frontDeskKey(currentPropertyId), tab, tab === 'in-house' ? '' : date],
    queryFn: () =>
      tab === 'in-house'
        ? api.call(OPERATION[tab], {})
        : api.call(OPERATION[tab], { query: { date } }),
    placeholderData: keepPreviousData,
  });
}

/** Quick check-in: as on the reservation page (M3 rule 2; day-use until its end time). */
function canCheckInNow(row: Row, today: string, now: number) {
  if (row.status !== 'CONFIRMED') return false;
  return row.dayUse
    ? row.arrival === today && Date.parse(row.dayUse.endsAt) > now
    : row.arrival <= today && row.departure > today;
}

export function FrontDeskPage() {
  const { t } = useTranslation();
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const today = localDate(new Date(), property?.timeZone ?? 'Africa/Lagos');
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((x) => x === params.get('tab')) ?? 'arrivals';
  const [dateInput, setDate] = useState(today);
  // While the field is being typed in (empty), the list stays on today.
  const date = dateInput || today;
  const [text, setText] = useState('');
  const lists = {
    arrivals: useList('arrivals', date),
    departures: useList('departures', date),
    'in-house': useList('in-house', date),
  };
  const current = lists[tab];
  const q = text.trim().toLowerCase();
  const rows = (current.data?.data ?? []).filter(
    (r) =>
      !q ||
      `${r.guest.firstName} ${r.guest.lastName}`.toLowerCase().includes(q) ||
      r.confirmationNo.toLowerCase().includes(q) ||
      (r.roomNumber ?? '').toLowerCase() === q,
  );

  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('nav.front-desk')}</h1>

      <div role="tablist" aria-label={t('frontDesk.lists')} className="mt-4 flex flex-wrap gap-2">
        {TABS.map((x) => (
          <Button
            key={x}
            role="tab"
            aria-selected={x === tab}
            variant={x === tab ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setParams({ tab: x }, { replace: true })}
          >
            {t(`frontDesk.tabs.${x}`)}
            {lists[x].data ? ` (${lists[x].data.data.length})` : ''}
          </Button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        {tab !== 'in-house' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="fd-date">{t('frontDesk.date')}</Label>
            <div className="flex gap-2">
              <Input
                id="fd-date"
                type="date"
                className="w-44"
                value={dateInput}
                onChange={(e) => setDate(e.target.value)}
              />
              {date !== today && (
                <Button size="sm" variant="ghost" onClick={() => setDate(today)}>
                  {t('frontDesk.today')}
                </Button>
              )}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="fd-find">{t('frontDesk.find')}</Label>
          <Input
            id="fd-find"
            className="w-64"
            placeholder={t('frontDesk.findHint')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      </div>

      {current.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(current.error)}
        </Alert>
      )}
      {current.data && rows.length === 0 && (
        <p className="mt-4 text-sm text-text-muted">{t(`frontDesk.empty.${tab}`)}</p>
      )}
      {rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table aria-label={t(`frontDesk.tabs.${tab}`)} className="w-full text-left text-sm">
            <thead className="text-text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">{t('frontDesk.cols.guest')}</th>
                <th className="py-2 pr-3 font-medium">{t('frontDesk.cols.room')}</th>
                <th className="py-2 pr-3 font-medium">{t('frontDesk.cols.stay')}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('frontDesk.cols.total')}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('frontDesk.cols.balance')}</th>
                <th className="py-2 font-medium">
                  <span className="sr-only">{t('frontDesk.cols.action')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <RowView key={row.stayId} row={row} tab={tab} today={today} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RowView({ row, tab, today }: { row: Row; tab: Tab; today: string }) {
  const { t } = useTranslation();
  const f = useFormats();
  const name = `${row.guest.firstName} ${row.guest.lastName}`;
  return (
    <tr className="border-t border-border align-top">
      <td className="py-2 pr-3">
        <Link
          to={`/reservations/${row.reservationId}`}
          className="font-medium text-brand underline"
        >
          {name}
        </Link>
        <span className="block text-xs text-text-muted">
          {row.confirmationNo}
          {row.guest.phone ? ` · ${row.guest.phone}` : ''}
        </span>
        {row.flags.length > 0 && (
          <span
            className="mt-1 flex flex-wrap gap-1"
            aria-label={t('frontDesk.flagsFor', { name })}
          >
            {row.flags.map((flag) => (
              <span
                key={flag}
                className={cn(
                  'rounded px-1.5 text-xs',
                  FLAG_TONE[flag] ?? 'bg-surface-sunken text-text-muted',
                )}
              >
                {t(`frontDesk.flags.${flag}`)}
              </span>
            ))}
          </span>
        )}
      </td>
      <td className="py-2 pr-3">
        {row.roomNumber ? (
          <>
            {row.roomNumber}
            {row.hkStatus && (
              <span className="block text-xs text-text-muted">{t(`rooms.hk.${row.hkStatus}`)}</span>
            )}
          </>
        ) : (
          <span className="text-text-muted">{t('frontDesk.noRoom')}</span>
        )}
      </td>
      <td className="py-2 pr-3">
        {row.dayUse ? (
          <>
            {f.time(row.dayUse.startsAt)}–{f.time(row.dayUse.endsAt)}
            <span className="block text-xs text-text-muted">{t('dayUse.tag')}</span>
          </>
        ) : (
          <>
            {f.date(row.arrival)} → {f.date(row.departure)}
            <span className="block text-xs text-text-muted">
              {t('frontDesk.nights', { count: row.nights })} · {row.roomTypeName} ·{' '}
              {row.ratePlanCode}
            </span>
          </>
        )}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">{f.money(row.totalMinor)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">
        {row.balanceMinor !== null ? (
          f.money(row.balanceMinor)
        ) : (
          <span title={t('frontDesk.balanceLater')}>—</span>
        )}
      </td>
      <td className="py-2">
        <Action row={row} tab={tab} today={today} name={name} />
      </td>
    </tr>
  );
}

function Action({ row, tab, today, name }: { row: Row; tab: Tab; today: string; name: string }) {
  const { t } = useTranslation();
  const f = useFormats();
  const { permissions, currentPropertyId } = useSession();
  const queryClient = useQueryClient();
  const [now] = useState(() => Date.now());
  const end = useMutation({
    mutationFn: () =>
      api.call(
        'checkOut',
        { params: { stayId: row.stayId }, body: { keysReturned: true } },
        { ifMatch: `"${row.version}"` },
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: frontDeskKey(currentPropertyId) }),
  });
  const status = (
    <span className={cn('rounded px-1.5 text-xs', STATUS_TONE[row.status])}>
      {t(`reservations.status.${row.status}`)}
    </span>
  );

  if (tab === 'arrivals') {
    if (permissions.includes('reservation.checkin') && canCheckInNow(row, today, now)) {
      return (
        <Link
          to={`/reservations/${row.reservationId}?checkIn=${row.stayId}`}
          aria-label={t('frontDesk.checkInNamed', { name })}
          className="inline-flex h-8 items-center rounded-md bg-brand px-3 text-on-brand hover:bg-brand-strong"
        >
          {t('checkIn.open')}
        </Link>
      );
    }
    return status;
  }
  if (tab === 'departures' && row.status === 'CHECKED_IN') {
    if (row.dayUse && permissions.includes('reservation.checkout')) {
      return (
        <div className="flex flex-col gap-1">
          <Button
            size="sm"
            disabled={end.isPending}
            aria-label={t('frontDesk.endNamed', { name })}
            onClick={() => end.mutate()}
          >
            {t('dayUse.end')}
          </Button>
          {end.error && <span className="text-xs text-critical">{errorMessage(end.error)}</span>}
        </div>
      );
    }
    return <span className="text-xs text-text-muted">{t('frontDesk.checkOutLater')}</span>;
  }
  if (row.status === 'CHECKED_OUT' && row.checkedOutAt) {
    return (
      <span className="text-xs text-text-muted">
        {t('frontDesk.left', { time: f.time(row.checkedOutAt) })}
      </span>
    );
  }
  return status;
}
