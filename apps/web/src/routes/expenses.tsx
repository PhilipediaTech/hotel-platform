import type { ExpenseItem } from '@hotel/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { uploadFile } from '../lib/files.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';
import expenseStrings from '../i18n/en/expenses.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(expenseStrings);

// S43 Expenses (PRD M10-06; T-147): record expenses with category, cost centre, supplier or
// payee, receipt photo and approval above the recorder's limit; petty cash floats with their
// balances and top-ups; void with a reason. Accounting exports join this screen with T-148.

type Expense = z.output<typeof ExpenseItem>;
type Method = Expense['paidFrom'];

const METHODS: Method[] = ['PETTY_CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE'];
const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const card = 'rounded-md border border-border bg-surface p-4';
const isPending = (r: unknown) => typeof r === 'object' && r !== null && 'approvalRequestId' in r;

function useRoot() {
  const { currentPropertyId } = useSession();
  return ['expenses', currentPropertyId ?? ''];
}

function useChange<T, R = unknown>(fn: (v: T) => Promise<R>) {
  const root = useRoot();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: root }),
  });
}

function useSetup() {
  const root = useRoot();
  return useQuery({
    queryKey: [...root, 'setup'],
    queryFn: () => api.call('getExpenseSetup', {}),
  });
}

function Failure({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert tone="critical" className="mt-2">
      {errorMessage(error)}
    </Alert>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

export function ExpensesPage() {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('expenses.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('expenses.intro')}</p>
      {sent && (
        <Alert tone="info" className="mt-3">
          {t('expenses.sentForApproval')}
        </Alert>
      )}
      {recording ? (
        <ExpenseForm
          onDone={(pending) => {
            setRecording(false);
            setSent(pending);
          }}
        />
      ) : (
        <Button
          className="mt-3 h-11"
          onClick={() => {
            setRecording(true);
            setSent(false);
          }}
        >
          {t('expenses.new')}
        </Button>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <ExpenseList />
        <div className="flex flex-col gap-4">
          <Floats />
          <Categories />
        </div>
      </div>
    </section>
  );
}

function ExpenseForm({ onDone }: { onDone: (pending: boolean) => void }) {
  const { t } = useTranslation();
  const setup = useSetup();
  const data = setup.data;
  const [spentOn, setSpentOn] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [payee, setPayee] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidFrom, setPaidFrom] = useState<Method>('PETTY_CASH');
  const [floatId, setFloatId] = useState('');
  const [reference, setReference] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [reason, setReason] = useState('');
  const save = useChange(async () => {
    const receiptFileId = receipt ? await uploadFile('Expense', receipt) : null;
    return api.call('recordExpense', {
      body: {
        spentOn: spentOn || (data?.businessDate ?? ''),
        categoryId,
        departmentId,
        supplierId: supplierId || null,
        payee: supplierId ? null : payee,
        description,
        amountMinor: toMinor(amount) ?? amount,
        paidFrom,
        floatId: paidFrom === 'PETTY_CASH' ? floatId || null : null,
        reference,
        receiptFileId,
        reason,
      },
    });
  });
  const select = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    options: { id: string; name: string }[],
    empty = t('expenses.choose'),
  ) => (
    <Field id={id} label={label}>
      <select id={id} className={selectClass} value={value} onChange={(e) => set(e.target.value)}>
        <option value="">{empty}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <form
      aria-label={t('expenses.form')}
      className={cn(card, 'mt-3 flex flex-col gap-2')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: (r) => onDone(isPending(r)) });
      }}
    >
      <div className="grid gap-2 md:grid-cols-3">
        <Field id="exp-date" label={t('expenses.spentOn')}>
          <Input
            id="exp-date"
            type="date"
            value={spentOn || (data?.businessDate ?? '')}
            max={data?.businessDate}
            onChange={(e) => setSpentOn(e.target.value)}
          />
        </Field>
        {select(
          'exp-category',
          t('expenses.category'),
          categoryId,
          setCategoryId,
          data?.categories.filter((c) => c.active) ?? [],
        )}
        {select(
          'exp-dept',
          t('expenses.costCentre'),
          departmentId,
          setDepartmentId,
          data?.departments ?? [],
        )}
        {select(
          'exp-supplier',
          t('expenses.supplier'),
          supplierId,
          setSupplierId,
          data?.suppliers.filter((s) => s.active) ?? [],
          t('expenses.noSupplier'),
        )}
        {!supplierId && (
          <Field id="exp-payee" label={t('expenses.payee')}>
            <Input id="exp-payee" value={payee} onChange={(e) => setPayee(e.target.value)} />
          </Field>
        )}
        <Field id="exp-desc" label={t('expenses.description')}>
          <Input
            id="exp-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field id="exp-amount" label={t('expenses.amount')}>
          <Input
            id="exp-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field id="exp-method" label={t('expenses.paidFrom')}>
          <select
            id="exp-method"
            className={selectClass}
            value={paidFrom}
            onChange={(e) => setPaidFrom(e.target.value as Method)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`expenses.methods.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        {paidFrom === 'PETTY_CASH' &&
          select(
            'exp-float',
            t('expenses.float'),
            floatId,
            setFloatId,
            data?.floats.filter((f) => f.active) ?? [],
          )}
        <Field id="exp-ref" label={t('expenses.reference')}>
          <Input id="exp-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field id="exp-receipt" label={t('expenses.receipt')}>
          <Input
            id="exp-receipt"
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field id="exp-reason" label={t('expenses.reason')}>
          <Input id="exp-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <Failure error={save.error} />
      <div className="flex gap-2">
        <Button
          type="submit"
          className="h-11"
          disabled={save.isPending || !categoryId || !departmentId}
        >
          {t('expenses.save')}
        </Button>
        <Button variant="ghost" className="h-11" onClick={() => onDone(false)}>
          {t('expenses.cancel')}
        </Button>
      </div>
    </form>
  );
}

function ExpenseList() {
  const { t } = useTranslation();
  const f = useFormats();
  const root = useRoot();
  const setup = useSetup();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const filters = {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(categoryId ? { categoryId } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: [...root, 'list', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.call('listExpenses', {
        query: { limit: 50, ...filters, ...(pageParam ? { cursor: pageParam } : {}) },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const total = list.data?.pages[0]?.totalMinor;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field id="filter-from" label={t('expenses.from')}>
          <Input
            id="filter-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field id="filter-to" label={t('expenses.to')}>
          <Input id="filter-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field id="filter-category" label={t('expenses.category')}>
          <select
            id="filter-category"
            className={selectClass}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">{t('expenses.allCategories')}</option>
            {setup.data?.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {total !== undefined && (
        <p className="font-medium">{t('expenses.total', { amount: f.money(total) })}</p>
      )}
      <Failure error={list.error} />
      {list.data && rows.length === 0 && (
        <p className="text-sm text-text-muted">{t('expenses.none')}</p>
      )}
      <ul aria-label={t('expenses.title')} className="flex flex-col gap-2">
        {rows.map((e) => (
          <ExpenseRow key={e.id} expense={e} />
        ))}
      </ul>
      {list.hasNextPage && (
        <Button
          variant="secondary"
          className="h-11 self-start"
          onClick={() => void list.fetchNextPage()}
        >
          {t('expenses.more')}
        </Button>
      )}
    </div>
  );
}

function ExpenseRow({ expense: e }: { expense: Expense }) {
  const { t } = useTranslation();
  const f = useFormats();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const voidIt = useChange(() =>
    api.call('voidExpense', { params: { expenseId: e.id }, body: { reason } }),
  );
  return (
    <li className={cn(card, e.voided && 'opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className={cn('font-medium', e.voided && 'line-through')}>{e.description}</p>
          <p className="text-sm text-text-muted">
            {t('expenses.line', {
              number: e.number,
              date: f.date(e.spentOn),
              category: e.category.name,
              costCentre: e.department.name,
            })}
          </p>
          <p className="text-sm text-text-muted">
            {[
              t('expenses.paidTo', { name: e.supplier?.name ?? e.payee ?? '' }),
              e.float
                ? `${t('expenses.methods.PETTY_CASH')} (${e.float.name})`
                : t(`expenses.methods.${e.paidFrom}`),
              e.reference,
              t('expenses.recordedBy', { name: e.recordedBy.name }),
              e.approvedBy && t('expenses.approvedBy', { name: e.approvedBy.name }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {e.voided && (
            <p className="text-sm text-critical">
              {t('expenses.voided', { name: e.voided.by.name, reason: e.voided.reason })}
            </p>
          )}
        </div>
        <p className={cn('font-semibold', e.voided && 'line-through')}>{f.money(e.amountMinor)}</p>
      </div>
      {!e.voided &&
        (voiding ? (
          <form
            aria-label={t('expenses.voidTitle', { number: e.number })}
            className="mt-2 flex flex-wrap items-end gap-2"
            onSubmit={(ev) => {
              ev.preventDefault();
              voidIt.mutate(undefined, { onSuccess: () => setVoiding(false) });
            }}
          >
            <Field id={`void-${e.id}`} label={t('expenses.voidReason')}>
              <Input
                id={`void-${e.id}`}
                value={reason}
                onChange={(ev) => setReason(ev.target.value)}
              />
            </Field>
            <Button type="submit" className="h-11" disabled={voidIt.isPending || !reason.trim()}>
              {t('expenses.confirmVoid')}
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => setVoiding(false)}>
              {t('expenses.cancel')}
            </Button>
            <Failure error={voidIt.error} />
          </form>
        ) : (
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setVoiding(true)}>
            {t('expenses.void')}
          </Button>
        ))}
    </li>
  );
}

function Floats() {
  const { t } = useTranslation();
  const f = useFormats();
  const setup = useSetup();
  const [name, setName] = useState('');
  const [custodianId, setCustodianId] = useState('');
  const [topping, setTopping] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const add = useChange(() =>
    api.call('createPettyCashFloat', { body: { name, custodianId: custodianId || null } }),
  );
  const topUp = useChange((floatId: string) =>
    api.call('topUpPettyCash', {
      params: { floatId },
      body: { amountMinor: toMinor(amount) ?? amount },
    }),
  );
  const toggle = useChange((fl: { id: string; active: boolean }) =>
    api.call('updatePettyCashFloat', { params: { floatId: fl.id }, body: { active: !fl.active } }),
  );
  const data = setup.data;
  return (
    <div className={card}>
      <h2 className="font-semibold">{t('expenses.floats.title')}</h2>
      {data && data.floats.length === 0 && (
        <p className="text-sm text-text-muted">{t('expenses.floats.none')}</p>
      )}
      <ul aria-label={t('expenses.floats.title')} className="mt-2 flex flex-col gap-2">
        {data?.floats.map((fl) => (
          <li key={fl.id} className="text-sm">
            <p className={cn('font-medium', !fl.active && 'text-text-muted line-through')}>
              {t('expenses.floats.balance', { name: fl.name, amount: f.money(fl.balanceMinor) })}
            </p>
            <p className="text-text-muted">
              {fl.custodian
                ? t('expenses.floats.heldBy', { name: fl.custodian.name })
                : t('expenses.floats.nobody')}
            </p>
            <div className="mt-1 flex gap-2">
              {fl.active && (
                <Button variant="secondary" size="sm" onClick={() => setTopping(fl.id)}>
                  {t('expenses.floats.topUp')}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => toggle.mutate(fl)}>
                {fl.active ? t('expenses.floats.switchOff') : t('expenses.floats.switchOn')}
              </Button>
            </div>
            {topping === fl.id && (
              <form
                aria-label={t('expenses.floats.topUpTitle', { name: fl.name })}
                className="mt-2 flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  topUp.mutate(fl.id, {
                    onSuccess: () => {
                      setTopping(null);
                      setAmount('');
                    },
                  });
                }}
              >
                <Field id={`topup-${fl.id}`} label={t('expenses.floats.topUpAmount')}>
                  <Input
                    id={`topup-${fl.id}`}
                    className="w-32"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </Field>
                <Button type="submit" className="h-11" disabled={topUp.isPending}>
                  {t('expenses.floats.confirmTopUp')}
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <Failure error={topUp.error ?? toggle.error} />
      <form
        aria-label={t('expenses.floats.add')}
        className="mt-3 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(undefined, {
            onSuccess: () => {
              setName('');
              setCustodianId('');
            },
          });
        }}
      >
        <Field id="float-name" label={t('expenses.floats.name')}>
          <Input id="float-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="float-custodian" label={t('expenses.floats.custodian')}>
          <select
            id="float-custodian"
            className={selectClass}
            value={custodianId}
            onChange={(e) => setCustodianId(e.target.value)}
          >
            <option value="">{t('expenses.floats.nobody')}</option>
            {data?.custodians.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" className="h-11 self-start" disabled={add.isPending || !name.trim()}>
          {t('expenses.floats.add')}
        </Button>
        <Failure error={add.error} />
      </form>
    </div>
  );
}

function Categories() {
  const { t } = useTranslation();
  const setup = useSetup();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const add = useChange(() => api.call('createExpenseCategory', { body: { code, name } }));
  const toggle = useChange((c: { id: string; active: boolean }) =>
    api.call('updateExpenseCategory', {
      params: { categoryId: c.id },
      body: { active: !c.active },
    }),
  );
  return (
    <div className={card}>
      <h2 className="font-semibold">{t('expenses.categories.title')}</h2>
      <ul aria-label={t('expenses.categories.title')} className="mt-2 flex flex-col gap-1">
        {setup.data?.categories.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
            <span className={cn(!c.active && 'text-text-muted line-through')}>
              {c.name} ({c.code})
            </span>
            <Button variant="ghost" size="sm" onClick={() => toggle.mutate(c)}>
              {c.active ? t('expenses.categories.switchOff') : t('expenses.categories.switchOn')}
            </Button>
          </li>
        ))}
      </ul>
      <form
        aria-label={t('expenses.categories.add')}
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(undefined, {
            onSuccess: () => {
              setCode('');
              setName('');
            },
          });
        }}
      >
        <Field id="cat-code" label={t('expenses.categories.code')}>
          <Input
            id="cat-code"
            className="w-24"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field id="cat-name" label={t('expenses.categories.name')}>
          <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" className="h-11" disabled={add.isPending}>
          {t('expenses.categories.add')}
        </Button>
      </form>
      <Failure error={add.error ?? toggle.error} />
    </div>
  );
}
