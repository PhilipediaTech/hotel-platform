import { EINVOICE_STATUSES, type EinvoiceStatus } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import einvoiceStrings from '../i18n/en/einvoices.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(einvoiceStrings);

// E-invoicing (PRD M4-24; T-160; beside the city ledger, S32): whether invoices go to the tax
// authority, and finance's list of invoices to send, sending, accepted, rejected or failed.
// Sending only queues the invoice; the worker passes it to the provider.

const card = 'rounded-md border border-border bg-surface p-4';

type Item = Awaited<ReturnType<typeof listOf>>['data'][number];
const listOf = (status: EinvoiceStatus) => api.call('listEinvoices', { query: { status } });

export function EinvoicesPage() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const [status, setStatus] = useState<EinvoiceStatus>('NOT_SENT');
  const list = useQuery({
    queryKey: ['einvoices', currentPropertyId ?? '', status],
    queryFn: () => listOf(status),
  });
  const counts = list.data?.counts;
  return (
    <section className="max-w-3xl">
      <h1 className="text-xl font-semibold">{t('einvoices.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('einvoices.intro')}</p>
      <SettingsCard />
      <div role="tablist" aria-label={t('einvoices.filter')} className="mt-4 flex flex-wrap gap-2">
        {EINVOICE_STATUSES.map((s) => (
          <Button
            key={s}
            role="tab"
            aria-selected={status === s}
            variant={status === s ? 'primary' : 'secondary'}
            onClick={() => setStatus(s)}
          >
            {t(`einvoices.filters.${s}`, { count: counts?.[s] ?? 0 })}
          </Button>
        ))}
      </div>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {list.data?.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('einvoices.none')}</p>
      )}
      <ul aria-label={t('einvoices.list')} className="mt-3 flex flex-col gap-3">
        {list.data?.data.map((i) => (
          <InvoiceRow key={`${i.folioId}-${i.windowNumber}`} item={i} />
        ))}
      </ul>
    </section>
  );
}

function SettingsCard() {
  const { t } = useTranslation();
  const f = useFormats();
  const session = useSession();
  const key = ['einvoice-settings', session.currentPropertyId ?? ''];
  const settings = useQuery({ queryKey: key, queryFn: () => api.call('getEinvoiceSettings', {}) });
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.call('updateEinvoiceSettings', { body: { enabled } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(key, saved);
      void queryClient.invalidateQueries({ queryKey: ['einvoices'] });
    },
  });
  const s = settings.data;
  if (!s) return null;
  const mayChange = session.permissions.includes('tax.manage');
  return (
    <div className={`${card} mt-4`} aria-label={t('einvoices.settings.label')} role="group">
      <p className="text-sm font-medium">
        {s.enabled && s.enabledAt
          ? t('einvoices.settings.on', { when: f.when(s.enabledAt) })
          : t('einvoices.settings.off')}
      </p>
      {s.sellerTin && (
        <p className="mt-1 text-sm text-text-muted">
          {t('einvoices.settings.tin', { tin: s.sellerTin })}
        </p>
      )}
      {!s.enabled && !s.providerReady && (
        <p className="mt-2 text-sm">{t('einvoices.settings.noProvider')}</p>
      )}
      {!s.enabled && s.providerReady && !s.sellerTin && (
        <p className="mt-2 text-sm">{t('einvoices.settings.noTin')}</p>
      )}
      {save.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      {mayChange && (s.enabled || (s.providerReady && s.sellerTin)) && (
        <Button
          className="mt-3"
          variant={s.enabled ? 'secondary' : 'primary'}
          disabled={save.isPending}
          onClick={() => save.mutate(!s.enabled)}
        >
          {s.enabled ? t('einvoices.settings.switchOff') : t('einvoices.settings.switchOn')}
        </Button>
      )}
    </div>
  );
}

function InvoiceRow({ item }: { item: Item }) {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const send = useMutation({
    mutationFn: () =>
      api.call('submitEinvoice', {
        params: { folioId: item.folioId, windowNumber: item.windowNumber },
        body: {},
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['einvoices'] }),
  });
  const canSend = ['NOT_SENT', 'REJECTED', 'FAILED'].includes(item.status);
  return (
    <li className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {item.invoiceNumber} · {f.money(item.totalMinor)}
        </p>
        <p className="text-sm">{t(`einvoices.status.${item.status}`)}</p>
      </div>
      <p className="mt-1 text-sm">
        {t('einvoices.billTo', { name: item.billTo })} ·{' '}
        {item.buyerTin
          ? t('einvoices.buyerTin', { tin: item.buyerTin })
          : t('einvoices.noBuyerTin')}
      </p>
      {item.irn && <p className="mt-1 text-sm">{t('einvoices.irn', { irn: item.irn })}</p>}
      {item.status === 'REJECTED' && (
        <ul className="mt-2 list-disc pl-5 text-sm text-critical">
          {item.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {item.status === 'FAILED' && (
        <p className="mt-2 text-sm text-critical">
          {t('einvoices.attempts', { count: item.attempts })}
        </p>
      )}
      {send.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(send.error)}
        </Alert>
      )}
      {canSend && (
        <Button
          className="mt-3"
          aria-label={t('einvoices.sendLabel', { number: item.invoiceNumber })}
          disabled={send.isPending}
          onClick={() => send.mutate()}
        >
          {item.status === 'NOT_SENT' ? t('einvoices.send') : t('einvoices.sendAgain')}
        </Button>
      )}
    </li>
  );
}
