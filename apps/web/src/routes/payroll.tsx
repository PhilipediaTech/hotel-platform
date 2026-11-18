import {
  localDate,
  monthRange,
  PAY_ITEM_TYPES,
  type PayItem,
  type PayItemType,
  type TimesheetItem,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';
import payrollStrings from '../i18n/en/payroll.json';
import staffStrings from '../i18n/en/staff.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(payrollStrings);
registerStrings(staffStrings);

// S36 timesheets and payroll (PRD M7-06, M7-07, M7-08; T-139): a month's timesheets to add up
// and approve with the overtime accepted, advances and deductions recorded by one person and
// approved by another, and the payroll file with approved figures only. No pay is computed.

type Sheet = z.output<typeof TimesheetItem>;
type Item = z.output<typeof PayItem>;
type StaffRef = { id: string; number: number; name: string };

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const hours = (minutes: number) => (minutes / 60).toFixed(1);

function useRoot() {
  const { currentPropertyId } = useSession();
  return ['payroll', currentPropertyId ?? ''];
}

export function PayrollPage() {
  const { t } = useTranslation();
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const [month, setMonth] = useState(() =>
    localDate(new Date(), property?.timeZone ?? 'UTC').slice(0, 7),
  );
  const can = (p: string) => session.permissions.includes(p);
  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">{t('pr.title')}</h1>
      <div className="mt-3 flex flex-col gap-1">
        <Label htmlFor="pr-month">{t('pr.month')}</Label>
        <Input
          id="pr-month"
          type="month"
          className="max-w-48"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
        />
      </div>
      <p className="mt-2 text-sm text-text-muted">{t('pr.noPayRule')}</p>
      {can('timesheet.approve') && <Timesheets month={month} />}
      {can('staff.payitem') && <PayItems month={month} />}
      {can('payroll.export') && <Export month={month} />}
    </section>
  );
}

// ── Timesheets ─────────────────────────────────────────────────────────────────────────

function Timesheets({ month }: { month: string }) {
  const { t } = useTranslation();
  const root = useRoot();
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: [...root, 'timesheets', month],
    queryFn: () => api.call('listTimesheets', { query: { month } }),
  });
  const data = list.data;
  return (
    <section aria-labelledby="pr-ts" className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pr-ts" className="font-semibold">
          {t('pr.ts.title')}
        </h2>
        {!adding && <Button onClick={() => setAdding(true)}>{t('pr.ts.add')}</Button>}
      </div>
      {adding && data && (
        <TimesheetForm month={month} staff={data.staff} onDone={() => setAdding(false)} />
      )}
      {list.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(list.error)}
        </Alert>
      )}
      {data && data.data.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">{t('pr.ts.none')}</p>
      )}
      <ul aria-label={t('pr.ts.list')} className="mt-2 flex flex-col gap-2">
        {data?.data.map((s) => (
          <TimesheetLine key={s.id} sheet={s} after={data.overtimeAfterMinutes} />
        ))}
      </ul>
    </section>
  );
}

function TimesheetLine({ sheet, after }: { sheet: Sheet; after: number }) {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const f = useFormats();
  const [accept, setAccept] = useState(String(sheet.overtimeMinutes));
  const [note, setNote] = useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: root });
  const params = { timesheetId: sheet.id };
  const approve = useMutation({
    mutationFn: () =>
      api.call('approveTimesheet', {
        params,
        body: { approvedOvertimeMinutes: Number(accept), note },
      }),
    onSuccess: refresh,
  });
  const recalc = useMutation({
    mutationFn: () => api.call('recalculateTimesheet', { params }),
    onSuccess: (s) => {
      setAccept(String(s.overtimeMinutes));
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.call('deleteTimesheet', { params }),
    onSuccess: refresh,
  });
  const error = approve.error ?? recalc.error ?? remove.error;
  const busy = approve.isPending || recalc.isPending || remove.isPending;
  return (
    <li className="rounded-md border border-border bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium">
          ST-{sheet.staff.number} {sheet.staff.name} · {f.date(sheet.from)} – {f.date(sheet.to)}
        </p>
        <span
          className={cn(
            'rounded px-2 py-0.5 text-xs font-medium',
            sheet.status === 'APPROVED' ? 'bg-success-subtle text-success' : 'bg-surface-muted',
          )}
        >
          {t(`pr.ts.statuses.${sheet.status}`)}
        </span>
      </div>
      <p className="mt-1 text-text-muted">
        {t('pr.ts.summary', {
          days: sheet.daysWorked,
          worked: t('pr.hours', { value: hours(sheet.workedMinutes) }),
          overtime: t('pr.hours', { value: hours(sheet.overtimeMinutes) }),
          after: t('pr.hours', { value: hours(after) }),
        })}
      </p>
      {sheet.openClocks > 0 && (
        <p className="mt-1 text-warning">{t('pr.ts.open', { count: sheet.openClocks })}</p>
      )}
      {sheet.status === 'APPROVED' && (
        <p className="mt-1">
          {t('pr.ts.approvedOvertime', {
            value: t('pr.hours', { value: hours(sheet.approvedOvertimeMinutes ?? 0) }),
          })}
          {sheet.approvedBy && ` · ${t('pr.ts.approvedBy', { name: sheet.approvedBy.name })}`}
          {sheet.note && ` · ${sheet.note}`}
        </p>
      )}
      {sheet.status === 'DRAFT' && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`accept-${sheet.id}`}>{t('pr.ts.accept')}</Label>
            <Input
              id={`accept-${sheet.id}`}
              type="number"
              min={0}
              max={sheet.overtimeMinutes}
              className="w-32"
              value={accept}
              onChange={(e) => setAccept(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`note-${sheet.id}`}>{t('pr.ts.note')}</Label>
            <Input id={`note-${sheet.id}`} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button className="h-11" disabled={busy} onClick={() => approve.mutate()}>
            {t('pr.ts.approve')}
          </Button>
          <Button
            variant="secondary"
            className="h-11"
            disabled={busy}
            onClick={() => recalc.mutate()}
          >
            {t('pr.ts.recalculate')}
          </Button>
          <Button variant="ghost" className="h-11" disabled={busy} onClick={() => remove.mutate()}>
            {t('pr.ts.remove')}
          </Button>
        </div>
      )}
      {error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(error)}
        </Alert>
      )}
    </li>
  );
}

