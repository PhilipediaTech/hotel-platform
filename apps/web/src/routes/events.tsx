import type {
  EventBookingItem,
  EventEnquiryItem,
  SpaceAvailabilityItem,
  SpaceItem,
} from '@hotel/shared';
import { addDays, localDate, SPACE_DAY_TYPES, SPACE_RATE_UNITS, zonedInstant } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import strings from '../i18n/en/events.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';

registerStrings(strings);

// S38 Events and spaces (PRD M9-01–M9-03; T-119): the space calendar, the enquiry pipeline with
// availability and holds, and space setup. All times are the hotel's own.

type Space = z.output<typeof SpaceItem>;
type Booking = z.output<typeof EventBookingItem>;
type Enquiry = z.output<typeof EventEnquiryItem>;
type Availability = z.output<typeof SpaceAvailabilityItem>;

const KEY = ['events'];
const CALENDAR_DAYS = 14;
const DEFAULT_HOLD_DAYS = 3;
const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';

function useProperty() {
  const { properties, currentPropertyId } = useSession();
  const property = properties.find((p) => p.id === currentPropertyId);
  return {
    timeZone: property?.timeZone ?? 'UTC',
    currency: property?.baseCurrency ?? 'NGN',
    today: property?.businessDate ?? localDate(new Date(), property?.timeZone ?? 'UTC'),
  };
}

function useTimes() {
  const { i18n } = useTranslation();
  const { timeZone } = useProperty();
  const format = (options: Intl.DateTimeFormatOptions) => (at: string) =>
    new Intl.DateTimeFormat(i18n.language, { ...options, timeZone }).format(new Date(at));
  return {
    when: format({ dateStyle: 'medium', timeStyle: 'short' }),
    time: format({ timeStyle: 'short' }),
    dayOf: format({ weekday: 'long', day: 'numeric', month: 'long' }),
  };
}

