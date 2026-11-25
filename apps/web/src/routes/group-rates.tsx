import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import groupRateStrings from '../i18n/en/group-rates.json';
import { registerStrings } from '../i18n/index.ts';

registerStrings(groupRateStrings);

// Rates across properties (PRD M2-13; T-162; beside the rate calendar, S23): one rate plan's
// prices or restrictions in several properties at once. Preview counts what would change;
// Apply sends the same change. The server checks every property first and changes all or none.

const card = 'rounded-md border border-border bg-surface p-4';
const MODES = ['NONE', 'PERCENT', 'AMOUNT', 'SET'] as const;
type Mode = (typeof MODES)[number];
type Body = Parameters<typeof send>[0];
type Result = Awaited<ReturnType<typeof send>>;
const send = (body: {
  propertyIds: string[];
  ratePlanCode: string;
  roomTypeCodes?: string[];
  from: string;
  to: string;
  weekdays: number[];
  price?:
    | { mode: 'PERCENT'; bps: number }
    | { mode: 'AMOUNT'; amountMinor: string }
    | { mode: 'SET'; amountMinor: string };
  restrictions?: { minStay?: number; stopSell?: boolean; closedToArrival?: boolean };
  dryRun: boolean;
}) => api.call('changeGroupRates', { body });

/** "5000" or "-2500.50" → minor units; null when not a number. */
function toMinor(text: string): string | null {
  const t = text.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole = '0', fraction = ''] = t.replace('-', '').split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return (t.startsWith('-') ? -minor : minor).toString();
}

