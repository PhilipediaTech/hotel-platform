import {
  FUEL_KINDS,
  type FuelKind,
  type GeneratorItem,
  type MeterReadingItem,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import utilitiesStrings from '../i18n/en/utilities.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';
import { amountToMinor, hoursAndMinutes } from './work-order.tsx';

registerStrings(utilitiesStrings);

// S35 Utilities (PRD M5-11, M5-12, M5 rule 4; T-132). Generators: start and stop, diesel
// received and issued, fuel checks with the variance since the last check (above the leakage
// threshold it raises an alert). Meters: readings per shift with the usage since the last one.

type Generator = z.output<typeof GeneratorItem>;
type Reading = z.output<typeof MeterReadingItem>;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';

/** "1,250.5" → 1250500 millilitres; null when not a number of litres. */
export function litresToMilli(text: string): number | null {
  const t = text.trim().replaceAll(',', '');
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(t)) return null;
  const [whole = '0', frac = ''] = t.split('.');
  return Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
}

const litres = (milli: number) =>
  (milli / 1000).toLocaleString('en-NG', { maximumFractionDigits: 1 });

function useKey(...parts: string[]) {
  const { currentPropertyId } = useSession();
  return ['utilities', currentPropertyId ?? '', ...parts];
}

export function UtilitiesPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'meters' ? 'meters' : 'generators';
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('utl.title')}</h1>
      <div role="tablist" aria-label={t('utl.views')} className="mt-3 flex gap-2">
        {(['generators', 'meters'] as const).map((v) => (
          <Button
            key={v}
            role="tab"
            aria-selected={view === v}
            variant={view === v ? 'primary' : 'secondary'}
            className="h-11"
            onClick={() => setParams(v === 'generators' ? {} : { view: v })}
          >
            {t(`utl.view.${v}`)}
          </Button>
        ))}
      </div>
      {view === 'generators' ? <Generators /> : <Meters />}
    </section>
  );
}

// ── Generators ─────────────────────────────────────────────────────────────────────────

