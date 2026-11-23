import type { AccountingMappingRow } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api, ApiError } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import accountingStrings from '../i18n/en/accounting.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(accountingStrings);

// S43 Expenses, accounting exports (PRD M10-07; T-148): the hotel's account codes for what the
// journal posts to, then a general journal CSV for a period of closed business days.

type Row = z.output<typeof AccountingMappingRow>;
const KINDS: Row['kind'][] = ['CONTROL', 'REVENUE_CODE', 'PAY_METHOD', 'EXPENSE_CATEGORY'];
const card = 'rounded-md border border-border bg-surface p-4';
const rowKey = (r: { kind: string; key: string }) => `${r.kind}:${r.key}`;

function useRoot() {
  const { currentPropertyId } = useSession();
  return ['accounting', currentPropertyId ?? ''];
}

export function AccountingPage() {
  const { t } = useTranslation();
  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('accounting.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('accounting.intro')}</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Mappings />
        <Exports />
      </div>
    </section>
  );
}

function Mappings() {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: [...root, 'mappings'],
    queryFn: () => api.call('getAccountingMappings', {}),
  });
  const [edits, setEdits] = useState<Record<string, { code: string; name: string }>>({});
  const save = useMutation({
    mutationFn: () =>
      api.call('updateAccountingMappings', {
        body: {
          mappings: Object.entries(edits).map(([k, v]) => {
            const [kind, ...rest] = k.split(':');
            return {
              kind: kind as Row['kind'],
              key: rest.join(':'),
              accountCode: v.code.trim() === '' ? null : v.code.trim(),
              accountName: v.name,
            };
          }),
        },
      }),
    onSuccess: () => {
      setEdits({});
      void queryClient.invalidateQueries({ queryKey: root });
    },
  });
  const value = (r: Row) =>
    edits[rowKey(r)] ?? { code: r.accountCode ?? '', name: r.accountName ?? '' };
  const change = (r: Row, patch: Partial<{ code: string; name: string }>) =>
    setEdits({ ...edits, [rowKey(r)]: { ...value(r), ...patch } });
  return (
    <form
      aria-label={t('accounting.accounts')}
      className={card}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="font-semibold">{t('accounting.accounts')}</h2>
      <p className="text-sm text-text-muted">{t('accounting.accountsIntro')}</p>
      {list.error && <Alert tone="critical">{errorMessage(list.error)}</Alert>}
      {KINDS.map((kind) => {
        const rows = list.data?.data.filter((r) => r.kind === kind) ?? [];
        if (rows.length === 0) return null;
        return (
          <fieldset key={kind} className="mt-3">
            <legend className="text-sm font-medium">{t(`accounting.kinds.${kind}`)}</legend>
            {rows.map((r) => (
              <div
                key={rowKey(r)}
                className="mt-1 grid grid-cols-[1fr_8rem_10rem] items-center gap-2"
              >
                <span className="text-sm">{r.label}</span>
                <Input
                  aria-label={t('accounting.code', { item: r.label })}
                  value={value(r).code}
                  onChange={(e) => change(r, { code: e.target.value })}
                />
                <Input
                  aria-label={t('accounting.name', { item: r.label })}
                  value={value(r).name}
                  onChange={(e) => change(r, { name: e.target.value })}
                />
              </div>
            ))}
          </fieldset>
        );
      })}
      {save.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      {save.isSuccess && (
        <Alert tone="success" className="mt-2">
          {t('accounting.saved')}
        </Alert>
      )}
      <Button
        type="submit"
        className="mt-3 h-11"
        disabled={save.isPending || Object.keys(edits).length === 0}
      >
        {t('accounting.save')}
      </Button>
    </form>
  );
}

function Exports() {
  const { t } = useTranslation();
  const f = useFormats();
  const root = useRoot();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: [...root, 'exports'],
    queryFn: () => api.call('listAccountingExports', {}),
  });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const last = list.data?.lastClosedDay ?? '';
  const create = useMutation({
    mutationFn: () => api.call('createAccountingExport', { body: { from, to: to || last } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: root }),
  });
  const download = async (exportId: string, number: number) => {
    setDownloadError(null);
    try {
      const blob = await api.download('getAccountingExport', {
        params: { exportId },
        query: { format: 'csv' },
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `journal-${number}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setDownloadError(err);
    }
  };
  const missing =
    create.error instanceof ApiError
      ? ((create.error.details as { missing?: { label: string }[] } | undefined)?.missing ?? [])
      : [];
  return (
    <div className="flex flex-col gap-4">
      <form
        aria-label={t('accounting.export')}
        className={card}
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h2 className="font-semibold">{t('accounting.export')}</h2>
        {last && (
          <p className="text-sm text-text-muted">
            {t('accounting.lastClosed', { date: f.date(last) })}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="acc-from">{t('accounting.from')}</Label>
            <Input
              id="acc-from"
              type="date"
              max={last}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="acc-to">{t('accounting.to')}</Label>
            <Input
              id="acc-to"
              type="date"
              max={last}
              value={to || last}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <Button type="submit" className="h-11" disabled={create.isPending || !from}>
            {t('accounting.create')}
          </Button>
        </div>
        {create.error && (
          <Alert tone="critical" className="mt-2">
            {missing.length > 0
              ? t('accounting.missing', { items: missing.map((m) => m.label).join(', ') })
              : errorMessage(create.error)}
          </Alert>
        )}
      </form>
      <div className={card}>
        <h2 className="font-semibold">{t('accounting.exports')}</h2>
        {downloadError !== null && (
          <Alert tone="critical" className="mt-2">
            {errorMessage(downloadError)}
          </Alert>
        )}
        {list.data && list.data.data.length === 0 && (
          <p className="text-sm text-text-muted">{t('accounting.none')}</p>
        )}
        <ul aria-label={t('accounting.exports')} className="mt-2 flex flex-col gap-2">
          {list.data?.data.map((e) => (
            <li key={e.id} className="text-sm">
              <p className="font-medium">
                {t('accounting.exportLine', {
                  number: e.number,
                  from: f.date(e.from),
                  to: f.date(e.to),
                })}
              </p>
              <p className="text-text-muted">
                {t('accounting.exportFacts', {
                  journals: e.journalCount,
                  lines: e.lineCount,
                  total: f.money(e.debitTotalMinor),
                  name: e.createdBy.name,
                  when: f.when(e.createdAt),
                })}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-1"
                aria-label={t('accounting.downloadOne', { number: e.number })}
                onClick={() => void download(e.id, e.number)}
              >
                {t('accounting.download')}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
