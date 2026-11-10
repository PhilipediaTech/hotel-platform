import {
  addDays,
  localDate,
  SERVICE_CATEGORIES,
  SERVICE_PRICING,
  type ServiceBookingItem,
  type ServiceItem,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import strings from '../i18n/en/services.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';

registerStrings(strings);

// S38 Events and spaces, other services (PRD M9-09; T-122): the day's service bookings, booking
// a service against its places left, and setting services up. All times are the hotel's own.

type Service = z.output<typeof ServiceItem>;
type Booking = z.output<typeof ServiceBookingItem>;

const KEY = ['services'];
const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';

function useHotel() {
  const { i18n } = useTranslation();
  const { properties, currentPropertyId } = useSession();
  const property = properties.find((p) => p.id === currentPropertyId);
  const timeZone = property?.timeZone ?? 'UTC';
  const currency = property?.baseCurrency ?? 'NGN';
  return {
    timeZone,
    today: property?.businessDate ?? localDate(new Date(), timeZone),
    time: (at: string) =>
      new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short', timeZone }).format(new Date(at)),
    money: (minor: string) =>
      new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(
        Number(minor) / 100,
      ),
  };
}

function Field({
  id,
  label,
  ...props
}: { id: string; label: string } & ComponentProps<typeof Input>) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}

// ── The day's bookings ──────────────────────────────────────────────────────────────────

function BookingRow({ b }: { b: Booking }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { time, money } = useHotel();
  const done = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const complete = useMutation({
    mutationFn: () => api.call('completeServiceBooking', { params: { bookingId: b.id }, body: {} }),
    onSuccess: done,
  });
  const cancel = useMutation({
    mutationFn: (noShow: boolean) =>
      api.call('cancelServiceBooking', { params: { bookingId: b.id }, body: { noShow } }),
    onSuccess: done,
  });
  const error = complete.error ?? cancel.error;
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-3 text-sm">
      <span className="font-medium">
        {time(b.startsAt)} – {time(b.endsAt)}
      </span>
      <span>{b.service.name}</span>
      <span>
        {b.guestName}
        {b.stay?.roomNumber ? ` · ${t('services.room', { number: b.stay.roomNumber })}` : ''}
      </span>
      {b.quantity > 1 && <span className="text-text-muted">× {b.quantity}</span>}
      <span className="text-text-muted">{money(b.amountMinor)}</span>
      <span className="text-text-muted">
        {t(`services.status.${b.status}`)}
        {b.charged ? ` · ${t('services.charged')}` : ''}
      </span>
      {b.status === 'BOOKED' && (
        <span className="ml-auto flex gap-2">
          <Button size="sm" disabled={complete.isPending} onClick={() => complete.mutate()}>
            {t('services.complete')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(true)}
          >
            {t('services.noShow')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(false)}
          >
            {t('services.cancel')}
          </Button>
        </span>
      )}
      {error && <Alert tone="critical">{errorMessage(error)}</Alert>}
    </li>
  );
}

function Bookings() {
  const { t } = useTranslation();
  const { today } = useHotel();
  const [date, setDate] = useState(today);
  const q = useQuery({
    queryKey: [...KEY, 'bookings', date],
    queryFn: () => api.call('listServiceBookings', { query: { date } }),
  });
  return (
    <section aria-label={t('services.tabs.bookings')}>
      <div className="flex flex-wrap items-end gap-2">
        <Button variant="secondary" size="sm" onClick={() => setDate(addDays(date, -1))}>
          {t('services.earlier')}
        </Button>
        <Field
          id="svc-day"
          label={t('services.day')}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <Button variant="secondary" size="sm" onClick={() => setDate(addDays(date, 1))}>
          {t('services.later')}
        </Button>
      </div>
      {q.error && <Alert tone="critical">{errorMessage(q.error)}</Alert>}
      {q.data?.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('services.noBookings')}</p>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {q.data?.data.map((b) => (
          <BookingRow key={b.id} b={b} />
        ))}
      </ul>
    </section>
  );
}

// ── Booking a service ───────────────────────────────────────────────────────────────────

