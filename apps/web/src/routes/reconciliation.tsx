import {
  addDays,
  DATE_ORDERS,
  guessStatementColumns,
  localDate,
  parseCsv,
  findHeaderRow,
  readStatement,
  STATEMENT_FIELDS,
  STATEMENT_LINE_STATUSES,
  type DateOrder,
  type StatementColumns,
  type StatementLineItem,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import strings from '../i18n/en/reconciliation.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';

registerStrings(strings);

// S37 Bank reconciliation (PRD M4-23; T-128): import a bank statement CSV, auto-match its lines
// to the payments in the books, match the rest by hand or explain them (expenses, bank
// charges). The CSV is read here in the browser; only its transactions go to the API.

type Line = z.output<typeof StatementLineItem>;
type Status = (typeof STATEMENT_LINE_STATUSES)[number];

const KEY = ['recon'];
const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';

function useHotel() {
  const { i18n } = useTranslation();
  const { properties, currentPropertyId } = useSession();
  const p = properties.find((x) => x.id === currentPropertyId);
  const currency = p?.baseCurrency ?? 'NGN';
  return {
    today: p?.businessDate ?? localDate(new Date(), p?.timeZone ?? 'UTC'),
    money: (minor: string | bigint) =>
      new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(
        Number(minor) / 100,
      ),
  };
}

function Field({
  id,
  label,
  ...props
}: { id: string; label: string } & ComponentProps<typeof Input>) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}

// ── Import ─────────────────────────────────────────────────────────────────────────────

interface Loaded {
  name: string;
  table: string[][];
  headerRow: number | null;
}

