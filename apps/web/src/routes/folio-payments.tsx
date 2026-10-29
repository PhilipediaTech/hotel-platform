import type { FolioItem } from '@hotel/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { toMinor } from './folios.tsx';
import { useFormats } from './reservations.tsx';

// Payments on the folio and its documents (PRD M4-08 and the receipt/invoice/proforma story;
// S11 "take payment", "print/send invoice"; T-062): the window's payments with a receipt each,
// the take-payment form (methods the hotel switched on; reference for anything but cash), and
// the PDF buttons. Opening a PDF needs the property header, so the file is fetched and shown
// from a blob URL.

type Folio = z.output<typeof FolioItem>;
type Window = Folio['windows'][number];

const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';

/**
 * Shows a PDF in a new tab. The tab is opened before the download (browsers block pop-ups
 * that open after a wait); without one, the file is saved instead.
 */
export function usePdf() {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const open = async (fetchFile: () => Promise<Blob>, filename: string) => {
    setError(null);
    setBusy(true);
    const tab = window.open('', '_blank');
    try {
      const url = URL.createObjectURL(await fetchFile());
      if (tab) {
        tab.location.href = url;
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      tab?.close();
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { open, error, busy };
}

export function PdfError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert tone="critical" className="mt-2">
      {errorMessage(error)}
    </Alert>
  );
}

export function PrintInvoice({ folio, windowNumber }: { folio: Folio; windowNumber: number }) {
  const { t } = useTranslation();
  const pdf = usePdf();
  const several = folio.windows.length > 1;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={pdf.busy}
        onClick={() =>
          void pdf.open(
            () => api.download('getFolioInvoice', { params: { folioId: folio.id }, query: {} }),
            `invoice-${folio.number}.pdf`,
          )
        }
      >
        {t('payments.printInvoice')}
      </Button>
      {several && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pdf.busy}
          onClick={() =>
            void pdf.open(
              () =>
                api.download('getFolioInvoice', {
                  params: { folioId: folio.id },
                  query: { window: windowNumber },
                }),
              `invoice-${folio.number}-${windowNumber}.pdf`,
            )
          }
        >
          {t('payments.printWindowInvoice', { n: windowNumber })}
        </Button>
      )}
      <PdfError error={pdf.error} />
    </div>
  );
}

