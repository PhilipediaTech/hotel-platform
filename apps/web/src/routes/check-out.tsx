import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { PdfError, usePdf } from './folio-payments.tsx';
import { useFormats } from './reservations.tsx';

// S12 Check-out (PRD M3 check-out story, M3 rules 3–4; T-064): the bill per window, warnings
// that don't stop the guest leaving (keys not returned, leaving early: the stay is shortened),
// what does (a balance), print the invoice, check out. Sending the bill by email or WhatsApp comes
// with notifications (T-024).

export function CheckOutPage() {
  const { t } = useTranslation();
  const f = useFormats();
  const { stayId = '' } = useParams();
  const { currentPropertyId, permissions } = useSession();
  const queryClient = useQueryClient();
  const key = ['check-out', currentPropertyId ?? '', stayId];
  const preview = useQuery({
    queryKey: key,
    queryFn: () => api.call('getCheckOut', { params: { stayId } }),
  });
  const [keysReturned, setKeysReturned] = useState(true);
  const pdf = usePdf();
  const leave = useMutation({
    mutationFn: (version: number) =>
      api.call(
        'checkOut',
        { params: { stayId }, body: { keysReturned } },
        { ifMatch: `"${version}"` },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: ['front-desk'] });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['folios'] });
    },
  });

  if (preview.error) return <Alert tone="critical">{errorMessage(preview.error)}</Alert>;
  const p = preview.data;
  if (!p) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  const done = p.status === 'CHECKED_OUT';
  const keysOut = p.warnings.find((w) => w.code === 'KEYS_NOT_RETURNED');
  const early = p.warnings.find((w) => w.code === 'EARLY_DEPARTURE');

  return (
    <section className="max-w-3xl">
      <p className="text-sm">
        <Link to="/front-desk?tab=departures" className="text-brand underline">
          {t('frontDesk.tabs.departures')}
        </Link>
      </p>
      <h1 className="mt-1 text-xl font-semibold">{t('checkOut.title', { name: p.guestName })}</h1>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-text-muted">{t('frontDesk.cols.room')}</dt>
        <dd>{p.roomNumber ?? '—'}</dd>
        <dt className="text-text-muted">{t('frontDesk.cols.stay')}</dt>
        <dd>
          {f.date(p.arrival)} → {f.date(p.departure)}
        </dd>
      </dl>

      {p.folio ? (
        <div className="mt-4 rounded-md border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">{t('checkOut.bill', { number: p.folio.number })}</h2>
            <Link to={`/folios/${p.folio.id}`} className="text-sm text-brand underline">
              {t('checkOut.openFolio')}
            </Link>
          </div>
          <table aria-label={t('checkOut.balances')} className="mt-2 w-full text-left text-sm">
            <tbody>
              {p.folio.windows.map((w) => (
                <tr key={w.number} className="border-t border-border">
                  <td className="py-1.5 pr-3">
                    {t('checkOut.window', { n: w.number, payer: w.payerName })}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{f.money(w.balanceMinor)}</td>
                </tr>
              ))}
              <tr className="border-t border-border font-semibold">
                <td className="py-1.5 pr-3">{t('folios.balance')}</td>
                <td className="py-1.5 text-right tabular-nums">{f.money(p.folio.balanceMinor)}</td>
              </tr>
            </tbody>
          </table>
          {permissions.includes('folio.invoice') && (
            <div className="mt-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={pdf.busy}
                onClick={() => {
                  const folio = p.folio;
                  if (!folio) return;
                  void pdf.open(
                    () =>
                      api.download('getFolioInvoice', { params: { folioId: folio.id }, query: {} }),
                    `invoice-${folio.number}.pdf`,
                  );
                }}
              >
                {t('payments.printInvoice')}
              </Button>
              <PdfError error={pdf.error} />
              <p className="mt-1 text-xs text-text-muted">{t('checkOut.sendLater')}</p>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-text-muted">{t('checkOut.noFolio')}</p>
      )}

      {done ? (
        <Alert tone="success" className="mt-4">
          {t('checkOut.done', { name: p.guestName })}
        </Alert>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {p.blockers.includes('FOLIO_BALANCE_OUTSTANDING') && (
            <Alert tone="critical">{t('checkOut.blockers.FOLIO_BALANCE_OUTSTANDING')}</Alert>
          )}
          {early && (
            <Alert tone="info">
              {t('checkOut.early', {
                count: early.count,
                booked: f.date(p.departure),
                leaves: f.date(p.leavesOn),
              })}
            </Alert>
          )}
          {keysOut && (
            <div className="rounded-md border border-border p-3 text-sm">
              <p>{t('checkOut.keysOut', { count: keysOut.count })}</p>
              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={keysReturned}
                  onChange={(e) => setKeysReturned(e.target.checked)}
                />
                {t('checkOut.keysReturned')}
              </label>
            </div>
          )}
          <div>
            <Button
              disabled={p.blockers.length > 0 || leave.isPending}
              onClick={() => leave.mutate(p.version)}
            >
              {t('checkOut.confirm')}
            </Button>
          </div>
          {leave.error && <Alert tone="critical">{errorMessage(leave.error)}</Alert>}
        </div>
      )}
    </section>
  );
}
