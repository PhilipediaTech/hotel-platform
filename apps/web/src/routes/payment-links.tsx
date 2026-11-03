import type { PaymentIntentItem } from '@hotel/shared';
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
import { toMinor } from '../lib/money.ts';
import { useFormats } from './reservations.tsx';

// Payment links (PRD M4-08 "I send a payment link … to a guest by WhatsApp or email"; T-070):
// the links asked for on a folio window or a booking's deposit, with their status; a new link
// for an amount, emailed to the guest or copied; "Check payment" asks the provider now (a job
// also asks every few minutes). WhatsApp comes with notifications (T-024).

type Intent = z.output<typeof PaymentIntentItem>;
type Target = { folioId: string; windowNumber: number } | { reservationId: string };

const STATUS_TONE: Record<Intent['status'], string> = {
  CREATED: 'bg-surface-muted text-text-muted',
  SUCCEEDED: 'bg-success-subtle text-success',
  FAILED: 'bg-critical-subtle text-critical',
  EXPIRED: 'bg-surface-muted text-text-muted',
};

export function PaymentLinks({
  target,
  suggestedMinor,
  onPaid,
}: {
  target: Target;
  /** What is still owed, offered as the amount. */
  suggestedMinor: string;
  onPaid: () => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const query =
    'folioId' in target ? { folioId: target.folioId } : { reservationId: target.reservationId };
  const key = ['payment-links', currentPropertyId ?? '', JSON.stringify(query)];
  const links = useQuery({
    queryKey: key,
    queryFn: () => api.call('listPaymentIntents', { query }),
  });
  const [amount, setAmount] = useState('');
  const [email, setEmail] = useState('');
  const [send, setSend] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const minor = toMinor(amount === '' ? (Number(suggestedMinor) / 100).toFixed(2) : amount);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () =>
      api.call('createPaymentIntent', {
        body: { ...target, amountMinor: minor ?? '0', email: email.trim(), send },
      }),
    onSuccess: () => {
      setAmount('');
      refresh();
    },
  });
  const check = useMutation({
    mutationFn: (id: string) => api.call('checkPaymentIntent', { params: { paymentIntentId: id } }),
    onSuccess: (intent) => {
      refresh();
      if (intent.status === 'SUCCEEDED') onPaid();
    },
  });
  const copy = async (intent: Intent) => {
    try {
      await navigator.clipboard.writeText(intent.checkoutUrl);
      setCopied(intent.id);
    } catch {
      setCopied(null);
    }
  };
  const data = links.data?.data ?? [];
  return (
    <section aria-label={t('paymentLinks.title')} className="mt-6">
      <h2 className="font-semibold">{t('paymentLinks.title')}</h2>
      {data.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2 text-sm">
          {data.map((i) => (
            <li
              key={i.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-2"
            >
              <span className="font-medium">{f.money(i.amountMinor)}</span>
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONE[i.status]}`}>
                {t(`paymentLinks.status.${i.status}`)}
              </span>
              <span className="text-text-muted">
                {i.sentTo
                  ? t('paymentLinks.sentTo', { email: i.sentTo, when: f.when(i.createdAt) })
                  : t('paymentLinks.made', { when: f.when(i.createdAt) })}
              </span>
              {i.status !== 'SUCCEEDED' && (
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void copy(i)}>
                    {copied === i.id ? t('paymentLinks.copied') : t('paymentLinks.copy')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={check.isPending}
                    onClick={() => check.mutate(i.id)}
                  >
                    {t('paymentLinks.check')}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {check.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(check.error)}
        </Alert>
      )}
      <form
        aria-label={t('paymentLinks.new')}
        className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (minor !== null && email.trim() !== '') create.mutate();
        }}
      >
        <Field id="pl-amount" label={t('payments.amount')}>
          <Input
            id="pl-amount"
            inputMode="decimal"
            placeholder={f.money(suggestedMinor)}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field id="pl-email" label={t('paymentLinks.email')}>
          <Input
            id="pl-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
          {t('paymentLinks.sendByEmail')}
        </label>
        <Button type="submit" disabled={minor === null || email.trim() === '' || create.isPending}>
          {t('paymentLinks.create')}
        </Button>
        {create.data && (
          <Alert tone="success" className="w-full">
            {create.data.sentTo
              ? t('paymentLinks.emailed', { email: create.data.sentTo })
              : t('paymentLinks.ready')}{' '}
            <a
              href={create.data.checkoutUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {create.data.checkoutUrl}
            </a>
          </Alert>
        )}
        {create.error && (
          <Alert tone="critical" className="w-full">
            {errorMessage(create.error)}
          </Alert>
        )}
      </form>
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
