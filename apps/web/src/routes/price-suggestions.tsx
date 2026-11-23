import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';
import suggestionStrings from '../i18n/en/price-suggestions.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(suggestionStrings);

// Price suggestions (PRD M14-13; T-149): per room type and date, the suggested change with its
// reasons; the revenue user picks which to accept, changing a price first if they like.

const DAY_CHOICES = [14, 30, 60, 90] as const;
const keyOf = (s: { ratePlan: { id: string }; roomType: { id: string }; date: string }) =>
  `${s.ratePlan.id}|${s.roomType.id}|${s.date}`;

export function PriceSuggestionsPage() {
  const { t } = useTranslation();
  const f = useFormats();
  const { currentPropertyId } = useSession();
  const queryClient = useQueryClient();
  const [days, setDays] = useState<number>(30);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const root = ['price-suggestions', currentPropertyId ?? ''];
  const list = useQuery({
    queryKey: [...root, days],
    queryFn: () => api.call('listPriceSuggestions', { query: { days } }),
  });
  const rows = list.data?.data ?? [];
  const accept = useMutation({
    mutationFn: () =>
      api.call('acceptPriceSuggestions', {
        body: {
          items: rows
            .filter((s) => picked[keyOf(s)] !== undefined)
            .map((s) => ({
              ratePlanId: s.ratePlan.id,
              roomTypeId: s.roomType.id,
              date: s.date,
              amountMinor: toMinor(picked[keyOf(s)] ?? '') ?? s.suggestedMinor,
              suggestedMinor: s.suggestedMinor,
            })),
        },
      }),
    onSuccess: () => {
      setPicked({});
      void queryClient.invalidateQueries({ queryKey: root });
    },
  });
  const count = Object.keys(picked).length;
  const major = (minor: string) => (Number(minor) / 100).toFixed(2);
  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('priceSuggestions.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('priceSuggestions.intro')}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="ps-days">{t('priceSuggestions.days')}</Label>
          <select
            id="ps-days"
            className="h-11 rounded-md border border-border bg-surface px-3 text-sm"
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              setPicked({});
            }}
          >
            {DAY_CHOICES.map((d) => (
              <option key={d} value={d}>
                {t('priceSuggestions.daysOption', { count: d })}
              </option>
            ))}
          </select>
        </div>
        <Button
          className="h-11"
          disabled={count === 0 || accept.isPending}
          onClick={() => accept.mutate()}
        >
          {t('priceSuggestions.accept', { count })}
        </Button>
      </div>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {accept.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(accept.error)}
        </Alert>
      )}
      {accept.data && (
        <Alert tone="success" className="mt-3">
          {t('priceSuggestions.accepted', { count: accept.data.changedDays })}
        </Alert>
      )}
      {list.data && rows.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('priceSuggestions.none')}</p>
      )}
      <ul aria-label={t('priceSuggestions.title')} className="mt-3 flex flex-col gap-2">
        {rows.map((s) => {
          const k = keyOf(s);
          const on = picked[k] !== undefined;
          const pct = Math.abs(s.changeBps) / 100;
          const label = { roomType: s.roomType.name, date: f.date(s.date) };
          return (
            <li key={k} className="rounded-md border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="checkbox"
                  className="size-5"
                  aria-label={t('priceSuggestions.select', label)}
                  checked={on}
                  onChange={(e) => {
                    const next = { ...picked };
                    if (e.target.checked) next[k] = major(s.suggestedMinor);
                    else delete next[k];
                    setPicked(next);
                  }}
                />
                <span className="font-medium">{f.date(s.date)}</span>
                <span>
                  {s.roomType.name} · {s.ratePlan.code}
                </span>
                <span className="text-text-muted">{f.money(s.currentMinor)}</span>
                <span>→</span>
                <span className="font-semibold">{f.money(s.suggestedMinor)}</span>
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-sm',
                    s.changeBps > 0
                      ? 'bg-success-subtle text-success'
                      : 'bg-warning-subtle text-warning',
                  )}
                >
                  {s.changeBps > 0
                    ? t('priceSuggestions.up', { pct })
                    : t('priceSuggestions.down', { pct })}
                </span>
                {on && (
                  <Input
                    aria-label={t('priceSuggestions.price', label)}
                    className="w-32"
                    inputMode="decimal"
                    value={picked[k]}
                    onChange={(e) => setPicked({ ...picked, [k]: e.target.value })}
                  />
                )}
              </div>
              <ul className="mt-1 list-inside list-disc text-sm text-text-muted">
                {s.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
