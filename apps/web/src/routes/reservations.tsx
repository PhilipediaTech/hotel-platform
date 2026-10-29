import {
  CANCEL_REASONS,
  GUARANTEES,
  RESERVATION_STATUSES,
  type ReservationItem,
  type ReservationStatus,
} from '@hotel/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { canCheckIn, CheckInPanel, StayKeys, usePropertyToday } from './check-in.tsx';
import { DayUseTimes, EndDayUse } from './day-use.tsx';

// S09 Reservations (PRD M3-01–M3-05; T-042): find reservations; a reservation's stays,
// details, history; change dates or guests (requoted), confirm a hold, cancel with a reason
// and reinstate. New bookings are made on S08 (T-044).

type Reservation = z.output<typeof ReservationItem>;
type Stay = Reservation['stays'][number];
type Guarantee = (typeof GUARANTEES)[number];
type CancelReason = (typeof CANCEL_REASONS)[number];

const reservationsKey = (propertyId: string | null) => ['reservations', propertyId ?? ''];

export function useFormats() {
  const { i18n } = useTranslation();
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const locale = property?.locale ?? i18n.language;
  const timeZone = property?.timeZone ?? 'UTC';
  return {
    money: (minor: string) =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: property?.baseCurrency ?? 'NGN',
      }).format(Number(minor) / 100),
    date: (iso: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(`${iso}T00:00:00Z`),
      ),
    time: (iso: string) =>
      new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(new Date(iso)),
    when: (iso: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
        new Date(iso),
      ),
  };
}

export const STATUS_TONE: Record<ReservationStatus, string> = {
  ENQUIRY: 'bg-surface-sunken text-text-muted',
  TENTATIVE: 'bg-warning-subtle text-warning',
  CONFIRMED: 'bg-brand-subtle text-brand-strong',
  CHECKED_IN: 'bg-success-subtle text-success',
  CHECKED_OUT: 'bg-surface-sunken text-text-muted',
  NO_SHOW: 'bg-critical-subtle text-critical',
  CANCELLED: 'bg-critical-subtle text-critical',
};

export function StatusBadge({ status }: { status: ReservationStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>
      {t(`reservations.status.${status}`)}
    </span>
  );
}

const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';

export function ReservationsPage() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const f = useFormats();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ReservationStatus | ''>('');
  const search = useInfiniteQuery({
    queryKey: [...reservationsKey(currentPropertyId), 'list', q, status],
    queryFn: ({ pageParam }) =>
      api.call('listReservations', {
        query: {
          limit: 25,
          ...(q ? { q } : {}),
          ...(status ? { status } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = search.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('reservations.title')}</h1>
      <form
        role="search"
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(text.trim());
        }}
      >
        <Input
          className="max-w-xs"
          aria-label={t('reservations.search')}
          placeholder={t('reservations.searchHint')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          aria-label={t('reservations.statusLabel')}
          className={selectClass}
          value={status}
          onChange={(e) => setStatus(e.target.value as ReservationStatus | '')}
        >
          <option value="">{t('reservations.allStatuses')}</option>
          {RESERVATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`reservations.status.${s}`)}
            </option>
          ))}
        </select>
        <Button type="submit">{t('guests.find')}</Button>
      </form>
      {search.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(search.error)}
        </Alert>
      )}
      {search.data && rows.length === 0 && (
        <p className="mt-4 text-sm text-text-muted">{t('reservations.none')}</p>
      )}
      {rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table aria-label={t('reservations.found')} className="w-full text-left text-sm">
            <thead className="border-b border-border text-text-muted">
              <tr>
                <th className="p-2 font-medium">{t('reservations.confirmationNo')}</th>
                <th className="p-2 font-medium">{t('reservations.booker')}</th>
                <th className="p-2 font-medium">{t('reservations.arrival')}</th>
                <th className="p-2 font-medium">{t('reservations.departure')}</th>
                <th className="p-2 font-medium">{t('reservations.rooms')}</th>
                <th className="p-2 font-medium">{t('reservations.statusLabel')}</th>
                <th className="p-2 text-right font-medium">{t('reservations.total')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="p-2">
                    <Link to={`/reservations/${r.id}`} className="text-brand underline">
                      {r.confirmationNo}
                    </Link>
                  </td>
                  <td className="p-2">{r.bookerName}</td>
                  <td className="p-2">{f.date(r.arrival)}</td>
                  <td className="p-2">{f.date(r.departure)}</td>
                  <td className="p-2">{r.rooms}</td>
                  <td className="p-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="p-2 text-right tabular-nums">{f.money(r.totalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {search.hasNextPage && (
        <Button
          className="mt-3"
          variant="secondary"
          size="sm"
          onClick={() => void search.fetchNextPage()}
        >
          {t('guests.more')}
        </Button>
      )}
    </section>
  );
}

