import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import paceStrings from '../i18n/en/pace.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(paceStrings);

// Pickup and pace (Versions V2 "revenue-management support"; T-165), a tab of S28 Reports:
// the coming nights on the books, what was picked up lately, and the same nights last year.
// The forecast (V3; T-179) is worked out by rules; "Explain with AI" only puts it in words.

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function Pace() {
  const { t } = useTranslation();
  const f = useFormats();
  const { currentPropertyId } = useSession();
  const [from, setFrom] = useState('');
  const [days, setDays] = useState('30');
  const q = useQuery({
    queryKey: ['reports', currentPropertyId ?? '', 'pace', from, days],
    queryFn: () =>
      api.call('getPaceReport', {
        query: { ...(from ? { from } : {}), days: Number(days) || 30 },
      }),
  });
  const r = q.data;
  const explain = useMutation({
    mutationFn: () =>
      api.call('explainPaceForecast', {
        body: { ...(from ? { from } : {}), days: Number(days) || 30 },
      }),
  });
  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <div>
          <Label htmlFor="pace-from">{t('pace.from')}</Label>
          <Input
            id="pace-from"
            type="date"
            value={from || (r?.from ?? '')}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="pace-days">{t('pace.days')}</Label>
          <select
            id="pace-days"
            className="mt-1 block rounded-md border border-border bg-surface p-2 text-sm"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          >
            {['14', '30', '60', '90', '120'].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      </div>
      {q.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(q.error)}
        </Alert>
      )}
      {r && (
        <>
          <p className="mt-3 text-sm" role="status">
            {t('pace.summary', {
              rooms: r.totals.rooms,
              occupancy: pct(r.totals.occupancyBps),
              revenue: f.money(r.totals.revenueMinor),
              d1: signed(r.totals.pickup.d1),
              d7: signed(r.totals.pickup.d7),
              d30: signed(r.totals.pickup.d30),
              sameTime: r.totals.lastYear.sameTime,
              final: r.totals.lastYear.final,
            })}
          </p>
          <p className="mt-1 text-sm font-medium">
            {t('pace.forecast.summary', {
              rooms: r.totals.forecast.rooms,
              occupancy: pct(r.totals.forecast.occupancyBps),
              low: r.totals.forecast.low,
              high: r.totals.forecast.high,
            })}
          </p>
          <div className="mt-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={explain.isPending}
              onClick={() => explain.mutate()}
            >
              {explain.isPending ? t('pace.forecast.explaining') : t('pace.forecast.explain')}
            </Button>
          </div>
          {explain.error && (
            <Alert tone="critical" className="mt-2">
              {errorMessage(explain.error)}
            </Alert>
          )}
          {explain.data && (
            <p className="mt-2 max-w-2xl text-sm">
              <span className="font-medium">{t('pace.forecast.byAi')}</span> {explain.data.note}
            </p>
          )}
          <div className="mt-3 overflow-x-auto">
            <table className="text-sm" aria-label={t('pace.table')}>
              <thead>
                <tr>
                  <th className="pr-3 text-left">{t('pace.night')}</th>
                  <th className="px-2 text-right">{t('pace.available')}</th>
                  <th className="px-2 text-right">{t('pace.rooms')}</th>
                  <th className="px-2 text-right">{t('pace.occupancy')}</th>
                  <th className="px-2 text-right">{t('pace.forecast.column')}</th>
                  <th className="px-2 text-left">{t('pace.forecast.why')}</th>
                  <th className="px-2 text-right">{t('pace.revenue')}</th>
                  <th className="px-2 text-right">
                    {t('pace.pickup')} {t('pace.d1')}
                  </th>
                  <th className="px-2 text-right">{t('pace.d7')}</th>
                  <th className="px-2 text-right">{t('pace.d30')}</th>
                  <th className="px-2 text-right">{t('pace.lastYearSame')}</th>
                  <th className="pl-2 text-right">{t('pace.lastYearFinal')}</th>
                </tr>
              </thead>
              <tbody>
                {r.nights.map((n) => (
                  <tr key={n.date}>
                    <th scope="row" className="pr-3 text-left font-normal">
                      {f.date(n.date)}
                    </th>
                    <td className="px-2 text-right">{n.roomsAvailable}</td>
                    <td className="px-2 text-right">{n.rooms}</td>
                    <td className="px-2 text-right">{pct(n.occupancyBps)}</td>
                    <td className="px-2 text-right">
                      {n.forecast.rooms}{' '}
                      <span className="text-xs text-text-muted">
                        ({t('pace.forecast.range', { low: n.forecast.low, high: n.forecast.high })})
                      </span>
                    </td>
                    <td className="px-2 text-xs text-text-muted">
                      {t(`pace.forecast.${n.forecast.method}`, {
                        pickup: signed(n.forecast.usualPickup),
                        compared: n.forecast.compared,
                      })}
                    </td>
                    <td className="px-2 text-right">{f.money(n.revenueMinor)}</td>
                    <td className="px-2 text-right">{signed(n.pickup.d1)}</td>
                    <td className="px-2 text-right">{signed(n.pickup.d7)}</td>
                    <td className="px-2 text-right">{signed(n.pickup.d30)}</td>
                    <td className="px-2 text-right">{n.lastYear.sameTime}</td>
                    <td className="pl-2 text-right">{n.lastYear.final}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-text-muted">{r.definitions}</p>
        </>
      )}
    </div>
  );
}
