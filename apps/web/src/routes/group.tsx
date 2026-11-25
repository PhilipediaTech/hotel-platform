import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import groupStrings from '../i18n/en/group.json';
import { registerStrings } from '../i18n/index.ts';

registerStrings(groupStrings);

// Group dashboards (PRD M1-13, M12-07; S46 /group; T-161): the owner's month across
// properties, each in its own currency, and the group's totals in the group currency. A
// property in another currency joins the money totals once the month's rate is set below.

const card = 'rounded-md border border-border bg-surface p-4';
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

type Dashboard = Awaited<ReturnType<typeof dashboardOf>>;
const dashboardOf = (month: string) => api.call('getGroupDashboard', { query: { month } });

function useMoney() {
  const { i18n } = useTranslation();
  return (minor: string, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(
      Number(minor) / 100,
    );
}

/** This month in the property's calendar, as "2026-11". */
function thisMonth(timeZone: string | undefined) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
  return parts.slice(0, 7);
}

export function GroupPage() {
  const { t } = useTranslation();
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const [month, setMonth] = useState(() => thisMonth(property?.timeZone));
  const q = useQuery({
    queryKey: ['group-dashboard', session.currentPropertyId ?? '', month],
    queryFn: () => dashboardOf(month),
  });
  const d = q.data;
  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('group.title')}</h1>
      {d && (
        <p className="mt-1 text-sm text-text-muted">
          {t('group.intro', { currency: d.groupCurrency })}
        </p>
      )}
      <div className="mt-3 max-w-xs">
        <Label htmlFor="group-month">{t('group.month')}</Label>
        <Input
          id="group-month"
          type="month"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
        />
      </div>
      {q.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(q.error)}
        </Alert>
      )}
      {d && <Totals d={d} />}
      {d && <Comparison d={d} />}
      {d && <RatesCard month={month} />}
    </section>
  );
}

function Totals({ d }: { d: Dashboard }) {
  const { t } = useTranslation();
  const money = useMoney();
  const c = d.groupCurrency;
  const tiles: [string, string][] = [
    [t('group.occupancy'), pct(d.totals.occupancyBps)],
    [t('group.roomsSold'), String(d.totals.roomsSold)],
    [t('group.adr'), money(d.totals.adrMinor, c)],
    [t('group.revpar'), money(d.totals.revparMinor, c)],
    [t('group.roomRevenue'), money(d.totals.roomRevenueMinor, c)],
    [t('group.revenue'), money(d.totals.revenueMinor, c)],
  ];
  return (
    <div className={`${card} mt-4`} role="group" aria-label={t('group.totals')}>
      <h2 className="font-medium">{t('group.totals')}</h2>
      <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {tiles.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-text-muted">{label}</dt>
            <dd className="text-lg font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-sm text-text-muted">
        {t('group.inTotals', {
          count: d.totals.propertiesInMoneyTotals,
          total: d.properties.length,
        })}
      </p>
      {d.missingRates.length > 0 && (
        <Alert tone="info" className="mt-2">
          {t('group.missing', { month: d.month, currencies: d.missingRates.join(', ') })}
        </Alert>
      )}
    </div>
  );
}

function Comparison({ d }: { d: Dashboard }) {
  const { t } = useTranslation();
  const money = useMoney();
  return (
    <div className={`${card} mt-4 overflow-x-auto`}>
      <h2 className="font-medium">{t('group.properties')}</h2>
      <table className="mt-2 text-sm" aria-label={t('group.properties')}>
        <thead>
          <tr>
            <th className="pr-3 text-left">{t('group.property')}</th>
            <th className="px-2 text-right">{t('group.days')}</th>
            <th className="px-2 text-right">{t('group.occupancy')}</th>
            <th className="px-2 text-right">{t('group.adr')}</th>
            <th className="px-2 text-right">{t('group.revpar')}</th>
            <th className="px-2 text-right">{t('group.revenue')}</th>
            <th className="pl-2 text-right">{t('group.inGroup', { currency: d.groupCurrency })}</th>
          </tr>
        </thead>
        <tbody>
          {d.properties.map((p) => (
            <tr key={p.propertyId}>
              <th scope="row" className="pr-3 text-left font-normal">
                {p.name}
              </th>
              <td className="px-2 text-right">{p.days}</td>
              <td className="px-2 text-right">{p.days ? pct(p.occupancyBps) : '—'}</td>
              <td className="px-2 text-right">{money(p.adrMinor, p.currency)}</td>
              <td className="px-2 text-right">{money(p.revparMinor, p.currency)}</td>
              <td className="px-2 text-right">{money(p.revenueMinor, p.currency)}</td>
              <td className="pl-2 text-right">
                {p.inGroupCurrency
                  ? money(p.inGroupCurrency.revenueMinor, d.groupCurrency)
                  : t('group.noRate')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RatesCard({ month }: { month: string }) {
  const { t } = useTranslation();
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ['group-rates', session.currentPropertyId ?? '', month];
  const rates = useQuery({
    queryKey: key,
    queryFn: () => api.call('getGroupRates', { query: { month } }),
  });
  const [draft, setDraft] = useState<{ month: string; values: Record<string, string> } | null>(
    null,
  );
  const data = rates.data;
  const values =
    draft?.month === month
      ? draft.values
      : Object.fromEntries((data?.rates ?? []).map((r) => [r.currency, r.rate ?? '']));
  const save = useMutation({
    mutationFn: () =>
      api.call('putGroupRates', {
        body: {
          month,
          groupCurrency: data?.groupCurrency ?? 'NGN',
          rates: Object.entries(values)
            .filter(([, rate]) => rate.trim() !== '')
            .map(([currency, rate]) => ({ currency, rate: rate.trim() })),
        },
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(key, saved);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['group-dashboard'] });
    },
  });
  if (!data) return null;
  return (
    <form
      className={`${card} mt-4`}
      aria-label={t('group.rates.title')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="font-medium">{t('group.rates.title')}</h2>
      <p className="mt-1 text-sm text-text-muted">{t('group.rates.intro')}</p>
      <p className="mt-2 text-sm">
        {t('group.rates.groupCurrency')}: {data.groupCurrency}
      </p>
      {data.rates.length === 0 && <p className="mt-2 text-sm">{t('group.rates.none')}</p>}
      {data.rates.map((r) => (
        <div key={r.currency} className="mt-3 max-w-xs">
          <Label htmlFor={`rate-${r.currency}`}>
            {t('group.rates.rateFor', { currency: r.currency, group: data.groupCurrency })}
          </Label>
          <Input
            id={`rate-${r.currency}`}
            inputMode="decimal"
            value={values[r.currency] ?? ''}
            onChange={(e) =>
              setDraft({ month, values: { ...values, [r.currency]: e.target.value } })
            }
          />
          {r.setBy && (
            <p className="mt-1 text-xs text-text-muted">
              {t('group.rates.setBy', { name: r.setBy })}
            </p>
          )}
        </div>
      ))}
      {save.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      {save.isSuccess && !draft && <p className="mt-2 text-sm">{t('group.rates.saved')}</p>}
      {data.rates.length > 0 && (
        <Button type="submit" className="mt-3" disabled={save.isPending}>
          {t('group.rates.save')}
        </Button>
      )}
    </form>
  );
}