export function ReservationPage() {
  const { t } = useTranslation();
  const { reservationId = '' } = useParams();
  // A walk-in or day-use just sold opens its check-in form (M3-09: fewest steps).
  const [params] = useSearchParams();
  const checkInNow = params.get('checkIn');
  const { currentPropertyId, permissions } = useSession();
  const f = useFormats();
  const key = [...reservationsKey(currentPropertyId), 'one', reservationId];
  const queryClient = useQueryClient();
  const today = usePropertyToday();
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: reservationsKey(currentPropertyId) });
  const reservation = useQuery({
    queryKey: key,
    queryFn: () => api.call('getReservation', { params: { reservationId } }),
  });
  if (reservation.error) return <Alert tone="critical">{errorMessage(reservation.error)}</Alert>;
  const r = reservation.data;
  if (!r) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  const can = (p: string) => permissions.includes(p);
  const open = r.status === 'ENQUIRY' || r.status === 'TENTATIVE' || r.status === 'CONFIRMED';

  return (
    <section className="max-w-4xl">
      <p className="text-sm">
        <Link to="/reservations" className="text-brand underline">
          {t('reservations.title')}
        </Link>
      </p>
      <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold">
        {r.confirmationNo} <StatusBadge status={r.status} />
      </h1>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-text-muted">{t('reservations.booker')}</dt>
        <dd>
          {r.booker.firstName} {r.booker.lastName} {r.booker.phone ?? ''}
        </dd>
        <dt className="text-text-muted">{t('reservations.source')}</dt>
        <dd>{t(`reservations.sources.${r.source}`)}</dd>
        <dt className="text-text-muted">{t('reservations.total')}</dt>
        <dd className="tabular-nums">{f.money(r.totalMinor)}</dd>
        <dt className="text-text-muted">{t('reservations.depositDue')}</dt>
        <dd className="tabular-nums">{f.money(r.depositDueMinor)}</dd>
        {r.holdExpiresAt && (
          <>
            <dt className="text-text-muted">{t('reservations.holdUntil')}</dt>
            <dd>{f.when(r.holdExpiresAt)}</dd>
          </>
        )}
        {r.cancelReason && (
          <>
            <dt className="text-text-muted">{t('reservations.cancelReason')}</dt>
            <dd>{t(`reservations.reasons.${r.cancelReason}`, { defaultValue: r.cancelReason })}</dd>
          </>
        )}
      </dl>

      <h2 className="mt-6 font-semibold">{t('reservations.stays')}</h2>
      <ul className="mt-2 flex flex-col gap-3">
        {r.stays.map((s) => (
          <li key={s.id} className="rounded-md border border-border bg-surface p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {s.guest.firstName} {s.guest.lastName} · {s.roomTypeName} · {s.ratePlanCode}
              </span>
              <span className="tabular-nums">{f.money(s.totalMinor)}</span>
            </div>
            <p className="text-text-muted">
              {s.dayUse ? (
                <DayUseTimes stay={s} />
              ) : (
                <>
                  {f.date(s.arrival)} → {f.date(s.departure)}
                </>
              )}{' '}
              · {t('reservations.guestsCount', { adults: s.adults, children: s.children })}
            </p>
            {s.dayUse ? (
              s.roomNumber && (
                <p className="mt-2">{t('reservations.room.is', { room: s.roomNumber })}</p>
              )
            ) : (
              <StayRoom reservation={r} stay={s} queryKey={key} />
            )}
            {canCheckIn(s, today, permissions) && (
              <CheckInPanel
                reservation={r}
                stay={s}
                onDone={refresh}
                startOpen={checkInNow === s.id}
              />
            )}
            {s.status === 'CHECKED_IN' && <StayKeys stay={s} />}
            {s.dayUse && s.status === 'CHECKED_IN' && can('reservation.checkout') && (
              <EndDayUse stay={s} onDone={refresh} />
            )}
            {open && !s.dayUse && s.status !== 'CANCELLED' && can('reservation.modify') && (
              <ChangeStay reservation={r} stay={s} queryKey={key} />
            )}
          </li>
        ))}
      </ul>

      {r.status === 'TENTATIVE' && can('reservation.modify') && (
        <ConfirmHold reservation={r} queryKey={key} />
      )}
      {can('reservation.modify') && <DetailsForm reservation={r} queryKey={key} />}
      {open && can('reservation.cancel') && <CancelPanel reservation={r} queryKey={key} />}
      {(r.status === 'CANCELLED' || r.status === 'NO_SHOW') && can('reservation.modify') && (
        <Reinstate reservation={r} queryKey={key} />
      )}
      <History reservationId={r.id} version={r.version} />
    </section>
  );
}

