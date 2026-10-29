import {
  localDate,
  type DayUseRoomType,
  type GUARANTEES,
  type ReservationItem,
} from '@hotel/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { useFormats } from './reservations.tsx';

// Day-use (PRD M3-10; T-052): a room for a start time and duration on one date, priced by the
// day-use plan for that date. The room is chosen at the sale and held for those hours; the
// same room can still be sold for the night. A guest for today goes straight to check-in; the
// desk ends the stay from the reservation page and the room becomes dirty.

type Reservation = z.output<typeof ReservationItem>;
type Stay = Reservation['stays'][number];
type RoomType = z.output<typeof DayUseRoomType>;
type Plan = RoomType['plans'][number];

interface Search {
  date: string;
  start: string;
  minutes: number;
  adults: number;
  children: number;
}

const HOURS = [1, 2, 3, 4, 5, 6, 8, 10, 12] as const;
const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';
const orNull = (s: string) => (s.trim() ? s.trim() : null);

/** The time at the property now, rounded down to five minutes, as `HH:MM`. */
function nowAt(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(new Date());
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return `${hour}:${String(minute - (minute % 5)).padStart(2, '0')}`;
}

/** "10 Nov 2026 · 10:00–14:00 · Day-use", and "Overdue" once a guest in the room is past it. */
export function DayUseTimes({ stay }: { stay: Stay }) {
  const { t } = useTranslation();
  const f = useFormats();
  // The clock moves on while the page is open: look again every minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!stay.dayUse) return null;
  const overdue = stay.status === 'CHECKED_IN' && Date.parse(stay.dayUse.endsAt) < now;
  return (
    <>
      {f.date(stay.arrival)} · {f.time(stay.dayUse.startsAt)}–{f.time(stay.dayUse.endsAt)} ·{' '}
      {t('dayUse.tag')}
      {overdue && (
        <span className="ml-2 rounded bg-critical-subtle px-1.5 text-xs text-critical">
          {t('dayUse.overdue')}
        </span>
      )}
    </>
  );
}

/** Ends a checked-in day-use stay: keys back, room dirty (housekeeping rule 2). */
export function EndDayUse({ stay, onDone }: { stay: Stay; onDone: () => void }) {
  const { t } = useTranslation();
  const end = useMutation({
    mutationFn: () =>
      api.call(
        'checkOut',
        { params: { stayId: stay.id }, body: { keysReturned: true } },
        { ifMatch: `"${stay.version}"` },
      ),
    onSuccess: onDone,
  });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={end.isPending} onClick={() => end.mutate()}>
        {t('dayUse.end')}
      </Button>
      <span className="text-xs text-text-muted">{t('dayUse.endHint')}</span>
      {end.error && <Alert tone="critical">{errorMessage(end.error)}</Alert>}
    </div>
  );
}

