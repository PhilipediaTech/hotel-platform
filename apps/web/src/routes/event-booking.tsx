import {
  EVENT_LINE_KINDS,
  EVENT_SCHEDULE_KINDS,
  localDate,
  type ApprovalPending,
  type EventBookingItem,
  type EventContractItem,
  type EventQuoteView,
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
import strings from '../i18n/en/events.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';
import { PdfError, usePdf } from '../lib/pdf.tsx';
import { AfterConfirming } from './event-closeout.tsx';

registerStrings(strings);

// S38 Events and spaces, one booking's file (PRD M9-04–M9-06; T-120): its quote versions, its
// contract and payment schedule, and confirming it.

type Booking = z.output<typeof EventBookingItem>;
type Quote = z.output<typeof EventQuoteView>;
type Contract = z.output<typeof EventContractItem>;
type LineKind = (typeof EVENT_LINE_KINDS)[number];
type EntryKind = (typeof EVENT_SCHEDULE_KINDS)[number];

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const isPending = (r: unknown): r is z.output<typeof ApprovalPending> =>
  typeof r === 'object' && r !== null && 'approvalRequestId' in r;

function useMoney() {
  const { i18n } = useTranslation();
  const { properties, currentPropertyId } = useSession();
  const property = properties.find((p) => p.id === currentPropertyId);
  const currency = property?.baseCurrency ?? 'NGN';
  const timeZone = property?.timeZone ?? 'UTC';
  return {
    timeZone,
    today: property?.businessDate ?? localDate(new Date(), timeZone),
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

const asMajor = (minor: string) => String(Number(minor) / 100);

// ── Quote (M9-04) ───────────────────────────────────────────────────────────────────────

interface LineDraft {
  kind: LineKind;
  description: string;
  quantity: string;
  unit: string;
}

function QuoteForm({
  quote,
  booking,
  onDone,
}: {
  quote: Quote;
  booking: Booking;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { money } = useMoney();
  const [lines, setLines] = useState<LineDraft[]>(
    quote.versions[0]?.lines
      .filter((l) => !l.minimumHire)
      .map((l) => ({
        kind: l.kind,
        description: l.description,
        quantity: String(l.quantity),
        unit: asMajor(l.unitMinor),
      })) ?? [],
  );
  const [notes, setNotes] = useState(quote.versions[0]?.notes ?? '');
  const add = (line: LineDraft) => setLines((list) => [...list, line]);
  const patch = (i: number, change: Partial<LineDraft>) =>
    setLines((list) => list.map((l, n) => (n === i ? { ...l, ...change } : l)));
  const save = useMutation({
    mutationFn: () =>
      api.call('createEventQuoteVersion', {
        params: { bookingId: booking.id },
        body: {
          lines: lines.map((l) => ({
            kind: l.kind,
            description: l.description,
            quantity: Number(l.quantity),
            unitMinor: toMinor(l.unit) ?? l.unit,
          })),
          notes: notes || null,
        },
      }),
    onSuccess: () => {
      onDone();
      void queryClient.invalidateQueries({ queryKey: ['event-file', booking.id] });
    },
  });
  const prefix = `ql-${booking.id}`;
  return (
    <form
      aria-label={t('events.quote.new')}
      className="mt-2 flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {quote.rates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-text-muted">{t('events.quote.rates')}</span>
          {quote.rates.map((r) => (
            <Button
              key={r.id}
              size="sm"
              variant="secondary"
              onClick={() =>
                add({
                  kind: r.unit === 'EXTRA' ? 'EXTRA' : 'SPACE',
                  description: r.name,
                  quantity: '1',
                  unit: asMajor(r.amountMinor),
                })
              }
            >
              {r.name} ({money(r.amountMinor)})
            </Button>
          ))}
        </div>
      )}
      {lines.map((l, i) => (
        <div key={i} className="grid gap-2 border-t border-border pt-2 sm:grid-cols-5">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${prefix}-k${i}`}>{t('events.quote.kind')}</Label>
            <select
              id={`${prefix}-k${i}`}
              className={selectClass}
              value={l.kind}
              onChange={(e) => patch(i, { kind: e.target.value as LineKind })}
            >
              {EVENT_LINE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`events.quote.kinds.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Field
              id={`${prefix}-d${i}`}
              label={t('events.quote.description')}
              value={l.description}
              onChange={(e) => patch(i, { description: e.target.value })}
              required
            />
          </div>
          <Field
            id={`${prefix}-q${i}`}
            label={t('events.quote.quantity')}
            type="number"
            min={1}
            value={l.quantity}
            onChange={(e) => patch(i, { quantity: e.target.value })}
            required
          />
          <Field
            id={`${prefix}-u${i}`}
            label={t('events.amount')}
            inputMode="decimal"
            value={l.unit}
            onChange={(e) => patch(i, { unit: e.target.value })}
            required
          />
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setLines((list) => list.filter((_, n) => n !== i))}
            >
              {t('events.remove')}
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => add({ kind: 'SPACE', description: '', quantity: '1', unit: '' })}
        >
          {t('events.quote.addLine')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            add({
              kind: 'CATERING',
              description: t('events.quote.cateringPerHead'),
              quantity: String(quote.expectedGuests),
              unit: '',
            })
          }
        >
          {t('events.quote.addCatering')}
        </Button>
      </div>
      <Field
        id={`${prefix}-notes`}
        label={t('events.notes')}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div>
        <Button type="submit" disabled={save.isPending || lines.length === 0}>
          {t('events.quote.save')}
        </Button>
      </div>
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
    </form>
  );
}

function QuoteSection({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const { money } = useMoney();
  const [editing, setEditing] = useState(false);
  const q = useQuery({
    queryKey: ['event-file', booking.id, 'quote'],
    queryFn: () => api.call('getEventQuotes', { params: { bookingId: booking.id } }),
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  if (!q.data) return null;
  const current = q.data.versions[0];
  const canEdit = permissions.includes('event.quote') && booking.status === 'HOLD';
  return (
    <section aria-label={t('events.quote.title')}>
      <h4 className="font-semibold">
        {t('events.quote.title')}
        {current ? ` · ${t('events.quote.version', { version: current.version })}` : ''}
      </h4>
      {!current && <p className="text-text-muted">{t('events.quote.none')}</p>}
      {current && !editing && (
        <>
          <ul className="mt-1">
            {current.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>
                  {l.description}
                  {l.quantity > 1 ? ` × ${l.quantity}` : ''}
                </span>
                <span>{money(l.amountMinor)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 flex justify-between gap-3 text-text-muted">
            <span>{t('events.quote.taxes')}</span>
            <span>{money(current.taxMinor)}</span>
          </p>
          <p className="flex justify-between gap-3 font-medium">
            <span>{t('events.quote.total')}</span>
            <span>{money(current.totalMinor)}</span>
          </p>
        </>
      )}
      {editing && <QuoteForm quote={q.data} booking={booking} onDone={() => setEditing(false)} />}
      {canEdit && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => setEditing((x) => !x)}
        >
          {editing ? t('events.quote.cancel') : t('events.quote.newVersion')}
        </Button>
      )}
    </section>
  );
}

// ── Contract and schedule (M9-05) ───────────────────────────────────────────────────────

interface EntryDraft {
  kind: EntryKind;
  dueDate: string;
  amount: string;
}

function ContractForm({
  booking,
  total,
  onDone,
}: {
  booking: Booking;
  total: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { money, today, timeZone } = useMoney();
  const enquiry = useQuery({
    queryKey: ['event-file', booking.id, 'enquiry'],
    enabled: booking.enquiryId !== null,
    queryFn: () => api.call('listEventEnquiries', { query: {} }),
  });
  const found = enquiry.data?.data.find((e) => e.id === booking.enquiryId);
  const [typed, setTyped] = useState<{ name?: string; email?: string; phone?: string }>({});
  const name = typed.name ?? found?.contactName ?? '';
  const email = typed.email ?? found?.contactEmail ?? '';
  const phone = typed.phone ?? found?.contactPhone ?? '';
  const [terms, setTerms] = useState('');
  const [send, setSend] = useState(true);
  const half = Math.floor(Number(total) / 200);
  const [entries, setEntries] = useState<EntryDraft[]>([
    { kind: 'DEPOSIT', dueDate: today, amount: String(half) },
    {
      kind: 'INSTALMENT',
      dueDate: localDate(new Date(booking.startsAt), timeZone),
      amount: String(Number(total) / 100 - half),
    },
  ]);
  const patch = (i: number, change: Partial<EntryDraft>) =>
    setEntries((list) => list.map((x, n) => (n === i ? { ...x, ...change } : x)));
  const owed = entries
    .filter((x) => x.kind !== 'DAMAGE_DEPOSIT')
    .reduce((sum, x) => sum + BigInt(toMinor(x.amount) ?? '0'), 0n);
  const issue = useMutation({
    mutationFn: () =>
      api.call('issueEventContract', {
        params: { bookingId: booking.id },
        body: {
          clientName: name,
          clientEmail: email,
          clientPhone: phone,
          terms,
          send,
          schedule: entries.map((x) => ({
            kind: x.kind,
            dueDate: x.dueDate,
            amountMinor: toMinor(x.amount) ?? x.amount,
          })),
        },
      }),
    onSuccess: () => {
      onDone();
      void queryClient.invalidateQueries({ queryKey: ['event-file', booking.id] });
    },
  });
  const prefix = `ct-${booking.id}`;
  return (
    <form
      aria-label={t('events.contract.new')}
      className="mt-2 grid gap-2 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        issue.mutate();
      }}
    >
      <Field
        id={`${prefix}-name`}
        label={t('events.contactName')}
        value={name}
        onChange={(e) => setTyped((x) => ({ ...x, name: e.target.value }))}
        required
      />
      <Field
        id={`${prefix}-email`}
        label={t('events.email')}
        type="email"
        value={email}
        onChange={(e) => setTyped((x) => ({ ...x, email: e.target.value }))}
        required
      />
      <Field
        id={`${prefix}-phone`}
        label={t('events.phone')}
        value={phone}
        onChange={(e) => setTyped((x) => ({ ...x, phone: e.target.value }))}
        required
      />
      <div className="flex flex-col gap-1 sm:col-span-3">
        <Label htmlFor={`${prefix}-terms`}>{t('events.contract.terms')}</Label>
        <textarea
          id={`${prefix}-terms`}
          className="min-h-24 rounded-md border border-border bg-surface p-2 text-sm"
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          required
        />
      </div>
      <h5 className="font-semibold sm:col-span-3">{t('events.contract.schedule')}</h5>
      {entries.map((x, i) => (
        <div key={i} className="grid gap-2 sm:col-span-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${prefix}-k${i}`}>{t('events.contract.kind')}</Label>
            <select
              id={`${prefix}-k${i}`}
              className={selectClass}
              value={x.kind}
              onChange={(e) => patch(i, { kind: e.target.value as EntryKind })}
            >
              {EVENT_SCHEDULE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`events.contract.kinds.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <Field
            id={`${prefix}-d${i}`}
            label={t('events.contract.due')}
            type="date"
            value={x.dueDate}
            onChange={(e) => patch(i, { dueDate: e.target.value })}
            required
          />
          <Field
            id={`${prefix}-a${i}`}
            label={t('events.amount')}
            inputMode="decimal"
            value={x.amount}
            onChange={(e) => patch(i, { amount: e.target.value })}
            required
          />
          <div className="flex items-end">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setEntries((list) => list.filter((_, n) => n !== i))}
            >
              {t('events.remove')}
            </Button>
          </div>
        </div>
      ))}
      <p className="text-text-muted sm:col-span-3">
        {t('events.contract.addsUp', { typed: money(owed.toString()), total: money(total) })}
      </p>
      <div className="flex flex-wrap gap-2 sm:col-span-3">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            setEntries((list) => [...list, { kind: 'INSTALMENT', dueDate: today, amount: '' }])
          }
        >
          {t('events.contract.addEntry')}
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-3">
        <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
        {t('events.contract.send')}
      </label>
      <div className="sm:col-span-3">
        <Button type="submit" disabled={issue.isPending}>
          {t('events.contract.issue')}
        </Button>
      </div>
      {issue.error && (
        <Alert tone="critical" className="sm:col-span-3">
          {errorMessage(issue.error)}
        </Alert>
      )}
    </form>
  );
}

function SignForm({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { today } = useMoney();
  const [name, setName] = useState('');
  const [date, setDate] = useState(today);
  const sign = useMutation({
    mutationFn: () =>
      api.call('signEventContract', {
        params: { bookingId: booking.id },
        body: { signedByName: name, signedOn: date },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['event-file', booking.id] }),
  });
  return (
    <form
      aria-label={t('events.contract.recordSigned')}
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        sign.mutate();
      }}
    >
      <Field
        id={`sign-${booking.id}`}
        label={t('events.contract.signedBy')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <Field
        id={`sign-d-${booking.id}`}
        label={t('events.contract.signedOn')}
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        required
      />
      <Button type="submit" variant="secondary" disabled={sign.isPending}>
        {t('events.contract.recordSigned')}
      </Button>
      {sign.error && <Alert tone="critical">{errorMessage(sign.error)}</Alert>}
    </form>
  );
}

function ContractDetails({ c, booking }: { c: Contract; booking: Booking }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const { money } = useMoney();
  const pdf = usePdf();
  return (
    <div className="mt-1">
      <p>
        {c.number} · {t(`events.contract.status.${c.status}`)} ·{' '}
        {t('events.quote.version', { version: c.quoteVersion })} · {c.clientName}
      </p>
      {c.signedByName && (
        <p className="text-text-muted">
          {t('events.contract.signedLine', { name: c.signedByName, on: c.signedOn ?? '' })}
        </p>
      )}
      {c.account && (
        <p className="mt-1 font-medium">
          {t('events.contract.account', {
            bank: c.account.bankName,
            number: c.account.accountNumber,
            name: c.account.accountName,
          })}
        </p>
      )}
      <ul className="mt-2 flex flex-col gap-1">
        {c.schedule.map((s) => (
          <li key={s.id} className="flex flex-wrap justify-between gap-3">
            <span>
              {s.dueDate} · {t(`events.contract.kinds.${s.kind}`)}
            </span>
            <span>
              {money(s.paidMinor)} / {money(s.amountMinor)} ·{' '}
              {t(`events.contract.entry.${s.status}`)}
            </span>
          </li>
        ))}
      </ul>
      {c.overpaidMinor !== '0' && (
        <Alert tone="info" className="mt-2">
          {t('events.contract.overpaid', { amount: money(c.overpaidMinor) })}
        </Alert>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={pdf.busy}
          onClick={() =>
            void pdf.open(
              () => api.download('getEventContractPdf', { params: { bookingId: booking.id } }),
              `${c.number}.pdf`,
            )
          }
        >
          {t('events.contract.pdf')}
        </Button>
      </div>
      <PdfError error={pdf.error} />
      {c.status === 'ISSUED' && permissions.includes('event.contract') && (
        <SignForm booking={booking} />
      )}
    </div>
  );
}

function ContractSection({ booking, total }: { booking: Booking; total: string | null }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [issuing, setIssuing] = useState(false);
  const q = useQuery({
    queryKey: ['event-file', booking.id, 'contract'],
    queryFn: () => api.call('getEventContract', { params: { bookingId: booking.id } }),
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  if (!q.data) return null;
  const { contract, missing } = q.data;
  const free =
    !contract ||
    (contract.status === 'ISSUED' && contract.schedule.every((s) => s.paidMinor === '0'));
  const canIssue =
    permissions.includes('event.contract') && booking.status === 'HOLD' && free && total !== null;
  return (
    <section aria-label={t('events.contract.title')}>
      <h4 className="font-semibold">{t('events.contract.title')}</h4>
      {!contract && <p className="text-text-muted">{t('events.contract.none')}</p>}
      {contract && !issuing && <ContractDetails c={contract} booking={booking} />}
      {issuing && total !== null && (
        <ContractForm booking={booking} total={total} onDone={() => setIssuing(false)} />
      )}
      {canIssue && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => setIssuing((x) => !x)}
        >
          {issuing
            ? t('events.quote.cancel')
            : contract
              ? t('events.contract.reissue')
              : t('events.contract.issue')}
        </Button>
      )}
      {booking.status === 'HOLD' && permissions.includes('event.confirm') && (
        <ConfirmSection booking={booking} missing={missing} />
      )}
    </section>
  );
}

// ── Confirming (M9-06) ──────────────────────────────────────────────────────────────────

function ConfirmSection({ booking, missing }: { booking: Booking; missing: string[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [asked, setAsked] = useState(false);
  const confirm = useMutation({
    mutationFn: (override: boolean) =>
      api.call('confirmEventBooking', {
        params: { bookingId: booking.id },
        body: { override, reason: override ? reason : '' },
      }),
    onSuccess: (result) => {
      if (isPending(result)) {
        setAsked(true);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      void queryClient.invalidateQueries({ queryKey: ['event-file', booking.id] });
    },
  });
  return (
    <div className="mt-3 border-t border-border pt-3">
      {missing.length > 0 && (
        <ul className="list-disc pl-5 text-text-muted">
          {missing.map((m) => (
            <li key={m}>{t(`events.confirm.missing.${m}`)}</li>
          ))}
        </ul>
      )}
      {missing.length === 0 && (
        <Button disabled={confirm.isPending} onClick={() => confirm.mutate(false)}>
          {t('events.confirm.button')}
        </Button>
      )}
      {missing.length > 0 && !asked && (
        <form
          aria-label={t('events.confirm.override')}
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate(true);
          }}
        >
          <Field
            id={`ovr-${booking.id}`}
            label={t('events.confirm.reason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
          <Button type="submit" variant="secondary" disabled={confirm.isPending}>
            {t('events.confirm.override')}
          </Button>
        </form>
      )}
      {asked && <Alert tone="info">{t('events.confirm.asked')}</Alert>}
      {confirm.error && <Alert tone="critical">{errorMessage(confirm.error)}</Alert>}
    </div>
  );
}

/** Everything agreed with the client for one hold or booking. */
export function BookingFile({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['event-file', booking.id, 'quote'],
    queryFn: () => api.call('getEventQuotes', { params: { bookingId: booking.id } }),
  });
  return (
    <div className="flex w-full flex-col gap-4 border-t border-border pt-3">
      {booking.confirmedByOverride && <Alert tone="info">{t('events.confirm.byOverride')}</Alert>}
      <QuoteSection booking={booking} />
      <ContractSection booking={booking} total={q.data?.versions[0]?.totalMinor ?? null} />
      {booking.status !== 'HOLD' && <AfterConfirming booking={booking} />}
    </div>
  );
}
