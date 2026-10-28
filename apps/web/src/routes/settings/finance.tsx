import {
  calculateTaxes,
  formatRate,
  localDate,
  REVENUE_GROUPS,
  RevenueCodeBody,
  RevenueCodePatchBody,
  TAX_BASES,
  TAX_LINE_GROUPS,
  TaxRuleBody,
  TaxVersionBody,
  versionsOn,
  type RevenueCodeItem,
  type TaxRuleItem,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { apiFieldErrors, errorMessage } from '../../lib/form.ts';
import { Field } from '../auth/layout.tsx';
import { fieldErrorsOf, serverErrors, validated, type FieldErrors } from './room-form.ts';

// S25 Tax, revenue codes and FX (PRD M4-17; T-032): tax rules with dated versions, the
// revenue codes they apply to, and a worked example from the shared calculator. New
// Nigerian properties start with example Lagos rates that must be checked and confirmed.

type Rule = z.output<typeof TaxRuleItem>;
type Code = z.output<typeof RevenueCodeItem>;

const TABS = ['taxes', 'codes', 'fx'] as const;
type Tab = (typeof TABS)[number];

function useFinance() {
  const session = useSession();
  const key = ['finance', session.currentPropertyId ?? ''];
  const rules = useQuery({ queryKey: [...key, 'rules'], queryFn: () => api.call('listTaxRules') });
  const codes = useQuery({
    queryKey: [...key, 'codes'],
    queryFn: async () => (await api.call('listRevenueCodes')).data,
  });
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const today = localDate(new Date(), property?.timeZone ?? 'Africa/Lagos');
  const money = (minor: bigint) =>
    new Intl.NumberFormat(property?.locale ?? 'en-NG', {
      style: 'currency',
      currency: property?.baseCurrency ?? 'NGN',
    }).format(Number(minor) / 100);
  const canEdit = session.permissions.includes('tax.manage');
  return { key, rules, codes, today, money, canEdit, locale: property?.locale ?? 'en-NG' };
}

function useInvalidate() {
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['finance', currentPropertyId ?? ''] });
    void queryClient.invalidateQueries({ queryKey: ['setup', currentPropertyId ?? ''] });
  };
}

