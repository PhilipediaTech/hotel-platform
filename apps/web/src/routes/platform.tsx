import {
  PLANS,
  SUBSCRIPTION_STATUSES,
  type PlatformTenantDetail,
  type PlatformTenantItem,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { ME_QUERY_KEY } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import platformStrings from '../i18n/en/platform.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';

registerStrings(platformStrings);

// S31 Platform (PRD M13-01–M13-05; T-100), for platform staff: hotel groups with plan, status
// and usage; per group the plan and prices, modules, monthly invoices and support sessions.

type Tenant = z.output<typeof PlatformTenantItem>;
type Detail = z.output<typeof PlatformTenantDetail>;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const KEY = ['platform'];

function useMoney() {
  const { i18n } = useTranslation();
  return (minor: string, currency = 'NGN') =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(
      Number(minor) / 100,
    );
}

function PlanForm({ tenant }: { tenant: Detail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const s = tenant.subscription;
  const [plan, setPlan] = useState<string>(s?.plan ?? 'ESSENTIALS');
  const [price, setPrice] = useState(s ? String(Number(s.pricePerRoomMinor) / 100) : '');
  const [minimum, setMinimum] = useState(s ? String(Number(s.minimumMinor) / 100) : '');
  const [status, setStatus] = useState<string>(s?.status ?? 'TRIAL');
  const [periodEnd, setPeriodEnd] = useState(s?.currentPeriodEnd ?? '');
  const save = useMutation({
    mutationFn: () =>
      api.call('setTenantSubscription', {
        params: { organisationId: tenant.id },
        body: {
          plan: plan as (typeof PLANS)[number],
          pricePerRoomMinor: toMinor(price) ?? price,
          minimumMinor: toMinor(minimum) ?? minimum,
          currency: 'NGN',
          status: status as (typeof SUBSCRIPTION_STATUSES)[number],
          currentPeriodEnd: periodEnd,
        },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  return (
    <form
      aria-label={t('platform.plan')}
      className="grid gap-2 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="font-semibold sm:col-span-3">{t('platform.plan')}</h3>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pl-plan">{t('platform.planName')}</Label>
        <select
          id="pl-plan"
          className={selectClass}
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
        >
          {PLANS.map((p) => (
            <option key={p} value={p}>
              {t(`platform.plans.${p}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pl-price">{t('platform.pricePerRoom')}</Label>
        <Input
          id="pl-price"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pl-min">{t('platform.minimum')}</Label>
        <Input
          id="pl-min"
          inputMode="decimal"
          value={minimum}
          onChange={(e) => setMinimum(e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pl-status">{t('platform.status')}</Label>
        <select
          id="pl-status"
          className={selectClass}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {SUBSCRIPTION_STATUSES.map((x) => (
            <option key={x} value={x}>
              {t(`platform.statuses.${x}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pl-end">{t('platform.periodEnd')}</Label>
        <Input
          id="pl-end"
          type="date"
          value={periodEnd}
          onChange={(e) => setPeriodEnd(e.target.value)}
          required
        />
      </div>
      <div className="flex items-end gap-2">
        <Button type="submit" disabled={save.isPending}>
          {t('platform.savePlan')}
        </Button>
        {save.isSuccess && (
          <span role="status" className="text-sm">
            {t('platform.saved')}
          </span>
        )}
      </div>
      {save.error && (
        <Alert tone="critical" className="sm:col-span-3">
          {errorMessage(save.error)}
        </Alert>
      )}
    </form>
  );
}

function Modules({ tenant }: { tenant: Detail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: (flag: { module: Detail['flags'][number]['module']; enabled: boolean }) =>
      api.call('updateTenantFlags', {
        params: { organisationId: tenant.id },
        body: { flags: [flag] },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  return (
    <section aria-label={t('platform.modules')}>
      <h3 className="font-semibold">{t('platform.modules')}</h3>
      <ul className="mt-1 flex flex-col gap-1">
        {tenant.flags.map((f) => (
          <li key={f.module}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={f.enabled}
                disabled={set.isPending}
                onChange={(e) => set.mutate({ module: f.module, enabled: e.target.checked })}
              />
              {f.label}
            </label>
          </li>
        ))}
      </ul>
      {set.error && <Alert tone="critical">{errorMessage(set.error)}</Alert>}
    </section>
  );
}

function Invoices({ tenant }: { tenant: Detail }) {
  const { t } = useTranslation();
  const money = useMoney();
  const queryClient = useQueryClient();
  const lastMonth = (() => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();
  const [month, setMonth] = useState(lastMonth);
  const done = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const issue = useMutation({
    mutationFn: () =>
      api.call('issuePlatformInvoice', { body: { organisationId: tenant.id, month } }),
    onSuccess: done,
  });
  const update = useMutation({
    mutationFn: (x: { invoiceId: string; status: 'PAID' | 'VOID' }) =>
      api.call('updatePlatformInvoice', {
        params: { invoiceId: x.invoiceId },
        body: { status: x.status },
      }),
    onSuccess: done,
  });
  return (
    <section aria-label={t('platform.invoices')}>
      <h3 className="font-semibold">{t('platform.invoices')}</h3>
      <form
        className="mt-1 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          issue.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="pl-month">{t('platform.month')}</Label>
          <Input
            id="pl-month"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            required
          />
        </div>
        <Button type="submit" variant="secondary" disabled={issue.isPending}>
          {t('platform.issue')}
        </Button>
      </form>
      {(issue.error ?? update.error) && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(issue.error ?? update.error)}
        </Alert>
      )}
      {tenant.invoices.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">{t('platform.noInvoices')}</p>
      )}
      <ul className="mt-2 flex flex-col gap-1">
        {tenant.invoices.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{inv.number}</span>
            <span>{money(inv.totalMinor, inv.currency)}</span>
            <span className="text-text-muted">
              {inv.activeRooms} · {t(`platform.invoiceStatus.${inv.status}`)}
            </span>
            {inv.status === 'ISSUED' && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => update.mutate({ invoiceId: inv.id, status: 'PAID' })}
                >
                  {t('platform.markPaid')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => update.mutate({ invoiceId: inv.id, status: 'VOID' })}
                >
                  {t('platform.void')}
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Support({ tenant }: { tenant: Detail }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('30');
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: KEY });
    // The session adds (or removes) the group in the property switcher.
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  };
  const start = useMutation({
    mutationFn: () =>
      api.call('startSupportSession', {
        body: { organisationId: tenant.id, reason: reason.trim(), minutes: Number(minutes) },
      }),
    onSuccess: async () => {
      setReason('');
      await done();
    },
  });
  const end = useMutation({
    mutationFn: (sessionId: string) => api.call('endSupportSession', { params: { sessionId } }),
    onSuccess: done,
  });
  const when = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' }).format(
      new Date(iso),
    );
  return (
    <section aria-label={t('platform.support')}>
      <h3 className="font-semibold">{t('platform.support')}</h3>
      <p className="text-sm text-text-muted">{t('platform.supportIntro')}</p>
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          start.mutate();
        }}
      >
        <div className="flex min-w-72 flex-1 flex-col gap-1">
          <Label htmlFor="pl-reason">{t('platform.reason')}</Label>
          <Input
            id="pl-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={10}
            maxLength={500}
            required
          />
        </div>
        <div className="flex w-32 flex-col gap-1">
          <Label htmlFor="pl-minutes">{t('platform.minutes')}</Label>
          <Input
            id="pl-minutes"
            type="number"
            min={5}
            max={60}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={start.isPending}>
          {t('platform.start')}
        </Button>
      </form>
      {(start.error ?? end.error) && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(start.error ?? end.error)}
        </Alert>
      )}
      {tenant.supportSessions.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">{t('platform.noSupport')}</p>
      )}
      <ul className="mt-2 flex flex-col gap-1">
        {tenant.supportSessions.map((x) => (
          <li key={x.id} className="text-sm">
            <span className="font-medium">{x.reason}</span>
            {x.active && <span className="ml-2 text-critical">{t('platform.open')}</span>}
            <span className="block text-text-muted">
              {t('platform.sessionLine', {
                name: x.admin.name,
                start: when(x.startedAt),
                end: when(x.endedAt ?? x.expiresAt),
                views: x.views,
              })}
            </span>
            {x.active && (
              <Button size="sm" variant="secondary" onClick={() => end.mutate(x.id)}>
                {t('platform.end')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TenantDetail({ id }: { id: string }) {
  const q = useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.call('getPlatformTenant', { params: { organisationId: id } }),
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  if (!q.data) return null;
  return (
    <article
      aria-label={q.data.name}
      className="flex flex-col gap-6 rounded-md border border-border bg-surface p-4"
    >
      <h2 className="text-lg font-semibold">{q.data.name}</h2>
      <PlanForm key={JSON.stringify(q.data.subscription)} tenant={q.data} />
      <Modules tenant={q.data} />
      <Invoices tenant={q.data} />
      <Support tenant={q.data} />
    </article>
  );
}

export function PlatformPage() {
  const { t } = useTranslation();
  const list = useQuery({
    queryKey: [...KEY, 'list'],
    queryFn: () => api.call('listPlatformTenants'),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const tenants: Tenant[] = list.data?.data ?? [];
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('platform.title')}</h1>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-[20rem_1fr]">
        <nav aria-label={t('platform.tenants')}>
          {list.data && tenants.length === 0 && (
            <p className="text-sm">{t('platform.noTenants')}</p>
          )}
          <ul className="flex flex-col gap-2">
            {tenants.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  aria-pressed={selected === x.id}
                  className={cn(
                    'w-full rounded-md border border-border bg-surface p-3 text-left text-sm',
                    selected === x.id && 'border-brand',
                  )}
                  onClick={() => setSelected(x.id)}
                >
                  <span className="block font-semibold">{x.name}</span>
                  <span className="block text-text-muted">
                    {t('platform.properties', { count: x.properties })} ·{' '}
                    {x.subscription
                      ? `${t(`platform.plans.${x.subscription.plan}`)}, ${t(`platform.statuses.${x.subscription.status}`)}`
                      : t('platform.noPlan')}
                  </span>
                  <span className="block text-text-muted">
                    {t('platform.usage', {
                      rooms: x.usage.activeRooms,
                      messages: x.usage.whatsappMessages,
                    })}
                  </span>
                  {x.activeSupportSession && (
                    <span className="block text-critical">{t('platform.inSupport')}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {selected && <TenantDetail key={selected} id={selected} />}
      </div>
    </section>
  );
}
