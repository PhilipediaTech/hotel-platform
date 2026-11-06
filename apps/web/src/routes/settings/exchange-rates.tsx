import { RateText } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { api } from '../../lib/api.ts';
import { errorMessage } from '../../lib/form.ts';
import { useFormats } from '../reservations.tsx';
import financeStrings from '../../i18n/en/finance.json';
import { registerStrings } from '../../i18n/index.ts';

registerStrings(financeStrings);

// S25 Exchange rates tab (PRD M4-18; T-065): the rates in force on the business date (set for
// it or carried from an earlier day) and, for fx.manage, setting a rate for today or later.

export const ratesKey = (pid: string | null, date: string) => ['exchange-rates', pid ?? '', date];

export function ExchangeRatesTab() {
  const { t } = useTranslation();
  const f = useFormats();
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const today = session.businessDate ?? new Date().toISOString().slice(0, 10);
  const canEdit = session.permissions.includes('fx.manage');
  const queryClient = useQueryClient();
  const rates = useQuery({
    queryKey: ratesKey(session.currentPropertyId, today),
    queryFn: () => api.call('getExchangeRates', { params: { date: today } }),
  });
  const [currency, setCurrency] = useState('USD');
  const [rate, setRate] = useState('');
  const [date, setDate] = useState(today);
  const valid = /^[A-Z]{3}$/.test(currency) && RateText.safeParse(rate.replace(/,/g, '')).success;
  const save = useMutation({
    mutationFn: () =>
      api.call('putExchangeRates', {
        params: { date },
        body: { rates: [{ currency, rate: rate.replace(/,/g, '') }] },
      }),
    onSuccess: () => {
      setRate('');
      void queryClient.invalidateQueries({ queryKey: ['exchange-rates'] });
    },
  });
  const base = property?.baseCurrency ?? 'NGN';

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p className="text-sm text-text-muted">{t('fx.intro', { base })}</p>
      {rates.error && <Alert tone="critical">{errorMessage(rates.error)}</Alert>}
      {rates.data && rates.data.rates.length === 0 && (
        <p className="text-sm text-text-muted">{t('fx.none')}</p>
      )}
      {rates.data && rates.data.rates.length > 0 && (
        <table aria-label={t('fx.title')} className="w-full text-left text-sm">
          <thead className="text-text-muted">
            <tr>
              <th className="py-2 pr-3 font-medium">{t('fx.currency')}</th>
              <th className="py-2 pr-3 font-medium">{t('fx.rate', { base })}</th>
              <th className="py-2 pr-3 font-medium">{t('fx.setFor')}</th>
              <th className="py-2 font-medium">{t('fx.setBy')}</th>
            </tr>
          </thead>
          <tbody>
            {rates.data.rates.map((r) => (
              <tr key={r.currency} className="border-t border-border">
                <td className="py-1.5 pr-3">{r.currency}</td>
                <td className="py-1.5 pr-3 tabular-nums">{r.rate}</td>
                <td className="py-1.5 pr-3">
                  {f.date(r.setFor)}
                  {r.setFor !== today && (
                    <span className="ml-1 text-xs text-text-muted">{t('fx.carried')}</span>
                  )}
                  {r.lockedAt && (
                    <span className="ml-1 text-xs text-text-muted">{t('fx.locked')}</span>
                  )}
                </td>
                <td className="py-1.5">{r.setBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canEdit && (
        <form
          aria-label={t('fx.set')}
          className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <h2 className="w-full font-semibold">{t('fx.set')}</h2>
          <div className="flex flex-col gap-1">
            <Label htmlFor="fx-currency">{t('fx.currency')}</Label>
            <Input
              id="fx-currency"
              className="w-24"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="fx-rate">{t('fx.rateFor', { currency, base })}</Label>
            <Input
              id="fx-rate"
              inputMode="decimal"
              placeholder="1580.50"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="fx-date">{t('fx.date')}</Label>
            <Input
              id="fx-date"
              type="date"
              min={today}
              value={date}
              onChange={(e) => setDate(e.target.value || today)}
            />
          </div>
          <Button type="submit" disabled={!valid || save.isPending}>
            {t('fx.save')}
          </Button>
          {save.error && (
            <Alert tone="critical" className="w-full">
              {errorMessage(save.error)}
            </Alert>
          )}
        </form>
      )}
    </div>
  );
}