function Generators() {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({
    queryKey: useKey('generators'),
    queryFn: () => api.call('listGenerators', {}),
  });
  return (
    <div className="mt-4">
      {!adding && (
        <Button className="h-11" onClick={() => setAdding(true)}>
          {t('utl.gen.add')}
        </Button>
      )}
      {adding && <GeneratorForm onDone={() => setAdding(false)} />}
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {list.data && list.data.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('utl.gen.none')}</p>
      )}
      <ul aria-label={t('utl.gen.list')} className="mt-3 grid gap-3 lg:grid-cols-2">
        {list.data?.data.map((g) => (
          <GeneratorCard
            key={g.id}
            generator={g}
            open={open === g.id}
            onToggle={() => setOpen(open === g.id ? null : g.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function GeneratorCard(props: { generator: Generator; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const listKey = useKey('generators');
  const detailKey = useKey('generator', props.generator.id);
  const g = props.generator;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: listKey });
    void queryClient.invalidateQueries({ queryKey: detailKey });
  };
  const start = useMutation({
    mutationFn: () => api.call('startGeneratorRun', { params: { generatorId: g.id }, body: {} }),
    onSuccess: refresh,
  });
  const stop = useMutation({
    mutationFn: (runId: string) => api.call('stopGeneratorRun', { params: { runId }, body: {} }),
    onSuccess: refresh,
  });
  const error = start.error ?? stop.error;
  return (
    <li
      aria-label={g.name}
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">
          {g.name} · {g.asset.tag}
        </span>
        <span
          className={cn(
            'rounded px-2 py-0.5 text-xs font-medium',
            g.running ? 'bg-success-subtle text-success' : 'bg-surface-muted text-text-muted',
          )}
        >
          {g.running ? t('utl.gen.running') : t('utl.gen.stopped')}
        </span>
      </div>
      <p className="text-text-muted">
        {[
          g.running
            ? t('utl.gen.since', {
                when: f.when(g.running.startedAt),
                time: hoursAndMinutes(t, g.running.minutes),
              })
            : null,
          t('utl.gen.today', { time: hoursAndMinutes(t, g.minutesToday) }),
          t('utl.gen.tank', { litres: litres(g.tankLitresMilli) }),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <p>
        {g.lastCheck
          ? t('utl.fuel.position', {
              checked: litres(g.lastCheck.litresMilli),
              when: f.when(g.lastCheck.at),
              received: litres(g.receivedMilli),
              issued: litres(g.issuedMilli),
              expected: litres(g.expectedMilli ?? 0),
            })
          : t('utl.fuel.noCheck')}
      </p>
      <div className="flex flex-wrap gap-2">
        {g.running ? (
          <Button
            className="h-11"
            disabled={stop.isPending}
            onClick={() => g.running && stop.mutate(g.running.id)}
          >
            {t('utl.gen.stop')}
          </Button>
        ) : (
          <Button className="h-11" disabled={start.isPending} onClick={() => start.mutate()}>
            {t('utl.gen.start')}
          </Button>
        )}
        <Button variant="secondary" className="h-11" onClick={props.onToggle}>
          {props.open ? t('utl.gen.hide') : t('utl.gen.fuelAndLog')}
        </Button>
      </div>
      {error && <Alert tone="critical">{errorMessage(error)}</Alert>}
      {props.open && (
        <>
          <FuelForm generatorId={g.id} onSaved={refresh} />
          <GeneratorLog generatorId={g.id} />
        </>
      )}
    </li>
  );
}

function FuelForm(props: { generatorId: string; onSaved: () => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<FuelKind>('LEVEL_CHECK');
  const [amount, setAmount] = useState('');
  const [cost, setCost] = useState('');
  const [supplier, setSupplier] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.call('recordFuelMovement', { body: body as never }),
    onSuccess: (saved) => {
      setAmount('');
      setCost('');
      setSupplier('');
      const v = saved.movement.variance;
      setResult(
        v
          ? t(v.varianceMilli > 0 ? 'utl.fuel.missing' : 'utl.fuel.balanced', {
              litres: litres(Math.abs(v.varianceMilli)),
              percent: (Math.abs(v.varianceBps) / 100).toFixed(1),
            }) + (v.alerted ? ` ${t('utl.fuel.alerted')}` : '')
          : t('utl.fuel.saved'),
      );
      props.onSaved();
    },
  });
  const submit = () => {
    const milli = litresToMilli(amount);
    const costMinor = kind === 'RECEIVED' && cost.trim() ? amountToMinor(cost) : null;
    if (milli === null || (kind === 'RECEIVED' && cost.trim() !== '' && costMinor === null)) {
      setProblem(t('utl.fuel.badNumber'));
      return;
    }
    setProblem(null);
    setResult(null);
    save.mutate({
      generatorId: props.generatorId,
      kind,
      litresMilli: milli,
      ...(kind === 'RECEIVED' ? { costMinor, supplier } : {}),
    });
  };
  const id = (k: string) => `fuel-${k}-${props.generatorId}`;
  return (
    <form
      aria-label={t('utl.fuel.form')}
      className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={id('kind')}>{t('utl.fuel.kind')}</Label>
        <select
          id={id('kind')}
          className={selectClass}
          value={kind}
          onChange={(e) => setKind(e.target.value as FuelKind)}
        >
          {FUEL_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`utl.fuel.kinds.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={id('litres')}>
          {kind === 'LEVEL_CHECK' ? t('utl.fuel.levelLitres') : t('utl.fuel.litres')}
        </Label>
        <Input
          id={id('litres')}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      {kind === 'RECEIVED' && (
        <>
          <div className="flex flex-col gap-1">
            <Label htmlFor={id('cost')}>{t('utl.fuel.cost')}</Label>
            <Input
              id={id('cost')}
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={id('supplier')}>{t('utl.fuel.supplier')}</Label>
            <Input
              id={id('supplier')}
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            />
          </div>
        </>
      )}
      {problem && (
        <Alert tone="critical" className="sm:col-span-2">
          {problem}
        </Alert>
      )}
      {save.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      {result && (
        <p role="status" className="sm:col-span-2">
          {result}
        </p>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {t('utl.fuel.save')}
        </Button>
      </div>
    </form>
  );
}

function GeneratorLog(props: { generatorId: string }) {
  const { t } = useTranslation();
  const f = useFormats();
  const detail = useQuery({
    queryKey: useKey('generator', props.generatorId),
    queryFn: () => api.call('getGenerator', { params: { generatorId: props.generatorId } }),
  });
  if (detail.error) return <Alert tone="critical">{errorMessage(detail.error)}</Alert>;
  const d = detail.data;
  if (!d) return <p className="text-text-muted">{t('shell.loading')}</p>;
  return (
    <div className="grid gap-3">
      <div>
        <h3 className="font-semibold">{t('utl.fuel.log')}</h3>
        {d.fuel.length === 0 ? (
          <p className="text-text-muted">{t('utl.fuel.empty')}</p>
        ) : (
          <ul aria-label={t('utl.fuel.log')} className="mt-1 flex flex-col gap-1">
            {d.fuel.map((m) => (
              <li key={m.id}>
                {f.when(m.at)} · {t(`utl.fuel.kinds.${m.kind}`)} · {litres(m.litresMilli)} L
                {m.costMinor ? ` · ${f.money(m.costMinor)}` : ''}
                {m.supplier ? ` · ${m.supplier}` : ''}
                <span className="text-text-muted"> · {m.by.name}</span>
                {m.variance && (
                  <span
                    className={cn(
                      'ml-1 text-xs font-medium',
                      m.variance.alerted ? 'text-critical' : 'text-text-muted',
                    )}
                  >
                    {t(m.variance.varianceMilli > 0 ? 'utl.fuel.missing' : 'utl.fuel.balanced', {
                      litres: litres(Math.abs(m.variance.varianceMilli)),
                      percent: (Math.abs(m.variance.varianceBps) / 100).toFixed(1),
                    })}
                    {m.variance.alerted ? ` ${t('utl.fuel.alerted')}` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="font-semibold">{t('utl.gen.runs')}</h3>
        {d.runs.length === 0 ? (
          <p className="text-text-muted">{t('utl.gen.noRuns')}</p>
        ) : (
          <ul aria-label={t('utl.gen.runs')} className="mt-1 flex flex-col gap-1">
            {d.runs.map((r) => (
              <li key={r.id}>
                {f.when(r.startedAt)} → {r.stoppedAt ? f.when(r.stoppedAt) : t('utl.gen.now')} ·{' '}
                {hoursAndMinutes(t, r.minutes)}
                <span className="text-text-muted"> · {r.startedBy.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function GeneratorForm(props: { onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const listKey = useKey('generators');
  const assets = useQuery({
    queryKey: useKey('assets'),
    queryFn: () => api.call('listAssets', {}),
  });
  const [form, setForm] = useState({ assetId: '', name: '', tank: '', serviceHours: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((s) => ({ ...s, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.call('createGenerator', { body: body as never }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
      props.onDone();
    },
  });
  const submit = () => {
    const tank = litresToMilli(form.tank);
    const hours = form.serviceHours.trim();
    if (tank === null || (hours !== '' && !/^\d+$/.test(hours))) {
      setProblem(t('utl.fuel.badNumber'));
      return;
    }
    setProblem(null);
    save.mutate({
      assetId: form.assetId,
      name: form.name,
      tankLitresMilli: tank,
      serviceEveryMinutes: hours ? Number(hours) * 60 : null,
    });
  };
  const choices = assets.data?.data.filter((a) => a.status !== 'RETIRED') ?? [];
  return (
    <form
      aria-label={t('utl.gen.form')}
      className="mt-3 grid gap-3 rounded-md border border-border bg-surface p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="gen-asset">{t('utl.gen.asset')}</Label>
        <select
          id="gen-asset"
          className={selectClass}
          value={form.assetId}
          onChange={set('assetId')}
        >
          <option value="">{t('utl.gen.chooseAsset')}</option>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              {a.tag} · {a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="gen-name">{t('utl.gen.name')}</Label>
        <Input id="gen-name" value={form.name} onChange={set('name')} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="gen-tank">{t('utl.gen.tankField')}</Label>
        <Input id="gen-tank" inputMode="decimal" value={form.tank} onChange={set('tank')} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="gen-service">{t('utl.gen.serviceField')}</Label>
        <Input
          id="gen-service"
          inputMode="numeric"
          value={form.serviceHours}
          onChange={set('serviceHours')}
        />
      </div>
      {problem && (
        <Alert tone="critical" className="sm:col-span-2">
          {problem}
        </Alert>
      )}
      {save.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" className="h-11" disabled={save.isPending || !form.assetId}>
          {t('utl.gen.save')}
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={props.onDone}>
          {t('utl.cancel')}
        </Button>
      </div>
    </form>
  );
}

// ── Meters ─────────────────────────────────────────────────────────────────────────────

const OTHER = '__other__';

function Meters() {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const key = useKey('meters');
  const list = useQuery({ queryKey: key, queryFn: () => api.call('listMeterReadings', {}) });
  const [meter, setMeter] = useState('GRID');
  const [other, setOther] = useState('');
  const [reading, setReading] = useState('');
  const [saved, setSaved] = useState<Reading | null>(null);
  const save = useMutation({
    mutationFn: (body: { meter: string; reading: string }) =>
      api.call('recordMeterReading', { body }),
    onSuccess: (r) => {
      setReading('');
      setSaved(r);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const name = (m: string) => t(`utl.meter.names.${m}`, { defaultValue: m.replaceAll('_', ' ') });
  const value = reading.trim().replaceAll(',', '');
  const valid = /^\d+$/.test(value) && (meter !== OTHER || other.trim().length >= 2);
  return (
    <div className="mt-4">
      <form
        aria-label={t('utl.meter.form')}
        className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate({ meter: meter === OTHER ? other : meter, reading: value });
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="meter-name">{t('utl.meter.meter')}</Label>
          <select
            id="meter-name"
            className={selectClass}
            value={meter}
            onChange={(e) => setMeter(e.target.value)}
          >
            {(list.data?.meters ?? ['GRID', 'WATER', 'GAS']).map((m) => (
              <option key={m} value={m}>
                {name(m)}
              </option>
            ))}
            <option value={OTHER}>{t('utl.meter.other')}</option>
          </select>
        </div>
        {meter === OTHER && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="meter-other">{t('utl.meter.otherName')}</Label>
            <Input id="meter-other" value={other} onChange={(e) => setOther(e.target.value)} />
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="meter-reading">{t('utl.meter.reading')}</Label>
          <Input
            id="meter-reading"
            inputMode="numeric"
            className="w-40"
            value={reading}
            onChange={(e) => setReading(e.target.value)}
          />
        </div>
        <Button type="submit" className="h-11" disabled={!valid || save.isPending}>
          {t('utl.meter.save')}
        </Button>
      </form>
      {save.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(save.error)}
        </Alert>
      )}
      {saved && (
        <p role="status" className="mt-2 text-sm">
          {saved.usage === null
            ? t('utl.meter.first', { meter: name(saved.meter) })
            : t('utl.meter.used', {
                meter: name(saved.meter),
                usage: Number(saved.usage).toLocaleString('en-NG'),
                hours: saved.hoursSincePrevious ?? 0,
              })}
        </p>
      )}
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {list.data && list.data.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('utl.meter.none')}</p>
      )}
      {list.data && list.data.data.length > 0 && (
        <table aria-label={t('utl.meter.list')} className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="py-1 pr-2 font-medium">{t('utl.meter.when')}</th>
              <th className="py-1 pr-2 font-medium">{t('utl.meter.meter')}</th>
              <th className="py-1 pr-2 text-right font-medium">{t('utl.meter.reading')}</th>
              <th className="py-1 pr-2 text-right font-medium">{t('utl.meter.usage')}</th>
              <th className="py-1 font-medium">{t('utl.meter.by')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data.data.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="py-1 pr-2">{f.when(r.at)}</td>
                <td className="py-1 pr-2">{name(r.meter)}</td>
                <td className="py-1 pr-2 text-right">
                  {Number(r.reading).toLocaleString('en-NG')}
                </td>
                <td className="py-1 pr-2 text-right">
                  {r.usage === null ? '–' : Number(r.usage).toLocaleString('en-NG')}
                </td>
                <td className="py-1">{r.by.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