function ImportStatement({ accounts }: { accounts: string[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { money } = useHotel();
  const [typed, setBankAccount] = useState<string | null>(null);
  const bankAccount = typed ?? accounts[0] ?? '';
  const [file, setFile] = useState<Loaded | null>(null);
  const [columns, setColumns] = useState<StatementColumns | null>(null);
  const [dateOrder, setDateOrder] = useState<DateOrder>('DMY');
  const read = useMemo(() => {
    if (!file || file.headerRow === null || !columns) return null;
    return readStatement(file.table, { headerRow: file.headerRow, columns, dateOrder });
  }, [file, columns, dateOrder]);
  const send = useMutation({
    mutationFn: () =>
      api.call('importBankStatement', {
        body: { bankAccount, fileName: file?.name ?? null, lines: read?.lines ?? [] },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  const choose = async (picked: File | undefined) => {
    send.reset();
    if (!picked) {
      setFile(null);
      return;
    }
    const table = parseCsv(await picked.text());
    const headerRow = findHeaderRow(table);
    setFile({ name: picked.name, table, headerRow });
    setColumns(headerRow === null ? null : guessStatementColumns(table[headerRow] ?? []));
  };
  const header = file && file.headerRow !== null ? (file.table[file.headerRow] ?? []) : [];
  const lines = read?.lines ?? [];
  const moneyIn = lines.reduce(
    (s, l) => (l.amountMinor.startsWith('-') ? s : s + BigInt(l.amountMinor)),
    0n,
  );
  const moneyOut = lines.reduce(
    (s, l) => (l.amountMinor.startsWith('-') ? s - BigInt(l.amountMinor) : s),
    0n,
  );
  const dates = lines.map((l) => l.postedOn).sort();
  const errors = read?.errors ?? [];
  return (
    <form
      aria-label={t('recon.import.title')}
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <h2 className="font-medium">{t('recon.import.title')}</h2>
      <p className="text-sm text-text-muted">{t('recon.import.explain')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field
          id="rc-account"
          label={t('recon.import.account')}
          placeholder={t('recon.import.accountHint')}
          list="rc-accounts"
          value={bankAccount}
          onChange={(e) => setBankAccount(e.target.value)}
          required
          minLength={2}
          maxLength={80}
        />
        <datalist id="rc-accounts">
          {accounts.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rc-file">{t('recon.import.file')}</Label>
          <input
            id="rc-file"
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={(e) => void choose(e.target.files?.[0])}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rc-order">{t('recon.import.dateOrder')}</Label>
          <select
            id="rc-order"
            className={selectClass}
            value={dateOrder}
            onChange={(e) => setDateOrder(e.target.value as DateOrder)}
          >
            {DATE_ORDERS.map((o) => (
              <option key={o} value={o}>
                {t(`recon.import.orders.${o}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {file && file.headerRow === null && (
        <Alert tone="critical">{t('recon.import.noHeader')}</Alert>
      )}
      {columns && (
        <fieldset className="flex flex-wrap gap-2">
          <legend className="mb-1 text-sm font-medium">{t('recon.import.columns')}</legend>
          {STATEMENT_FIELDS.map((f) => (
            <div key={f} className="flex flex-col gap-1">
              <Label htmlFor={`rc-col-${f}`}>{t(`recon.import.fields.${f}`)}</Label>
              <select
                id={`rc-col-${f}`}
                className={selectClass}
                value={columns[f] ?? ''}
                onChange={(e) =>
                  setColumns({
                    ...columns,
                    [f]: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              >
                <option value="">{t('recon.import.notUsed')}</option>
                {header.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `#${i + 1}`}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </fieldset>
      )}
      {read && lines.length === 0 && errors.length === 0 && (
        <p className="text-sm text-text-muted">{t('recon.import.none')}</p>
      )}
      {lines.length > 0 && (
        <p className="text-sm">
          {t('recon.import.found', {
            count: lines.length,
            from: dates[0],
            to: dates[dates.length - 1],
            moneyIn: money(moneyIn),
            moneyOut: money(moneyOut),
          })}
        </p>
      )}
      {errors.length > 0 && (
        <Alert tone="critical">
          <p>{t('recon.import.fixFirst')}</p>
          <ul className="list-disc pl-5">
            {errors.slice(0, 10).map((e) => (
              <li key={e.row}>{t('recon.import.rowError', { row: e.row, message: e.message })}</li>
            ))}
          </ul>
          {errors.length > 10 && (
            <p>{t('recon.import.moreErrors', { count: errors.length - 10 })}</p>
          )}
        </Alert>
      )}
      {lines.length > 0 && errors.length === 0 && (
        <div>
          <Button type="submit" size="sm" disabled={send.isPending}>
            {t('recon.import.button', { count: lines.length })}
          </Button>
        </div>
      )}
      {send.data && (
        <Alert tone="success">
          {t('recon.import.done', {
            imported: send.data.imported,
            skipped: send.data.skipped,
            matched: send.data.autoMatched,
          })}
        </Alert>
      )}
      {send.error && <Alert tone="critical">{errorMessage(send.error)}</Alert>}
    </form>
  );
}

// ── Matching one line ──────────────────────────────────────────────────────────────────

function MatchLine({ line, onClose }: { line: Line; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { money, today } = useHotel();
  const [picked, setPicked] = useState<{ kind: string; id: string; amount: bigint }[]>([]);
  const [differenceNote, setDifferenceNote] = useState('');
  const [note, setNote] = useState('');
  const to = addDays(line.postedOn, 3) > today ? today : addDays(line.postedOn, 3);
  const entries = useQuery({
    queryKey: [...KEY, 'entries', line.postedOn, to],
    queryFn: () => api.call('listBookEntries', { query: { from: addDays(line.postedOn, -7), to } }),
  });
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: KEY });
    onClose();
  };
  const match = useMutation({
    mutationFn: () =>
      api.call('matchBankLine', {
        params: { lineId: line.id },
        body: {
          paymentIds: picked.filter((p) => p.kind === 'PAYMENT').map((p) => p.id),
          arPaymentIds: picked.filter((p) => p.kind === 'AR_PAYMENT').map((p) => p.id),
          differenceNote: differenceNote.trim() || null,
        },
      }),
    onSuccess: done,
  });
  const explain = useMutation({
    mutationFn: () =>
      api.call('explainBankLine', { params: { lineId: line.id }, body: { note: note.trim() } }),
    onSuccess: done,
  });
  const lineAmount = BigInt(line.amountMinor);
  // Same sign as the line, closest amount first.
  const rows = (entries.data?.data ?? [])
    .filter((e) => e.amountMinor.startsWith('-') === lineAmount < 0n)
    .sort((a, b) => {
      const da = BigInt(a.amountMinor) - lineAmount;
      const db = BigInt(b.amountMinor) - lineAmount;
      return (da < 0n ? -da : da) < (db < 0n ? -db : db) ? -1 : 1;
    });
  const chosen = picked.reduce((s, p) => s + p.amount, 0n);
  const difference = lineAmount - chosen;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3">
      <form
        aria-label={t('recon.match.button')}
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          match.mutate();
        }}
      >
        <h3 className="font-medium">
          {t('recon.match.title', { amount: money(line.amountMinor), date: line.postedOn })}
        </h3>
        <p className="text-sm text-text-muted">{t('recon.match.entries')}</p>
        {entries.error && <Alert tone="critical">{errorMessage(entries.error)}</Alert>}
        {entries.data && rows.length === 0 && (
          <p className="text-sm text-text-muted">{t('recon.match.noEntries')}</p>
        )}
        {rows.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {rows.map((e) => {
              const label = t('recon.match.pick', {
                method: t(`recon.methods.${e.method}`, { defaultValue: e.method }),
                amount: money(e.amountMinor),
                payer: e.payer,
                date: e.date,
              });
              return (
                <li key={e.id}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={label}
                      checked={picked.some((p) => p.id === e.id)}
                      onChange={(ev) =>
                        setPicked((x) =>
                          ev.target.checked
                            ? [...x, { kind: e.kind, id: e.id, amount: BigInt(e.amountMinor) }]
                            : x.filter((p) => p.id !== e.id),
                        )
                      }
                    />
                    <span>{label}</span>
                    {e.reference && <span className="text-text-muted">{e.reference}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {picked.length > 0 && (
          <>
            <p className="text-sm">
              {t('recon.match.chosen', { chosen: money(chosen), line: money(lineAmount) })}
              {difference !== 0n && (
                <strong> {t('recon.match.differs', { amount: money(difference) })}</strong>
              )}
            </p>
            {difference !== 0n && (
              <Field
                id="rc-diff"
                label={t('recon.match.differenceNote')}
                value={differenceNote}
                onChange={(e) => setDifferenceNote(e.target.value)}
                required
                minLength={3}
                maxLength={200}
              />
            )}
            <div>
              <Button type="submit" size="sm" disabled={match.isPending}>
                {t('recon.match.button')}
              </Button>
            </div>
          </>
        )}
        {match.error && <Alert tone="critical">{errorMessage(match.error)}</Alert>}
      </form>
      <form
        aria-label={t('recon.match.explainButton')}
        className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          explain.mutate();
        }}
      >
        <p className="w-full text-sm text-text-muted">{t('recon.match.orExplain')}</p>
        <Field
          id="rc-note"
          label={t('recon.match.note')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          required
          minLength={3}
          maxLength={200}
        />
        <Button type="submit" size="sm" variant="secondary" disabled={explain.isPending}>
          {t('recon.match.explainButton')}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onClose}>
          {t('recon.match.close')}
        </Button>
        {explain.error && <Alert tone="critical">{errorMessage(explain.error)}</Alert>}
      </form>
    </div>
  );
}

function UndoMatch({ line, onClose }: { line: Line; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const undo = useMutation({
    mutationFn: () =>
      api.call('unmatchBankLine', { params: { lineId: line.id }, body: { reason: reason.trim() } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  return (
    <form
      aria-label={t('recon.undoButton')}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        undo.mutate();
      }}
    >
      <Field
        id="rc-undo"
        label={t('recon.undoReason')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        minLength={3}
        maxLength={200}
      />
      <Button type="submit" size="sm" variant="secondary" disabled={undo.isPending}>
        {t('recon.undoButton')}
      </Button>
      {undo.error && <Alert tone="critical">{errorMessage(undo.error)}</Alert>}
    </form>
  );
}

// ── The page ───────────────────────────────────────────────────────────────────────────

export function ReconciliationPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { money, today } = useHotel();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<Status | ''>('UNMATCHED');
  const [bankAccount, setBankAccount] = useState('');
  const [open, setOpen] = useState<{ id: string; as: 'match' | 'undo' } | null>(null);
  const q = useQuery({
    queryKey: [...KEY, 'lines', from, to, status, bankAccount],
    queryFn: () =>
      api.call('listBankStatementLines', {
        query: {
          from,
          to,
          ...(status ? { status } : {}),
          ...(bankAccount ? { bankAccount } : {}),
        },
      }),
    enabled: from !== '' && to !== '' && to >= from,
  });
  const auto = useMutation({
    mutationFn: () => api.call('autoMatchBankLines', { body: {} }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  const rows = q.data?.data ?? [];
  const summary = q.data?.summary;
  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('recon.title')}</h1>
      <ImportStatement accounts={q.data?.bankAccounts ?? []} />
      <div className="flex flex-wrap items-end gap-2">
        <Field
          id="rc-from"
          label={t('recon.from')}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Field
          id="rc-to"
          label={t('recon.to')}
          type="date"
          max={today}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor="rc-status">{t('recon.status')}</Label>
          <select
            id="rc-status"
            className={selectClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as Status | '')}
          >
            {STATEMENT_LINE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`recon.statuses.${s}`)}
              </option>
            ))}
            <option value="">{t('recon.all')}</option>
          </select>
        </div>
        {(q.data?.bankAccounts.length ?? 0) > 1 && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="rc-filter-account">{t('recon.import.account')}</Label>
            <select
              id="rc-filter-account"
              className={selectClass}
              value={bankAccount}
              onChange={(e) => setBankAccount(e.target.value)}
            >
              <option value="">{t('recon.allAccounts')}</option>
              {q.data?.bankAccounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={auto.isPending}
          onClick={() => auto.mutate()}
        >
          {t('recon.autoMatch')}
        </Button>
      </div>
      {auto.data && (
        <Alert tone="success">{t('recon.autoMatched', { count: auto.data.matched })}</Alert>
      )}
      {auto.error && <Alert tone="critical">{errorMessage(auto.error)}</Alert>}
      {summary && (
        <p className="text-sm">
          {t('recon.summary', {
            moneyIn: money(summary.moneyInMinor),
            moneyOut: money(summary.moneyOutMinor),
          })}{' '}
          {summary.unmatchedCount > 0 && (
            <strong>
              {t('recon.unmatched', {
                count: summary.unmatchedCount,
                amount: money(summary.unmatchedMinor),
              })}
            </strong>
          )}
        </p>
      )}
      {q.error && <Alert tone="critical">{errorMessage(q.error)}</Alert>}
      {q.data && rows.length === 0 && (
        <p className="text-sm text-text-muted">{t('recon.noLines')}</p>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {rows.map((l) => (
            <li key={l.id} className="flex flex-col gap-2 p-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="w-24 shrink-0">{l.postedOn}</span>
                <span className="min-w-0 flex-1 break-words">
                  {l.description}
                  {l.reference && <span className="text-text-muted"> {l.reference}</span>}
                </span>
                <span
                  className={`font-medium ${l.amountMinor.startsWith('-') ? 'text-critical' : ''}`}
                >
                  {money(l.amountMinor)}
                </span>
                <span>{t(`recon.statuses.${l.status}`)}</span>
                {l.status === 'UNMATCHED' ? (
                  <Button
                    size="sm"
                    aria-label={t('recon.matchLine', { description: l.description })}
                    onClick={() => setOpen(open?.id === l.id ? null : { id: l.id, as: 'match' })}
                  >
                    {t('recon.matchButton')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={t('recon.undoLine', { description: l.description })}
                    onClick={() => setOpen(open?.id === l.id ? null : { id: l.id, as: 'undo' })}
                  >
                    {t('recon.undo')}
                  </Button>
                )}
              </div>
              {l.matches.length > 0 && (
                <ul className="pl-4 text-text-muted">
                  {l.matches.map((m) => (
                    <li key={m.id}>
                      {m.entry &&
                        `${t('recon.matchedTo')} ${t(`recon.methods.${m.entry.method}`, { defaultValue: m.entry.method })} ${money(m.amountMinor)} · ${m.entry.payer} · ${m.entry.date}`}
                      {m.kind === 'DIFFERENCE' &&
                        `${t('recon.difference', { note: m.note ?? '' })} ${money(m.amountMinor)}`}
                      {m.kind === 'EXPLAINED' && t('recon.explained', { note: m.note ?? '' })}
                      {m.auto && ` (${t('recon.auto')})`}
                    </li>
                  ))}
                </ul>
              )}
              {open?.id === l.id && open.as === 'match' && (
                <MatchLine line={l} onClose={() => setOpen(null)} />
              )}
              {open?.id === l.id && open.as === 'undo' && (
                <UndoMatch line={l} onClose={() => setOpen(null)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