export function DayUsePage() {
  const { t } = useTranslation();
  const session = useSession();
  const f = useFormats();
  const navigate = useNavigate();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const timeZone = property?.timeZone ?? 'Africa/Lagos';
  const today = localDate(new Date(), timeZone);

  const [draft, setDraft] = useState<Search>(() => ({
    date: today,
    start: nowAt(timeZone),
    minutes: 180,
    adults: 1,
    children: 0,
  }));
  const [search, setSearch] = useState<Search | null>(null);
  const [choice, setChoice] = useState<{ type: RoomType; plan: Plan } | null>(null);
  const [roomId, setRoomId] = useState('');
  const [guest, setGuest] = useState({ firstName: '', lastName: '', phone: '' });

  const offers = useQuery({
    queryKey: ['bookings', session.currentPropertyId ?? '', 'day-use', search],
    queryFn: () => api.call('getDayUseAvailability', { query: search as Search }),
    enabled: search !== null,
  });

  const sell = useMutation({
    mutationFn: () => {
      if (!search || !choice) throw new Error('Nothing chosen');
      const guarantee: (typeof GUARANTEES)[number] =
        choice.plan.guarantee === 'COMPANY' ? 'NONE' : choice.plan.guarantee;
      return api.call('createDayUse', {
        body: {
          ...search,
          roomTypeId: choice.type.roomTypeId,
          ratePlanId: choice.plan.ratePlanId,
          roomId,
          source: 'WALK_IN',
          guarantee,
          booker: {
            guestId: null,
            firstName: guest.firstName.trim(),
            lastName: guest.lastName.trim(),
            phone: orNull(guest.phone),
            email: null,
          },
          notes: null,
        },
      });
    },
    onSuccess: (r) => {
      const stay = r.stays[0];
      void navigate(
        stay && search?.date === today
          ? `/reservations/${r.id}?checkIn=${stay.id}`
          : `/reservations/${r.id}`,
      );
    },
  });

  const ready =
    choice !== null &&
    roomId !== '' &&
    guest.firstName.trim() !== '' &&
    guest.lastName.trim() !== '';
  const set = <K extends keyof Search>(k: K, v: Search[K]) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <section className="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('dayUse.title')}</h1>
        <Link to="/bookings/new?mode=walk-in" className="text-sm text-brand underline">
          {t('dayUse.toWalkIn')}
        </Link>
      </div>

      {/* 1. When and who */}
      <form
        aria-label={t('dayUse.searchTitle')}
        className="mt-4 grid items-end gap-3 rounded-md border border-border bg-surface p-4 sm:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          setChoice(null);
          setRoomId('');
          setSearch({ ...draft });
        }}
      >
        <Field id="du-date" label={t('dayUse.date')}>
          <Input
            id="du-date"
            type="date"
            min={today}
            value={draft.date}
            onChange={(e) => set('date', e.target.value)}
          />
        </Field>
        <Field id="du-start" label={t('dayUse.start')}>
          <Input
            id="du-start"
            type="time"
            step={300}
            value={draft.start}
            onChange={(e) => set('start', e.target.value)}
          />
        </Field>
        <Field id="du-hours" label={t('dayUse.hours')}>
          <select
            id="du-hours"
            className={selectClass}
            value={String(draft.minutes)}
            onChange={(e) => set('minutes', Number(e.target.value))}
          >
            {HOURS.map((h) => (
              <option key={h} value={String(h * 60)}>
                {t('dayUse.hoursN', { count: h })}
              </option>
            ))}
          </select>
        </Field>
        <Field id="du-adults" label={t('reservations.adults')}>
          <Input
            id="du-adults"
            type="number"
            min={1}
            max={20}
            value={String(draft.adults)}
            onChange={(e) => set('adults', Number(e.target.value))}
          />
        </Field>
        <Field id="du-children" label={t('reservations.children')}>
          <Input
            id="du-children"
            type="number"
            min={0}
            max={20}
            value={String(draft.children)}
            onChange={(e) => set('children', Number(e.target.value))}
          />
        </Field>
        <Button type="submit">{t('booking.search')}</Button>
      </form>

      {offers.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(offers.error)}
        </Alert>
      )}

      {/* 2. Room type and plan */}
      {offers.data && (
        <div className="mt-4">
          <h2 className="font-semibold">
            {t('dayUse.results', {
              from: f.time(offers.data.startsAt),
              to: f.time(offers.data.endsAt),
            })}
          </h2>
          {offers.data.roomTypes.length === 0 && (
            <p className="mt-2 text-sm text-text-muted">{t('dayUse.noPlans')}</p>
          )}
          <ul className="mt-2 flex flex-col gap-3">
            {offers.data.roomTypes.map((type) => (
              <li
                key={type.roomTypeId}
                className="rounded-md border border-border bg-surface p-3 text-sm"
              >
                <p className="font-medium">
                  {type.name}{' '}
                  <span className="font-normal text-text-muted">
                    · {t('dayUse.roomsFree', { count: type.rooms.length })}
                  </span>
                </p>
                <table
                  aria-label={t('booking.plansFor', { type: type.name })}
                  className="mt-2 w-full text-left"
                >
                  <tbody>
                    {type.plans.map((plan) => (
                      <tr key={plan.ratePlanId} className="border-t border-border">
                        <td className="py-2 pr-2">
                          {plan.name}{' '}
                          <span className="text-text-muted">
                            · {t('dayUse.upTo', { count: plan.maxMinutes / 60 })}
                          </span>
                          {!plan.sellable && (
                            <span className="block text-xs text-critical">
                              {plan.violations.length > 0
                                ? plan.violations
                                    .map((v) =>
                                      t(`booking.violations.${v.rule}`, {
                                        n: v.limit ?? 0,
                                        date: f.date(v.date),
                                      }),
                                    )
                                    .join(' · ')
                                : search && search.minutes > plan.maxMinutes
                                  ? t('dayUse.tooLong')
                                  : t('dayUse.noRoom')}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">
                          {plan.totalMinor !== null ? f.money(plan.totalMinor) : '—'}
                        </td>
                        <td className="w-28 py-2 text-right">
                          <Button
                            size="sm"
                            variant={
                              choice?.plan.ratePlanId === plan.ratePlanId ? 'primary' : 'secondary'
                            }
                            disabled={!plan.sellable}
                            aria-label={t('booking.addNamed', { type: type.name, plan: plan.name })}
                            onClick={() => {
                              setChoice({ type, plan });
                              setRoomId(type.rooms[0]?.id ?? '');
                            }}
                          >
                            {t('dayUse.choose')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 3. Room and guest, then sell */}
      {choice && (
        <form
          aria-label={t('dayUse.detailsTitle')}
          className="mt-6 flex flex-col gap-4 rounded-md border border-border bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) sell.mutate();
          }}
        >
          <Field id="du-room" label={t('reservations.room.label')}>
            <select
              id="du-room"
              className={selectClass}
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
            >
              {choice.type.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.number} · {t(`rooms.hk.${r.hkStatus}`)}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="du-first" label={t('booking.firstName')}>
              <Input
                id="du-first"
                required
                value={guest.firstName}
                onChange={(e) => setGuest((g) => ({ ...g, firstName: e.target.value }))}
              />
            </Field>
            <Field id="du-last" label={t('booking.lastName')}>
              <Input
                id="du-last"
                required
                value={guest.lastName}
                onChange={(e) => setGuest((g) => ({ ...g, lastName: e.target.value }))}
              />
            </Field>
            <Field id="du-phone" label={t('booking.phone')}>
              <Input
                id="du-phone"
                type="tel"
                placeholder="+2348031234567"
                value={guest.phone}
                onChange={(e) => setGuest((g) => ({ ...g, phone: e.target.value }))}
              />
            </Field>
          </div>
          {sell.error && <Alert tone="critical">{errorMessage(sell.error)}</Alert>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!ready || sell.isPending}>
              {t('dayUse.sell', { total: f.money(choice.plan.totalMinor ?? '0') })}
            </Button>
            <Link to="/reservations" className="text-sm text-brand underline">
              {t('booking.cancel')}
            </Link>
          </div>
        </form>
      )}
    </section>
  );
}

function Field(props: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
    </div>
  );
}
