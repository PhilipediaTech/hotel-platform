import {
  addDays,
  CancellationPolicyBody,
  GUARANTEES,
  localDate,
  MEAL_PLANS,
  PackageBody,
  RateCalendarUpdateBody,
  RatePlanBody,
  RatePlanPatchBody,
  SELLABLE_PLAN_KINDS,
  TAX_LINE_GROUPS,
  type RateCalendarDay,
  type RatePlanItem,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Label } from '../components/ui/label.tsx';
import { api, ApiError } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { apiFieldErrors, errorMessage } from '../lib/form.ts';
import { Field } from './auth/layout.tsx';
import { RoomsLeft } from './rooms-left.tsx';
import { fieldErrorsOf, serverErrors, validated, type FieldErrors } from './settings/room-form.ts';

// S23 Rate calendar and plans (PRD M2-04–M2-08; T-033): a price and restriction grid per
// plan, bulk edit by dates, weekdays and room types, plan setup (BAR, derived, package,
// day-use) and package components.

type Plan = z.output<typeof RatePlanItem>;
type Day = z.output<typeof RateCalendarDay>;

const WINDOW = 14;
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** "45000" (naira) → "4500000" (kobo); blank → null. */
function toMinor(naira: string): string | null {
  const text = naira.replace(/[,\s]/g, '');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? String(Math.round(n * 100)) : 'x';
}
const toNaira = (minor: string | null) => (minor === null ? '' : String(Number(minor) / 100));

function useRates() {
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const base = ['rates', session.currentPropertyId ?? ''];
  const plans = useQuery({
    queryKey: [...base, 'plans'],
    queryFn: async () => (await api.call('listRatePlans')).data,
  });
  const types = useQuery({
    queryKey: ['rooms', session.currentPropertyId ?? '', 'types'],
    queryFn: async () => (await api.call('listRoomTypes')).data,
  });
  const policies = useQuery({
    queryKey: [...base, 'policies'],
    queryFn: async () => (await api.call('listCancellationPolicies')).data,
  });
  const locale = property?.locale ?? 'en-NG';
  const money = (minor: string) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number(minor) / 100);
  return {
    base,
    plans,
    types,
    policies,
    locale,
    money,
    currency: property?.baseCurrency ?? 'NGN',
    today: localDate(new Date(), property?.timeZone ?? 'Africa/Lagos'),
    canEdit: session.permissions.includes('rate.manage'),
  };
}

function useInvalidate() {
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['rates', currentPropertyId ?? ''] });
    void queryClient.invalidateQueries({ queryKey: ['setup', currentPropertyId ?? ''] });
  };
}

type Panel = 'bulk' | 'new-plan' | 'edit-plan' | 'package' | null;

