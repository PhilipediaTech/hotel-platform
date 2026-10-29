import type { CurrentShift, ShiftItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { useFormats } from './reservations.tsx';

// S14 Cashier shift (PRD M4-10–M4-12; T-061): open with a float, hand cash to a colleague or
// the safe, close with a blind count (the expected amounts appear only after counting), give a
// reason for a variance above tolerance; supervisors sign off. Payments arrive with T-062.

type Current = z.output<typeof CurrentShift>;
type Shift = z.output<typeof ShiftItem>;

const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';
/** Methods offered on the count; cash is always counted. */
const COUNTED = ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER'] as const;

/** "1,500.50" → "150050"; "0" → "0"; null when it is not an amount. */
export function amountMinor(text: string): string | null {
  const clean = text.replace(/[,\s₦]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole = '0', fraction = ''] = clean.split('.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))).toString();
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['shifts'] });
}

export function ShiftPage() {
  const { t } = useTranslation();
  const { currentPropertyId, permissions } = useSession();
  const can = (p: string) => permissions.includes(p);
  const current = useQuery({
    queryKey: ['shifts', currentPropertyId ?? '', 'current'],
    queryFn: () => api.call('getCurrentShift', {}),
    enabled: can('shift.open'),
  });
  const [closed, setClosed] = useState<Shift | null>(null);
  const data = current.data;
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('shift.title')}</h1>
      {current.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(current.error)}
        </Alert>
      )}
      {closed && <CloseResult shift={closed} />}
      {data && (
        <>
          {data.incoming.length > 0 && <Incoming current={data} />}
          {data.shift ? (
            <OpenShiftView current={data} onClosed={setClosed} />
          ) : (
            can('shift.open') && <OpenForm />
          )}
          {data.awaitingSignOff
            .filter((s) => s.id !== closed?.id)
            .map((s) => (
              <CloseResult key={s.id} shift={s} />
            ))}
        </>
      )}
      {can('shift.signoff') && <Supervisor />}
    </section>
  );
}

// ── Opening ──────────────────────────────────────────────────────────────────────────

function OpenForm() {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const [float, setFloat] = useState('');
  const minor = amountMinor(float);
  const open = useMutation({
    mutationFn: () => api.call('openShift', { body: { floatMinor: minor ?? '0' } }),
    onSuccess: refresh,
  });
  return (
    <form
      aria-label={t('shift.open')}
      className="mt-4 flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (minor !== null) open.mutate();
      }}
    >
      <p className="w-full text-sm text-text-muted">{t('shift.noShift')}</p>
      <Field id="sh-float" label={t('shift.float')}>
        <Input
          id="sh-float"
          inputMode="decimal"
          placeholder="20,000.00"
          value={float}
          onChange={(e) => setFloat(e.target.value)}
        />
      </Field>
      <Button type="submit" disabled={minor === null || open.isPending}>
        {t('shift.open')}
      </Button>
      {open.error && (
        <Alert tone="critical" className="w-full">
          {errorMessage(open.error)}
        </Alert>
      )}
    </form>
  );
}

// ── The open shift (blind) ─────────────────────────────────────────────────────────────