export function Payments({ folio, window: w }: { folio: Folio; window: Window }) {
  const { t } = useTranslation();
  const f = useFormats();
  const { permissions } = useSession();
  const pdf = usePdf();
  if (w.payments.length === 0) return null;
  return (
    <div className="mt-4 overflow-x-auto">
      <table aria-label={t('payments.title')} className="w-full text-left text-sm">
        <thead className="text-text-muted">
          <tr>
            <th className="py-2 pr-3 font-medium">{t('folios.cols.date')}</th>
            <th className="py-2 pr-3 font-medium">{t('payments.method')}</th>
            <th className="py-2 pr-3 font-medium">{t('payments.reference')}</th>
            <th className="py-2 pr-3 text-right font-medium">{t('folios.cols.amount')}</th>
            <th className="py-2 pr-3 font-medium">{t('folios.cols.by')}</th>
            <th className="py-2 font-medium">
              <span className="sr-only">{t('frontDesk.cols.action')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {w.payments.map((p) => (
            <tr key={p.id} className="border-t border-border">
              <td className="py-1.5 pr-3">{f.date(p.businessDate)}</td>
              <td className="py-1.5 pr-3">
                {t(`shift.methods.${p.method}`)}
                {p.note && <span className="block text-xs text-text-muted">{p.note}</span>}
              </td>
              <td className="py-1.5 pr-3">{p.externalRef ?? '—'}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">−{f.money(p.amountMinor)}</td>
              <td className="py-1.5 pr-3 text-xs">{p.receivedBy ?? ''}</td>
              <td className="py-1.5">
                {permissions.includes('folio.invoice') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pdf.busy}
                    aria-label={t('payments.receiptFor', { amount: f.money(p.amountMinor) })}
                    onClick={() =>
                      void pdf.open(
                        () =>
                          api.download('getFolioReceipt', {
                            params: { folioId: folio.id },
                            query: { paymentId: p.id },
                          }),
                        `receipt-${p.id.slice(0, 8)}.pdf`,
                      )
                    }
                  >
                    {t('payments.receipt')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <PdfError error={pdf.error} />
    </div>
  );
}

export function TakePayment({ folio, windowNumber }: { folio: Folio; windowNumber: number }) {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const methods = folio.paymentMethods;
  const [method, setMethod] = useState(methods[0] ?? 'CASH');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const minor = toMinor(amount);
  const needsRef = method !== 'CASH';
  const ready = minor !== null && (!needsRef || reference.trim() !== '');
  const take = useMutation({
    mutationFn: () =>
      api.call('capturePayment', {
        body: {
          folioId: folio.id,
          windowNumber,
          method,
          amountMinor: minor ?? '0',
          externalRef: needsRef ? reference.trim() : null,
          note: note.trim() || null,
        },
      }),
    onSuccess: (result) => {
      setDone(t('payments.taken', { balance: f.money(result.balanceMinor) }));
      setAmount('');
      setReference('');
      setNote('');
      void queryClient.invalidateQueries({
        queryKey: ['folios', currentPropertyId ?? '', folio.id],
      });
      void queryClient.invalidateQueries({ queryKey: ['front-desk'] });
      void queryClient.invalidateQueries({ queryKey: ['shifts'] });
    },
  });
  if (methods.length === 0) {
    return <p className="mt-6 text-sm text-text-muted">{t('payments.noMethods')}</p>;
  }
  return (
    <form
      aria-label={t('payments.take')}
      className="mt-6 grid items-end gap-3 rounded-md border border-border bg-surface p-4 sm:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        setDone(null);
        if (ready) take.mutate();
      }}
    >
      <h2 className="font-semibold sm:col-span-4">{t('payments.takeOn', { n: windowNumber })}</h2>
      <Field id="pay-method" label={t('payments.method')}>
        <select
          id="pay-method"
          className={selectClass}
          value={method}
          onChange={(e) => setMethod(e.target.value as typeof method)}
        >
          {methods.map((m) => (
            <option key={m} value={m}>
              {t(`shift.methods.${m}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="pay-amount" label={t('payments.amount')}>
        <Input
          id="pay-amount"
          inputMode="decimal"
          placeholder={f.money(folio.balanceMinor)}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      {needsRef && (
        <Field id="pay-ref" label={t('payments.reference')}>
          <Input
            id="pay-ref"
            maxLength={100}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
      )}
      <Field id="pay-note" label={t('payments.note')}>
        <Input
          id="pay-note"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div className="sm:col-span-4">
        <Button type="submit" disabled={!ready || take.isPending}>
          {t('payments.takeButton')}
        </Button>
      </div>
      {take.error && (
        <Alert tone="critical" className="sm:col-span-4">
          {errorMessage(take.error)}
        </Alert>
      )}
      {done && (
        <Alert tone="success" className="sm:col-span-4">
          {done}
        </Alert>
      )}
    </form>
  );
}

export function PrintProforma({
  reservationId,
  confirmationNo,
}: {
  reservationId: string;
  confirmationNo: string;
}) {
  const { t } = useTranslation();
  const pdf = usePdf();
  return (
    <span>
      <Button
        size="sm"
        variant="secondary"
        disabled={pdf.busy}
        onClick={() =>
          void pdf.open(
            () => api.download('getProforma', { params: { reservationId } }),
            `proforma-${confirmationNo}.pdf`,
          )
        }
      >
        {t('payments.proforma')}
      </Button>
      <PdfError error={pdf.error} />
    </span>
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
