import {
  ALERT_OUTCOMES,
  type AlertOutcomeKind,
  type LeakageAlertItem,
  type LeakageRuleCode,
  type listLeakageRules,
} from '@hotel/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import leakageStrings from '../i18n/en/leakage.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';
import { useFormats } from './reservations.tsx';

registerStrings(leakageStrings);

// S22 Leakage alerts (PRD M6-07–M6-09, M6 rule 3; T-090). The owner or GM sees the alerts by
// rule and status with the recovered total, opens one to read its evidence, and adds outcomes
// (a recovered amount names the charge or payment that recovered it). Below, the rules'
// settings: on or off, thresholds, and whether alerts come at once or with the flash report.

type AlertRow = z.output<typeof LeakageAlertItem>;
type Rules = z.output<(typeof listLeakageRules)['response']>;
type Rule = Rules['rules'][number];
type Status = 'OPEN' | 'REVIEWED' | '';

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const textareaClass = 'min-h-20 rounded-md border border-border bg-surface p-2 text-sm';

function useLeakageKey(...parts: string[]) {
  const { currentPropertyId } = useSession();
  return ['leakage', currentPropertyId ?? '', ...parts];
}

const SEVERITY_TONE: Record<string, string> = {
  LOW: 'bg-surface-muted text-text-muted',
  NORMAL: 'bg-warning-subtle text-warning',
  HIGH: 'bg-critical-subtle text-critical',
  CRITICAL: 'bg-critical text-on-brand',
};

// ── Summary ──────────────────────────────────────────────────────────────────────────────

function Totals({ rules }: { rules: Rules }) {
  const { t } = useTranslation();
  const f = useFormats();
  const tile = 'rounded-md border border-border bg-surface p-3';
  return (
    <dl className="mt-4 grid grid-cols-3 gap-2 text-sm" aria-label={t('leakage.byRule.title')}>
      <div className={tile}>
        <dt className="text-text-muted">{t('leakage.totals.open')}</dt>
        <dd className="text-xl font-semibold">{rules.totals.open}</dd>
      </div>
      <div className={tile}>
        <dt className="text-text-muted">{t('leakage.totals.reviewed')}</dt>
        <dd className="text-xl font-semibold">{rules.totals.reviewed}</dd>
      </div>
      <div className={tile}>
        <dt className="text-text-muted">{t('leakage.totals.recovered')}</dt>
        <dd className="text-xl font-semibold">{f.money(rules.totals.recoveredMinor)}</dd>
      </div>
    </dl>
  );
}

