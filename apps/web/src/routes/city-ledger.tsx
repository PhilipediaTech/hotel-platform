import {
  addDays,
  AGEING_BUCKETS,
  AR_ACCOUNT_STATUSES,
  AR_PAY_METHODS,
  localDate,
  type ApprovalPending,
  type ArAccountDetail,
  type ArAccountItem,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import strings from '../i18n/en/ar.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';
import { PdfError, usePdf } from '../lib/pdf.tsx';

registerStrings(strings);

// S32 City ledger (PRD M4-21; T-126): company accounts, their invoices and payments,
// allocation, statements and ageing; and, on a folio, moving what it owes to an account.

type Account = z.output<typeof ArAccountItem>;
type Detail = z.output<typeof ArAccountDetail>;

const KEY = ['ar'];
const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';
const isPending = (r: unknown): r is z.output<typeof ApprovalPending> =>
  typeof r === 'object' && r !== null && 'approvalRequestId' in r;

function useHotel() {
  const { i18n } = useTranslation();
  const { properties, currentPropertyId } = useSession();
  const p = properties.find((x) => x.id === currentPropertyId);
  const currency = p?.baseCurrency ?? 'NGN';
  return {
    today: p?.businessDate ?? localDate(new Date(), p?.timeZone ?? 'UTC'),
    money: (minor: string) =>
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

// ── On a folio: transfer to a company account ───────────────────────────────────────────

export function ArTransferPanel({
  folioId,
  windowNumber,
  balanceMinor,
}: {
  folioId: string;
  windowNumber: number;
  balanceMinor: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { money } = useHotel();
  const accounts = useQuery({
    queryKey: [...KEY, 'list'],
    queryFn: () => api.call('listArAccounts'),
  });
  const active = accounts.data?.data.filter((a) => a.status === 'ACTIVE') ?? [];
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState(String(Number(balanceMinor) / 100));
  const [reason, setReason] = useState('');
  const [asked, setAsked] = useState(false);
  const chosen = accountId || active[0]?.id || '';
  const move = useMutation({
    mutationFn: () =>
      api.call('transferToAr', {
        params: { accountId: chosen },
        body: { folioId, windowNumber, amountMinor: toMinor(amount) ?? amount, reason },
      }),
    onSuccess: (r) => {
      if (isPending(r)) {
        setAsked(true);
        return;
      }
      void queryClient.invalidateQueries();
    },
    onError: () => setAsked(false),
  });
  if (active.length === 0) return null;
  return (
    <form
      aria-label={t('ar.transfer.title')}
      className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        move.mutate();
      }}
    >
      <h3 className="w-full text-sm font-semibold">{t('ar.transfer.title')}</h3>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`ar-to-${folioId}`}>{t('ar.transfer.account')}</Label>
        <select
          id={`ar-to-${folioId}`}
          className={selectClass}
          value={chosen}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {active.map((a) => (
            <option key={a.id} value={a.id}>
              {a.company.name} ({t('ar.owes', { amount: money(a.balanceMinor) })})
            </option>
          ))}
        </select>
      </div>
      <Field
        id={`ar-amt-${folioId}`}
        label={t('ar.amount')}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        required
      />
      <Field
        id={`ar-why-${folioId}`}
        label={t('ar.transfer.reason')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={move.isPending}>
        {t('ar.transfer.button')}
      </Button>
      {asked && <Alert tone="info">{t('ar.transfer.asked')}</Alert>}
      {move.isSuccess && !asked && <Alert tone="success">{t('ar.transfer.done')}</Alert>}
      {move.error && <Alert tone="critical">{errorMessage(move.error)}</Alert>}
    </form>
  );
}

// ── One account ─────────────────────────────────────────────────────────────────────────

function PaymentForm({ account }: { account: Detail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { today } = useHotel();
  const [method, setMethod] = useState<(typeof AR_PAY_METHODS)[number]>('BANK_TRANSFER');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(today);
  const record = useMutation({
    mutationFn: () =>
      api.call('recordArPayment', {
        params: { accountId: account.id },
        body: {
          method,
          amountMinor: toMinor(amount) ?? amount,
          reference: reference || null,
          receivedOn: date,
          note: null,
          allocate: true,
        },
      }),
    onSuccess: () => {
      setAmount('');
      setReference('');
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  return (
    <form
      aria-label={t('ar.payment.title')}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        record.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="ar-pay-method">{t('ar.payment.method')}</Label>
        <select
          id="ar-pay-method"
          className={selectClass}
          value={method}
          onChange={(e) => setMethod(e.target.value as typeof method)}
        >
          {AR_PAY_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`ar.methods.${m}`)}
            </option>
          ))}
        </select>
      </div>
      <Field
        id="ar-pay-amount"
        label={t('ar.amount')}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        required
      />
      <Field
        id="ar-pay-ref"
        label={t('ar.payment.reference')}
        value={reference}
        onChange={(e) => setReference(e.target.value)}
      />
      <Field
        id="ar-pay-date"
        label={t('ar.payment.date')}
        type="date"
        max={today}
        value={date}
        onChange={(e) => setDate(e.target.value)}
        required
      />
      <Button type="submit" size="sm" disabled={record.isPending}>
        {t('ar.payment.record')}
      </Button>
      {record.error && <Alert tone="critical">{errorMessage(record.error)}</Alert>}
    </form>
  );
}

function Statement({ account }: { account: Detail }) {
  const { t } = useTranslation();
  const { today, money } = useHotel();
  const pdf = usePdf();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const view = useQuery({
    queryKey: [...KEY, account.id, 'statement', from, to],
    queryFn: () =>
      api.call('getArStatement', { params: { accountId: account.id }, query: { from, to } }),
  });
  const send = useMutation({
    mutationFn: () =>
      api.call('sendArStatement', { params: { accountId: account.id }, body: { from, to } }),
  });
  return (
    <section aria-label={t('ar.statement.title')} className="flex flex-col gap-2">
      <h3 className="font-semibold">{t('ar.statement.title')}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <Field
          id="ar-st-from"
          label={t('ar.statement.from')}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Field
          id="ar-st-to"
          label={t('ar.statement.to')}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={pdf.busy}
          onClick={() =>
            void pdf.open(
              () =>
                api.download('getArStatementPdf', {
                  params: { accountId: account.id },
                  query: { from, to },
                }),
              `statement-${to}.pdf`,
            )
          }
        >
          {t('ar.statement.pdf')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={send.isPending}
          onClick={() => send.mutate()}
        >
          {t('ar.statement.send')}
        </Button>
      </div>
      {send.data && (
        <Alert tone="success">{t('ar.statement.sent', { to: send.data.sentTo })}</Alert>
      )}
      {send.error && <Alert tone="critical">{errorMessage(send.error)}</Alert>}
      <PdfError error={pdf.error} />
      {view.data && (
        <table className="text-sm">
          <tbody>
            <tr>
              <td className="pr-3">{from}</td>
              <td className="pr-3" colSpan={2}>
                {t('ar.statement.opening')}
              </td>
              <td className="text-right">{money(view.data.openingMinor)}</td>
            </tr>
            {view.data.lines.map((l, i) => (
              <tr key={i}>
                <td className="pr-3">{l.date}</td>
                <td className="pr-3">{l.reference}</td>
                <td className="pr-3 text-right">{money(l.amountMinor)}</td>
                <td className="text-right">{money(l.balanceMinor)}</td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className="pr-3">{to}</td>
              <td className="pr-3" colSpan={2}>
                {t('ar.statement.closing')}
              </td>
              <td className="text-right">{money(view.data.closingMinor)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}

function AccountSettings({ account }: { account: Detail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState(String(Number(account.creditLimitMinor) / 100));
  const [terms, setTerms] = useState(String(account.termsDays));
  const [status, setStatus] = useState(account.status);
  const save = useMutation({
    mutationFn: () =>
      api.call('updateArAccount', {
        params: { accountId: account.id },
        body: { creditLimitMinor: toMinor(limit) ?? limit, termsDays: Number(terms), status },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  return (
    <form
      aria-label={t('ar.settings')}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field
        id="ar-set-limit"
        label={t('ar.creditLimit')}
        inputMode="decimal"
        value={limit}
        onChange={(e) => setLimit(e.target.value)}
        required
      />
      <Field
        id="ar-set-terms"
        label={t('ar.terms')}
        type="number"
        min={0}
        value={terms}
        onChange={(e) => setTerms(e.target.value)}
        required
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor="ar-set-status">{t('ar.status')}</Label>
        <select
          id="ar-set-status"
          className={selectClass}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          {AR_ACCOUNT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`ar.statuses.${s}`)}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" size="sm" variant="secondary" disabled={save.isPending}>
        {t('ar.save')}
      </Button>
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
    </form>
  );
}

function AccountView({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { money } = useHotel();
  const q = useQuery({
    queryKey: [...KEY, accountId],
    queryFn: () => api.call('getArAccount', { params: { accountId } }),
  });
  const allocate = useMutation({
    mutationFn: (paymentId: string) =>
      api.call('allocateArPayment', { params: { paymentId }, body: {} }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  const a = q.data;
  if (!a) return null;
  return (
    <div className="mt-3 flex flex-col gap-5 border-t border-border pt-3">
      <AccountSettings key={`${a.creditLimitMinor}-${a.termsDays}-${a.status}`} account={a} />
      <section aria-label={t('ar.invoices')}>
        <h3 className="font-semibold">{t('ar.invoices')}</h3>
        {a.invoices.length === 0 && <p className="text-text-muted">{t('ar.noInvoices')}</p>}
        <ul className="mt-1 flex flex-col gap-1">
          {a.invoices.map((i) => (
            <li key={i.id} className="flex flex-wrap gap-3">
              <span className="font-medium">{i.number}</span>
              {i.folio && <span className="text-text-muted">{i.folio.name}</span>}
              <span>{money(i.amountMinor)}</span>
              <span className="text-text-muted">{t('ar.dueOn', { date: i.dueOn })}</span>
              <span className={i.status === 'OPEN' ? 'font-medium' : 'text-text-muted'}>
                {i.status === 'OPEN' ? t('ar.open', { amount: money(i.openMinor) }) : t('ar.paid')}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={t('ar.payments')} className="flex flex-col gap-2">
        <h3 className="font-semibold">{t('ar.payments')}</h3>
        <PaymentForm account={a} />
        <ul className="flex flex-col gap-1">
          {a.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3">
              <span>{p.receivedOn}</span>
              <span>{t(`ar.methods.${p.method}`)}</span>
              <span>{money(p.amountMinor)}</span>
              {p.reference && <span className="text-text-muted">{p.reference}</span>}
              {p.allocations.length > 0 && (
                <span className="text-text-muted">
                  {p.allocations.map((x) => x.invoiceNumber).join(', ')}
                </span>
              )}
              {p.unallocatedMinor !== '0' && (
                <>
                  <span className="font-medium">
                    {t('ar.unallocated', { amount: money(p.unallocatedMinor) })}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={allocate.isPending}
                    onClick={() => allocate.mutate(p.id)}
                  >
                    {t('ar.allocateOldest')}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        {allocate.error && <Alert tone="critical">{errorMessage(allocate.error)}</Alert>}
      </section>
      <Statement account={a} />
    </div>
  );
}

// ── Accounts and ageing ─────────────────────────────────────────────────────────────────

function NewAccount({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companies = useQuery({
    queryKey: ['companies', 'for-ar'],
    queryFn: async () => (await api.call('listCompanies', { query: {} })).data,
  });
  const options = (companies.data ?? []).filter((c) => c.active && c.kind !== 'EVENT_CLIENT');
  const [companyId, setCompanyId] = useState('');
  const chosen = options.find((c) => c.id === (companyId || options[0]?.id));
  const [limit, setLimit] = useState('');
  const [terms, setTerms] = useState('');
  const open = useMutation({
    mutationFn: () =>
      api.call('createArAccount', {
        body: {
          companyId: chosen?.id ?? '',
          creditLimitMinor:
            toMinor(limit) ?? (chosen?.creditLimitMinor ? chosen.creditLimitMinor : '0'),
          termsDays: Number(terms || chosen?.paymentTermsDays || 30),
        },
      }),
    onSuccess: () => {
      onDone();
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  return (
    <form
      aria-label={t('ar.newAccount')}
      className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        open.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="ar-new-company">{t('ar.company')}</Label>
        <select
          id="ar-new-company"
          className={selectClass}
          value={chosen?.id ?? ''}
          onChange={(e) => setCompanyId(e.target.value)}
        >
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <Field
        id="ar-new-limit"
        label={t('ar.creditLimit')}
        inputMode="decimal"
        placeholder={chosen?.creditLimitMinor ? String(Number(chosen.creditLimitMinor) / 100) : '0'}
        value={limit}
        onChange={(e) => setLimit(e.target.value)}
      />
      <Field
        id="ar-new-terms"
        label={t('ar.terms')}
        type="number"
        min={0}
        placeholder={String(chosen?.paymentTermsDays ?? 30)}
        value={terms}
        onChange={(e) => setTerms(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={open.isPending || !chosen}>
        {t('ar.openAccount')}
      </Button>
      {open.error && <Alert tone="critical">{errorMessage(open.error)}</Alert>}
    </form>
  );
}

function Accounts() {
  const { t } = useTranslation();
  const { money } = useHotel();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: [...KEY, 'list'], queryFn: () => api.call('listArAccounts') });
  return (
    <section aria-label={t('ar.tabs.accounts')}>
      <Button size="sm" onClick={() => setAdding((x) => !x)}>
        {adding ? t('ar.cancel') : t('ar.newAccount')}
      </Button>
      {adding && (
        <div className="mt-3">
          <NewAccount onDone={() => setAdding(false)} />
        </div>
      )}
      {q.error && <Alert tone="critical">{errorMessage(q.error)}</Alert>}
      {q.data?.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('ar.noAccounts')}</p>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {q.data?.data.map((a: Account) => (
          <li key={a.id} className="rounded-md border border-border bg-surface p-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{a.company.name}</span>
              <span>{t('ar.owes', { amount: money(a.balanceMinor) })}</span>
              {a.overdueMinor !== '0' && (
                <span className="font-medium text-critical">
                  {t('ar.overdue', { amount: money(a.overdueMinor) })}
                </span>
              )}
              <span className="text-text-muted">
                {t('ar.limitLine', { limit: money(a.creditLimitMinor), days: a.termsDays })}
              </span>
              {a.status !== 'ACTIVE' && (
                <span className="text-text-muted">{t(`ar.statuses.${a.status}`)}</span>
              )}
              <Button
                size="sm"
                variant="secondary"
                className="ml-auto"
                aria-expanded={open === a.id}
                onClick={() => setOpen((x) => (x === a.id ? null : a.id))}
              >
                {t('ar.openButton')}
              </Button>
            </div>
            {open === a.id && <AccountView accountId={a.id} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Ageing() {
  const { t } = useTranslation();
  const { money, today } = useHotel();
  const [asOf, setAsOf] = useState(today);
  const q = useQuery({
    queryKey: [...KEY, 'ageing', asOf],
    queryFn: () => api.call('getArAgeing', { query: { asOf } }),
  });
  return (
    <section aria-label={t('ar.tabs.ageing')} className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <Field
          id="ar-age-asof"
          label={t('ar.asOf')}
          type="date"
          value={asOf}
          max={addDays(today, 365)}
          onChange={(e) => setAsOf(e.target.value)}
        />
      </div>
      {q.error && <Alert tone="critical">{errorMessage(q.error)}</Alert>}
      {q.data && (
        <div className="overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr>
                <th className="pr-3 text-left">{t('ar.company')}</th>
                {AGEING_BUCKETS.map((b) => (
                  <th key={b} className="px-2 text-right">
                    {t(`ar.buckets.${b}`)}
                  </th>
                ))}
                <th className="pl-2 text-right">{t('ar.total')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.accounts.map((a) => (
                <tr key={a.accountId}>
                  <td className="pr-3">{a.company}</td>
                  {AGEING_BUCKETS.map((b) => (
                    <td key={b} className="px-2 text-right">
                      {money(a.buckets[b])}
                    </td>
                  ))}
                  <td className="pl-2 text-right font-medium">{money(a.totalMinor)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="pr-3">{t('ar.total')}</td>
                {AGEING_BUCKETS.map((b) => (
                  <td key={b} className="px-2 text-right">
                    {money(q.data.totals[b])}
                  </td>
                ))}
                <td className="pl-2 text-right">{money(q.data.totals.totalMinor)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const TABS = ['accounts', 'ageing'] as const;

export function CityLedgerPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<(typeof TABS)[number]>('accounts');
  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('ar.title')}</h1>
      <div role="tablist" className="mt-3 flex gap-2">
        {TABS.map((x) => (
          <Button
            key={x}
            role="tab"
            aria-selected={tab === x}
            size="sm"
            variant={tab === x ? 'primary' : 'secondary'}
            onClick={() => setTab(x)}
          >
            {t(`ar.tabs.${x}`)}
          </Button>
        ))}
      </div>
      <div className="mt-4">
        {tab === 'accounts' && <Accounts />}
        {tab === 'ageing' && <Ageing />}
      </div>
    </section>
  );
}
