import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import billingStrings from '../i18n/en/billing.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { PdfError, usePdf } from '../lib/pdf.tsx';

registerStrings(billingStrings);

// S30 Plan and billing (PRD M13-04; T-100): the owner's plan and prices, this month's usage
// and estimate, invoices as PDF, the legal name invoices carry, and every support session
// (M13-02 "that the owner can see").

function useMoney() {
  const { i18n } = useTranslation();
  return (minor: string, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(
      Number(minor) / 100,
    );
}

const isUsedUp = (used: number, allowance: number | null | undefined) =>
  allowance !== null && allowance !== undefined && used >= allowance;

export function BillingPage() {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const key = ['billing', currentPropertyId ?? ''];
  const page = useQuery({ queryKey: key, queryFn: () => api.call('getSubscription') });
  const pdf = usePdf();
  const [legalName, setLegalName] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (name: string) => api.call('updateBillingDetails', { body: { legalName: name } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const when = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  if (page.error) return <Alert tone="critical">{errorMessage(page.error)}</Alert>;
  const d = page.data;
  if (!d) return null;
  const s = d.subscription;
  const currency = s?.currency ?? 'NGN';
  const ofAllowance = (used: number, allowance: number | null | undefined) =>
    allowance === null || allowance === undefined
      ? used
      : t('billing.ofAllowance', { used, allowance });
  return (
    <section className="max-w-3xl">
      <h1 className="text-xl font-semibold">{t('billing.title')}</h1>

      <section
        aria-label={t('billing.plan')}
        className="mt-4 rounded-md border border-border bg-surface p-4"
      >
        {s ? (
          <>
            <p className="text-lg font-semibold">
              {t(`billing.plans.${s.plan}`)} · {t(`billing.statuses.${s.status}`)}
            </p>
            <p className="text-sm">
              {t('billing.price', {
                price: money(s.pricePerRoomMinor, currency),
                minimum: money(s.minimumMinor, currency),
              })}
            </p>
            <p className="text-sm text-text-muted">
              {t('billing.periodEnd', { date: s.currentPeriodEnd })}
            </p>
          </>
        ) : (
          <p className="text-sm text-text-muted">{t('billing.noPlan')}</p>
        )}
        <h2 className="mt-4 font-semibold">{t('billing.usage', { month: d.usage.month })}</h2>
        <dl className="mt-1 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-text-muted">{t('billing.activeRooms')}</dt>
            <dd className="text-lg font-semibold">{d.usage.activeRooms}</dd>
          </div>
          <div>
            <dt className="text-text-muted">{t('billing.whatsapp')}</dt>
            <dd className="text-lg font-semibold">
              {ofAllowance(d.usage.whatsappMessages, s?.whatsappAllowance)}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">{t('billing.ai')}</dt>
            <dd className="text-lg font-semibold">{ofAllowance(d.usage.aiUses, s?.aiAllowance)}</dd>
          </div>
          {d.usage.estimateMinor && (
            <div>
              <dt className="text-text-muted">{t('billing.estimate')}</dt>
              <dd className="text-lg font-semibold">{money(d.usage.estimateMinor, currency)}</dd>
            </div>
          )}
        </dl>
        {isUsedUp(d.usage.whatsappMessages, s?.whatsappAllowance) && (
          <Alert tone="critical" className="mt-3">
            {t('billing.whatsappUsedUp')}
          </Alert>
        )}
        {isUsedUp(d.usage.aiUses, s?.aiAllowance) && (
          <Alert tone="critical" className="mt-3">
            {t('billing.aiUsedUp')}
          </Alert>
        )}
      </section>

      <section aria-label={t('billing.invoices')} className="mt-6">
        <h2 className="font-semibold">{t('billing.invoices')}</h2>
        {d.invoices.length === 0 && (
          <p className="text-sm text-text-muted">{t('billing.noInvoices')}</p>
        )}
        <ul className="mt-2 flex flex-col gap-2">
          {d.invoices.map((inv) => (
            <li
              key={inv.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-3 text-sm"
            >
              <span className="font-medium">{inv.number}</span>
              <span>
                {inv.periodStart} – {inv.periodEnd}
              </span>
              <span className="font-semibold">{money(inv.totalMinor, inv.currency)}</span>
              <span className="text-text-muted">{t(`billing.invoiceStatus.${inv.status}`)}</span>
              <Button
                size="sm"
                variant="secondary"
                className="ml-auto"
                disabled={pdf.busy}
                onClick={() =>
                  void pdf.open(
                    () => api.download('getPlatformInvoicePdf', { params: { invoiceId: inv.id } }),
                    `${inv.number}.pdf`,
                  )
                }
              >
                {t('billing.pdf')}
              </Button>
            </li>
          ))}
        </ul>
        <PdfError error={pdf.error} />
      </section>

      <form
        aria-label={t('billing.details')}
        className="mt-6 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate((legalName ?? d.organisation.legalName ?? '').trim());
        }}
      >
        <div className="flex min-w-72 flex-1 flex-col gap-1">
          <Label htmlFor="billing-legal">{t('billing.legalName')}</Label>
          <Input
            id="billing-legal"
            value={legalName ?? d.organisation.legalName ?? ''}
            onChange={(e) => setLegalName(e.target.value)}
            maxLength={200}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={save.isPending}>
          {t('billing.save')}
        </Button>
        {save.isSuccess && (
          <span role="status" className="text-sm">
            {t('billing.saved')}
          </span>
        )}
        {save.error && (
          <Alert tone="critical" className="w-full">
            {errorMessage(save.error)}
          </Alert>
        )}
      </form>

      <section aria-label={t('billing.support')} className="mt-6">
        <h2 className="font-semibold">{t('billing.support')}</h2>
        <p className="text-sm text-text-muted">{t('billing.supportIntro')}</p>
        {d.supportSessions.length === 0 && (
          <p className="mt-2 text-sm text-text-muted">{t('billing.noSupport')}</p>
        )}
        <ul className="mt-2 flex flex-col gap-2">
          {d.supportSessions.map((x) => (
            <li key={x.id} className="rounded-md border border-border bg-surface p-3 text-sm">
              <p className="font-medium">
                {x.reason}
                {x.active && <span className="ml-2 text-critical">{t('billing.open')}</span>}
              </p>
              <p className="text-text-muted">
                {t('billing.sessionLine', {
                  name: x.admin.name,
                  start: when(x.startedAt),
                  end: when(x.endedAt ?? x.expiresAt),
                  views: x.views,
                })}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
