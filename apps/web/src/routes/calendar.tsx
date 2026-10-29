import { addDays, daysBetween, localDate, type CalendarStay } from '@hotel/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { STATUS_TONE } from './reservations.tsx';
import { BlockForm } from './settings/rooms-tab.tsx';
import { useRoomData, type Room } from './settings/rooms.tsx';

// S07 Reservation calendar (tape chart; T-044): room types and their rooms down the side,
// dates across. Stays without a room sit on their type's "Unassigned" rows (assigning and
// moving rooms by dragging arrives with T-050); blocks show on their room's row; the type's
// row shows rooms left per night. Users with room.block can block a room from here.

type Stay = z.output<typeof CalendarStay>;
const DAYS = 14;

/** Packs stays into as few rows as possible, none overlapping (arrival order). */
export function lanes(stays: Stay[]): Stay[][] {
  const rows: Stay[][] = [];
  for (const s of [...stays].sort((a, b) => a.arrival.localeCompare(b.arrival))) {
    const free = rows.find((row) => (row.at(-1)?.departure ?? '') <= s.arrival);
    if (free) free.push(s);
    else rows.push([s]);
  }
  return rows;
}

interface Window {
  from: string;
  /** Exclusive. */
  to: string;
  today: string;
  dates: string[];
}

const COLUMNS: CSSProperties = {
  gridTemplateColumns: `8rem repeat(${DAYS}, minmax(3.25rem, 1fr))`,
};

/** Grid columns a date range covers inside the window (column 1 is the label). */
const span = (w: Window, start: string, end: string): CSSProperties => ({
  gridRow: 1,
  gridColumnStart: 2 + Math.max(0, daysBetween(w.from, start)),
  gridColumnEnd: 2 + Math.min(DAYS, daysBetween(w.from, end)),
});

function Row(props: { w: Window; label: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div role="row" className={cn('grid border-b border-border', props.className)} style={COLUMNS}>
      <div role="rowheader" className="sticky left-0 z-10 truncate bg-surface p-1.5 text-xs">
        {props.label}
      </div>
      {props.w.dates.map((d, i) => (
        <div
          key={d}
          aria-hidden
          className={cn('border-l border-border', d === props.w.today && 'bg-brand-subtle/40')}
          style={{ gridRow: 1, gridColumn: i + 2 }}
        />
      ))}
      {props.children}
    </div>
  );
}

function StayBar({ w, s }: { w: Window; s: Stay }) {
  const { t } = useTranslation();
  const status = t(`reservations.status.${s.status}`);
  return (
    <Link
      to={`/reservations/${s.reservationId}`}
      title={`${s.guestName} · ${s.confirmationNo} · ${status}`}
      aria-label={t('calendar.stayLabel', { guest: s.guestName, no: s.confirmationNo, status })}
      className={cn(
        'z-0 m-0.5 truncate rounded px-1.5 py-0.5 text-xs font-medium',
        STATUS_TONE[s.status],
        s.arrival < w.from && 'rounded-l-none',
        s.departure > w.to && 'rounded-r-none',
      )}
      style={span(w, s.arrival, s.departure)}
    >
      {s.guestName} · {status}
    </Link>
  );
}