function BookForm({ services }: { services: Service[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { permissions } = useSession();
  const { today, time } = useHotel();
  const live = services.filter((s) => s.active);
  const [serviceId, setServiceId] = useState(live[0]?.id ?? '');
  const [date, setDate] = useState(today);
  const [quantity, setQuantity] = useState('1');
  const [hours, setHours] = useState('');
  const [stayId, setStayId] = useState('');
  const [guestName, setGuestName] = useState('');
  const [notes, setNotes] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const service = live.find((s) => s.id === serviceId);
  const slots = useQuery({
    queryKey: [...KEY, 'slots', serviceId, date],
    enabled: serviceId !== '',
    queryFn: () => api.call('getServiceSlots', { params: { serviceId }, query: { date } }),
  });
  const guests = useQuery({
    queryKey: [...KEY, 'in-house'],
    enabled: permissions.includes('frontdesk.read'),
    queryFn: () => api.call('listInHouse'),
  });
  const book = useMutation({
    mutationFn: () =>
      api.call('createServiceBooking', {
        body: {
          serviceId,
          startsAt: picked ?? '',
          quantity: Number(quantity),
          ...(service?.pricing === 'PER_HOUR' && hours
            ? { durationMinutes: Math.round(Number(hours) * 60) }
            : {}),
          stayId: stayId || null,
          guestName: guestName || null,
          notes: notes || null,
        },
      }),
    onSuccess: () => {
      setPicked(null);
      setNotes('');
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  if (live.length === 0)
    return <p className="text-sm text-text-muted">{t('services.noServices')}</p>;
  return (
    <form
      aria-label={t('services.book')}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        book.mutate();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="svc-pick">{t('services.service')}</Label>
          <select
            id="svc-pick"
            className={selectClass}
            value={serviceId}
            onChange={(e) => {
              setServiceId(e.target.value);
              setPicked(null);
            }}
          >
            {live.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <Field
          id="svc-date"
          label={t('services.day')}
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setPicked(null);
          }}
        />
        <Field
          id="svc-qty"
          label={t('services.quantity')}
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          required
        />
        {service?.pricing === 'PER_HOUR' && (
          <Field
            id="svc-hours"
            label={t('services.hours')}
            inputMode="decimal"
            placeholder={String(service.durationMinutes / 60)}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('services.times')}>
        {slots.data?.slots.map((s) => (
          <Button
            key={s.startsAt}
            size="sm"
            variant={picked === s.startsAt ? 'primary' : 'secondary'}
            aria-pressed={picked === s.startsAt}
            disabled={!s.bookable || s.left === 0}
            onClick={() => setPicked(s.startsAt)}
          >
            {time(s.startsAt)}
            {s.left !== null ? ` (${t('services.left', { count: s.left })})` : ''}
          </Button>
        ))}
      </div>
      {slots.data?.slots.length === 0 && (
        <p className="text-sm text-text-muted">{t('services.closed')}</p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {guests.data && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="svc-guest">{t('services.guest')}</Label>
            <select
              id="svc-guest"
              className={selectClass}
              value={stayId}
              onChange={(e) => setStayId(e.target.value)}
            >
              <option value="">{t('services.notStaying')}</option>
              {guests.data.data.map((g) => (
                <option key={g.stayId} value={g.stayId}>
                  {g.roomNumber ? `${g.roomNumber} · ` : ''}
                  {g.guest.firstName} {g.guest.lastName}
                </option>
              ))}
            </select>
          </div>
        )}
        {!stayId && (
          <Field
            id="svc-name"
            label={t('services.name')}
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
          />
        )}
        <Field
          id="svc-notes"
          label={t('services.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      {service?.chargeToFolio && !stayId && (
        <p className="text-sm text-text-muted">{t('services.needsGuest')}</p>
      )}
      <div>
        <Button type="submit" disabled={book.isPending || picked === null}>
          {t('services.bookButton')}
        </Button>
      </div>
      {book.isSuccess && <Alert tone="success">{t('services.booked')}</Alert>}
      {book.error && <Alert tone="critical">{errorMessage(book.error)}</Alert>}
    </form>
  );
}

// ── Setup (M9-09) ───────────────────────────────────────────────────────────────────────

const BLANK = {
  code: '',
  name: '',
  category: 'SPA' as Service['category'],
  price: '',
  pricing: 'PER_BOOKING' as Service['pricing'],
  duration: '60',
  capacity: '',
  opensAt: '07:00',
  closesAt: '22:00',
  notice: '0',
  advance: '30',
  chargeToFolio: true,
  revenueCode: 'MISC',
  active: true,
};

function ServiceForm({ saved, onDone }: { saved: Service | null; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [f, setF] = useState(
    saved
      ? {
          code: saved.code,
          name: saved.name,
          category: saved.category,
          price: String(Number(saved.priceMinor) / 100),
          pricing: saved.pricing,
          duration: String(saved.durationMinutes),
          capacity: saved.capacity === null ? '' : String(saved.capacity),
          opensAt: saved.opensAt,
          closesAt: saved.closesAt,
          notice: String(saved.minNoticeMinutes),
          advance: String(saved.maxAdvanceDays),
          chargeToFolio: saved.chargeToFolio,
          revenueCode: saved.revenueCode,
          active: saved.active,
        }
      : BLANK,
  );
  const set = <K extends keyof typeof BLANK>(key: K, value: (typeof BLANK)[K]) =>
    setF((x) => ({ ...x, [key]: value }));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: f.code,
        name: f.name,
        category: f.category,
        description: saved?.description ?? null,
        priceMinor: toMinor(f.price) ?? f.price,
        pricing: f.pricing,
        durationMinutes: Number(f.duration),
        capacity: f.capacity ? Number(f.capacity) : null,
        opensAt: f.opensAt,
        closesAt: f.closesAt,
        minNoticeMinutes: Number(f.notice),
        maxAdvanceDays: Number(f.advance),
        chargeToFolio: f.chargeToFolio,
        revenueCode: f.revenueCode,
        active: f.active,
      };
      return saved
        ? api.call('updateService', { params: { serviceId: saved.id }, body })
        : api.call('createService', { body });
    },
    onSuccess: () => {
      onDone();
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  const id = saved?.id ?? 'new';
  return (
    <form
      aria-label={saved ? saved.name : t('services.newService')}
      className="grid gap-2 rounded-md border border-border bg-surface p-3 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field
        id={`sv-code-${id}`}
        label={t('services.code')}
        value={f.code}
        onChange={(e) => set('code', e.target.value)}
        required
      />
      <Field
        id={`sv-name-${id}`}
        label={t('services.serviceName')}
        value={f.name}
        onChange={(e) => set('name', e.target.value)}
        required
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor={`sv-cat-${id}`}>{t('services.category')}</Label>
        <select
          id={`sv-cat-${id}`}
          className={selectClass}
          value={f.category}
          onChange={(e) => set('category', e.target.value as Service['category'])}
        >
          {SERVICE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`services.categories.${c}`)}
            </option>
          ))}
        </select>
      </div>
      <Field
        id={`sv-price-${id}`}
        label={t('services.price')}
        inputMode="decimal"
        value={f.price}
        onChange={(e) => set('price', e.target.value)}
        required
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor={`sv-pricing-${id}`}>{t('services.pricing')}</Label>
        <select
          id={`sv-pricing-${id}`}
          className={selectClass}
          value={f.pricing}
          onChange={(e) => set('pricing', e.target.value as Service['pricing'])}
        >
          {SERVICE_PRICING.map((p) => (
            <option key={p} value={p}>
              {t(`services.pricings.${p}`)}
            </option>
          ))}
        </select>
      </div>
      <Field
        id={`sv-dur-${id}`}
        label={t('services.duration')}
        type="number"
        min={15}
        value={f.duration}
        onChange={(e) => set('duration', e.target.value)}
        required
      />
      <Field
        id={`sv-cap-${id}`}
        label={t('services.capacity')}
        type="number"
        min={1}
        value={f.capacity}
        onChange={(e) => set('capacity', e.target.value)}
      />
      <Field
        id={`sv-open-${id}`}
        label={t('services.opensAt')}
        type="time"
        value={f.opensAt}
        onChange={(e) => set('opensAt', e.target.value)}
        required
      />
      <Field
        id={`sv-close-${id}`}
        label={t('services.closesAt')}
        type="time"
        value={f.closesAt}
        onChange={(e) => set('closesAt', e.target.value)}
        required
      />
      <Field
        id={`sv-notice-${id}`}
        label={t('services.notice')}
        type="number"
        min={0}
        value={f.notice}
        onChange={(e) => set('notice', e.target.value)}
        required
      />
      <Field
        id={`sv-adv-${id}`}
        label={t('services.advance')}
        type="number"
        min={0}
        value={f.advance}
        onChange={(e) => set('advance', e.target.value)}
        required
      />
      <Field
        id={`sv-rc-${id}`}
        label={t('services.revenueCode')}
        value={f.revenueCode}
        onChange={(e) => set('revenueCode', e.target.value)}
        required
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={f.chargeToFolio}
          onChange={(e) => set('chargeToFolio', e.target.checked)}
        />
        {t('services.chargeToFolio')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={f.active}
          onChange={(e) => set('active', e.target.checked)}
        />
        {t('services.active')}
      </label>
      <div className="sm:col-span-3">
        <Button type="submit" disabled={save.isPending}>
          {t('services.save')}
        </Button>
      </div>
      {save.error && (
        <Alert tone="critical" className="sm:col-span-3">
          {errorMessage(save.error)}
        </Alert>
      )}
    </form>
  );
}

function Setup({ services }: { services: Service[] }) {
  const { t } = useTranslation();
  const { money } = useHotel();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section aria-label={t('services.tabs.setup')}>
      <ul className="flex flex-col gap-2">
        {services.map((s) => (
          <li key={s.id}>
            {editing === s.id ? (
              <ServiceForm saved={s} onDone={() => setEditing(null)} />
            ) : (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-3 text-sm">
                <span className="font-medium">{s.name}</span>
                <span className="text-text-muted">
                  {money(s.priceMinor)} {t(`services.pricings.${s.pricing}`).toLowerCase()}
                </span>
                <span className="text-text-muted">
                  {t('services.hoursLine', { opens: s.opensAt, closes: s.closesAt })}
                </span>
                {s.capacity !== null && (
                  <span className="text-text-muted">
                    {t('services.atOnce', { count: s.capacity })}
                  </span>
                )}
                {!s.active && <span className="text-text-muted">{t('services.inactive')}</span>}
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  onClick={() => setEditing(s.id)}
                >
                  {t('services.edit')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing === 'new' ? (
        <div className="mt-3">
          <ServiceForm saved={null} onDone={() => setEditing(null)} />
        </div>
      ) : (
        <Button className="mt-3" onClick={() => setEditing('new')}>
          {t('services.addService')}
        </Button>
      )}
    </section>
  );
}

const TABS = ['bookings', 'book', 'setup'] as const;

export function ServicesPage() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const canBook = permissions.includes('folio.charge');
  const canManage = permissions.includes('service.manage');
  const tabs = TABS.filter((x) => (x === 'setup' ? canManage && canBook : canBook));
  const [tab, setTab] = useState<(typeof TABS)[number]>('bookings');
  const q = useQuery({
    queryKey: [...KEY, 'list'],
    enabled: canBook,
    queryFn: () => api.call('listServices'),
  });
  if (!canBook) return <Alert tone="info">{t('services.needsCharge')}</Alert>;
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('services.title')}</h1>
      <div role="tablist" className="mt-3 flex gap-2">
        {tabs.map((x) => (
          <Button
            key={x}
            role="tab"
            aria-selected={tab === x}
            size="sm"
            variant={tab === x ? 'primary' : 'secondary'}
            onClick={() => setTab(x)}
          >
            {t(`services.tabs.${x}`)}
          </Button>
        ))}
      </div>
      {q.error && <Alert tone="critical">{errorMessage(q.error)}</Alert>}
      <div className="mt-4">
        {tab === 'bookings' && <Bookings />}
        {tab === 'book' && q.data && <BookForm services={q.data.data} />}
        {tab === 'setup' && q.data && <Setup services={q.data.data} />}
      </div>
    </section>
  );
}