export function FinanceSettingsPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const wanted = search.get('tab') as Tab | null;
  const tab: Tab = wanted && TABS.includes(wanted) ? wanted : 'taxes';
  return (
    <section>
      <h1 className="text-xl font-semibold">{t('finance.title')}</h1>
      <div
        role="tablist"
        aria-label={t('finance.title')}
        className="mt-4 flex gap-1 border-b border-border"
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setSearch({ tab: name })}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === name
                ? 'border-brand font-semibold text-brand-strong'
                : 'border-transparent text-text-muted',
            )}
          >
            {t(`finance.tabs.${name}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-4">
        {tab === 'taxes' && <TaxesTab />}
        {tab === 'codes' && <CodesTab />}
        {tab === 'fx' && <p className="text-sm text-text-muted">{t('finance.fxLater')}</p>}
      </div>
    </section>
  );
}

// ── Taxes ──────────────────────────────────────────────────────────────────────────────

function TaxesTab() {
  const { t } = useTranslation();
  const f = useFinance();
  const [panel, setPanel] = useState<{ kind: 'new' } | { kind: 'version'; rule: Rule } | null>(
    null,
  );
  const error = f.rules.error ?? f.codes.error;
  if (error) return <Alert tone="critical">{errorMessage(error)}</Alert>;
  if (!f.rules.data || !f.codes.data) {
    return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  }
  const { data: rules, confirmation } = f.rules.data;
  const codeName = new Map(f.codes.data.map((c) => [c.id, c.name]));

  return (
    <div>
      <ConfirmBanner confirmation={confirmation} canEdit={f.canEdit} locale={f.locale} />
      {rules.length === 0 ? (
        <p className="mb-4 text-sm text-text-muted">{t('finance.taxes.none')}</p>
      ) : (
        <div className="mb-4 overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-text-muted">
              <tr>
                <th className="p-2 font-medium">{t('finance.taxes.order')}</th>
                <th className="p-2 font-medium">{t('finance.taxes.name')}</th>
                <th className="p-2 font-medium">{t('finance.taxes.rate')}</th>
                <th className="p-2 font-medium">{t('finance.taxes.basis')}</th>
                <th className="p-2 font-medium">{t('finance.taxes.postsTo')}</th>
                <th className="p-2 font-medium">{t('finance.taxes.changes')}</th>
                <th className="p-2 font-medium">
                  <span className="sr-only">{t('finance.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...rules]
                .sort((a, b) => (current(a)?.sequence ?? 99) - (current(b)?.sequence ?? 99))
                .map((rule) => {
                  const now = current(rule);
                  const later = rule.versions.filter((v) => v.effectiveFrom > f.today);
                  return (
                    <tr key={rule.id} className="border-b border-border align-top last:border-0">
                      <td className="p-2">{now?.sequence ?? '–'}</td>
                      <td className="p-2">
                        <span className="font-medium">{rule.name}</span>
                        <span className="block text-xs text-text-muted">{rule.authority}</span>
                      </td>
                      <td className="p-2">
                        {now ? formatRate(now.rateBps) : t('finance.taxes.notYet')}
                        {now?.inclusive && (
                          <span className="block text-xs text-text-muted">
                            {t('finance.taxes.included')}
                          </span>
                        )}
                      </td>
                      <td className="p-2">{now ? t(`finance.basis.${now.basis}`) : ''}</td>
                      <td className="p-2">{codeName.get(rule.revenueCodeId)}</td>
                      <td className="p-2 text-xs">
                        {later.map((v) => (
                          <span key={v.id} className="block">
                            {t('finance.taxes.from', {
                              date: v.effectiveFrom,
                              rate: formatRate(v.rateBps),
                            })}
                          </span>
                        ))}
                      </td>
                      <td className="p-2 text-right">
                        {f.canEdit && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('finance.taxes.changeNamed', { name: rule.name })}
                            onClick={() => setPanel({ kind: 'version', rule })}
                          >
                            {t('finance.taxes.change')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
      {f.canEdit && panel === null && (
        <Button variant="secondary" onClick={() => setPanel({ kind: 'new' })}>
          {t('finance.taxes.add')}
        </Button>
      )}
      {panel?.kind === 'new' && (
        <TaxForm codes={f.codes.data} today={f.today} onDone={() => setPanel(null)} />
      )}
      {panel?.kind === 'version' && (
        <VersionForm
          key={panel.rule.id}
          rule={panel.rule}
          today={f.today}
          onDone={() => setPanel(null)}
        />
      )}
      <WorkedExample rules={rules} codes={f.codes.data} today={f.today} money={f.money} />
    </div>
  );

  function current(rule: Rule) {
    return rule.versions.find((v) => v.id === rule.currentVersionId);
  }
}

function ConfirmBanner({
  confirmation,
  canEdit,
  locale,
}: {
  confirmation: {
    examples: boolean;
    confirmedAt: string | null;
    confirmedBy: { name: string } | null;
  };
  canEdit: boolean;
  locale: string;
}) {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  const confirm = useMutation({
    mutationFn: () => api.call('confirmTaxes'),
    onSuccess: invalidate,
  });
  if (confirmation.confirmedAt) {
    return (
      <p className="mb-4 text-sm text-text-muted">
        {t('finance.confirmed', {
          name: confirmation.confirmedBy?.name ?? '—',
          date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
            new Date(confirmation.confirmedAt),
          ),
        })}
      </p>
    );
  }
  return (
    <Alert tone={confirmation.examples ? 'critical' : 'info'} className="mb-4">
      <p className="font-medium">
        {confirmation.examples ? t('finance.examplesTitle') : t('finance.confirmTitle')}
      </p>
      <p className="mt-1">
        {confirmation.examples ? t('finance.examplesText') : t('finance.confirmText')}
      </p>
      {canEdit && (
        <Button
          size="sm"
          className="mt-2"
          disabled={confirm.isPending}
          onClick={() => confirm.mutate()}
        >
          {t('finance.confirm')}
        </Button>
      )}
      {confirm.error && <p className="mt-1">{errorMessage(confirm.error)}</p>}
    </Alert>
  );
}

interface VersionDraft {
  effectiveFrom: string;
  rate: string;
  basis: (typeof TAX_BASES)[number];
  sequence: string;
  inclusive: boolean;
}

/** The API reports version fields as `body.version.<field>`; key them by field. */
function versionErrorsOf(error: unknown): FieldErrors {
  return Object.fromEntries(
    apiFieldErrors(error).flatMap(({ field, message }) =>
      field.startsWith('version.') ? [[field.slice('version.'.length), message]] : [],
    ),
  );
}

/** "7.5" → 750 basis points (NaN stays NaN, so the schema reports it). */
const bps = (percent: string) => Math.round(Number(percent.replace(',', '.')) * 100);

function versionPayload(d: VersionDraft) {
  return {
    effectiveFrom: d.effectiveFrom,
    rateBps: bps(d.rate),
    basis: d.basis,
    sequence: Number(d.sequence),
    inclusive: d.inclusive,
  };
}

function VersionFields({
  draft,
  setDraft,
  errors,
  today,
}: {
  draft: VersionDraft;
  setDraft: (d: VersionDraft) => void;
  errors: FieldErrors;
  today: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field
          label={t('finance.taxes.effectiveFrom')}
          type="date"
          min={today}
          value={draft.effectiveFrom}
          onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })}
          error={errors['effectiveFrom']}
        />
        <Field
          label={t('finance.taxes.ratePercent')}
          inputMode="decimal"
          value={draft.rate}
          onChange={(e) => setDraft({ ...draft, rate: e.target.value })}
          error={errors['rateBps']}
        />
        <Field
          label={t('finance.taxes.order')}
          hint={t('finance.taxes.orderHint')}
          inputMode="numeric"
          value={draft.sequence}
          onChange={(e) => setDraft({ ...draft, sequence: e.target.value })}
          error={errors['sequence']}
        />
      </div>
      <div className="mb-4 flex flex-col gap-1">
        <Label htmlFor="tax-basis">{t('finance.taxes.basis')}</Label>
        <select
          id="tax-basis"
          className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
          value={draft.basis}
          onChange={(e) => setDraft({ ...draft, basis: e.target.value as VersionDraft['basis'] })}
        >
          {TAX_BASES.map((b) => (
            <option key={b} value={b}>
              {t(`finance.basis.${b}`)}
            </option>
          ))}
        </select>
      </div>
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.inclusive}
          onChange={(e) => setDraft({ ...draft, inclusive: e.target.checked })}
        />
        {t('finance.taxes.inclusive')}
      </label>
    </>
  );
}

function FormShell({
  title,
  pending,
  error,
  onSubmit,
  onDone,
  children,
}: {
  title: string;
  pending: boolean;
  error: unknown;
  onSubmit: () => void;
  onDone: () => void;
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
      className="mt-2 max-w-2xl rounded-md border border-border bg-surface p-4"
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
          {t('finance.save')}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t('finance.cancel')}
        </Button>
      </div>
    </form>
  );
}

function VersionForm({ rule, today, onDone }: { rule: Rule; today: string; onDone: () => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  const last = rule.versions.at(-1);
  const [draft, setDraft] = useState<VersionDraft>({
    effectiveFrom: today,
    rate: last ? String(last.rateBps / 100) : '',
    basis: last?.basis ?? 'NET',
    sequence: String(last?.sequence ?? 1),
    inclusive: last?.inclusive ?? false,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: async () =>
      api.call('addTaxRuleVersion', {
        params: { taxRuleId: rule.id },
        body: validated(TaxVersionBody, versionPayload(draft)),
      }),
    onSuccess: () => {
      invalidate();
      onDone();
    },
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  return (
    <FormShell
      title={t('finance.taxes.changeNamed', { name: rule.name })}
      pending={save.isPending}
      error={save.error}
      onSubmit={() => {
        setErrors({});
        save.mutate();
      }}
      onDone={onDone}
    >
      <p className="mb-3 text-sm text-text-muted">{t('finance.taxes.versionHint')}</p>
      <VersionFields draft={draft} setDraft={setDraft} errors={errors} today={today} />
    </FormShell>
  );
}

function TaxForm({ codes, today, onDone }: { codes: Code[]; today: string; onDone: () => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  const taxCodes = codes.filter(
    (c) => c.active && (TAX_LINE_GROUPS as readonly string[]).includes(c.group),
  );
  const [name, setName] = useState('');
  const [authority, setAuthority] = useState('');
  const [revenueCodeId, setRevenueCodeId] = useState(taxCodes[0]?.id ?? '');
  const [draft, setDraft] = useState<VersionDraft>({
    effectiveFrom: today,
    rate: '',
    basis: 'NET',
    sequence: '1',
    inclusive: false,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: async () =>
      api.call('createTaxRule', {
        body: validated(TaxRuleBody, {
          name,
          authority,
          revenueCodeId,
          // Checked on its own first so its fields get their own messages.
          version: validated(TaxVersionBody, versionPayload(draft)),
        }),
      }),
    onSuccess: () => {
      invalidate();
      onDone();
    },
    onError: (error) => setErrors({ ...fieldErrorsOf(error), ...versionErrorsOf(error) }),
  });
  return (
    <FormShell
      title={t('finance.taxes.add')}
      pending={save.isPending}
      error={save.error}
      onSubmit={() => {
        setErrors({});
        save.mutate();
      }}
      onDone={onDone}
    >
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field
          label={t('finance.taxes.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors['name']}
        />
        <Field
          label={t('finance.taxes.authority')}
          hint={t('finance.taxes.authorityHint')}
          value={authority}
          onChange={(e) => setAuthority(e.target.value)}
          error={errors['authority']}
        />
      </div>
      <div className="mb-4 flex flex-col gap-1">
        <Label htmlFor="tax-code">{t('finance.taxes.postsTo')}</Label>
        <select
          id="tax-code"
          className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
          value={revenueCodeId}
          onChange={(e) => setRevenueCodeId(e.target.value)}
        >
          {taxCodes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.code})
            </option>
          ))}
        </select>
        {(errors['revenueCodeId'] ?? taxCodes.length === 0) && (
          <p className="text-sm text-critical">
            {errors['revenueCodeId'] ?? t('finance.taxes.needCode')}
          </p>
        )}
      </div>
      <VersionFields draft={draft} setDraft={setDraft} errors={errors} today={today} />
    </FormShell>
  );
}

/** "What does a ₦100,000 line cost?" with today's rules for a chosen revenue code. */
function WorkedExample({
  rules,
  codes,
  today,
  money,
}: {
  rules: Rule[];
  codes: Code[];
  today: string;
  money: (minor: bigint) => string;
}) {
  const { t } = useTranslation();
  const income = codes.filter(
    (c) => c.active && !(TAX_LINE_GROUPS as readonly string[]).includes(c.group),
  );
  const [codeId, setCodeId] = useState(income.find((c) => c.code === 'ROOM')?.id ?? income[0]?.id);
  const [amount, setAmount] = useState('100000');
  const code = income.find((c) => c.id === codeId);
  const minor = BigInt(Math.round(Number(amount.replace(/,/g, '')) * 100) || 0);
  const versions = rules
    .filter((r) => code?.taxRuleIds.includes(r.id))
    .flatMap((r) => r.versions.map((v) => ({ ...v, taxRuleId: r.id })));
  const result = calculateTaxes(minor, versionsOn(versions, today));
  const nameOf = new Map(rules.map((r) => [r.id, r.name]));

  return (
    <section aria-labelledby="worked-example" className="mt-6 max-w-xl">
      <h2 id="worked-example" className="font-semibold">
        {t('finance.example.title')}
      </h2>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="example-code">{t('finance.example.code')}</Label>
          <select
            id="example-code"
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
            value={codeId}
            onChange={(e) => setCodeId(e.target.value)}
          >
            {income.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="example-amount">{t('finance.example.amount')}</Label>
          <Input
            id="example-amount"
            className="w-40"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
      <table aria-label={t('finance.example.title')} className="mt-3 w-full text-sm">
        <tbody>
          <tr>
            <td className="py-1">{t('finance.example.net')}</td>
            <td className="py-1 text-right tabular-nums">{money(result.netMinor)}</td>
          </tr>
          {result.taxes.map((tax) => (
            <tr key={tax.taxRuleId}>
              <td className="py-1">
                {nameOf.get(tax.taxRuleId)}
                <span className="ml-1 text-xs text-text-muted">
                  {t('finance.example.on', { base: money(tax.baseMinor) })}
                  {tax.inclusive ? ` · ${t('finance.taxes.included')}` : ''}
                </span>
              </td>
              <td className="py-1 text-right tabular-nums">{money(tax.amountMinor)}</td>
            </tr>
          ))}
          <tr className="border-t border-border font-semibold">
            <td className="py-1">{t('finance.example.total')}</td>
            <td className="py-1 text-right tabular-nums">{money(result.totalMinor)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

// ── Revenue codes ──────────────────────────────────────────────────────────────────────

function CodesTab() {
  const { t } = useTranslation();
  const f = useFinance();
  const [editing, setEditing] = useState<Code | 'new' | null>(null);
  const error = f.rules.error ?? f.codes.error;
  if (error) return <Alert tone="critical">{errorMessage(error)}</Alert>;
  if (!f.rules.data || !f.codes.data) {
    return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  }
  const ruleName = new Map(f.rules.data.data.map((r) => [r.id, r.name]));
  return (
    <div>
      <div className="mb-4 overflow-x-auto rounded-md border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-text-muted">
            <tr>
              <th className="p-2 font-medium">{t('finance.codes.code')}</th>
              <th className="p-2 font-medium">{t('finance.codes.name')}</th>
              <th className="p-2 font-medium">{t('finance.codes.group')}</th>
              <th className="p-2 font-medium">{t('finance.codes.taxes')}</th>
              <th className="p-2 font-medium">
                <span className="sr-only">{t('finance.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {f.codes.data.map((code) => (
              <tr key={code.id} className="border-b border-border last:border-0">
                <td className="p-2 font-mono">{code.code}</td>
                <td className="p-2">
                  {code.name}
                  {!code.active && (
                    <span className="ml-2 text-xs text-text-muted">{t('finance.inactive')}</span>
                  )}
                </td>
                <td className="p-2">{t(`finance.groups.${code.group}`)}</td>
                <td className="p-2">
                  {code.taxRuleIds.map((id) => ruleName.get(id)).join(', ') || '–'}
                </td>
                <td className="p-2 text-right">
                  {f.canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('finance.codes.editNamed', { name: code.name })}
                      onClick={() => setEditing(code)}
                    >
                      {t('finance.edit')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {f.canEdit && editing === null && (
        <Button onClick={() => setEditing('new')}>{t('finance.codes.add')}</Button>
      )}
      {editing !== null && (
        <CodeForm
          key={editing === 'new' ? 'new' : editing.id}
          code={editing === 'new' ? null : editing}
          rules={f.rules.data.data}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function CodeForm({
  code,
  rules,
  onDone,
}: {
  code: Code | null;
  rules: Rule[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  const [draft, setDraft] = useState({
    code: code?.code ?? '',
    name: code?.name ?? '',
    group: code?.group ?? 'OTHER',
    taxRuleIds: code?.taxRuleIds ?? [],
    active: code?.active ?? true,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const carriesTaxes = !(TAX_LINE_GROUPS as readonly string[]).includes(draft.group);
  const save = useMutation({
    mutationFn: async () => {
      const taxRuleIds = carriesTaxes ? draft.taxRuleIds : [];
      if (code) {
        return api.call('updateRevenueCode', {
          params: { revenueCodeId: code.id },
          body: validated(RevenueCodePatchBody, {
            name: draft.name,
            taxRuleIds,
            active: draft.active,
          }),
        });
      }
      return api.call('createRevenueCode', {
        body: validated(RevenueCodeBody, { ...draft, taxRuleIds }),
      });
    },
    onSuccess: () => {
      invalidate();
      onDone();
    },
    onError: (error) => setErrors(fieldErrorsOf(error)),
  });
  const title = code ? t('finance.codes.editNamed', { name: code.name }) : t('finance.codes.add');
  return (
    <FormShell
      title={title}
      pending={save.isPending}
      error={save.error}
      onSubmit={() => {
        setErrors({});
        save.mutate();
      }}
      onDone={onDone}
    >
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field
          label={t('finance.codes.code')}
          disabled={code !== null}
          value={draft.code}
          onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          error={errors['code']}
        />
        <Field
          label={t('finance.codes.name')}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          error={errors['name']}
        />
      </div>
      <div className="mb-4 flex flex-col gap-1">
        <Label htmlFor="code-group">{t('finance.codes.group')}</Label>
        <select
          id="code-group"
          disabled={code !== null}
          className="h-10 rounded-md border border-border bg-surface px-3 text-sm disabled:opacity-60"
          value={draft.group}
          onChange={(e) => setDraft({ ...draft, group: e.target.value as Code['group'] })}
        >
          {REVENUE_GROUPS.map((g) => (
            <option key={g} value={g}>
              {t(`finance.groups.${g}`)}
            </option>
          ))}
        </select>
      </div>
      {carriesTaxes && (
        <fieldset className="mb-4">
          <legend className="mb-1 text-sm font-medium">{t('finance.codes.taxes')}</legend>
          {rules.map((rule) => (
            <label key={rule.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.taxRuleIds.includes(rule.id)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    taxRuleIds: e.target.checked
                      ? [...draft.taxRuleIds, rule.id]
                      : draft.taxRuleIds.filter((id) => id !== rule.id),
                  })
                }
              />
              {rule.name}
            </label>
          ))}
          {errors['taxRuleIds'] && <p className="text-sm text-critical">{errors['taxRuleIds']}</p>}
        </fieldset>
      )}
      {code && (
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
          />
          {t('finance.codes.active')}
        </label>
      )}
    </FormShell>
  );
}