type Props = { reservation: Reservation; queryKey: readonly string[] };

function useSaved(queryKey: readonly string[]) {
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  return (saved: Reservation) => {
    queryClient.setQueryData(queryKey, saved);
    void queryClient.invalidateQueries({ queryKey: reservationsKey(currentPropertyId) });
  };
}

/** M3-03: new dates or guests are priced again; the reservation keeps the new quote. */
function ChangeStay({ reservation, stay, queryKey }: Props & { stay: Stay }) {
  const { t } = useTranslation();
  const f = useFormats();
  const saved = useSaved(queryKey);
  const [editing, setEditing] = useState(false);
  const [arrival, setArrival] = useState(stay.arrival);
  const [departure, setDeparture] = useState(stay.departure);
  const [adults, setAdults] = useState(String(stay.adults));
  const [children, setChildren] = useState(String(stay.children));
  const [difference, setDifference] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: async () => {
      const quote = await api.call('createQuote', {
        body: {
          roomTypeId: stay.roomTypeId,
          ratePlanId: stay.ratePlanId,
          arrival,
          departure,
          adults: Number(adults),
          children: Number(children),
        },
      });
      return api.call(
        'updateReservation',
        {
          params: { reservationId: reservation.id },
          body: {
            stays: [
              {
                stayId: stay.id,
                quoteId: quote.quoteId,
                adults: Number(adults),
                children: Number(children),
              },
            ],
          },
        },
        { ifMatch: `"${reservation.version}"` },
      );
    },
    onSuccess: (result) => {
      setDifference(result.differenceMinor);
      setEditing(false);
      saved(result);
    },
  });
  if (!editing) {
    return (
      <div className="mt-2 flex items-center gap-3">
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
          {t('reservations.changeStay')}
        </Button>
        {difference !== null && (
          <span role="status" className="text-sm">
            {t('reservations.difference', { amount: f.money(difference) })}
          </span>
        )}
      </div>
    );
  }
  return (
    <form
      aria-label={t('reservations.changeStay')}
      className="mt-2 grid items-end gap-3 sm:grid-cols-5"
      onSubmit={(e) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      <DateField label={t('reservations.arrival')} value={arrival} onChange={setArrival} />
      <DateField label={t('reservations.departure')} value={departure} onChange={setDeparture} />
      <NumberField label={t('reservations.adults')} value={adults} onChange={setAdults} min={1} />
      <NumberField
        label={t('reservations.children')}
        value={children}
        onChange={setChildren}
        min={0}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={change.isPending}>
          {t('reservations.reprice')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          {t('guests.cancel')}
        </Button>
      </div>
      {change.error && (
        <Alert tone="critical" className="sm:col-span-5">
          {errorMessage(change.error)}
        </Alert>
      )}
    </form>
  );
}

/**
 * M3-07, M3-11 (T-050): the stay's room; give or change it before check-in (a room that is
 * not ready for a guest arriving today needs a manager), move a checked-in guest with a reason.
 */
function StayRoom({ reservation, stay, queryKey }: Props & { stay: Stay }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const saved = useSaved(queryKey);
  const [open, setOpen] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const inHouse = stay.status === 'CHECKED_IN';
  const planned = stay.status === 'TENTATIVE' || stay.status === 'CONFIRMED';
  const allowed = inHouse ? permissions.includes('room.move') : permissions.includes('room.assign');
  const rooms = useQuery({
    queryKey: ['rooms', reservation.id, 'for-stay', stay.id, stay.version],
    queryFn: async () =>
      (await api.call('listAssignableRooms', { params: { stayId: stay.id } })).data,
    enabled: open,
  });
  const chosen = rooms.data?.find((r) => r.id === roomId);
  const needsManager = !inHouse && (chosen?.problems.length ?? 0) > 0;
  const done = (result: Reservation | { approvalRequestId: string }) => {
    setOpen(false);
    setRoomId('');
    setReason('');
    if ('approvalRequestId' in result) {
      setMessage(t('reservations.room.sentForApproval'));
      return;
    }
    setMessage(null);
    saved(result);
  };
  const give = useMutation({
    mutationFn: (to: string | null) =>
      api.call('assignRoom', {
        params: { stayId: stay.id },
        body: { roomId: to, ...(needsManager && to ? { overrideReason: reason.trim() } : {}) },
      }),
    onSuccess: done,
  });
  const move = useMutation({
    mutationFn: () =>
      api.call('moveStay', {
        params: { stayId: stay.id },
        body: { roomId, reason: reason.trim() },
      }),
    onSuccess: done,
  });
  const error = give.error ?? move.error;
  if (!planned && !inHouse) return null;

  return (
    <div className="mt-2">
      <p className="flex flex-wrap items-center gap-2">
        <span>
          {stay.roomNumber
            ? t('reservations.room.is', { room: stay.roomNumber })
            : t('reservations.room.none')}
        </span>
        {allowed && !open && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            {inHouse
              ? t('reservations.room.move')
              : stay.roomNumber
                ? t('reservations.room.change')
                : t('reservations.room.choose')}
          </Button>
        )}
        {allowed && !open && planned && stay.roomNumber && (
          <Button
            size="sm"
            variant="ghost"
            disabled={give.isPending}
            onClick={() => give.mutate(null)}
          >
            {t('reservations.room.release')}
          </Button>
        )}
      </p>
      {message && (
        <Alert tone="success" className="mt-2">
          {message}
        </Alert>
      )}
      {open && (
        <form
          aria-label={inHouse ? t('reservations.room.move') : t('reservations.room.choose')}
          className="mt-2 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (inHouse) move.mutate();
            else give.mutate(roomId);
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`room-${stay.id}`}>{t('reservations.room.label')}</Label>
            <select
              id={`room-${stay.id}`}
              className={selectClass}
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
            >
              <option value="">
                {rooms.data && rooms.data.length === 0
                  ? t('reservations.room.noneFree')
                  : t('reservations.room.pick')}
              </option>
              {(rooms.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.number} · {t(`rooms.hk.${r.hkStatus}`)}
                  {r.problems.length > 0
                    ? ` · ${r.problems.map((p) => t(`reservations.room.problems.${p}`)).join(', ')}`
                    : ''}
                </option>
              ))}
            </select>
          </div>
          {(inHouse || needsManager) && (
            <div className="flex min-w-64 flex-1 flex-col gap-1">
              <Label htmlFor={`room-reason-${stay.id}`}>
                {inHouse ? t('reservations.room.moveReason') : t('reservations.room.managerReason')}
              </Label>
              <Input
                id={`room-reason-${stay.id}`}
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={
              !roomId ||
              ((inHouse || needsManager) && !reason.trim()) ||
              give.isPending ||
              move.isPending
            }
          >
            {inHouse
              ? t('reservations.room.moveNow')
              : needsManager
                ? t('reservations.room.askManager')
                : t('reservations.room.give')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {t('guests.cancel')}
          </Button>
        </form>
      )}
      {error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(error)}
        </Alert>
      )}
    </div>
  );
}