export function GroupRatesPage() {
  const { t } = useTranslation();
  const session = useSession();
  const [picked, setPicked] = useState<string[]>(() =>
    session.currentPropertyId ? [session.currentPropertyId] : [],
  );
  const [plan, setPlan] = useState('BAR');
  const [types, setTypes] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5, 6, 7]);
  const [mode, setMode] = useState<Mode>('PERCENT');
  const [value, setValue] = useState('');
  const [minStay, setMinStay] = useState('');
  const [stopSell, setStopSell] = useState(false);
  const [closedToArrival, setClosedToArrival] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<{ body: string; out: Result } | null>(null);

  // The form's change as the API takes it, or what's wrong with it (pure: used while rendering).
  const compose = (dryRun: boolean): { body: Body } | { problem: string } => {
    if (picked.length === 0) return { problem: t('groupRates.pickProperty') };
    let price: Body['price'];
    if (mode === 'PERCENT') {
      const n = Number(value);
      if (!value.trim() || !Number.isFinite(n)) return { problem: t('groupRates.badNumber') };
      price = { mode, bps: Math.round(n * 100) };
    } else if (mode === 'AMOUNT' || mode === 'SET') {
      const minor = toMinor(value);
      if (minor === null) return { problem: t('groupRates.badNumber') };
      price = { mode, amountMinor: minor };
    }
    const restrictions = {
      ...(minStay.trim() ? { minStay: Number(minStay) } : {}),
      ...(stopSell ? { stopSell: true } : {}),
      ...(closedToArrival ? { closedToArrival: true } : {}),
    };
    const codes = types
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    return {
      body: {
        propertyIds: picked,
        ratePlanCode: plan.trim().toUpperCase(),
        ...(codes.length ? { roomTypeCodes: codes } : {}),
        from,
        to,
        weekdays,
        ...(price ? { price } : {}),
        ...(Object.keys(restrictions).length ? { restrictions } : {}),
        dryRun,
      },
    };
  };
  const run = useMutation({
    mutationFn: send,
    onSuccess: (out, body) => setResult({ body: JSON.stringify({ ...body, dryRun: false }), out }),
  });
  const submit = (dryRun: boolean) => {
    const c = compose(dryRun);
    if ('problem' in c) {
      setProblem(c.problem);
      return;
    }
    setProblem(null);
    run.mutate(c.body);
  };
  // Apply only what was previewed: any edit since needs a new preview.
  const now = compose(false);
  const previewed =
    result?.out.dryRun === true && 'body' in now && result.body === JSON.stringify(now.body);

  return (
    <section className="max-w-3xl">
      <h1 className="text-xl font-semibold">{t('groupRates.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('groupRates.intro')}</p>
      <form
        className={`${card} mt-4 flex flex-col gap-3`}
        aria-label={t('groupRates.form')}
        onSubmit={(e) => {
          e.preventDefault();
          submit(true);
        }}
      >
        <fieldset>
          <legend className="text-sm font-medium">{t('groupRates.properties')}</legend>
          {session.properties.map((p) => (
            <label key={p.id} className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(p.id)}
                onChange={(e) =>
                  setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))
                }
              />
              {p.name}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="gr-plan">{t('groupRates.plan')}</Label>
            <Input id="gr-plan" value={plan} onChange={(e) => setPlan(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="gr-types">{t('groupRates.roomTypes')}</Label>
            <Input id="gr-types" value={types} onChange={(e) => setTypes(e.target.value)} />
            <p className="mt-1 text-xs text-text-muted">{t('groupRates.roomTypesHint')}</p>
          </div>
          <div>
            <Label htmlFor="gr-from">{t('groupRates.from')}</Label>
            <Input
              id="gr-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="gr-to">{t('groupRates.to')}</Label>
            <Input id="gr-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">{t('groupRates.weekdays')}</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {(t('groupRates.days', { returnObjects: true }) as string[]).map((d, i) => (
              <label key={d} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={weekdays.includes(i + 1)}
                  onChange={(e) =>
                    setWeekdays(
                      e.target.checked
                        ? [...weekdays, i + 1].sort()
                        : weekdays.filter((x) => x !== i + 1),
                    )
                  }
                />
                {d}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <Label htmlFor="gr-mode">{t('groupRates.price')}</Label>
          <select
            id="gr-mode"
            className="mt-1 block rounded-md border border-border bg-surface p-2 text-sm"
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(`groupRates.priceModes.${m}`)}
              </option>
            ))}
          </select>
          {mode !== 'NONE' && (
            <div className="mt-2 max-w-xs">
              <Label htmlFor="gr-value">
                {mode === 'PERCENT'
                  ? t('groupRates.percent')
                  : mode === 'AMOUNT'
                    ? t('groupRates.amount')
                    : t('groupRates.setPrice')}
              </Label>
              <Input
                id="gr-value"
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          )}
        </div>
        <fieldset>
          <legend className="text-sm font-medium">{t('groupRates.restrictions')}</legend>
          <div className="mt-1 max-w-xs">
            <Label htmlFor="gr-minstay">{t('groupRates.minStay')}</Label>
            <Input
              id="gr-minstay"
              inputMode="numeric"
              value={minStay}
              onChange={(e) => setMinStay(e.target.value)}
            />
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={stopSell}
              onChange={(e) => setStopSell(e.target.checked)}
            />
            {t('groupRates.stopSell')}
          </label>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={closedToArrival}
              onChange={(e) => setClosedToArrival(e.target.checked)}
            />
            {t('groupRates.closedToArrival')}
          </label>
        </fieldset>
        {problem && <Alert tone="critical">{problem}</Alert>}
        {run.error && <Alert tone="critical">{errorList(run.error)}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="secondary" disabled={run.isPending}>
            {t('groupRates.preview')}
          </Button>
          <Button
            type="button"
            disabled={!previewed || run.isPending}
            onClick={() => submit(false)}
          >
            {t('groupRates.apply', { count: picked.length })}
          </Button>
        </div>
      </form>
      {result && (
        <div className={`${card} mt-4`} role="status">
          <p className="font-medium">
            {result.out.dryRun
              ? t('groupRates.previewResult', { count: result.out.changedDays })
              : t('groupRates.applied', { count: result.out.changedDays })}
          </p>
          <ul className="mt-2 text-sm">
            {result.out.properties.map((p) => (
              <li key={p.propertyId}>
                {t('groupRates.propertyResult', {
                  name: p.name,
                  count: p.changedDays,
                  types: p.roomTypeCodes.join(', '),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Each property's problem on its own line, else the error's message. */
function errorList(error: unknown) {
  const issues = (error as { details?: { issues?: { message?: string }[] } }).details?.issues;
  return issues?.length ? (
    <ul>
      {issues.map((i, n) => (
        <li key={n}>{i.message}</li>
      ))}
    </ul>
  ) : (
    errorMessage(error)
  );
}