export function RatesPage() {
  const { t } = useTranslation();
  const r = useRates();
  const [search, setSearch] = useSearchParams();
  const [panel, setPanel] = useState<Panel>(null);
  const [start, setStart] = useState<string | null>(null);

  const error = r.plans.error ?? r.types.error ?? r.policies.error;
  if (error) return <Alert tone="critical">{errorMessage(error)}</Alert>;
  if (!r.plans.data || !r.types.data || !r.policies.data) {
    return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  }
  const plans = r.plans.data;
  const plan = plans.find((p) => p.id === search.get('plan')) ?? plans[0];
  const from = start ?? r.today;
  const view = search.get('view') === 'rooms-left' ? 'rooms-left' : 'prices';
  const views = (
    <div
      role="tablist"
      aria-label={t('rates.views')}
      className="mt-3 flex gap-1 border-b border-border"
    >
      {(['prices', 'rooms-left'] as const).map((name) => (
        <button
          key={name}
          type="button"
          role="tab"
          aria-selected={view === name}
          onClick={() => setSearch(name === 'prices' ? {} : { view: name })}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm',
            view === name
              ? 'border-brand font-semibold text-brand-strong'
              : 'border-transparent text-text-muted',
          )}
        >
          {t(`rates.viewNames.${name}`)}
        </button>
      ))}
    </div>
  );

  if (view === 'rooms-left') {
    return (
      <section>
        <h1 className="text-xl font-semibold">{t('rates.title')}</h1>
        {views}
        <RoomsLeft />
      </section>
    );
  }

  return (
    <section>
      <h1 className="text-xl font-semibold">{t('rates.title')}</h1>
      {views}
      {plans.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">{t('rates.noPlans')}</p>
      ) : (
        <div role="tablist" aria-label={t('rates.plans')} className="mt-4 flex flex-wrap gap-2">
          {plans.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === plan?.id}
              onClick={() => {
                setSearch({ plan: p.id });
                setPanel(null);
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                p.id === plan?.id
                  ? 'border-brand bg-brand-subtle font-medium'
                  : 'border-border bg-surface',
                !p.active && 'opacity-60',
              )}
            >
              {p.name} <span className="text-xs text-text-muted">{t(`rates.kinds.${p.kind}`)}</span>
            </button>
          ))}
        </div>
      )}
      {r.canEdit && (
        <div className="mt-3 flex flex-wrap gap-2">
          {plan && (
            <Button size="sm" onClick={() => setPanel('bulk')}>
              {t('rates.bulk.open')}
            </Button>
          )}
          {plan && (
            <Button size="sm" variant="secondary" onClick={() => setPanel('edit-plan')}>
              {t('rates.plan.edit')}
            </Button>
          )}
          {plan?.kind === 'PACKAGE' && (
            <Button size="sm" variant="secondary" onClick={() => setPanel('package')}>
              {t('rates.package.open')}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setPanel('new-plan')}>
            {t('rates.plan.add')}
          </Button>
        </div>
      )}
      {panel === 'bulk' && plan && <BulkForm plan={plan} r={r} onDone={() => setPanel(null)} />}
      {panel === 'new-plan' && <PlanForm plan={null} r={r} onDone={() => setPanel(null)} />}
      {panel === 'edit-plan' && plan && (
        <PlanForm key={plan.id} plan={plan} r={r} onDone={() => setPanel(null)} />
      )}
      {panel === 'package' && plan && (
        <PackageForm key={plan.id} plan={plan} onDone={() => setPanel(null)} />
      )}
      {plan && (
        <Calendar
          plan={plan}
          from={from}
          r={r}
          onMove={(days) => setStart(addDays(from, days))}
          parentName={plans.find((p) => p.id === plan.parentRatePlanId)?.name}
        />
      )}
    </section>
  );
}

type Rates = ReturnType<typeof useRates>;