function TimesheetForm(props: { month: string; staff: StaffRef[]; onDone: () => void }) {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const range = monthRange(props.month);
  const [staffId, setStaffId] = useState('');
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const save = useMutation({
    mutationFn: () => api.call('createTimesheet', { body: { staffId, from, to } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: root });
      props.onDone();
    },
  });
  return (
    <form
      aria-label={t('pr.ts.form')}
      className="mt-2 flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="ts-staff">{t('pr.staff')}</Label>
        <select
          id="ts-staff"
          className={selectClass}
          required
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
        >
          <option value="">{t('pr.choose')}</option>
          {props.staff.map((s) => (
            <option key={s.id} value={s.id}>
              ST-{s.number} {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="ts-from">{t('pr.ts.from')}</Label>
        <Input id="ts-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="ts-to">{t('pr.ts.to')}</Label>
        <Input id="ts-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <Button type="submit" className="h-11" disabled={save.isPending}>
        {t('pr.ts.create')}
      </Button>
      <Button type="button" variant="ghost" className="h-11" onClick={props.onDone}>
        {t('pr.cancel')}
      </Button>
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
    </form>
  );
}

// ── Advances and deductions ────────────────────────────────────────────────────────────

function PayItems({ month }: { month: string }) {
  const { t } = useTranslation();
  const root = useRoot();
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: [...root, 'items', month],
    queryFn: () => api.call('listPayItems', { query: { month } }),
  });
  const data = list.data;
  return (
    <section aria-labelledby="pr-pi" className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pr-pi" className="font-semibold">
          {t('pr.pi.title')}
        </h2>
        {!adding && <Button onClick={() => setAdding(true)}>{t('pr.pi.add')}</Button>}
      </div>
      {adding && data && (
        <PayItemForm month={month} staff={data.staff} onDone={() => setAdding(false)} />
      )}
      {list.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(list.error)}
        </Alert>
      )}
      {data && data.data.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">{t('pr.pi.none')}</p>
      )}
      <ul aria-label={t('pr.pi.list')} className="mt-2 flex flex-col gap-2">
        {data?.data.map((item) => (
          <PayItemLine key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function PayItemLine({ item }: { item: Item }) {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const f = useFormats();
  const [note, setNote] = useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: root });
  const params = { payItemId: item.id };
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api.call('decidePayItem', { params, body: { decision, note } }),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: () => api.call('cancelPayItem', { params }),
    onSuccess: refresh,
  });
  const busy = decide.isPending || cancel.isPending;
  return (
    <li className="rounded-md border border-border bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium">
          ST-{item.staff.number} {item.staff.name} · {t(`pr.pi.types.${item.type}`)} ·{' '}
          {f.money(item.amountMinor)}
        </p>
        <span className="rounded bg-surface-muted px-2 py-0.5 text-xs font-medium">
          {t(`pr.pi.statuses.${item.status}`)}
        </span>
      </div>
      <p className="mt-1">{item.description}</p>
      <p className="mt-1 text-text-muted">
        {t('pr.pi.recordedBy', { name: item.requestedBy.name })}
        {item.decidedBy &&
          ` · ${t('pr.pi.decidedBy', {
            status: t(`pr.pi.statuses.${item.status}`),
            name: item.decidedBy.name,
          })}`}
        {item.decisionNote && `: ${item.decisionNote}`}
      </p>
      {item.status === 'PENDING' && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`pi-note-${item.id}`}>{t('pr.pi.note')}</Label>
            <Input
              id={`pi-note-${item.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <Button className="h-11" disabled={busy} onClick={() => decide.mutate('APPROVE')}>
            {t('pr.pi.approve')}
          </Button>
          <Button
            variant="secondary"
            className="h-11"
            disabled={busy}
            onClick={() => decide.mutate('REJECT')}
          >
            {t('pr.pi.reject')}
          </Button>
          <Button variant="ghost" className="h-11" disabled={busy} onClick={() => cancel.mutate()}>
            {t('pr.pi.withdraw')}
          </Button>
        </div>
      )}
      {(decide.error ?? cancel.error) && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(decide.error ?? cancel.error)}
        </Alert>
      )}
    </li>
  );
}

function PayItemForm(props: { month: string; staff: StaffRef[]; onDone: () => void }) {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const [staffId, setStaffId] = useState('');
  const [type, setType] = useState<PayItemType>('ADVANCE');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.call('createPayItem', {
        body: {
          staffId,
          type,
          amountMinor: toMinor(amount) ?? '0',
          month: props.month,
          description,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: root });
      props.onDone();
    },
  });
  return (
    <form
      aria-label={t('pr.pi.form')}
      className="mt-2 grid gap-3 rounded-md border border-border bg-surface p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="pi-staff">{t('pr.staff')}</Label>
        <select
          id="pi-staff"
          className={selectClass}
          required
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
        >
          <option value="">{t('pr.choose')}</option>
          {props.staff.map((s) => (
            <option key={s.id} value={s.id}>
              ST-{s.number} {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pi-type">{t('pr.pi.type')}</Label>
        <select
          id="pi-type"
          className={selectClass}
          value={type}
          onChange={(e) => setType(e.target.value as PayItemType)}
        >
          {PAY_ITEM_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`pr.pi.types.${x}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pi-amount">{t('pr.pi.amount')}</Label>
        <Input
          id="pi-amount"
          inputMode="decimal"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pi-description">{t('pr.pi.description')}</Label>
        <Input
          id="pi-description"
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {save.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={save.isPending}>
          {t('pr.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={props.onDone}>
          {t('pr.cancel')}
        </Button>
      </div>
    </form>
  );
}

// ── Payroll file ───────────────────────────────────────────────────────────────────────

function Export({ month }: { month: string }) {
  const { t } = useTranslation();
  const root = useRoot();
  const f = useFormats();
  const [error, setError] = useState<unknown>(null);
  const preview = useQuery({
    queryKey: [...root, 'export', month],
    queryFn: () => api.call('getPayrollExport', { query: { month, format: 'json' } }),
  });
  const save = async () => {
    setError(null);
    try {
      const blob = await api.download('getPayrollExport', { query: { month, format: 'csv' } });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `payroll-${month}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err);
    }
  };
  const data = preview.data;
  return (
    <section aria-labelledby="pr-ex" className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pr-ex" className="font-semibold">
          {t('pr.ex.title')}
        </h2>
        <Button variant="secondary" onClick={() => void save()}>
          {t('pr.ex.download')}
        </Button>
      </div>
      {(preview.error ?? error) !== null && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(preview.error ?? error)}
        </Alert>
      )}
      {data && (data.waiting.draftTimesheets > 0 || data.waiting.pendingPayItems > 0) && (
        <Alert tone="info" className="mt-2">
          {t('pr.ex.waiting', {
            timesheets: data.waiting.draftTimesheets,
            items: data.waiting.pendingPayItems,
          })}
        </Alert>
      )}
      {data && (
        <div className="mt-2 overflow-x-auto">
          <table aria-label={t('pr.ex.table')} className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="text-left">
                <th className="p-2">{t('pr.ex.number')}</th>
                <th className="p-2">{t('pr.ex.name')}</th>
                <th className="p-2">{t('pr.ex.type')}</th>
                <th className="p-2 text-right">{t('pr.ex.rate')}</th>
                <th className="p-2 text-right">{t('pr.ex.worked')}</th>
                <th className="p-2 text-right">{t('pr.ex.overtime')}</th>
                <th className="p-2 text-right">{t('pr.ex.advances')}</th>
                <th className="p-2 text-right">{t('pr.ex.deductions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.staff.id} className="border-t border-border">
                  <td className="p-2">ST-{r.staff.number}</td>
                  <td className="p-2">{r.staff.name}</td>
                  <td className="p-2">{t(`st.types.${r.employmentType}`)}</td>
                  <td className="p-2 text-right">
                    {r.payRateMinor === null ? '—' : f.money(r.payRateMinor)}
                  </td>
                  <td className="p-2 text-right">{hours(r.workedMinutes)}</td>
                  <td className="p-2 text-right">{hours(r.approvedOvertimeMinutes)}</td>
                  <td className="p-2 text-right">{f.money(r.advancesMinor)}</td>
                  <td className="p-2 text-right">{f.money(r.deductionsMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
