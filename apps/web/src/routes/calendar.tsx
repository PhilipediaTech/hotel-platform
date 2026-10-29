import {
  addDays,
  daysBetween,
  localDate,
  SETTABLE_HK_STATUSES,
  type CalendarStay,
} from '@hotel/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Label } from '../components/ui/label.tsx';
import { Input } from '../components/ui/input.tsx';
import { api, ApiError } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { STATUS_TONE, useFormats } from './reservations.tsx';
import { BlockForm } from './settings/rooms-tab.tsx';
import { useRoomData, type Room } from './settings/rooms.tsx';

// S07 Reservation calendar (tape chart; T-044, T-050): room types and their rooms down the
// side, dates across. Stays without a room sit on their type's "Unassigned" rows; dragging a
// booking onto a room gives it that room, dragging it to Unassigned takes the room back (the
// reservation page does the same without a mouse, and moves checked-in guests). Blocks show
// on their room's row; the type's row shows rooms left per night. Users with room.block can
// block a room, housekeeping can set a room's status.

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

function Row(props: {
  w: Window;
  label: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Set on rows a booking can be dropped on. */
  onDrop?: () => void;
}) {
  const { onDrop } = props;
  return (
    <div
      role="row"
      className={cn('grid border-b border-border', props.className)}
      style={COLUMNS}
      onDragOver={onDrop ? (e) => e.preventDefault() : undefined}
      onDrop={
        onDrop
          ? (e) => {
              e.preventDefault();
              onDrop();
            }
          : undefined
      }
    >
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

function StayBar({
  w,
  s,
  start = s.arrival,
  end = s.departure,
  onDragStart,
}: {
  w: Window;
  s: Stay;
  /** The nights shown on this row (a moved guest has a bar on each room). */
  start?: string;
  end?: string;
  onDragStart?: () => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const status = t(`reservations.status.${s.status}`);
  const hours = s.dayUse ? ` · ${f.time(s.dayUse.startsAt)}–${f.time(s.dayUse.endsAt)}` : '';
  return (
    <Link
      to={`/reservations/${s.reservationId}`}
      title={`${s.guestName} · ${s.confirmationNo} · ${status}`}
      aria-label={t('calendar.stayLabel', { guest: s.guestName, no: s.confirmationNo, status })}
      className={cn(
        'z-0 m-0.5 truncate rounded px-1.5 py-0.5 text-xs font-medium',
        STATUS_TONE[s.status],
        start < w.from && 'rounded-l-none',
        end > w.to && 'rounded-r-none',
        onDragStart && 'cursor-grab',
      )}
      style={span(w, start, end)}
      draggable={onDragStart ? true : undefined}
      onDragStart={onDragStart}
    >
      {s.guestName}
      {hours} · {status}
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
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['rooms', pid] });
  const [dragging, setDragging] = useState<Stay | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'critical'; text: string } | null>(null);
  /** A room that is not ready, offered to a manager for approval (M3-07). */
  const [override, setOverride] = useState<{ stay: Stay; room: Room; reason: string } | null>(null);

  const assign = useMutation({
    mutationFn: (v: { stay: Stay; room: Room | null; overrideReason?: string }) =>
      api.call('assignRoom', {
        params: { stayId: v.stay.id },
        body: {
          roomId: v.room?.id ?? null,
          ...(v.overrideReason ? { overrideReason: v.overrideReason } : {}),
        },
      }),
    onSuccess: (result, v) => {
      setOverride(null);
      refresh();
      setNotice({
        tone: 'success',
        text:
          'approvalRequestId' in result
            ? t('calendar.sentForApproval', { room: v.room?.number ?? '' })
            : v.room
              ? t('calendar.assigned', { guest: v.stay.guestName, room: v.room.number })
              : t('calendar.released', { guest: v.stay.guestName }),
      });
    },
    onError: (error, v) => {
      if (error instanceof ApiError && error.code === 'ROOM_NOT_READY' && v.room) {
        setOverride({ stay: v.stay, room: v.room, reason: '' });
        setNotice({ tone: 'critical', text: errorMessage(error) });
        return;
      }
      setNotice({ tone: 'critical', text: errorMessage(error) });
    },
  });
  const setStatus = useMutation({
    mutationFn: (v: { room: Room; hkStatus: (typeof SETTABLE_HK_STATUSES)[number] }) =>
      api.call(
        'setHkStatus',
        { params: { roomId: v.room.id }, body: { hkStatus: v.hkStatus } },
        { ifMatch: `"${v.room.version}"` },
      ),
    onSuccess: refresh,
    onError: (error) => setNotice({ tone: 'critical', text: errorMessage(error) }),
  });
  const canDrag = can('room.assign');
  const canClean = can('hk.work') || can('hk.inspect');

  /** A booking dropped on a room row (or on Unassigned: room null). */
  const dropOn = (room: Room | null, roomTypeId: string) => {
    const stay = dragging;
    setDragging(null);
    if (!stay) return;
    if (stay.roomTypeId !== roomTypeId) {
      setNotice({ tone: 'critical', text: t('calendar.otherType') });
      return;
    }
    if (stay.status === 'CHECKED_IN') {
      setNotice({ tone: 'critical', text: t('calendar.moveOnPage') });
      return;
    }
    if ((room?.id ?? null) === stay.roomId) return;
    setOverride(null);
    assign.mutate({ stay, room });
  };

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
      {notice && (
        <Alert tone={notice.tone} className="mt-3">
          {notice.text}
        </Alert>
      )}
      {override && (
        <form
          aria-label={t('calendar.overrideTitle', { room: override.room.number })}
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            assign.mutate({
              stay: override.stay,
              room: override.room,
              overrideReason: override.reason.trim(),
            });
          }}
        >
          <div className="flex min-w-64 flex-1 flex-col gap-1">
            <Label htmlFor="calendar-override">
              {t('calendar.overrideReason', { room: override.room.number })}
            </Label>
            <Input
              id="calendar-override"
              value={override.reason}
              maxLength={500}
              onChange={(e) => setOverride({ ...override, reason: e.target.value })}
            />
          </div>
          <Button type="submit" size="sm" disabled={!override.reason.trim() || assign.isPending}>
            {t('calendar.askManager')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOverride(null)}>
            {t('calendar.cancel')}
          </Button>
        </form>
      )}

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
            const unassigned = lanes(ofType.filter((s) => s.rooms.length === 0));
            // A day-use stay keeps the room it was sold with.
            const drag = (s: Stay) => (canDrag && !s.dayUse ? () => setDragging(s) : undefined);
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
                    onDrop={canDrag ? () => dropOn(null, type.id) : undefined}
                  >
                    {lane.map((s) => (
                      <StayBar key={s.id} w={w} s={s} onDragStart={drag(s)} />
                    ))}
                  </Row>
                ))}
                {canDrag && unassigned.length === 0 && dragging?.roomTypeId === type.id && (
                  <Row
                    w={w}
                    label={<span className="text-text-muted">{t('calendar.unassigned')}</span>}
                    onDrop={() => dropOn(null, type.id)}
                  />
                )}
                {typeRooms.map((room) => (
                  <Row
                    w={w}
                    key={room.id}
                    label={
                      <>
                        <span className="font-medium">{room.number}</span>{' '}
                        {canClean && !room.hkStatus.startsWith('OUT_OF') ? (
                          <select
                            aria-label={t('calendar.hkOf', { room: room.number })}
                            className="bg-transparent text-text-muted"
                            value={room.hkStatus}
                            disabled={setStatus.isPending}
                            onChange={(e) =>
                              setStatus.mutate({
                                room,
                                hkStatus: e.target.value as (typeof SETTABLE_HK_STATUSES)[number],
                              })
                            }
                          >
                            {SETTABLE_HK_STATUSES.filter(
                              (h) => h !== 'INSPECTED' || can('hk.inspect'),
                            ).map((h) => (
                              <option key={h} value={h}>
                                {t(`rooms.hk.${h}`)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-text-muted">{t(`rooms.hk.${room.hkStatus}`)}</span>
                        )}
                      </>
                    }
                    onDrop={canDrag ? () => dropOn(room, type.id) : undefined}
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
                    {ofType.flatMap((s) =>
                      s.rooms
                        .filter((a) => a.roomId === room.id)
                        .map((a) => (
                          <StayBar
                            key={`${s.id} ${a.startDate}`}
                            w={w}
                            s={s}
                            start={a.startDate}
                            end={a.endDate}
                            onDragStart={drag(s)}
                          />
                        )),
                    )}
                  </Row>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {canDrag && <p className="mt-2 text-xs text-text-muted">{t('calendar.dragHelp')}</p>}
    </section>
  );
}