function OpenShiftView({
  current,
  onClosed,
}: {
  current: Current;
  onClosed: (shift: Shift) => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const { permissions } = useSession();
  const shift = current.shift;
  if (!shift) return null;
  const payments = shift.paymentCounts.reduce((n, p) => n + p.count, 0);
  return (
    <div className="mt-4 flex flex-col gap-4">
      <dl className="grid gap-3 rounded-md border border-border bg-surface p-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-text-muted">{t('shift.openedAt')}</dt>
          <dd>{f.when(shift.openedAt)}</dd>
        </div>
        <div>
          <dt className="text-text-muted">{t('shift.float')}</dt>
          <dd>{f.money(shift.floatMinor)}</dd>
        </div>
        <div>
          <dt className="text-text-muted">{t('shift.payments')}</dt>
          <dd>
            {payments === 0
              ? t('shift.noPayments')
              : shift.paymentCounts
                  .map((p) =>
                    t('shift.paymentCount', {
                      method: t(`shift.methods.${p.method}`),
                      count: p.count,
                    }),
                  )
                  .join(' · ')}
          </dd>
        </div>
      </dl>

      {(shift.handoversOut.length > 0 || shift.handoversIn.length > 0) && (
        <table aria-label={t('shift.handovers')} className="w-full text-left text-sm">
          <thead className="text-text-muted">
            <tr>
              <th className="py-2 pr-3 font-medium">{t('shift.cols.when')}</th>
              <th className="py-2 pr-3 font-medium">{t('shift.cols.handover')}</th>
              <th className="py-2 text-right font-medium">{t('shift.cols.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {shift.handoversOut.map((h) => (
              <tr key={h.id} className="border-t border-border">
                <td className="py-2 pr-3">{f.time(h.at)}</td>
                <td className="py-2 pr-3">
                  {h.to ? t('shift.toColleague', { name: h.to }) : t('shift.toSafe')}
                  {h.to && !h.confirmedAt && (
                    <span className="ml-2 text-text-muted">{t('shift.unconfirmed')}</span>
                  )}
                </td>
                <td className="py-2 text-right">−{f.money(h.amountMinor)}</td>
              </tr>
            ))}
            {shift.handoversIn.map((h) => (
              <tr key={h.id} className="border-t border-border">
                <td className="py-2 pr-3">{f.time(h.confirmedAt ?? h.at)}</td>
                <td className="py-2 pr-3">{t('shift.fromColleague', { name: h.from })}</td>
                <td className="py-2 text-right">{f.money(h.amountMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {permissions.includes('shift.handover') && <HandoverForm current={current} />}
      {permissions.includes('shift.close') && <CloseForm shiftId={shift.id} onClosed={onClosed} />}
    </div>
  );
}

function HandoverForm({ current }: { current: Current }) {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const [to, setTo] = useState('SAFE');
  const [amount, setAmount] = useState('');
  const minor = amountMinor(amount);
  const ready = minor !== null && minor !== '0';
  const send = useMutation({
    mutationFn: () =>
      api.call('createHandover', {
        body: { toUserId: to === 'SAFE' ? null : to, amountMinor: minor ?? '0' },
      }),
    onSuccess: () => {
      setAmount('');
      refresh();
    },
  });
  return (
    <form
      aria-label={t('shift.handOver')}
      className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) send.mutate();
      }}
    >
      <h2 className="w-full font-semibold">{t('shift.handOver')}</h2>
      <Field id="sh-to" label={t('shift.to')}>
        <select
          id="sh-to"
          className={selectClass}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        >
          <option value="SAFE">{t('shift.safe')}</option>
          {current.colleagues.map((c) => (
            <option key={c.userId} value={c.userId}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="sh-amount" label={t('shift.amount')}>
        <Input
          id="sh-amount"
          inputMode="decimal"
          placeholder="10,000.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="secondary" disabled={!ready || send.isPending}>
        {t('shift.handOverButton')}
      </Button>
      {send.error && (
        <Alert tone="critical" className="w-full">
          {errorMessage(send.error)}
        </Alert>
      )}
    </form>
  );
}

function Incoming({ current }: { current: Current }) {
  const { t } = useTranslation();
  const f = useFormats();
  const refresh = useRefresh();
  const confirm = useMutation({
    mutationFn: (handoverId: string) => api.call('confirmHandover', { params: { handoverId } }),
    onSuccess: refresh,
  });
  return (
    <section
      aria-label={t('shift.incoming')}
      className="mt-4 rounded-md border border-border bg-surface p-4"
    >
      <h2 className="font-semibold">{t('shift.incoming')}</h2>
      <ul className="mt-2 flex flex-col gap-2 text-sm">
        {current.incoming.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center gap-3">
            <span>
              {t('shift.incomingLine', {
                name: h.from,
                amount: f.money(h.amountMinor),
                time: f.time(h.at),
              })}
            </span>
            {current.shift && (
              <Button size="sm" onClick={() => confirm.mutate(h.id)} disabled={confirm.isPending}>
                {t('shift.confirmReceived')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {!current.shift && <p className="mt-2 text-sm text-text-muted">{t('shift.openToReceive')}</p>}
      {confirm.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(confirm.error)}
        </Alert>
      )}
    </section>
  );
}

// ── Blind close (M4-11) ─────────────────────────────────────────────────────────────────

function CloseForm({ shiftId, onClosed }: { shiftId: string; onClosed: (shift: Shift) => void }) {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const { properties, currentPropertyId } = useSession();
  const currency = properties.find((p) => p.id === currentPropertyId)?.baseCurrency ?? 'NGN';
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const parsed = COUNTED.map((method) => ({ method, text: counts[method] ?? '' }))
    .filter((c) => c.method === 'CASH' || c.text.trim() !== '')
    .map((c) => ({ method: c.method, minor: amountMinor(c.text) }));
  const ready = parsed.every((c) => c.minor !== null);
  const close = useMutation({
    mutationFn: () =>
      api.call('closeShift', {
        params: { shiftId },
        body: {
          counts: parsed.map((c) => ({ method: c.method, currency, countedMinor: c.minor ?? '0' })),
          varianceNote: null,
        },
      }),
    onSuccess: (shift) => {
      onClosed(shift);
      refresh();
    },
  });
  return (
    <form
      aria-label={t('shift.close')}
      className="grid items-end gap-3 rounded-md border border-border bg-surface p-4 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        if (confirming) close.mutate();
        else setConfirming(true);
      }}
    >
      <h2 className="font-semibold sm:col-span-3">{t('shift.close')}</h2>
      <p className="text-sm text-text-muted sm:col-span-3">{t('shift.blindHint')}</p>
      {COUNTED.map((method) => (
        <Field key={method} id={`sh-count-${method}`} label={t(`shift.methods.${method}`)}>
          <Input
            id={`sh-count-${method}`}
            inputMode="decimal"
            placeholder={method === 'CASH' ? '0.00' : t('shift.notTaken')}
            value={counts[method] ?? ''}
            onChange={(e) => {
              setConfirming(false);
              setCounts({ ...counts, [method]: e.target.value });
            }}
          />
        </Field>
      ))}
      <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
        <Button
          type="submit"
          variant={confirming ? 'primary' : 'secondary'}
          disabled={!ready || close.isPending}
        >
          {confirming ? t('shift.confirmClose') : t('shift.closeButton')}
        </Button>
        {confirming && <span className="text-sm text-text-muted">{t('shift.finalCount')}</span>}
      </div>
      {close.error && (
        <Alert tone="critical" className="sm:col-span-3">
          {errorMessage(close.error)}
        </Alert>
      )}
    </form>
  );
}

function CountLines({ shift }: { shift: Shift }) {
  const { t } = useTranslation();
  const f = useFormats();
  return (
    <table
      aria-label={t('shift.countOf', { name: shift.cashier })}
      className="mt-2 w-full text-left text-sm"
    >
      <thead className="text-text-muted">
        <tr>
          <th className="py-2 pr-3 font-medium">{t('shift.cols.method')}</th>
          <th className="py-2 pr-3 text-right font-medium">{t('shift.cols.expected')}</th>
          <th className="py-2 pr-3 text-right font-medium">{t('shift.cols.counted')}</th>
          <th className="py-2 text-right font-medium">{t('shift.cols.variance')}</th>
        </tr>
      </thead>
      <tbody>
        {shift.lines.map((l) => (
          <tr key={`${l.method} ${l.currency}`} className="border-t border-border">
            <td className="py-2 pr-3">{t(`shift.methods.${l.method}`)}</td>
            <td className="py-2 pr-3 text-right">{f.money(l.expectedMinor)}</td>
            <td className="py-2 pr-3 text-right">
              {l.countedMinor === null ? '—' : f.money(l.countedMinor)}
            </td>
            <td className="py-2 text-right">
              {l.varianceMinor === null ? '—' : f.money(l.varianceMinor)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The count revealed after closing; above tolerance, the reason and the wait for sign-off. */
function CloseResult({ shift }: { shift: Shift }) {
  const { t } = useTranslation();
  const f = useFormats();
  return (
    <section
      aria-label={t('shift.result')}
      className="mt-4 rounded-md border border-border bg-surface p-4"
    >
      <h2 className="font-semibold">{t('shift.result')}</h2>
      <CountLines shift={shift} />
      {shift.status === 'CLOSED' ? (
        <Alert tone="success" className="mt-3">
          {t('shift.closedOk')}
        </Alert>
      ) : (
        <>
          <Alert tone="info" className="mt-3">
            {t('shift.aboveTolerance', { tolerance: f.money(shift.toleranceMinor) })}
          </Alert>
          {shift.varianceNote ? (
            <p className="mt-2 text-sm">{t('shift.reasonGiven', { note: shift.varianceNote })}</p>
          ) : (
            <ReasonForm shiftId={shift.id} />
          )}
        </>
      )}
    </section>
  );
}

function ReasonForm({ shiftId }: { shiftId: string }) {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.call('addVarianceNote', { params: { shiftId }, body: { note: note.trim() } }),
    onSuccess: refresh,
  });
  return (
    <form
      aria-label={t('shift.reason')}
      className="mt-3 flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim()) save.mutate();
      }}
    >
      <Field id={`sh-reason-${shiftId}`} label={t('shift.reason')}>
        <Input
          id={`sh-reason-${shiftId}`}
          className="w-80"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <Button type="submit" disabled={!note.trim() || save.isPending}>
        {t('shift.saveReason')}
      </Button>
      {save.error && (
        <Alert tone="critical" className="w-full">
          {errorMessage(save.error)}
        </Alert>
      )}
    </form>
  );
}

// ── Supervisors ───────────────────────────────────────────────────────────────────────

function Supervisor() {
  const { t } = useTranslation();
  const f = useFormats();
  const { currentPropertyId } = useSession();
  const refresh = useRefresh();
  const [status, setStatus] = useState<'CLOSING' | 'OPEN' | 'CLOSED'>('CLOSING');
  const list = useQuery({
    queryKey: ['shifts', currentPropertyId ?? '', 'list', status],
    queryFn: () => api.call('listShifts', { query: { status } }),
  });
  const signOff = useMutation({
    mutationFn: (shiftId: string) =>
      api.call('signOffShift', { params: { shiftId }, body: { note: null } }),
    onSuccess: refresh,
  });
  return (
    <section aria-label={t('shift.supervisor')} className="mt-8">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className="text-lg font-semibold">{t('shift.supervisor')}</h2>
        <Field id="sh-status" label={t('shift.show')}>
          <select
            id="sh-status"
            className={selectClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            {(['CLOSING', 'OPEN', 'CLOSED'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`shift.statuses.${s}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {signOff.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(signOff.error)}
        </Alert>
      )}
      {list.data?.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t(`shift.noneOf.${status}`)}</p>
      )}
      {list.data?.data.map((s) => (
        <article key={s.id} className="mt-3 rounded-md border border-border bg-surface p-4">
          <p className="text-sm">
            <span className="font-semibold">{s.cashier}</span> ·{' '}
            {t('shift.openedLine', { when: f.when(s.openedAt), float: f.money(s.floatMinor) })}
          </p>
          <CountLines shift={s} />
          {s.varianceNote && (
            <p className="mt-2 text-sm">{t('shift.reasonGiven', { note: s.varianceNote })}</p>
          )}
          {s.signedOffBy && (
            <p className="mt-2 text-sm text-text-muted">
              {t('shift.signedOffBy', { name: s.signedOffBy })}
            </p>
          )}
          {s.status === 'CLOSING' &&
            (s.varianceNote ? (
              <Button
                className="mt-3"
                size="sm"
                onClick={() => signOff.mutate(s.id)}
                disabled={signOff.isPending}
              >
                {t('shift.signOff', { name: s.cashier })}
              </Button>
            ) : (
              <p className="mt-2 text-sm text-text-muted">{t('shift.waitingReason')}</p>
            ))}
        </article>
      ))}
    </section>
  );
}

function Field(props: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
    </div>
  );
}