function ByRule({ rules, onPick }: { rules: Rules; onPick: (code: LeakageRuleCode) => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[28rem] text-left text-sm">
        <caption className="mb-1 text-left font-semibold">{t('leakage.byRule.title')}</caption>
        <thead className="text-text-muted">
          <tr>
            <th className="py-1 pr-2 font-normal">{t('leakage.byRule.rule')}</th>
            <th className="py-1 pr-2 text-right font-normal">{t('leakage.byRule.open')}</th>
            <th className="py-1 pr-2 text-right font-normal">{t('leakage.byRule.reviewed')}</th>
            <th className="py-1 text-right font-normal">{t('leakage.byRule.recovered')}</th>
          </tr>
        </thead>
        <tbody>
          {rules.rules.map((r) => (
            <tr key={r.code} className="border-t border-border">
              <td className="py-1 pr-2">
                <button
                  type="button"
                  className="text-brand underline"
                  onClick={() => onPick(r.code)}
                >
                  {r.label}
                </button>
                {!r.enabled && (
                  <span className="ml-2 text-xs text-text-muted">{t('leakage.byRule.off')}</span>
                )}
              </td>
              <td className="py-1 pr-2 text-right">{r.open}</td>
              <td className="py-1 pr-2 text-right">{r.reviewed}</td>
              <td className="py-1 text-right">{f.money(r.recoveredMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Evidence and outcomes ────────────────────────────────────────────────────────────────

function EvidenceList({ evidence }: { evidence: Record<string, unknown> }) {
  const { t } = useTranslation();
  const f = useFormats();
  const shown = Object.entries(evidence).filter(
    ([key, value]) => value !== null && !key.endsWith('Id') && !key.endsWith('Ids'),
  );
  const show = (key: string, value: unknown): string => {
    if (key.endsWith('Minor') && typeof value === 'string') return f.money(value);
    if (Array.isArray(value)) return String(value.length);
    if (typeof value === 'object') return JSON.stringify(value);
    if (key.endsWith('At') && typeof value === 'string') return f.when(value);
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : JSON.stringify(value);
  };
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      {shown.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-text-muted">{t(`leakage.evidence.${key}`, { defaultValue: key })}</dt>
          <dd className="break-words">{show(key, value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Picks the charge or payment that recovered the money, from a folio found by search. */
function RecoveredBy({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [folioId, setFolioId] = useState('');
  const folios = useQuery({
    queryKey: useLeakageKey('folios', search),
    queryFn: () => api.call('listFolios', { query: { status: 'OPEN', q: search } }),
    enabled: search !== '',
  });
  const folio = useQuery({
    queryKey: useLeakageKey('folio', folioId),
    queryFn: () => api.call('getFolio', { params: { folioId } }),
    enabled: folioId !== '',
  });
  const charges = folio.data?.windows.flatMap((w) => w.lines).filter((l) => l.kind === 'CHARGE');
  const payments = folio.data?.windows
    .flatMap((w) => w.payments)
    .filter((p) => !p.amountMinor.startsWith('-'));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor="leakage-folio-search">{t('leakage.outcome.folio')}</Label>
        <div className="flex gap-2">
          <Input
            id="leakage-folio-search"
            placeholder={t('leakage.outcome.folioHint')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button type="button" variant="secondary" onClick={() => setSearch(q.trim())}>
            {t('leakage.outcome.find')}
          </Button>
        </div>
      </div>
      {folios.data && folios.data.data.length === 0 && (
        <p className="text-sm text-text-muted">{t('leakage.outcome.noFolios')}</p>
      )}
      {folios.data && folios.data.data.length > 0 && (
        <select
          aria-label={t('leakage.outcome.folio')}
          className={selectClass}
          value={folioId}
          onChange={(e) => {
            setFolioId(e.target.value);
            onChange('');
          }}
        >
          <option value="">{t('leakage.outcome.choose')}</option>
          {folios.data.data.map((fo) => (
            <option key={fo.id} value={fo.id}>
              {fo.number} · {fo.name}
              {fo.roomNumber ? ` · ${fo.roomNumber}` : ''}
            </option>
          ))}
        </select>
      )}
      {folio.data && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="leakage-recovered-by">{t('leakage.outcome.recoveredBy')}</Label>
          <select
            id="leakage-recovered-by"
            className={selectClass}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">{t('leakage.outcome.choose')}</option>
            <optgroup label={t('leakage.outcome.charges')}>
              {charges?.map((l) => (
                <option key={l.id} value={`line:${l.id}`}>
                  {l.description} · {f.money(l.amountMinor)} · {f.date(l.businessDate)}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('leakage.outcome.payments')}>
              {payments?.map((p) => (
                <option key={p.id} value={`payment:${p.id}`}>
                  {p.method} · {f.money(p.baseAmountMinor)} · {f.date(p.businessDate)}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
      )}
    </div>
  );
}

function OutcomeForm({ alertId }: { alertId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const allKey = useLeakageKey();
  const [outcome, setOutcome] = useState<AlertOutcomeKind>('EXPLAINED');
  const [amount, setAmount] = useState('');
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const [added, setAdded] = useState(false);
  const [problem, setProblem] = useState('');
  const recovered = outcome === 'RECOVERED';
  const add = useMutation({
    mutationFn: () => {
      const [kind, id = ''] = link.split(':');
      return api.call('addLeakageAlertOutcome', {
        params: { alertId },
        body: {
          outcome,
          note: note.trim(),
          ...(recovered
            ? {
                recoveredMinor: toMinor(amount),
                linkedLineId: kind === 'line' ? id : null,
                linkedPaymentId: kind === 'payment' ? id : null,
              }
            : {}),
        },
      });
    },
    onSuccess: async () => {
      setNote('');
      setAmount('');
      setLink('');
      setAdded(true);
      await queryClient.invalidateQueries({ queryKey: allKey });
    },
  });
  return (
    <form
      aria-label={t('leakage.outcome.title')}
      className="flex flex-col gap-3 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        setAdded(false);
        setProblem('');
        if (recovered && toMinor(amount) === null) {
          setProblem(t('leakage.outcome.badAmount'));
          return;
        }
        add.mutate();
      }}
    >
      <h3 className="font-semibold">{t('leakage.outcome.title')}</h3>
      <div className="flex flex-col gap-1">
        <Label htmlFor="leakage-outcome">{t('leakage.outcome.kind')}</Label>
        <select
          id="leakage-outcome"
          className={selectClass}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as AlertOutcomeKind)}
        >
          {ALERT_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {t(`leakage.outcome.${o}`)}
            </option>
          ))}
        </select>
      </div>
      {recovered && (
        <>
          <div className="flex flex-col gap-1">
            <Label htmlFor="leakage-amount">{t('leakage.outcome.amount')}</Label>
            <Input
              id="leakage-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <RecoveredBy value={link} onChange={setLink} />
        </>
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor="leakage-note">{t('leakage.outcome.note')}</Label>
        <textarea
          id="leakage-note"
          className={textareaClass}
          maxLength={2000}
          required
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="text-xs text-text-muted">{t('leakage.outcome.noteHint')}</p>
      </div>
      {problem && <Alert tone="critical">{problem}</Alert>}
      {add.error && <Alert tone="critical">{errorMessage(add.error)}</Alert>}
      {added && <Alert tone="success">{t('leakage.outcome.added')}</Alert>}
      <div>
        <Button
          type="submit"
          disabled={note.trim() === '' || (recovered && link === '') || add.isPending}
        >
          {t('leakage.outcome.submit')}
        </Button>
      </div>
    </form>
  );
}

function AlertDetail({ alertId, onClose }: { alertId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  const detail = useQuery({
    queryKey: useLeakageKey('alert', alertId),
    queryFn: () => api.call('getLeakageAlert', { params: { alertId } }),
  });
  const a = detail.data;
  return (
    <aside
      aria-label={t('leakage.detail.label')}
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-semibold">{a?.label ?? ''}</h2>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('leakage.detail.close')}
        </Button>
      </div>
      {detail.error && <Alert tone="critical">{errorMessage(detail.error)}</Alert>}
      {a && (
        <>
          <p className="text-text-muted">
            {t('leakage.detail.raised', { when: f.when(a.raisedAt), date: f.date(a.businessDate) })}
            {a.subject && <> · {t('leakage.list.about', { name: a.subject.name })}</>}
          </p>
          <section>
            <h3 className="mb-1 font-semibold">{t('leakage.detail.evidence')}</h3>
            <EvidenceList evidence={a.evidence} />
          </section>
          <section>
            <h3 className="mb-1 font-semibold">{t('leakage.detail.outcomes')}</h3>
            {a.outcomeList.length === 0 ? (
              <p className="text-text-muted">{t('leakage.detail.noOutcomes')}</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {a.outcomeList.map((o) => (
                  <li key={o.id} className="rounded border border-border p-2">
                    <p className="font-medium">
                      {t(`leakage.outcome.${o.outcome}`)}
                      {o.recoveredMinor && (
                        <>
                          {' '}
                          · {t('leakage.detail.recovered', { amount: f.money(o.recoveredMinor) })}
                        </>
                      )}
                    </p>
                    {o.linkedLine && (
                      <p className="text-text-muted">
                        {t('leakage.detail.line', {
                          folio: o.linkedLine.folioNumber,
                          description: o.linkedLine.description,
                        })}
                      </p>
                    )}
                    {o.linkedPayment && (
                      <p className="text-text-muted">
                        {t('leakage.detail.payment', {
                          method: o.linkedPayment.method,
                          amount: f.money(o.linkedPayment.amountMinor),
                        })}
                      </p>
                    )}
                    <p className="whitespace-pre-wrap">{o.note}</p>
                    <p className="text-xs text-text-muted">
                      {t('leakage.detail.by', { name: o.by.name, when: f.when(o.at) })}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <OutcomeForm alertId={a.id} />
        </>
      )}
    </aside>
  );
}

// ── Rule settings ────────────────────────────────────────────────────────────────────────

function RuleSettings({ rule }: { rule: Rule }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const rulesKey = useLeakageKey('rules');
  const [enabled, setEnabled] = useState(rule.enabled);
  const [instant, setInstant] = useState(rule.notifyInstant);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      rule.params.map((p) => [
        p.key,
        p.kind === 'amount' ? String(Number(p.value) / 100) : String(p.value),
      ]),
    ),
  );
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.call('updateLeakageRules', {
        body: {
          rules: [
            {
              code: rule.code,
              ...(rule.canDisable ? { enabled } : {}),
              notifyInstant: instant,
              params: Object.fromEntries(
                rule.params.map((p) => {
                  const text = values[p.key] ?? '';
                  return [
                    p.key,
                    p.kind === 'amount'
                      ? (toMinor(text) ?? (text.trim() === '0' ? '0' : text))
                      : Number(text),
                  ];
                }),
              ),
            },
          ],
        },
      }),
    onSuccess: async (data) => {
      setSaved(true);
      queryClient.setQueryData(rulesKey, data);
      await queryClient.invalidateQueries({ queryKey: rulesKey });
    },
  });
  return (
    <li className="rounded-md border border-border bg-surface p-3 text-sm">
      <form
        aria-label={rule.label}
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate();
        }}
      >
        <h3 className="font-semibold">{rule.label}</h3>
        <p className="text-text-muted">{rule.trigger}</p>
        <div className="flex flex-wrap items-center gap-4">
          {rule.canDisable ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-5"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {t('leakage.rules.on')}
            </label>
          ) : (
            <span className="text-xs text-text-muted">{t('leakage.rules.required')}</span>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-5"
              checked={instant}
              onChange={(e) => setInstant(e.target.checked)}
            />
            {t('leakage.rules.instant')}
          </label>
        </div>
        {rule.params.length > 0 && (
          <div className="flex flex-wrap gap-3">
            {rule.params.map((p) => (
              <div key={p.key} className="flex flex-col gap-1">
                <Label htmlFor={`rule-${rule.code}-${p.key}`}>{p.label}</Label>
                <Input
                  id={`rule-${rule.code}-${p.key}`}
                  className="w-36"
                  inputMode={p.kind === 'amount' ? 'decimal' : 'numeric'}
                  value={values[p.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [p.key]: e.target.value })}
                />
              </div>
            ))}
          </div>
        )}
        {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
        {saved && <Alert tone="success">{t('leakage.rules.saved')}</Alert>}
        <div>
          <Button type="submit" variant="secondary" disabled={save.isPending}>
            {t('leakage.rules.save')}
          </Button>
        </div>
      </form>
    </li>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────────────────

export function LeakagePage() {
  const { t } = useTranslation();
  const f = useFormats();
  const [status, setStatus] = useState<Status>('OPEN');
  const [rule, setRule] = useState<LeakageRuleCode | ''>('');
  const [selected, setSelected] = useState('');
  const rules = useQuery({
    queryKey: useLeakageKey('rules'),
    queryFn: () => api.call('listLeakageRules', {}),
  });
  const list = useInfiniteQuery({
    queryKey: useLeakageKey('list', status, rule),
    queryFn: ({ pageParam }) =>
      api.call('listLeakageAlerts', {
        query: {
          ...(status ? { status } : {}),
          ...(rule ? { rule } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
  const alerts: AlertRow[] = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('leakage.title')}</h1>
      {rules.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(rules.error)}
        </Alert>
      )}
      {rules.data && (
        <>
          <Totals rules={rules.data} />
          <ByRule
            rules={rules.data}
            onPick={(code) => {
              setRule(code);
              setStatus('');
            }}
          />
        </>
      )}

      <div className="mt-6 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="leakage-status">{t('leakage.filters.status')}</Label>
          <select
            id="leakage-status"
            className={selectClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
          >
            <option value="OPEN">{t('leakage.filters.OPEN')}</option>
            <option value="REVIEWED">{t('leakage.filters.REVIEWED')}</option>
            <option value="">{t('leakage.filters.all')}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="leakage-rule">{t('leakage.filters.rule')}</Label>
          <select
            id="leakage-rule"
            className={selectClass}
            value={rule}
            onChange={(e) => setRule(e.target.value as LeakageRuleCode | '')}
          >
            <option value="">{t('leakage.filters.allRules')}</option>
            {rules.data?.rules.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_26rem]">
        <div>
          {list.error && <Alert tone="critical">{errorMessage(list.error)}</Alert>}
          {list.data && alerts.length === 0 && (
            <p className="text-sm text-text-muted">{t('leakage.list.empty')}</p>
          )}
          <ul aria-label={t('leakage.list.label')} className="flex flex-col gap-2">
            {alerts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  aria-pressed={selected === a.id}
                  className={cn(
                    'w-full rounded-md border border-border bg-surface p-3 text-left text-sm',
                    selected === a.id && 'border-brand',
                  )}
                  onClick={() => setSelected(a.id)}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{a.label}</span>
                    <span
                      className={cn(
                        'rounded px-1.5 text-xs font-medium',
                        SEVERITY_TONE[a.severity],
                      )}
                    >
                      {t(`leakage.severity.${a.severity}`)}
                    </span>
                    <span className="text-xs text-text-muted">
                      {t(`leakage.status.${a.status}`)}
                    </span>
                  </span>
                  <span className="block text-text-muted">
                    {f.date(a.businessDate)}
                    {a.subject && <> · {t('leakage.list.about', { name: a.subject.name })}</>}
                    {a.outcomes > 0 && <> · {t('leakage.list.outcomes', { count: a.outcomes })}</>}
                    {a.recoveredMinor !== '0' && <> · {f.money(a.recoveredMinor)}</>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {list.hasNextPage && (
            <Button
              variant="secondary"
              className="mt-3"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {t('leakage.list.loadMore')}
            </Button>
          )}
        </div>
        {selected && (
          <AlertDetail key={selected} alertId={selected} onClose={() => setSelected('')} />
        )}
      </div>

      {rules.data && (
        <details className="mt-6">
          <summary className="cursor-pointer text-lg font-semibold">
            {t('leakage.rules.title')}
          </summary>
          <p className="mt-1 text-xs text-text-muted">{t('leakage.rules.instantHint')}</p>
          <ul className="mt-2 flex flex-col gap-2">
            {rules.data.rules.map((r) => (
              <RuleSettings
                key={`${r.code}-${String(r.enabled)}-${String(r.notifyInstant)}`}
                rule={r}
              />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
