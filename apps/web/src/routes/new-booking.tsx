import {
  addDays,
  type ApprovalPending,
  BOOKING_SOURCES,
  GUARANTEES,
  localDate,
  type AvailabilityRoomType,
  type BookingSource,
} from '@hotel/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api, ApiError } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { useFormats } from './reservations.tsx';

// S08 Availability search and new booking (PRD M3-01, M3-02, M3-05, M3 rule 8; T-044):
// dates and guests → room types with the price per plan → guest details → guarantee →
// confirm. Each room is quoted (POST /quotes) and the booking made from the quotes
// (POST /reservations). Walk-in mode books from today, source Walk-in, confirmed, and opens
// the check-in form on the new reservation (M3-09: at most six steps; T-052).

type RoomType = z.output<typeof AvailabilityRoomType>;
type Plan = RoomType['plans'][number];
type Guarantee = (typeof GUARANTEES)[number];

interface Search {
  arrival: string;
  departure: string;
  adults: number;
  children: number;
}

interface Person {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

interface CartRoom {
  key: number;
  roomTypeId: string;
  roomTypeName: string;
  plan: Plan;
  adults: number;
  children: number;
  /** Null: the booker stays in this room. */
  guest: Person | null;
}

interface Pending {
  expiresAt: string;
  approverRoles: string[];
}

const HOLD_HOURS = [1, 4, 24, 48, 72] as const;
const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';
const noPerson: Person = { firstName: '', lastName: '', phone: '', email: '' };
const orNull = (s: string) => (s.trim() ? s.trim() : null);

/** The strongest guarantee the chosen plans ask for (company is set on the reservation). */
const GUARANTEE_ORDER: Guarantee[] = ['NONE', 'CARD_ON_FILE', 'DEPOSIT', 'COMPANY'];
function guaranteeFor(cart: CartRoom[]): Guarantee {
  const wanted = cart.map((r) => GUARANTEE_ORDER.indexOf(r.plan.guarantee));
  const i = Math.max(0, ...wanted);
  const g = GUARANTEE_ORDER[i] ?? 'NONE';
  return g === 'COMPANY' ? 'NONE' : g;
}

export function NewBookingPage() {
  const { t } = useTranslation();
  const session = useSession();
  const f = useFormats();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const walkIn = params.get('mode') === 'walk-in';
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const today = localDate(new Date(), property?.timeZone ?? 'Africa/Lagos');
  const canFindGuests = session.permissions.includes('guest.manage');

  const [draft, setDraft] = useState<Search>({
    arrival: today,
    departure: addDays(today, 1),
    adults: 1,
    children: 0,
  });
  const [search, setSearch] = useState<Search | null>(null);
  const [cart, setCart] = useState<CartRoom[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [booker, setBooker] = useState<Person>(noPerson);
  const [bookerId, setBookerId] = useState<{ id: string; name: string } | null>(null);
  const [source, setSource] = useState<BookingSource>('PHONE');
  const [guarantee, setGuarantee] = useState<Guarantee | null>(null);
  const [holdHours, setHoldHours] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [approvalReason, setApprovalReason] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const arrival = walkIn ? today : draft.arrival;
  const availability = useQuery({
    queryKey: ['bookings', session.currentPropertyId ?? '', 'availability', search],
    queryFn: () => api.call('getAvailability', { query: search as Search }),
    enabled: search !== null,
  });

  const setMode = (next: boolean) => {
    setParams(next ? { mode: 'walk-in' } : {}, { replace: true });
    setCart([]);
    setSearch(null);
    setHoldHours(null);
  };

  const startOver = () => {
    setPending(null);
    setCart([]);
    setSearch(null);
    setBooker(noPerson);
    setBookerId(null);
    setGuarantee(null);
    setHoldHours(null);
    setNotes('');
    setApprovalReason(null);
  };

  const add = (type: RoomType, plan: Plan) => {
    if (!search) return;
    setCart((c) => [
      ...c,
      {
        key: nextKey,
        roomTypeId: type.roomTypeId,
        roomTypeName: type.name,
        plan,
        adults: search.adults,
        children: search.children,
        guest: c.length === 0 ? null : { ...noPerson },
      },
    ]);
    setNextKey((k) => k + 1);
  };

  const book = useMutation({
    mutationFn: async () => {
      if (!search) throw new Error('No search');
      const stays = [];
      for (const room of cart) {
        const quote = await api.call('createQuote', {
          body: {
            roomTypeId: room.roomTypeId,
            ratePlanId: room.plan.ratePlanId,
            arrival: search.arrival,
            departure: search.departure,
            adults: room.adults,
            children: room.children,
          },
        });
        stays.push({
          quoteId: quote.quoteId,
          adults: room.adults,
          children: room.children,
          guest: room.guest
            ? {
                sameAsBooker: false,
                guestId: null,
                firstName: room.guest.firstName.trim(),
                lastName: room.guest.lastName.trim(),
                phone: orNull(room.guest.phone),
                email: orNull(room.guest.email),
              }
            : { sameAsBooker: true, guestId: null, phone: null, email: null },
          roomId: null,
        });
      }
      return api.call('createReservation', {
        body: {
          source: walkIn ? 'WALK_IN' : source,
          guarantee: guarantee ?? guaranteeFor(cart),
          holdUntil:
            !walkIn && holdHours !== null
              ? new Date(Date.now() + holdHours * 3_600_000).toISOString()
              : null,
          booker: bookerId
            ? { guestId: bookerId.id, phone: null, email: null }
            : {
                guestId: null,
                firstName: booker.firstName.trim(),
                lastName: booker.lastName.trim(),
                phone: orNull(booker.phone),
                email: orNull(booker.email),
              },
          companyId: null,
          stays,
          notes: orNull(notes),
          ...(approvalReason?.trim() ? { approvalReason: approvalReason.trim() } : {}),
        },
      });
    },
    onSuccess: (result) => {
      // 202: a do-not-rent guest waits for a manager (M3 rule 8).
      // The contract types the 201 body only, so the 202 one is told apart by its fields.
      if ('approvalRequestId' in result) {
        const request = result as unknown as z.output<typeof ApprovalPending>;
        setPending({ expiresAt: request.expiresAt, approverRoles: request.approverRoles });
        return;
      }
      const first = result.stays[0];
      void navigate(
        walkIn && first
          ? `/reservations/${result.id}?checkIn=${first.id}`
          : `/reservations/${result.id}`,
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details?.['doNotRent']) setApprovalReason('');
    },
  });

  if (pending) {
    return (
      <section className="max-w-3xl">
        <h1 className="text-xl font-semibold">{t('booking.title')}</h1>
        <Alert tone="success" className="mt-4">
          {t('booking.sentForApproval', {
            roles: pending.approverRoles.join(', '),
            time: f.when(pending.expiresAt),
          })}
        </Alert>
        <Button className="mt-4" variant="secondary" onClick={startOver}>
          {t('booking.another')}
        </Button>
      </section>
    );
  }

  const total = cart.reduce((sum, r) => sum + BigInt(r.plan.totalMinor ?? '0'), 0n);
  const bookerReady = bookerId !== null || (booker.firstName.trim() && booker.lastName.trim());
  const guestsReady = cart.every(
    (r) => r.guest === null || (r.guest.firstName.trim() && r.guest.lastName.trim()),
  );
  const needsReason = approvalReason !== null;
  const ready =
    cart.length > 0 &&
    bookerReady &&
    guestsReady &&
    (!needsReason || (approvalReason ?? '').trim().length > 0);

  return (
    <section className="max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          {walkIn ? t('booking.walkInTitle') : t('booking.title')}
        </h1>
        <span className="flex flex-wrap items-center gap-2">
          {session.permissions.includes('reservation.dayuse') && (
            <Link to="/bookings/day-use" className="text-sm text-brand underline">
              {t('booking.toDayUse')}
            </Link>
          )}
          <Button variant="secondary" size="sm" onClick={() => setMode(!walkIn)}>
            {walkIn ? t('booking.toAdvance') : t('booking.toWalkIn')}
          </Button>
        </span>
      </div>

      {/* 1. Dates and guests */}
      <form
        aria-label={t('booking.searchTitle')}
        className="mt-4 grid items-end gap-3 rounded-md border border-border bg-surface p-4 sm:grid-cols-5"
        onSubmit={(e) => {
          e.preventDefault();
          setCart([]);
          setSearch({ ...draft, arrival });
        }}
      >
        <SmallField
          label={t('reservations.arrival')}
          type="date"
          min={today}
          value={arrival}
          disabled={walkIn}
          onChange={(v) => setDraft((d) => ({ ...d, arrival: v }))}
        />
        <SmallField
          label={t('reservations.departure')}
          type="date"
          min={arrival ? addDays(arrival, 1) : today}
          value={draft.departure}
          onChange={(v) => setDraft((d) => ({ ...d, departure: v }))}
        />
        <SmallField
          label={t('reservations.adults')}
          type="number"
          min={1}
          max={20}
          value={String(draft.adults)}
          onChange={(v) => setDraft((d) => ({ ...d, adults: Number(v) }))}
        />
        <SmallField
          label={t('reservations.children')}
          type="number"
          min={0}
          max={20}
          value={String(draft.children)}
          onChange={(v) => setDraft((d) => ({ ...d, children: Number(v) }))}
        />
        <Button type="submit">{t('booking.search')}</Button>
      </form>

      {/* 2. Room types with the price per plan */}
      {availability.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(availability.error)}
        </Alert>
      )}
      {availability.data && (
        <div className="mt-4">
          <h2 className="font-semibold">
            {t('booking.results', { count: availability.data.nights })}
          </h2>
          {availability.data.roomTypes.length === 0 && (
            <p className="mt-2 text-sm text-text-muted">{t('booking.noTypes')}</p>
          )}
          <ul className="mt-2 flex flex-col gap-3">
            {availability.data.roomTypes.map((type) => (
              <li
                key={type.roomTypeId}
                className="rounded-md border border-border bg-surface p-3 text-sm"
              >
                <p className="font-medium">
                  {type.name}{' '}
                  <span className="font-normal text-text-muted">
                    · {t('booking.left', { count: Math.max(0, type.available) })}
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
                            · {t(`rates.meals.${plan.mealPlan}`)}
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
                                : t('booking.soldOut')}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">
                          {plan.totalMinor !== null ? f.money(plan.totalMinor) : '—'}
                        </td>
                        <td className="w-28 py-2 text-right">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={
                              !plan.sellable ||
                              cart.filter((r) => r.roomTypeId === type.roomTypeId).length >=
                                type.available
                            }
                            aria-label={t('booking.addNamed', {
                              type: type.name,
                              plan: plan.name,
                            })}
                            onClick={() => add(type, plan)}
                          >
                            {t('booking.add')}
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

      {cart.length > 0 && (
        <form
          aria-label={t('booking.detailsTitle')}
          className="mt-6 flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) book.mutate();
          }}
        >
          {/* 3. Guest details */}
          <fieldset className="rounded-md border border-border bg-surface p-4">
            <legend className="px-1 font-semibold">{t('booking.booker')}</legend>
            {bookerId ? (
              <p className="text-sm">
                {bookerId.name}{' '}
                <Button size="sm" variant="ghost" onClick={() => setBookerId(null)}>
                  {t('booking.change')}
                </Button>
              </p>
            ) : (
              <>
                {canFindGuests && <FindGuest onPick={setBookerId} />}
                <PersonFields value={booker} onChange={setBooker} prefix="booker" />
              </>
            )}
          </fieldset>

          <fieldset className="rounded-md border border-border bg-surface p-4">
            <legend className="px-1 font-semibold">{t('booking.rooms')}</legend>
            <ul className="flex flex-col gap-4">
              {cart.map((room, i) => (
                <li key={room.key} className="border-b border-border pb-4 text-sm last:border-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {t('booking.roomN', { n: i + 1 })}: {room.roomTypeName} · {room.plan.code}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">
                        {room.plan.totalMinor !== null ? f.money(room.plan.totalMinor) : ''}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setCart((c) => c.filter((r) => r.key !== room.key))}
                      >
                        {t('booking.remove')}
                      </Button>
                    </span>
                  </div>
                  <label className="mt-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={room.guest === null}
                      onChange={(e) =>
                        setCart((c) =>
                          c.map((r) =>
                            r.key === room.key
                              ? { ...r, guest: e.target.checked ? null : { ...noPerson } }
                              : r,
                          ),
                        )
                      }
                    />
                    {t('booking.sameAsBooker')}
                  </label>
                  {room.guest && (
                    <PersonFields
                      value={room.guest}
                      prefix={`room-${room.key}`}
                      onChange={(guest) =>
                        setCart((c) => c.map((r) => (r.key === room.key ? { ...r, guest } : r)))
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          </fieldset>

          {/* 4. Guarantee and the rest */}
          <fieldset className="grid gap-3 rounded-md border border-border bg-surface p-4 sm:grid-cols-3">
            <legend className="px-1 font-semibold">{t('booking.terms')}</legend>
            {!walkIn && (
              <SelectField
                label={t('reservations.source')}
                value={source}
                onChange={(v) => setSource(v as BookingSource)}
                options={BOOKING_SOURCES.filter(
                  (s) => s !== 'WALK_IN' && s !== 'OTA_CHANNEL' && s !== 'DIRECT',
                ).map((s) => ({ value: s, label: t(`reservations.sources.${s}`) }))}
              />
            )}
            <SelectField
              label={t('reservations.guarantee')}
              value={guarantee ?? guaranteeFor(cart)}
              onChange={(v) => setGuarantee(v as Guarantee)}
              options={GUARANTEES.filter((g) => g !== 'COMPANY').map((g) => ({
                value: g,
                label: t(`reservations.guarantees.${g}`),
              }))}
            />
            {!walkIn && (
              <SelectField
                label={t('booking.hold')}
                value={holdHours === null ? '' : String(holdHours)}
                onChange={(v) => setHoldHours(v ? Number(v) : null)}
                options={[
                  { value: '', label: t('booking.noHold') },
                  ...HOLD_HOURS.map((h) => ({
                    value: String(h),
                    label: t('booking.holdFor', { count: h }),
                  })),
                ]}
              />
            )}
            <div className="flex flex-col gap-1 sm:col-span-3">
              <Label htmlFor="booking-notes">{t('reservations.notes')}</Label>
              <textarea
                id="booking-notes"
                className="min-h-16 rounded-md border border-border bg-surface p-2 text-sm"
                value={notes}
                maxLength={2000}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </fieldset>

          {needsReason && (
            <div className="flex flex-col gap-1">
              <Alert tone="critical">{t('booking.doNotRent')}</Alert>
              <Label htmlFor="booking-reason">{t('booking.approvalReason')}</Label>
              <Input
                id="booking-reason"
                value={approvalReason ?? ''}
                maxLength={500}
                onChange={(e) => setApprovalReason(e.target.value)}
              />
            </div>
          )}

          {book.error && !(book.error instanceof ApiError && book.error.details?.['doNotRent']) && (
            <Alert tone="critical">{errorMessage(book.error)}</Alert>
          )}

          {/* 5. Confirm */}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!ready || book.isPending}>
              {needsReason
                ? t('booking.sendForApproval')
                : walkIn || holdHours === null
                  ? t('booking.confirm', { count: cart.length, total: f.money(total.toString()) })
                  : t('booking.placeHold', {
                      count: cart.length,
                      total: f.money(total.toString()),
                    })}
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

function FindGuest({ onPick }: { onPick: (g: { id: string; name: string }) => void }) {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const found = useQuery({
    queryKey: ['guests', currentPropertyId ?? '', 'find', q],
    queryFn: () => api.call('listGuests', { query: { q, limit: 5 } }),
    enabled: q.length > 0,
  });
  return (
    <div className="mb-3">
      <div className="flex gap-2">
        <Input
          className="max-w-xs"
          aria-label={t('booking.findGuest')}
          placeholder={t('booking.findGuestHint')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              setQ(text.trim());
            }
          }}
        />
        <Button size="sm" variant="secondary" onClick={() => setQ(text.trim())}>
          {t('guests.find')}
        </Button>
      </div>
      {found.data && found.data.data.length === 0 && (
        <p className="mt-1 text-xs text-text-muted">{t('booking.noGuest')}</p>
      )}
      {found.data && found.data.data.length > 0 && (
        <ul aria-label={t('booking.guestsFound')} className="mt-2 flex flex-col gap-1 text-sm">
          {found.data.data.map((g) => {
            const name = `${g.firstName} ${g.lastName}`;
            return (
              <li key={g.id} className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onPick({ id: g.id, name: `${name} ${g.phone ?? ''}`.trim() })}
                >
                  {t('booking.pick', { name })}
                </Button>
                <span className="text-text-muted">{g.phone ?? g.email ?? ''}</span>
                {g.flags?.doNotRent && (
                  <span className="rounded bg-critical-subtle px-1.5 text-xs text-critical">
                    {t('booking.flagDnr')}
                  </span>
                )}
                {g.flags?.vip && (
                  <span className="rounded bg-brand-subtle px-1.5 text-xs text-brand-strong">
                    VIP
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PersonFields(props: { value: Person; onChange: (p: Person) => void; prefix: string }) {
  const { t } = useTranslation();
  const set = (k: keyof Person) => (v: string) => props.onChange({ ...props.value, [k]: v });
  return (
    <div className="mt-2 grid gap-3 sm:grid-cols-4">
      <SmallField
        id={`${props.prefix}-first`}
        label={t('booking.firstName')}
        value={props.value.firstName}
        onChange={set('firstName')}
        required
      />
      <SmallField
        id={`${props.prefix}-last`}
        label={t('booking.lastName')}
        value={props.value.lastName}
        onChange={set('lastName')}
        required
      />
      <SmallField
        id={`${props.prefix}-phone`}
        label={t('booking.phone')}
        type="tel"
        placeholder="+2348031234567"
        value={props.value.phone}
        onChange={set('phone')}
      />
      <SmallField
        id={`${props.prefix}-email`}
        label={t('booking.email')}
        type="email"
        value={props.value.email}
        onChange={set('email')}
      />
    </div>
  );
}

function SmallField({
  label,
  onChange,
  id,
  ...input
}: {
  label: string;
  onChange: (v: string) => void;
  id?: string;
} & Omit<ComponentProps<'input'>, 'onChange'>) {
  const fieldId = id ?? `b-${label}`;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={fieldId}>{label}</Label>
      <Input id={fieldId} {...input} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function SelectField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const id = `b-${props.label}`;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{props.label}</Label>
      <select
        id={id}
        className={selectClass}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