export function CalendarPage() {
  const { t } = useTranslation();
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const locale = property?.locale ?? 'en-NG';
  const today = localDate(new Date(), property?.timeZone ?? 'Africa/Lagos');
  const [from, setFrom] = useState(today);
  const [blocking, setBlocking] = useState<Room | null>(null);
  const [blockRoomId, setBlockRoomId] = useState('');
  const to = addDays(from, DAYS);
  const can = (p: string) => session.permissions.includes(p);
  const pid = session.currentPropertyId ?? '';

  const { types, rooms } = useRoomData();
  const stays = useQuery({
    queryKey: ['rooms', pid, 'calendar', from],
    queryFn: async () => (await api.call('getCalendar', { query: { from, to } })).data,
    // Keep the last window on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
  const left = useQuery({
    queryKey: ['rooms', pid, 'calendar-left', from],
    queryFn: async () =>
      (await api.call('getInventory', { query: { from, to: addDays(to, -1) } })).days,
    enabled: can('availability.read'),
    placeholderData: keepPreviousData,
  });

  const error = stays.error ?? types.error ?? rooms.error;
  if (error) return <Alert tone="critical">{errorMessage(error)}</Alert>;
  if (!stays.data || !types.data || !rooms.data) {
    return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  }

  const dates = Array.from({ length: DAYS }, (_, i) => addDays(from, i));
  const w: Window = { from, to, today, dates };
  const leftOn = new Map((left.data ?? []).map((d) => [`${d.roomTypeId} ${d.date}`, d.available]));
  const activeRooms = rooms.data.filter((r) => r.active);
  const heading = (date: string) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${date}T00:00:00Z`),
    );
  const range = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('calendar.title')}</h1>
        <div className="flex flex-wrap gap-2">
          {can('reservation.create') && (
            <>
              <Link
                to="/bookings/new"
                className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-on-brand"
              >
                {t('calendar.newBooking')}
              </Link>
              <Link
                to="/bookings/new?mode=walk-in"
                className="rounded-md border border-border px-3 py-2 text-sm font-medium"
              >
                {t('calendar.walkIn')}
              </Link>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('calendar.earlier')}
          onClick={() => setFrom(addDays(from, -7))}
        >
          <ChevronLeft aria-hidden className="size-4" />
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setFrom(today)}>
          {t('calendar.today')}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('calendar.later')}
          onClick={() => setFrom(addDays(from, 7))}
        >
          <ChevronRight aria-hidden className="size-4" />
        </Button>
        <span className="text-sm" aria-live="polite">
          {range.format(new Date(`${from}T00:00:00Z`))} –{' '}
          {range.format(new Date(`${addDays(to, -1)}T00:00:00Z`))}
        </span>
        {can('room.block') && (
          <form
            className="ml-auto flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setBlocking(activeRooms.find((r) => r.id === blockRoomId) ?? null);
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="calendar-block-room">{t('calendar.blockRoom')}</Label>
              <select
                id="calendar-block-room"
                className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
                value={blockRoomId}
                onChange={(e) => setBlockRoomId(e.target.value)}
              >
                <option value="">{t('calendar.chooseRoom')}</option>
                {activeRooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.number}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" size="sm" variant="secondary" disabled={!blockRoomId}>
              {t('calendar.block')}
            </Button>
          </form>
        )}
      </div>
      {blocking && <BlockForm room={blocking} onDone={() => setBlocking(null)} />}

      <div
        role="grid"
        aria-label={t('calendar.gridLabel')}
        className="mt-3 overflow-x-auto rounded-md border border-border bg-surface"
      >
        <div className="min-w-[56rem]">
          <Row w={w} label={t('calendar.room')} className="font-medium">
            {dates.map((d, i) => (
              <div
                key={d}
                role="columnheader"
                className={cn('p-1.5 text-center text-xs', d === today && 'font-semibold')}
                style={{ gridRow: 1, gridColumn: i + 2 }}
              >
                {heading(d)}
              </div>
            ))}
          </Row>
          {types.data.map((type) => {
            const ofType = stays.data.filter((s) => s.roomTypeId === type.id);
            const unassigned = lanes(ofType.filter((s) => s.roomId === null));
            const typeRooms = activeRooms.filter((r) => r.roomTypeId === type.id);
            return (
              <div key={type.id} role="rowgroup" aria-label={type.name}>
                <Row
                  w={w}
                  label={<span className="font-semibold">{type.name}</span>}
                  className="bg-surface-sunken"
                >
                  {left.data &&
                    dates.map((d, i) => {
                      const n = leftOn.get(`${type.id} ${d}`);
                      return (
                        <div
                          key={d}
                          className={cn(
                            'p-1 text-center text-xs tabular-nums',
                            n !== undefined && n <= 0 && 'font-semibold text-critical',
                          )}
                          style={{ gridRow: 1, gridColumn: i + 2 }}
                          title={t('calendar.leftTitle')}
                        >
                          {n === undefined ? '' : t('calendar.left', { count: n })}
                        </div>
                      );
                    })}
                </Row>
                {unassigned.map((lane, i) => (
                  <Row
                    w={w}
                    key={`u${i}`}
                    label={<span className="text-text-muted">{t('calendar.unassigned')}</span>}
                  >
                    {lane.map((s) => (
                      <StayBar key={s.id} w={w} s={s} />
                    ))}
                  </Row>
                ))}
                {typeRooms.map((room) => (
                  <Row
                    w={w}
                    key={room.id}
                    label={
                      <>
                        <span className="font-medium">{room.number}</span>{' '}
                        <span className="text-text-muted">{t(`rooms.hk.${room.hkStatus}`)}</span>
                      </>
                    }
                  >
                    {room.blocks
                      .filter((b) => b.endDate > from && b.startDate < to && !b.releasedAt)
                      .map((b) => (
                        <div
                          key={b.id}
                          title={b.reason}
                          className="z-0 m-0.5 truncate rounded bg-critical-subtle px-1.5 py-0.5 text-xs text-critical"
                          style={span(w, b.startDate, b.endDate)}
                        >
                          {t(`rooms.hk.${b.kind}`)}: {b.reason}
                        </div>
                      ))}
                    {ofType
                      .filter((s) => s.roomId === room.id)
                      .map((s) => (
                        <StayBar key={s.id} w={w} s={s} />
                      ))}
                  </Row>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-xs text-text-muted">{t('calendar.assignLater')}</p>
    </section>
  );
}