function Calendar({
  plan,
  from,
  r,
  onMove,
  parentName,
}: {
  plan: Plan;
  from: string;
  r: Rates;
  onMove: (days: number) => void;
  parentName: string | undefined;
}) {
  const { t } = useTranslation();
  const to = addDays(from, WINDOW - 1);
  const calendar = useQuery({
    queryKey: [...r.base, 'calendar', plan.id, from],
    queryFn: () => api.call('getRateCalendar', { query: { ratePlanId: plan.id, from, to } }),
  });
  const dates = Array.from({ length: WINDOW }, (_, i) => addDays(from, i));
  const typeName = new Map((r.types.data ?? []).map((rt) => [rt.id, rt.name]));
  const byType = new Map<string, Map<string, Day>>();
  for (const d of calendar.data?.days ?? []) {
    const row = byType.get(d.roomTypeId) ?? new Map<string, Day>();
    row.set(d.date, d);
    byType.set(d.roomTypeId, row);
  }
  const heading = (date: string) =>
    new Intl.DateTimeFormat(r.locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('rates.earlier')}
          onClick={() => onMove(-WINDOW)}
        >
          <ChevronLeft aria-hidden className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('rates.later')}
          onClick={() => onMove(WINDOW)}
        >
          <ChevronRight aria-hidden className="size-4" />
        </Button>
        <p className="text-sm text-text-muted">
          {plan.parentRatePlanId
            ? t('rates.follows', {
                parent: parentName ?? '',
                rule: describeDerivation(plan, r.money, t),
              })
            : t('rates.ownPrices', { currency: r.currency })}
        </p>
      </div>
      {calendar.error && <Alert tone="critical">{errorMessage(calendar.error)}</Alert>}
      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table aria-label={t('rates.gridNamed', { plan: plan.name })} className="text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="sticky left-0 bg-surface p-2 text-left font-medium">
                {t('rates.roomType')}
              </th>
              {dates.map((date) => (
                <th key={date} className="min-w-20 p-2 text-center text-xs font-medium">
                  {heading(date)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...byType.entries()].map(([roomTypeId, row]) => (
              <tr key={roomTypeId} className="border-b border-border last:border-0">
                <th scope="row" className="sticky left-0 bg-surface p-2 text-left font-medium">
                  {typeName.get(roomTypeId)}
                </th>
                {dates.map((date) => {
                  const d = row.get(date);
                  return (
                    <td
                      key={date}
                      className={cn(
                        'p-2 text-center align-top',
                        d?.stopSell && 'bg-critical-subtle',
                      )}
                    >
                      <span className="tabular-nums">
                        {d?.amountMinor ? r.money(d.amountMinor) : '–'}
                      </span>
                      {d && <Badges day={d} />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Badges({ day }: { day: Day }) {
  const { t } = useTranslation();
  const tags = [
    day.stopSell && t('rates.tags.stop'),
    day.closedToArrival && t('rates.tags.cta'),
    day.closedToDeparture && t('rates.tags.ctd'),
    day.minStay !== null && t('rates.tags.min', { n: day.minStay }),
    day.maxStay !== null && t('rates.tags.max', { n: day.maxStay }),
  ].filter(Boolean);
  if (tags.length === 0) return null;
  return (
    <span className="block text-[11px] leading-tight text-text-muted">{tags.join(' · ')}</span>
  );
}

function describeDerivation(
  plan: Plan,
  money: (minor: string) => string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (plan.derivationBps !== null) {
    parts.push(
      plan.derivationBps < 0
        ? t('rates.percentOff', { n: Math.abs(plan.derivationBps) / 100 })
        : t('rates.percentOn', { n: plan.derivationBps / 100 }),
    );
  }
  if (plan.derivationAmountMinor !== null) {
    const amount = BigInt(plan.derivationAmountMinor);
    parts.push(
      amount < 0n
        ? t('rates.amountOff', { amount: money((-amount).toString()) })
        : t('rates.amountOn', { amount: money(amount.toString()) }),
    );
  }
  return parts.join(', ') || t('rates.samePrice');
}

// ── Forms ──────────────────────────────────────────────────────────────────────────────

function FormShell({
  title,
  pending,
  error,
  onSubmit,
  onDone,
  submit,
  children,
}: {
  title: string;
  pending: boolean;
  error: unknown;
  onSubmit: () => void;
  onDone: () => void;
  submit: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const formError =
    error instanceof ApiError && Object.keys(serverErrors(error)).length === 0
      ? errorMessage(error)
      : null;
  return (
    <form
      noValidate
      aria-label={title}
      className="mt-3 max-w-3xl rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
      {formError && (
        <Alert tone="critical" className="mb-3">
          {formError}
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {submit}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t('rates.cancel')}
        </Button>
      </div>
    </form>
  );
}

function Select({
  id,
  label,
  value,
  onChange,
  options,
  error,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  error?: string | undefined;
  disabled?: boolean;
}) {
  return (
    <div className="mb-4 flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        className="h-10 rounded-md border border-border bg-surface px-3 text-sm disabled:opacity-60"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <p className="text-sm text-critical">{error}</p>}
    </div>
  );
}

/** Errors under `body.set.*` keyed by field. */
function setErrorsOf(error: unknown): FieldErrors {
  return Object.fromEntries(
    apiFieldErrors(error).flatMap(({ field, message }) =>
      field.startsWith('set.')
        ? [[field.slice(4), message]]
        : field === 'set'
          ? [['set', message]]
          : [],
    ),
  );
}

type Tri = 'leave' | 'on' | 'off';
const tri = (v: Tri) => (v === 'leave' ? undefined : v === 'on');

function BulkForm({ plan, r, onDone }: { plan: Plan; r: Rates; onDone: () => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  const types = (r.types.data ?? []).filter((rt) =>
    plan.roomTypeIds.length > 0 ? plan.roomTypeIds.includes(rt.id) : rt.active,
  );
  const [from, setFrom] = useState(r.today);
  const [to, setTo] = useState(addDays(r.today, 6));
  const [weekdays, setWeekdays] = useState<number[]>([...WEEKDAYS]);
  const [roomTypeIds, setRoomTypeIds] = useState(types.map((rt) => rt.id));
  const [price, setPrice] = useState('');
  const [clearPrice, setClearPrice] = useState(false);
  const [minStay, setMinStay] = useState('');
  const [maxStay, setMaxStay] = useState('');
  const [cta, setCta] = useState<Tri>('leave');
  const [ctd, setCtd] = useState<Tri>('leave');
  const [stop, setStop] = useState<Tri>('leave');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<number | null>(null);
  const derived = plan.kind === 'DERIVED';

  const save = useMutation({
    mutationFn: async () => {
      const set = {
        ...(clearPrice
          ? { amountMinor: null }
          : price.trim()
            ? { amountMinor: toMinor(price) }
            : {}),
        ...(minStay.trim() ? { minStay: minStay === '-' ? null : Number(minStay) } : {}),
        ...(maxStay.trim() ? { maxStay: maxStay === '-' ? null : Number(maxStay) } : {}),
        ...(tri(cta) !== undefined ? { closedToArrival: tri(cta) } : {}),
        ...(tri(ctd) !== undefined ? { closedToDeparture: tri(ctd) } : {}),
        ...(tri(stop) !== undefined ? { stopSell: tri(stop) } : {}),
      };
      return api.call('updateRateCalendar', {
        body: validated(RateCalendarUpdateBody, {
          ratePlanId: plan.id,
          roomTypeIds,
          from,
          to,
          weekdays,
          set,
        }),
      });
    },
    onSuccess: (res) => {
      setResult(res.changedDays);
      invalidate();
    },
    onError: (error) => setErrors({ ...fieldErrorsOf(error), ...setErrorsOf(error) }),
  });
  const toggle = (list: number[], n: number) =>
    list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort();
  const weekdayName = (n: number) =>
    new Intl.DateTimeFormat(r.locale, { weekday: 'short', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2024, 0, n)), // 1 Jan 2024 was a Monday
    );
  const triSelect = (id: string, label: string, value: Tri, set: (v: Tri) => void) => (
    <Select
      id={id}
      label={label}
      value={value}
      onChange={(v) => set(v as Tri)}
      options={(['leave', 'on', 'off'] as const).map((v) => ({
        value: v,
        label: t(`rates.bulk.${v}`),
      }))}
    />
  );

  return (
    <FormShell
      title={t('rates.bulk.title', { plan: plan.name })}
      submit={t('rates.bulk.apply')}
      pending={save.isPending}
      error={save.error}
      onSubmit={() => {
        setErrors({});
        setResult(null);
        save.mutate();
      }}
      onDone={onDone}
    >
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field
          label={t('rates.bulk.from')}
          type="date"
          min={r.today}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          error={errors['from']}
        />
        <Field
          label={t('rates.bulk.to')}
          type="date"
          min={from}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          error={errors['to']}
        />
      </div>
      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-medium">{t('rates.bulk.weekdays')}</legend>
        <div className="flex flex-wrap gap-3">
          {WEEKDAYS.map((n) => (
            <label key={n} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={weekdays.includes(n)}
                onChange={() => setWeekdays((w) => toggle(w, n))}
              />
              {weekdayName(n)}
            </label>
          ))}
        </div>
        {errors['weekdays'] && <p className="text-sm text-critical">{errors['weekdays']}</p>}
      </fieldset>
      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-medium">{t('rates.bulk.roomTypes')}</legend>
        <div className="flex flex-wrap gap-3">
          {types.map((rt) => (
            <label key={rt.id} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={roomTypeIds.includes(rt.id)}
                onChange={() =>
                  setRoomTypeIds((ids) =>
                    ids.includes(rt.id) ? ids.filter((x) => x !== rt.id) : [...ids, rt.id],
                  )
                }
              />
              {rt.name}
            </label>
          ))}
        </div>
        {errors['roomTypeIds'] && <p className="text-sm text-critical">{errors['roomTypeIds']}</p>}
      </fieldset>
      {derived ? (
        <p className="mb-4 text-sm text-text-muted">{t('rates.bulk.derivedPrice')}</p>
      ) : (
        <div className="grid items-end gap-x-4 sm:grid-cols-2">
          <Field
            label={t('rates.bulk.price', { currency: r.currency })}
            hint={t('rates.bulk.leaveBlank')}
            inputMode="decimal"
            disabled={clearPrice}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            error={errors['amountMinor']}
          />
          <label className="mb-6 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={clearPrice}
              onChange={(e) => setClearPrice(e.target.checked)}
            />
            {t('rates.bulk.clearPrice')}
          </label>
        </div>
      )}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field
          label={t('rates.bulk.minStay')}
          hint={t('rates.bulk.stayHint')}
          inputMode="numeric"
          value={minStay}
          onChange={(e) => setMinStay(e.target.value)}
          error={errors['minStay']}
        />
        <Field
          label={t('rates.bulk.maxStay')}
          hint={t('rates.bulk.stayHint')}
          inputMode="numeric"
          value={maxStay}
          onChange={(e) => setMaxStay(e.target.value)}
          error={errors['maxStay']}
        />
      </div>
      <div className="grid gap-x-4 sm:grid-cols-3">
        {triSelect('bulk-cta', t('rates.bulk.cta'), cta, setCta)}
        {triSelect('bulk-ctd', t('rates.bulk.ctd'), ctd, setCtd)}
        {triSelect('bulk-stop', t('rates.bulk.stop'), stop, setStop)}
      </div>
      {errors['set'] && <p className="mb-3 text-sm text-critical">{errors['set']}</p>}
      {result !== null && (
        <p role="status" className="mb-3 text-sm">
          {t('rates.bulk.done', { count: result })}
        </p>
      )}
    </FormShell>
  );
}

interface PlanDraft {
  code: string;
  name: string;
  kind: (typeof SELLABLE_PLAN_KINDS)[number];
  parentRatePlanId: string;
  percent: string;
  amount: string;
  rounding: string;
  floor: string;
  mealPlan: (typeof MEAL_PLANS)[number];
  cancellationPolicyId: string;
  guarantee: (typeof GUARANTEES)[number];
  isPublic: boolean;
  dayUseHours: string;
  roomTypeIds: string[];
  active: boolean;
}

function PlanForm({ plan, r, onDone }: { plan: Plan | null; r: Rates; onDone: () => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  const [, setSearch] = useSearchParams();
  const bars = (r.plans.data ?? []).filter(
    (p) => p.kind === 'BAR' && p.active && p.id !== plan?.id,
  );
  const [d, setD] = useState<PlanDraft>({
    code: plan?.code ?? '',
    name: plan?.name ?? '',
    kind: (plan?.kind === 'NEGOTIATED' ? 'BAR' : plan?.kind) ?? 'BAR',
    parentRatePlanId: plan?.parentRatePlanId ?? bars[0]?.id ?? '',
    percent:
      plan?.derivationBps !== null && plan?.derivationBps !== undefined
        ? String(-plan.derivationBps / 100)
        : '',
    amount: plan?.derivationAmountMinor ? toNaira(plan.derivationAmountMinor) : '',
    rounding: toNaira(plan?.roundingMinor ?? '10000'),
    floor: toNaira(plan?.floorMinor ?? null),
    mealPlan: plan?.mealPlan ?? 'ROOM_ONLY',
    cancellationPolicyId: plan?.cancellationPolicyId ?? r.policies.data?.[0]?.id ?? '',
    guarantee: plan?.guarantee ?? 'NONE',
    isPublic: plan?.isPublic ?? false,
    dayUseHours: plan?.dayUseMaxMinutes ? String(plan.dayUseMaxMinutes / 60) : '6',
    roomTypeIds: plan?.roomTypeIds ?? [],
    active: plan?.active ?? true,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [newPolicy, setNewPolicy] = useState(false);
  const set = <K extends keyof PlanDraft>(k: K, v: PlanDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const follows =
    d.kind === 'DERIVED' ||
    ((d.kind === 'PACKAGE' || d.kind === 'DAY_USE') &&
      d.parentRatePlanId !== '' &&
      (d.percent !== '' || d.amount !== ''));
  const derivation = {
    // "10" percent off → -1000 bps.
    derivationBps: d.percent.trim() ? Math.round(-Number(d.percent) * 100) : null,
    derivationAmountMinor: d.amount.trim() ? toMinor(d.amount) : null,
  };
  const common = {
    name: d.name,
    roundingMinor: toMinor(d.rounding) ?? '10000',
    floorMinor: toMinor(d.floor),
    mealPlan: d.mealPlan,
    cancellationPolicyId: d.cancellationPolicyId,
    guarantee: d.guarantee,
    isPublic: d.isPublic,
    dayUseMaxMinutes: d.kind === 'DAY_USE' ? Math.round(Number(d.dayUseHours) * 60) : null,
    roomTypeIds: d.roomTypeIds,
  };
  const save = useMutation({
    mutationFn: async () => {
      if (plan) {
        return api.call(
          'updateRatePlan',
          {
            params: { ratePlanId: plan.id },
            body: validated(RatePlanPatchBody, {
              ...common,
              ...(plan.parentRatePlanId ? derivation : {}),
              active: d.active,
            }),
          },
          { ifMatch: `"${plan.version}"` },
        );
      }
      return api.call('createRatePlan', {
        body: validated(RatePlanBody, {
          ...common,
          code: d.code,
          kind: d.kind,
          ...(follows ? { parentRatePlanId: d.parentRatePlanId || null, ...derivation } : {}),
        }),
      });
    },
    onSuccess: (saved) => {
      invalidate();
      setSearch({ plan: saved.id });
      onDone();
    },
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  const title = plan ? t('rates.plan.editNamed', { name: plan.name }) : t('rates.plan.add');
  const canDerive = plan ? plan.parentRatePlanId !== null : d.kind !== 'BAR';

  return (
    <FormShell
      title={title}
      submit={t('rates.save')}
      pending={save.isPending}
      error={save.error}
      onSubmit={() => {
        setErrors({});
        save.mutate();
      }}
      onDone={onDone}
    >
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Select
          id="plan-kind"
          label={t('rates.plan.kind')}
          value={d.kind}
          disabled={plan !== null}
          onChange={(v) => set('kind', v as PlanDraft['kind'])}
          options={SELLABLE_PLAN_KINDS.map((k) => ({ value: k, label: t(`rates.kinds.${k}`) }))}
          error={errors['kind']}
        />
        <Field
          label={t('rates.plan.code')}
          disabled={plan !== null}
          value={d.code}
          onChange={(e) => set('code', e.target.value)}
          error={errors['code']}
        />
        <Field
          label={t('rates.plan.name')}
          value={d.name}
          onChange={(e) => set('name', e.target.value)}
          error={errors['name']}
        />
      </div>
      <p className="mb-3 text-xs text-text-muted">{t(`rates.kindHints.${d.kind}`)}</p>
      {canDerive && (
        <div className="mb-2 rounded-md border border-border p-3">
          <div className="grid gap-x-4 sm:grid-cols-3">
            <Select
              id="plan-parent"
              label={t('rates.plan.parent')}
              value={d.parentRatePlanId}
              disabled={plan !== null}
              onChange={(v) => set('parentRatePlanId', v)}
              options={[
                ...(d.kind === 'DERIVED' ? [] : [{ value: '', label: t('rates.plan.noParent') }]),
                ...(plan?.parentRatePlanId && !bars.some((b) => b.id === plan.parentRatePlanId)
                  ? [{ value: plan.parentRatePlanId, label: '…' }]
                  : []),
                ...bars.map((b) => ({ value: b.id, label: b.name })),
              ]}
              error={errors['parentRatePlanId']}
            />
            <Field
              label={t('rates.plan.percentOff')}
              hint={t('rates.plan.percentHint')}
              inputMode="decimal"
              value={d.percent}
              onChange={(e) => set('percent', e.target.value)}
              error={errors['derivationBps']}
            />
            <Field
              label={t('rates.plan.amount', { currency: r.currency })}
              hint={t('rates.plan.amountHint')}
              inputMode="decimal"
              value={d.amount}
              onChange={(e) => set('amount', e.target.value)}
              error={errors['derivationAmountMinor']}
            />
            <Field
              label={t('rates.plan.rounding', { currency: r.currency })}
              inputMode="decimal"
              value={d.rounding}
              onChange={(e) => set('rounding', e.target.value)}
              error={errors['roundingMinor']}
            />
            <Field
              label={t('rates.plan.floor', { currency: r.currency })}
              hint={t('rates.plan.floorHint')}
              inputMode="decimal"
              value={d.floor}
              onChange={(e) => set('floor', e.target.value)}
              error={errors['floorMinor']}
            />
          </div>
        </div>
      )}
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Select
          id="plan-meal"
          label={t('rates.plan.mealPlan')}
          value={d.mealPlan}
          onChange={(v) => set('mealPlan', v as PlanDraft['mealPlan'])}
          options={MEAL_PLANS.map((m) => ({ value: m, label: t(`rates.meals.${m}`) }))}
        />
        <Select
          id="plan-guarantee"
          label={t('rates.plan.guarantee')}
          value={d.guarantee}
          onChange={(v) => set('guarantee', v as PlanDraft['guarantee'])}
          options={GUARANTEES.filter((g) => g !== 'COMPANY').map((g) => ({
            value: g,
            label: t(`rates.guarantees.${g}`),
          }))}
        />
        {d.kind === 'DAY_USE' && (
          <Field
            label={t('rates.plan.dayUseHours')}
            inputMode="decimal"
            value={d.dayUseHours}
            onChange={(e) => set('dayUseHours', e.target.value)}
            error={errors['dayUseMaxMinutes']}
          />
        )}
      </div>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Select
            id="plan-policy"
            label={t('rates.plan.policy')}
            value={d.cancellationPolicyId}
            onChange={(v) => set('cancellationPolicyId', v)}
            options={(r.policies.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            error={
              errors['cancellationPolicyId'] ??
              ((r.policies.data ?? []).length === 0 ? t('rates.plan.needPolicy') : undefined)
            }
          />
        </div>
        <Button className="mb-4" size="sm" variant="ghost" onClick={() => setNewPolicy((x) => !x)}>
          {t('rates.policy.add')}
        </Button>
      </div>
      {newPolicy && (
        <PolicyForm
          onDone={(id) => {
            setNewPolicy(false);
            if (id) set('cancellationPolicyId', id);
          }}
        />
      )}
      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-medium">{t('rates.plan.roomTypes')}</legend>
        <p className="mb-1 text-xs text-text-muted">{t('rates.plan.roomTypesHint')}</p>
        <div className="flex flex-wrap gap-3">
          {(r.types.data ?? [])
            .filter((rt) => rt.active)
            .map((rt) => (
              <label key={rt.id} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={d.roomTypeIds.includes(rt.id)}
                  onChange={() =>
                    set(
                      'roomTypeIds',
                      d.roomTypeIds.includes(rt.id)
                        ? d.roomTypeIds.filter((x) => x !== rt.id)
                        : [...d.roomTypeIds, rt.id],
                    )
                  }
                />
                {rt.name}
              </label>
            ))}
        </div>
      </fieldset>
      <label className="mb-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={d.isPublic}
          onChange={(e) => set('isPublic', e.target.checked)}
        />
        {t('rates.plan.public')}
      </label>
      {plan && (
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={d.active}
            onChange={(e) => set('active', e.target.checked)}
          />
          {t('rates.plan.active')}
        </label>
      )}
    </FormShell>
  );
}

/** A simple policy: free until N days before, then a fee; no-show fee. */
function PolicyForm({ onDone }: { onDone: (id: string | null) => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  const [name, setName] = useState('');
  const [days, setDays] = useState('1');
  const [nights, setNights] = useState('1');
  const [noShow, setNoShow] = useState('1');
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: async () =>
      api.call('createCancellationPolicy', {
        body: validated(CancellationPolicyBody, {
          name,
          rules: [{ daysBefore: Number(days), feeType: 'NIGHTS', value: Number(nights) }],
          noShowFee: { feeType: 'NIGHTS', value: Number(noShow) },
        }),
      }),
    onSuccess: (policy) => {
      invalidate();
      onDone(policy.id);
    },
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  return (
    <div className="mb-4 rounded-md border border-dashed border-border p-3">
      <div className="grid gap-x-4 sm:grid-cols-4">
        <Field
          label={t('rates.policy.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors['name']}
        />
        <Field
          label={t('rates.policy.days')}
          inputMode="numeric"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          error={errors['rules']}
        />
        <Field
          label={t('rates.policy.nights')}
          inputMode="numeric"
          value={nights}
          onChange={(e) => setNights(e.target.value)}
        />
        <Field
          label={t('rates.policy.noShow')}
          inputMode="numeric"
          value={noShow}
          onChange={(e) => setNoShow(e.target.value)}
          error={errors['noShowFee']}
        />
      </div>
      <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
        {t('rates.policy.save')}
      </Button>
    </div>
  );
}

interface ComponentDraft {
  name: string;
  revenueCodeId: string;
  amount: string;
  perPerson: boolean;
}

function PackageForm({ plan, onDone }: { plan: Plan; onDone: () => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  const { currentPropertyId } = useSession();
  const codes = useQuery({
    queryKey: ['finance', currentPropertyId ?? '', 'codes'],
    queryFn: async () => (await api.call('listRevenueCodes')).data,
  });
  const income = (codes.data ?? []).filter(
    (c) => c.active && !(TAX_LINE_GROUPS as readonly string[]).includes(c.group),
  );
  const [rows, setRows] = useState<ComponentDraft[]>(
    plan.components.map((c) => ({
      name: c.name,
      revenueCodeId: c.revenueCodeId,
      amount: toNaira(c.amountMinor),
      perPerson: c.perPerson,
    })),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: async () =>
      api.call('setPackageComponents', {
        body: validated(PackageBody, {
          ratePlanId: plan.id,
          components: rows.map((c) => ({
            name: c.name,
            revenueCodeId: c.revenueCodeId,
            amountMinor: toMinor(c.amount),
            perPerson: c.perPerson,
          })),
        }),
      }),
    onSuccess: () => {
      invalidate();
      onDone();
    },
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  const update = (i: number, change: Partial<ComponentDraft>) =>
    setRows((list) => list.map((c, j) => (j === i ? { ...c, ...change } : c)));

  return (
    <FormShell
      title={t('rates.package.title', { plan: plan.name })}
      submit={t('rates.save')}
      pending={save.isPending}
      error={save.error}
      onSubmit={() => {
        setErrors({});
        save.mutate();
      }}
      onDone={onDone}
    >
      <p className="mb-3 text-sm text-text-muted">{t('rates.package.intro')}</p>
      {rows.map((c, i) => (
        <fieldset
          key={i}
          className="mb-2 grid items-end gap-x-3 sm:grid-cols-[1fr_1fr_8rem_auto_auto]"
        >
          <legend className="sr-only">{t('rates.package.component', { n: i + 1 })}</legend>
          <Field
            label={t('rates.package.name')}
            value={c.name}
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <Select
            id={`component-code-${i}`}
            label={t('rates.package.code')}
            value={c.revenueCodeId}
            onChange={(v) => update(i, { revenueCodeId: v })}
            options={income.map((code) => ({ value: code.id, label: code.name }))}
          />
          <Field
            label={t('rates.package.amount')}
            inputMode="decimal"
            value={c.amount}
            onChange={(e) => update(i, { amount: e.target.value })}
          />
          <label className="mb-6 flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={c.perPerson}
              onChange={(e) => update(i, { perPerson: e.target.checked })}
            />
            {t('rates.package.perPerson')}
          </label>
          <Button
            className="mb-4"
            size="sm"
            variant="ghost"
            onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
          >
            {t('rates.package.remove')}
          </Button>
        </fieldset>
      ))}
      {errors['components'] && <p className="mb-2 text-sm text-critical">{errors['components']}</p>}
      <Button
        className="mb-4"
        size="sm"
        variant="secondary"
        onClick={() =>
          setRows((list) => [
            ...list,
            { name: '', revenueCodeId: income[0]?.id ?? '', amount: '', perPerson: false },
          ])
        }
      >
        {t('rates.package.add')}
      </Button>
    </FormShell>
  );
}
