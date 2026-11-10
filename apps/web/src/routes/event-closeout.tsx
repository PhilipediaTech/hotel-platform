import {
  EVENT_LINE_KINDS,
  type EventBookingItem,
  type EventBriefView,
  type EventCloseOutView,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
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

registerStrings(strings);

// S38 Events and spaces, a confirmed booking's file (PRD M9-07, M9-08; T-121): the brief for each
// department, the inspection and final invoice, and closing the event.

type Booking = z.output<typeof EventBookingItem>;
type Brief = z.output<typeof EventBriefView>;
type CloseOut = z.output<typeof EventCloseOutView>;
type LineKind = (typeof EVENT_LINE_KINDS)[number];

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const textClass = 'min-h-20 rounded-md border border-border bg-surface p-2 text-sm';

function useMoney() {
  const { i18n } = useTranslation();
  const { properties, currentPropertyId } = useSession();
  const currency = properties.find((p) => p.id === currentPropertyId)?.baseCurrency ?? 'NGN';
  return (minor: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(
      Number(minor) / 100,
    );
}

// ── The brief (M9-07) ───────────────────────────────────────────────────────────────────

function BriefForm({
  booking,
  brief,
  canEdit,
}: {
  booking: Booking;
  brief: Brief;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const pdf = usePdf();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const textOf = (id: string, saved: string) => typed[id] ?? saved;
  const save = useMutation({
    mutationFn: () =>
      api.call('saveEventBrief', {
        params: { bookingId: booking.id },
        body: {
          sections: brief.sections.map((s) => ({
            departmentId: s.department.id,
            instructions: textOf(s.department.id, s.instructions),
          })),
        },
      }),
    onSuccess: () => {
      setTyped({});
      void queryClient.invalidateQueries({ queryKey: ['event-file', booking.id, 'brief'] });
    },
  });
  const anySaved = brief.sections.some((s) => s.instructions);
  return (
    <form
      aria-label={t('events.brief.title')}
      className="mt-1 flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {brief.sections.map((s) => (
        <div key={s.department.id} className="flex flex-col gap-1">
          <Label htmlFor={`brief-${booking.id}-${s.department.id}`}>{s.department.name}</Label>
          <textarea
            id={`brief-${booking.id}-${s.department.id}`}
            className={textClass}
            value={textOf(s.department.id, s.instructions)}
            readOnly={!canEdit}
            onChange={(e) => setTyped((x) => ({ ...x, [s.department.id]: e.target.value }))}
          />
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {canEdit && (
          <Button type="submit" variant="secondary" size="sm" disabled={save.isPending}>
            {t('events.brief.save')}
          </Button>
        )}
        {anySaved && (
          <Button
            size="sm"
            variant="secondary"
            disabled={pdf.busy}
            onClick={() =>
              void pdf.open(
                () =>
                  api.download('getEventBriefPdf', {
                    params: { bookingId: booking.id },
                    query: {},
                  }),
                'banquet-event-order.pdf',
              )
            }
          >
            {t('events.brief.pdf')}
          </Button>
        )}
      </div>
      <PdfError error={pdf.error} />
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
    </form>
  );
}

function BriefSection({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const q = useQuery({
    queryKey: ['event-file', booking.id, 'brief'],
    queryFn: () => api.call('getEventBrief', { params: { bookingId: booking.id } }),
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  if (!q.data) return null;
  return (
    <section aria-label={t('events.brief.heading')}>
      <h4 className="font-semibold">{t('events.brief.heading')}</h4>
      <BriefForm
        booking={booking}
        brief={q.data}
        canEdit={permissions.includes('event.brief') && booking.status === 'CONFIRMED'}
      />
    </section>
  );
}

// ── Close-out (M9-08) ───────────────────────────────────────────────────────────────────

interface ExtraDraft {
  kind: LineKind;
  description: string;
  quantity: string;
  unit: string;
}

function InspectionForm({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState('');
  const [damage, setDamage] = useState('');
  const [what, setWhat] = useState('');
  const [extras, setExtras] = useState<ExtraDraft[]>([]);
  const patch = (i: number, change: Partial<ExtraDraft>) =>
    setExtras((list) => list.map((x, n) => (n === i ? { ...x, ...change } : x)));
  const inspect = useMutation({
    mutationFn: () =>
      api.call('inspectEvent', {
        params: { bookingId: booking.id },
        body: {
          notes,
          damageMinor: damage ? (toMinor(damage) ?? damage) : '0',
          damageDescription: what || null,
          extras: extras.map((x) => ({
            kind: x.kind,
            description: x.description,
            quantity: Number(x.quantity),
            unitMinor: toMinor(x.unit) ?? x.unit,
          })),
        },
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['event-file', booking.id, 'closeout'] }),
  });
  const prefix = `insp-${booking.id}`;
  return (
    <form
      aria-label={t('events.closeOut.inspection')}
      className="mt-2 flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        inspect.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${prefix}-notes`}>{t('events.closeOut.notes')}</Label>
        <textarea
          id={`${prefix}-notes`}
          className={textClass}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          required
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${prefix}-what`}>{t('events.closeOut.damageWhat')}</Label>
          <Input id={`${prefix}-what`} value={what} onChange={(e) => setWhat(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${prefix}-cost`}>{t('events.closeOut.damageCost')}</Label>
          <Input
            id={`${prefix}-cost`}
            inputMode="decimal"
            value={damage}
            onChange={(e) => setDamage(e.target.value)}
          />
        </div>
      </div>
      {extras.map((x, i) => (
        <div key={i} className="grid gap-2 border-t border-border pt-2 sm:grid-cols-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${prefix}-k${i}`}>{t('events.quote.kind')}</Label>
            <select
              id={`${prefix}-k${i}`}
              className={selectClass}
              value={x.kind}
              onChange={(e) => patch(i, { kind: e.target.value as LineKind })}
            >
              {EVENT_LINE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`events.quote.kinds.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${prefix}-d${i}`}>{t('events.quote.description')}</Label>
            <Input
              id={`${prefix}-d${i}`}
              value={x.description}
              onChange={(e) => patch(i, { description: e.target.value })}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${prefix}-q${i}`}>{t('events.quote.quantity')}</Label>
            <Input
              id={`${prefix}-q${i}`}
              type="number"
              min={1}
              value={x.quantity}
              onChange={(e) => patch(i, { quantity: e.target.value })}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${prefix}-u${i}`}>{t('events.amount')}</Label>
            <Input
              id={`${prefix}-u${i}`}
              inputMode="decimal"
              value={x.unit}
              onChange={(e) => patch(i, { unit: e.target.value })}
              required
            />
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            setExtras((list) => [
              ...list,
              { kind: 'EXTRA', description: '', quantity: '1', unit: '' },
            ])
          }
        >
          {t('events.closeOut.addExtra')}
        </Button>
        <Button type="submit" size="sm" disabled={inspect.isPending}>
          {t('events.closeOut.inspect')}
        </Button>
      </div>
      {inspect.error && <Alert tone="critical">{errorMessage(inspect.error)}</Alert>}
    </form>
  );
}

function Settlement({ view, booking }: { view: CloseOut; booking: Booking }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { permissions } = useSession();
  const money = useMoney();
  const pdf = usePdf();
  const close = useMutation({
    mutationFn: () => api.call('closeEvent', { params: { bookingId: booking.id }, body: {} }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      void queryClient.invalidateQueries({ queryKey: ['event-file', booking.id] });
    },
  });
  const canClose = permissions.includes('event.close');
  const balance = BigInt(view.folio?.balanceMinor ?? '0');
  return (
    <div className="mt-1 flex flex-col gap-2">
      {view.inspection && <p className="text-text-muted">{view.inspection.notes}</p>}
      {view.inspection?.damageDescription && (
        <p>
          {t('events.closeOut.damageLine', {
            what: view.inspection.damageDescription,
            amount: money(view.inspection.damageTotalMinor),
          })}
        </p>
      )}
      {view.damageDepositHeldMinor !== '0' && (
        <p>
          {t('events.closeOut.depositLine', {
            held: money(view.damageDepositHeldMinor),
            retained: money(view.damageDepositRetainedMinor),
          })}
        </p>
      )}
      {view.folio && (
        <p className="font-medium">
          {balance > 0n
            ? t('events.closeOut.owes', { amount: money(view.folio.balanceMinor) })
            : balance < 0n
              ? t('events.closeOut.owed', { amount: money((-balance).toString()) })
              : t('events.closeOut.settled')}{' '}
          <Link className="underline" to={`/folios/${view.folio.id}`}>
            {t('events.closeOut.bill', { number: view.folio.number })}
          </Link>
        </p>
      )}
      {view.status === 'CLOSED' ? (
        <Alert tone="success">{t('events.closeOut.closed')}</Alert>
      ) : (
        view.blockers.length > 0 && (
          <ul className="list-disc pl-5 text-text-muted">
            {view.blockers.map((b) => (
              <li key={b}>{t(`events.closeOut.blockers.${b}`)}</li>
            ))}
          </ul>
        )
      )}
      {canClose && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pdf.busy}
            onClick={() =>
              void pdf.open(
                () => api.download('getEventInvoicePdf', { params: { bookingId: booking.id } }),
                `invoice-${view.folio?.number ?? 'event'}.pdf`,
              )
            }
          >
            {t('events.closeOut.invoice')}
          </Button>
          {view.status !== 'CLOSED' && (
            <Button
              size="sm"
              disabled={close.isPending || view.blockers.length > 0}
              onClick={() => close.mutate()}
            >
              {t('events.closeOut.close')}
            </Button>
          )}
        </div>
      )}
      <PdfError error={pdf.error} />
      {close.error && <Alert tone="critical">{errorMessage(close.error)}</Alert>}
    </div>
  );
}

function CloseOutSection({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const q = useQuery({
    queryKey: ['event-file', booking.id, 'closeout'],
    queryFn: () => api.call('getEventCloseOut', { params: { bookingId: booking.id } }),
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  if (!q.data) return null;
  return (
    <section aria-label={t('events.closeOut.heading')}>
      <h4 className="font-semibold">{t('events.closeOut.heading')}</h4>
      {q.data.inspection ? (
        <Settlement view={q.data} booking={booking} />
      ) : new Date(booking.endsAt) > new Date() ? (
        <p className="text-text-muted">{t('events.closeOut.notYet')}</p>
      ) : permissions.includes('event.close') ? (
        <InspectionForm booking={booking} />
      ) : (
        <p className="text-text-muted">{t('events.closeOut.waiting')}</p>
      )}
    </section>
  );
}

/** What happens once a booking is confirmed. */
export function AfterConfirming({ booking }: { booking: Booking }) {
  return (
    <>
      <BriefSection booking={booking} />
      <CloseOutSection booking={booking} />
    </>
  );
}