function DateField(props: { label: string; value: string; onChange: (v: string) => void }) {
  const id = `f-${props.label}`;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{props.label}</Label>
      <Input
        id={id}
        type="date"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}

function NumberField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
}) {
  const id = `f-${props.label}`;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{props.label}</Label>
      <Input
        id={id}
        type="number"
        min={props.min}
        max={20}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}

function ConfirmHold({ reservation, queryKey }: Props) {
  const { t } = useTranslation();
  const saved = useSaved(queryKey);
  const confirm = useMutation({
    mutationFn: () =>
      api.call(
        'updateReservation',
        { params: { reservationId: reservation.id }, body: { confirm: true } },
        { ifMatch: `"${reservation.version}"` },
      ),
    onSuccess: saved,
  });
  return (
    <div className="mt-4 rounded-md border border-border bg-surface p-3">
      <p className="text-sm">{t('reservations.holdHelp')}</p>
      <Button
        className="mt-2"
        size="sm"
        disabled={confirm.isPending}
        onClick={() => confirm.mutate()}
      >
        {t('reservations.confirmHold')}
      </Button>
      {confirm.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(confirm.error)}
        </Alert>
      )}
    </div>
  );
}

function DetailsForm({ reservation, queryKey }: Props) {
  const { t } = useTranslation();
  const saved = useSaved(queryKey);
  const [notes, setNotes] = useState(reservation.notes ?? '');
  const [guarantee, setGuarantee] = useState<Guarantee>(reservation.guarantee);
  const save = useMutation({
    mutationFn: () =>
      api.call(
        'updateReservation',
        {
          params: { reservationId: reservation.id },
          body: { notes: notes.trim() === '' ? null : notes.trim(), guarantee },
        },
        { ifMatch: `"${reservation.version}"` },
      ),
    onSuccess: saved,
  });
  return (
    <form
      aria-label={t('reservations.details')}
      className="mt-6 rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="mb-3 font-semibold">{t('reservations.details')}</h2>
      <div className="mb-3 flex flex-col gap-1">
        <Label htmlFor="res-guarantee">{t('reservations.guarantee')}</Label>
        <select
          id="res-guarantee"
          className={`${selectClass} max-w-xs`}
          value={guarantee}
          onChange={(e) => setGuarantee(e.target.value as Guarantee)}
        >
          {GUARANTEES.map((g) => (
            <option key={g} value={g}>
              {t(`reservations.guarantees.${g}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="mb-3 flex flex-col gap-1">
        <Label htmlFor="res-notes">{t('reservations.notes')}</Label>
        <textarea
          id="res-notes"
          className="min-h-20 rounded-md border border-border bg-surface p-2 text-sm"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      {save.error && (
        <Alert tone="critical" className="mb-3">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={save.isPending}>
          {t('guests.save')}
        </Button>
        {save.isSuccess && (
          <span role="status" className="text-sm">
            {t('guests.saved')}
          </span>
        )}
      </div>
    </form>
  );
}

function CancelPanel({ reservation, queryKey }: Props) {
  const { t } = useTranslation();
  const f = useFormats();
  const saved = useSaved(queryKey);
  const [reason, setReason] = useState<CancelReason>('GUEST_REQUEST');
  const [note, setNote] = useState('');
  const [sure, setSure] = useState(false);
  const cancel = useMutation({
    mutationFn: () =>
      api.call('cancelReservation', {
        params: { reservationId: reservation.id },
        body: { reason, note: note.trim() === '' ? null : note.trim() },
      }),
    onSuccess: saved,
  });
  return (
    <section
      aria-label={t('reservations.cancelTitle')}
      className="mt-6 rounded-md border border-border bg-surface p-4"
    >
      <h2 className="mb-3 font-semibold">{t('reservations.cancelTitle')}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="cancel-reason">{t('reservations.cancelReason')}</Label>
          <select
            id="cancel-reason"
            className={selectClass}
            value={reason}
            onChange={(e) => setReason(e.target.value as CancelReason)}
          >
            {CANCEL_REASONS.map((x) => (
              <option key={x} value={x}>
                {t(`reservations.reasons.${x}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="cancel-note">{t('reservations.cancelNote')}</Label>
          <Input id="cancel-note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      {!sure ? (
        <Button className="mt-3" variant="secondary" onClick={() => setSure(true)}>
          {t('reservations.cancel')}
        </Button>
      ) : (
        <div className="mt-3">
          <p className="text-sm">{t('reservations.cancelWarning')}</p>
          <div className="mt-2 flex gap-2">
            <Button disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              {t('reservations.cancelConfirm')}
            </Button>
            <Button variant="ghost" onClick={() => setSure(false)}>
              {t('reservations.keep')}
            </Button>
          </div>
        </div>
      )}
      {cancel.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(cancel.error)}
        </Alert>
      )}
      {cancel.data && (
        <p role="status" className="mt-2 text-sm">
          {t('reservations.cancelled', { fee: f.money(cancel.data.feeMinor) })}
        </p>
      )}
    </section>
  );
}

function Reinstate({ reservation, queryKey }: Props) {
  const { t } = useTranslation();
  const saved = useSaved(queryKey);
  const reinstate = useMutation({
    mutationFn: () =>
      api.call('reinstateReservation', { params: { reservationId: reservation.id } }),
    onSuccess: saved,
  });
  return (
    <div className="mt-6 rounded-md border border-border bg-surface p-4">
      <p className="text-sm">{t('reservations.reinstateHelp')}</p>
      <Button
        className="mt-2"
        variant="secondary"
        disabled={reinstate.isPending}
        onClick={() => reinstate.mutate()}
      >
        {t('reservations.reinstate')}
      </Button>
      {reinstate.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(reinstate.error)}
        </Alert>
      )}
    </div>
  );
}

function History({ reservationId, version }: { reservationId: string; version: number }) {
  const { t } = useTranslation();
  const f = useFormats();
  const { currentPropertyId } = useSession();
  const history = useQuery({
    queryKey: [...reservationsKey(currentPropertyId), 'history', reservationId, version],
    queryFn: async () =>
      (await api.call('getReservationHistory', { params: { reservationId } })).data,
  });
  return (
    <section aria-label={t('reservations.history')} className="mt-6">
      <h2 className="font-semibold">{t('reservations.history')}</h2>
      <ol className="mt-2 flex flex-col gap-1 text-sm">
        {(history.data ?? []).map((h, i) => (
          <li key={i}>
            <span className="text-text-muted">{f.when(h.at)}</span>{' '}
            {h.fromStatus ? `${t(`reservations.status.${h.fromStatus}`)} → ` : ''}
            {t(`reservations.status.${h.toStatus}`)}
            {h.reason ? ` · ${h.reason}` : ''}
            {h.byName ? ` · ${h.byName}` : ''}
          </li>
        ))}
      </ol>
    </section>
  );
}