function Field({
  id,
  label,
  ...props
}: { id: string; label: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}

// ── The space calendar ──────────────────────────────────────────────────────────────────

function BookingRow({ b }: { b: Booking }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { permissions } = useSession();
  const { time, when } = useTimes();
  const release = useMutation({
    mutationFn: () => api.call('releaseEventHold', { params: { bookingId: b.id }, body: {} }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-3 text-sm">
      <span className="font-medium">
        {time(b.startsAt)} – {time(b.endsAt)}
      </span>
      <span>{b.space.name}</span>
      <span>{b.title}</span>
      <span className="text-text-muted">{t(`events.status.${b.status}`)}</span>
      {b.status === 'HOLD' && b.holdExpiresAt && (
        <span className="text-text-muted">
          {t('events.holdEnds', { when: when(b.holdExpiresAt) })}
        </span>
      )}
      {b.status === 'HOLD' && permissions.includes('event.hold') && (
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={release.isPending}
          onClick={() => release.mutate()}
        >
          {t('events.release')}
        </Button>
      )}
      {release.error && <Alert tone="critical">{errorMessage(release.error)}</Alert>}
    </li>
  );
}

function Calendar() {
  const { t } = useTranslation();
  const { timeZone, today } = useProperty();
  const { dayOf } = useTimes();
  const [from, setFrom] = useState(today);
  const to = addDays(from, CALENDAR_DAYS);
  const q = useQuery({
    queryKey: [...KEY, 'calendar', from],
    queryFn: () =>
      api.call('listEventBookings', {
        query: {
          from: zonedInstant(from, '00:00', timeZone)
            .toISOString()
            .replace(/\.\d{3}Z$/, 'Z'),
          to: zonedInstant(to, '00:00', timeZone)
            .toISOString()
            .replace(/\.\d{3}Z$/, 'Z'),
        },
      }),
  });
  const days = new Map<string, Booking[]>();
  for (const b of q.data?.data ?? []) {
    const key = localDate(new Date(b.startsAt), timeZone);
    days.set(key, [...(days.get(key) ?? []), b]);
  }
  return (
    <section aria-label={t('events.tabs.calendar')}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setFrom(addDays(from, -CALENDAR_DAYS))}
        >
          {t('events.earlier')}
        </Button>
        <span className="text-sm">{t('events.range', { from, to: addDays(to, -1) })}</span>
        <Button variant="secondary" size="sm" onClick={() => setFrom(to)}>
          {t('events.later')}
        </Button>
      </div>
      {q.error && <Alert tone="critical">{errorMessage(q.error)}</Alert>}
      {q.data?.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('events.noBookings')}</p>
      )}
      {[...days].map(([date, list]) => (
        <div key={date} className="mt-4">
          <h3 className="font-semibold">{dayOf(list[0]?.startsAt ?? '')}</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {list.map((b) => (
              <BookingRow key={b.id} b={b} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

// ── Finding a space and holding it ──────────────────────────────────────────────────────

const instant = (date: string, time: string, timeZone: string) =>
  zonedInstant(date, time, timeZone)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

function HoldForm({ enquiry }: { enquiry: Enquiry }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { permissions } = useSession();
  const { timeZone, currency, today } = useProperty();
  const { i18n } = useTranslation();
  const { when } = useTimes();
  const startDay = enquiry.eventDate ?? today;
  const [date, setDate] = useState(startDay);
  const [startTime, setStartTime] = useState('10:00');
  const [endDate, setEndDate] = useState(startDay);
  const [endTime, setEndTime] = useState('16:00');
  const [guests, setGuests] = useState(String(enquiry.expectedGuests ?? ''));
  const [holdDate, setHoldDate] = useState(addDays(today, DEFAULT_HOLD_DAYS));
  const [layouts, setLayouts] = useState<Record<string, string>>({});
  const startsAt = instant(date, startTime, timeZone);
  const endsAt = instant(endDate, endTime, timeZone);
  const check = useMutation({
    mutationFn: () =>
      api.call('getSpaceAvailability', {
        query: { startsAt, endsAt, ...(guests ? { guests: Number(guests) } : {}) },
      }),
  });
  const hold = useMutation({
    mutationFn: (a: Availability) =>
      api.call('createEventBooking', {
        body: {
          enquiryId: enquiry.id,
          spaceId: a.space.id,
          layoutId: layouts[a.space.id] ?? a.layouts[0]?.id ?? '',
          title: `${enquiry.eventType}: ${enquiry.contactName}`,
          startsAt,
          endsAt,
          expectedGuests: Number(guests),
          holdUntil: instant(holdDate, '17:00', timeZone),
        },
      }),
    onSuccess: () => {
      check.reset();
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  const money = (minor: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(
      Number(minor) / 100,
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    check.mutate();
  };
  const prefix = `hold-${enquiry.id}`;
  return (
    <div className="mt-3 border-t border-border pt-3">
      <form aria-label={t('events.check')} className="grid gap-2 sm:grid-cols-3" onSubmit={submit}>
        <Field
          id={`${prefix}-date`}
          label={t('events.startDate')}
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setEndDate(e.target.value);
          }}
          required
        />
        <Field
          id={`${prefix}-start`}
          label={t('events.startTime')}
          type="time"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          required
        />
        <Field
          id={`${prefix}-guests`}
          label={t('events.guests')}
          type="number"
          min={1}
          value={guests}
          onChange={(e) => setGuests(e.target.value)}
          required
        />
        <Field
          id={`${prefix}-end-date`}
          label={t('events.endDate')}
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          required
        />
        <Field
          id={`${prefix}-end`}
          label={t('events.endTime')}
          type="time"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
          required
        />
        <div className="flex items-end">
          <Button type="submit" variant="secondary" disabled={check.isPending}>
            {t('events.checkButton')}
          </Button>
        </div>
      </form>
      {check.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(check.error)}
        </Alert>
      )}
      {check.data && (
        <>
          {check.data.data.length === 0 && (
            <p className="mt-2 text-sm text-text-muted">{t('events.noSpaces')}</p>
          )}
          {check.data.data.length > 0 && permissions.includes('event.hold') && (
            <div className="mt-2 max-w-xs">
              <Field
                id={`${prefix}-until`}
                label={t('events.holdUntil')}
                type="date"
                value={holdDate}
                onChange={(e) => setHoldDate(e.target.value)}
              />
            </div>
          )}
          <ul className="mt-2 flex flex-col gap-2">
            {check.data.data.map((a) => (
              <li
                key={a.space.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-sm"
              >
                <span className="font-medium">{a.space.name}</span>
                {a.available ? (
                  a.layouts.length > 0 ? (
                    <span>{t('events.free')}</span>
                  ) : (
                    <span className="text-text-muted">{t('events.tooSmall')}</span>
                  )
                ) : (
                  <span className="text-text-muted">
                    {t('events.taken', {
                      title: a.conflicts[0]?.title ?? '',
                      from: when(a.conflicts[0]?.blockedFrom ?? a.blockedFrom),
                    })}
                  </span>
                )}
                {a.minimumHireMinor !== '0' && (
                  <span className="text-text-muted">
                    {t('events.minimum', { amount: money(a.minimumHireMinor) })}
                  </span>
                )}
                {a.available && a.layouts.length > 0 && permissions.includes('event.hold') && (
                  <span className="ml-auto flex items-center gap-2">
                    <select
                      aria-label={t('events.layoutFor', { space: a.space.name })}
                      className={selectClass}
                      value={layouts[a.space.id] ?? a.layouts[0]?.id}
                      onChange={(e) => setLayouts((x) => ({ ...x, [a.space.id]: e.target.value }))}
                    >
                      {a.layouts.map((l) => (
                        <option key={l.id} value={l.id}>
                          {t('events.layoutOption', { name: l.name, capacity: l.capacity })}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" disabled={hold.isPending} onClick={() => hold.mutate(a)}>
                      {t('events.hold')}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {hold.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(hold.error)}
        </Alert>
      )}
    </div>
  );
}

function LoseForm({ enquiry, onDone }: { enquiry: Enquiry; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const lose = useMutation({
    mutationFn: () =>
      api.call('updateEventEnquiry', {
        params: { enquiryId: enquiry.id },
        body: {
          contactName: enquiry.contactName,
          contactPhone: enquiry.contactPhone,
          contactEmail: enquiry.contactEmail,
          eventType: enquiry.eventType,
          eventDate: enquiry.eventDate,
          expectedGuests: enquiry.expectedGuests,
          notes: enquiry.notes,
          status: 'LOST',
          lostReason: reason,
        },
      }),
    onSuccess: () => {
      onDone();
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        lose.mutate();
      }}
    >
      <Field
        id={`lost-${enquiry.id}`}
        label={t('events.lostReason')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
      />
      <Button type="submit" variant="secondary" disabled={lose.isPending}>
        {t('events.markLost')}
      </Button>
      {lose.error && <Alert tone="critical">{errorMessage(lose.error)}</Alert>}
    </form>
  );
}

function EnquiryCard({ enquiry }: { enquiry: Enquiry }) {
  const { t } = useTranslation();
  const { when } = useTimes();
  const [open, setOpen] = useState<'hold' | 'lost' | null>(null);
  const toggle = (panel: 'hold' | 'lost') => setOpen((x) => (x === panel ? null : panel));
  const live = enquiry.bookings.filter((b) => b.status === 'HOLD' || b.status === 'CONFIRMED');
  return (
    <li className="rounded-md border border-border bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{enquiry.eventType}</span>
        <span>{enquiry.contactName}</span>
        {enquiry.contactPhone && <span className="text-text-muted">{enquiry.contactPhone}</span>}
        {enquiry.eventDate && <span className="text-text-muted">{enquiry.eventDate}</span>}
        {enquiry.expectedGuests !== null && (
          <span className="text-text-muted">
            {t('events.guestCount', { count: enquiry.expectedGuests })}
          </span>
        )}
        {enquiry.status === 'OPEN' ? (
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => toggle('hold')}>
              {t('events.findSpace')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => toggle('lost')}>
              {t('events.lost')}
            </Button>
          </span>
        ) : (
          <span className="ml-auto text-text-muted">{t(`events.enquiry.${enquiry.status}`)}</span>
        )}
      </div>
      {enquiry.notes && <p className="mt-1 text-text-muted">{enquiry.notes}</p>}
      {enquiry.lostReason && <p className="mt-1 text-text-muted">{enquiry.lostReason}</p>}
      {live.map((b) => (
        <p key={b.id} className="mt-1">
          {t(`events.status.${b.status}`)}: {b.space.name}, {when(b.startsAt)}
          {b.holdExpiresAt ? ` (${t('events.holdEnds', { when: when(b.holdExpiresAt) })})` : ''}
        </p>
      ))}
      {open === 'hold' && <HoldForm enquiry={enquiry} />}
      {open === 'lost' && <LoseForm enquiry={enquiry} onDone={() => setOpen(null)} />}
    </li>
  );
}

const NEW_ENQUIRY = {
  contactName: '',
  contactPhone: '',
  contactEmail: '',
  eventType: '',
  eventDate: '',
  expectedGuests: '',
  notes: '',
};

function Enquiries() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'OPEN' | 'WON' | 'LOST'>('OPEN');
  const [f, setF] = useState(NEW_ENQUIRY);
  const set = (key: keyof typeof NEW_ENQUIRY, value: string) =>
    setF((x) => ({ ...x, [key]: value }));
  const q = useQuery({
    queryKey: [...KEY, 'enquiries', status],
    queryFn: () => api.call('listEventEnquiries', { query: { status } }),
  });
  const add = useMutation({
    mutationFn: () =>
      api.call('createEventEnquiry', {
        body: {
          contactName: f.contactName,
          contactPhone: f.contactPhone || null,
          contactEmail: f.contactEmail || null,
          eventType: f.eventType,
          eventDate: f.eventDate || null,
          expectedGuests: f.expectedGuests ? Number(f.expectedGuests) : null,
          notes: f.notes || null,
        },
      }),
    onSuccess: () => {
      setF(NEW_ENQUIRY);
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  return (
    <section aria-label={t('events.tabs.enquiries')}>
      <form
        aria-label={t('events.newEnquiry')}
        className="grid gap-2 rounded-md border border-border bg-surface p-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <h3 className="font-semibold sm:col-span-3">{t('events.newEnquiry')}</h3>
        <Field
          id="eq-type"
          label={t('events.eventType')}
          value={f.eventType}
          onChange={(e) => set('eventType', e.target.value)}
          required
        />
        <Field
          id="eq-name"
          label={t('events.contactName')}
          value={f.contactName}
          onChange={(e) => set('contactName', e.target.value)}
          required
        />
        <Field
          id="eq-phone"
          label={t('events.phone')}
          value={f.contactPhone}
          onChange={(e) => set('contactPhone', e.target.value)}
        />
        <Field
          id="eq-email"
          label={t('events.email')}
          type="email"
          value={f.contactEmail}
          onChange={(e) => set('contactEmail', e.target.value)}
        />
        <Field
          id="eq-date"
          label={t('events.eventDate')}
          type="date"
          value={f.eventDate}
          onChange={(e) => set('eventDate', e.target.value)}
        />
        <Field
          id="eq-guests"
          label={t('events.guests')}
          type="number"
          min={1}
          value={f.expectedGuests}
          onChange={(e) => set('expectedGuests', e.target.value)}
        />
        <div className="sm:col-span-3">
          <Field
            id="eq-notes"
            label={t('events.notes')}
            value={f.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </div>
        <div>
          <Button type="submit" disabled={add.isPending}>
            {t('events.addEnquiry')}
          </Button>
        </div>
        {add.error && (
          <Alert tone="critical" className="sm:col-span-3">
            {errorMessage(add.error)}
          </Alert>
        )}
      </form>
      <div className="mt-4 flex items-center gap-2">
        <Label htmlFor="eq-filter">{t('events.show')}</Label>
        <select
          id="eq-filter"
          className={selectClass}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          {(['OPEN', 'WON', 'LOST'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`events.enquiry.${s}`)}
            </option>
          ))}
        </select>
      </div>
      {q.error && <Alert tone="critical">{errorMessage(q.error)}</Alert>}
      {q.data?.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('events.noEnquiries')}</p>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {q.data?.data.map((e) => (
          <EnquiryCard key={e.id} enquiry={e} />
        ))}
      </ul>
    </section>
  );
}

// ── Space setup (M9-01) ─────────────────────────────────────────────────────────────────

interface RuleDraft {
  name: string;
  unit: (typeof SPACE_RATE_UNITS)[number];
  dayType: (typeof SPACE_DAY_TYPES)[number];
  seasonFrom: string;
  seasonTo: string;
  amount: string;
}

function SpaceForm({ saved, onDone }: { saved: Space | null; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [code, setCode] = useState(saved?.code ?? '');
  const [name, setName] = useState(saved?.name ?? '');
  const [setup, setSetup] = useState(String(saved?.setupMinutes ?? 60));
  const [cleanup, setCleanup] = useState(String(saved?.cleanupMinutes ?? 60));
  const [minimum, setMinimum] = useState(
    saved ? String(Number(saved.minimumHireMinor) / 100) : '0',
  );
  const [active, setActive] = useState(saved?.active ?? true);
  const [layouts, setLayouts] = useState(
    saved?.layouts.map((l) => ({ name: l.name, capacity: String(l.capacity) })) ?? [
      { name: '', capacity: '' },
    ],
  );
  const [rules, setRules] = useState<RuleDraft[]>(
    saved?.rateRules.map((r) => ({
      name: r.name,
      unit: r.unit,
      dayType: r.dayType,
      seasonFrom: r.seasonFrom ?? '',
      seasonTo: r.seasonTo ?? '',
      amount: String(Number(r.amountMinor) / 100),
    })) ?? [],
  );
  const setRule = (i: number, patch: Partial<RuleDraft>) =>
    setRules((list) => list.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const setLayout = (i: number, patch: Partial<(typeof layouts)[number]>) =>
    setLayouts((list) => list.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        code,
        name,
        description: saved?.description ?? null,
        setupMinutes: Number(setup),
        cleanupMinutes: Number(cleanup),
        minimumHireMinor: toMinor(minimum) ?? minimum,
        active,
        layouts: layouts.map((l) => ({ name: l.name, capacity: Number(l.capacity) })),
        rateRules: rules.map((r) => ({
          name: r.name,
          unit: r.unit,
          dayType: r.dayType,
          seasonFrom: r.seasonFrom || null,
          seasonTo: r.seasonTo || null,
          amountMinor: toMinor(r.amount) ?? r.amount,
        })),
      };
      return saved
        ? api.call('updateSpace', { params: { spaceId: saved.id }, body })
        : api.call('createSpace', { body });
    },
    onSuccess: () => {
      onDone();
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  const id = saved?.id ?? 'new';
  return (
    <form
      aria-label={saved ? saved.name : t('events.newSpace')}
      className="grid gap-2 rounded-md border border-border bg-surface p-3 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field
        id={`sp-code-${id}`}
        label={t('events.code')}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        required
      />
      <Field
        id={`sp-name-${id}`}
        label={t('events.spaceName')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <Field
        id={`sp-min-${id}`}
        label={t('events.minimumHire')}
        inputMode="decimal"
        value={minimum}
        onChange={(e) => setMinimum(e.target.value)}
      />
      <Field
        id={`sp-setup-${id}`}
        label={t('events.setup')}
        type="number"
        min={0}
        value={setup}
        onChange={(e) => setSetup(e.target.value)}
        required
      />
      <Field
        id={`sp-cleanup-${id}`}
        label={t('events.cleanup')}
        type="number"
        min={0}
        value={cleanup}
        onChange={(e) => setCleanup(e.target.value)}
        required
      />
      <label className="flex items-end gap-2 text-sm">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        {t('events.active')}
      </label>

      <h4 className="mt-2 font-semibold sm:col-span-3">{t('events.layouts')}</h4>
      {layouts.map((l, i) => (
        <div key={i} className="flex items-end gap-2 sm:col-span-3">
          <Field
            id={`sp-l-${id}-${i}`}
            label={t('events.layoutName')}
            value={l.name}
            onChange={(e) => setLayout(i, { name: e.target.value })}
            required
          />
          <Field
            id={`sp-c-${id}-${i}`}
            label={t('events.capacity')}
            type="number"
            min={1}
            value={l.capacity}
            onChange={(e) => setLayout(i, { capacity: e.target.value })}
            required
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={layouts.length === 1}
            onClick={() => setLayouts((list) => list.filter((_, n) => n !== i))}
          >
            {t('events.remove')}
          </Button>
        </div>
      ))}
      <div className="sm:col-span-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setLayouts((list) => [...list, { name: '', capacity: '' }])}
        >
          {t('events.addLayout')}
        </Button>
      </div>

      <h4 className="mt-2 font-semibold sm:col-span-3">{t('events.prices')}</h4>
      {rules.map((r, i) => (
        <div
          key={i}
          className="grid gap-2 border-t border-border pt-2 sm:col-span-3 sm:grid-cols-3"
        >
          <Field
            id={`sp-rn-${id}-${i}`}
            label={t('events.priceName')}
            value={r.name}
            onChange={(e) => setRule(i, { name: e.target.value })}
            required
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor={`sp-ru-${id}-${i}`}>{t('events.unit')}</Label>
            <select
              id={`sp-ru-${id}-${i}`}
              className={selectClass}
              value={r.unit}
              onChange={(e) => setRule(i, { unit: e.target.value as RuleDraft['unit'] })}
            >
              {SPACE_RATE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`events.units.${u}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`sp-rd-${id}-${i}`}>{t('events.days')}</Label>
            <select
              id={`sp-rd-${id}-${i}`}
              className={selectClass}
              value={r.dayType}
              onChange={(e) => setRule(i, { dayType: e.target.value as RuleDraft['dayType'] })}
            >
              {SPACE_DAY_TYPES.map((d) => (
                <option key={d} value={d}>
                  {t(`events.dayTypes.${d}`)}
                </option>
              ))}
            </select>
          </div>
          <Field
            id={`sp-rf-${id}-${i}`}
            label={t('events.seasonFrom')}
            type="date"
            value={r.seasonFrom}
            onChange={(e) => setRule(i, { seasonFrom: e.target.value })}
          />
          <Field
            id={`sp-rt-${id}-${i}`}
            label={t('events.seasonTo')}
            type="date"
            value={r.seasonTo}
            onChange={(e) => setRule(i, { seasonTo: e.target.value })}
          />
          <Field
            id={`sp-ra-${id}-${i}`}
            label={t('events.amount')}
            inputMode="decimal"
            value={r.amount}
            onChange={(e) => setRule(i, { amount: e.target.value })}
            required
          />
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRules((list) => list.filter((_, n) => n !== i))}
            >
              {t('events.remove')}
            </Button>
          </div>
        </div>
      ))}
      <div className="sm:col-span-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            setRules((list) => [
              ...list,
              {
                name: '',
                unit: 'FULL_DAY',
                dayType: 'ALL',
                seasonFrom: '',
                seasonTo: '',
                amount: '',
              },
            ])
          }
        >
          {t('events.addPrice')}
        </Button>
      </div>
      <div className="sm:col-span-3">
        <Button type="submit" disabled={save.isPending}>
          {t('events.saveSpace')}
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

function Spaces({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const q = useQuery({
    queryKey: [...KEY, 'spaces'],
    queryFn: () => api.call('listSpaces'),
  });
  return (
    <section aria-label={t('events.tabs.spaces')}>
      {q.error && <Alert tone="critical">{errorMessage(q.error)}</Alert>}
      {q.data?.data.length === 0 && (
        <p className="text-sm text-text-muted">{t('events.noSpacesYet')}</p>
      )}
      <ul className="flex flex-col gap-2">
        {q.data?.data.map((s) => (
          <li key={s.id}>
            {editing === s.id ? (
              <SpaceForm saved={s} onDone={() => setEditing(null)} />
            ) : (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-3 text-sm">
                <span className="font-medium">{s.name}</span>
                <span className="text-text-muted">
                  {s.layouts
                    .map((l) => t('events.layoutOption', { name: l.name, capacity: l.capacity }))
                    .join(', ')}
                </span>
                <span className="text-text-muted">
                  {t('events.buffers', { setup: s.setupMinutes, cleanup: s.cleanupMinutes })}
                </span>
                {!s.active && <span className="text-text-muted">{t('events.inactive')}</span>}
                {canManage && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="ml-auto"
                    onClick={() => setEditing(s.id)}
                  >
                    {t('events.edit')}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {canManage &&
        (editing === 'new' ? (
          <div className="mt-3">
            <SpaceForm saved={null} onDone={() => setEditing(null)} />
          </div>
        ) : (
          <Button className="mt-3" onClick={() => setEditing('new')}>
            {t('events.addSpace')}
          </Button>
        ))}
    </section>
  );
}

const TABS = ['calendar', 'enquiries', 'spaces'] as const;

export function EventsPage() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const canRead = permissions.includes('event.enquiry');
  const canManage = permissions.includes('space.manage');
  const tabs = TABS.filter((x) => canRead || (x === 'spaces' && canManage));
  const [tab, setTab] = useState<(typeof TABS)[number]>(canRead ? 'calendar' : 'spaces');
  if (!canRead && !canManage) return null;
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('events.title')}</h1>
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
            {t(`events.tabs.${x}`)}
          </Button>
        ))}
      </div>
      <div className="mt-4">
        {tab === 'calendar' && <Calendar />}
        {tab === 'enquiries' && <Enquiries />}
        {tab === 'spaces' && <Spaces canManage={canManage} />}
      </div>
    </section>
  );
}
