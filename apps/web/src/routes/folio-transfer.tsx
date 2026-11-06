import type { ApprovalPending, FolioItem } from '@hotel/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';
import { useFormats } from './reservations.tsx';
import foliosStrings from '../i18n/en/folios.json';
import paymentsStrings from '../i18n/en/payments.json';
import { registerStrings } from '../i18n/index.ts';

registerStrings(foliosStrings);
registerStrings(paymentsStrings);

// Folio transfer (tab 4 POST /folios/{id}/transfer; T-065): move an amount a window owes to
// another window of the folio, or to another open folio by its number (a company or paymaster
// account). Between folios a manager approves unless it is within the caller's limit.

type Folio = z.output<typeof FolioItem>;

const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';

const isPending = (r: unknown): r is z.output<typeof ApprovalPending> =>
  typeof r === 'object' && r !== null && 'approvalRequestId' in r;

export function TransferForm({ folio, windowNumber }: { folio: Folio; windowNumber: number }) {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const others = folio.windows.filter((w) => w.number !== windowNumber);
  const [where, setWhere] = useState<'window' | 'folio'>(others.length > 0 ? 'window' : 'folio');
  const [toWindow, setToWindow] = useState(String(others[0]?.number ?? 1));
  const [number, setNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const owes = folio.windows.find((w) => w.number === windowNumber)?.balanceMinor ?? '0';
  const minor = toMinor(amount);
  const ready =
    minor !== null && reason.trim() !== '' && (where === 'window' || number.trim() !== '');
  const move = useMutation({
    mutationFn: async () => {
      let toFolioId = folio.id;
      if (where === 'folio') {
        const wanted = number.trim().toUpperCase();
        const found = await api.call('listFolios', { query: { status: 'OPEN', q: wanted } });
        const match = found.data.find((x) => x.number === wanted);
        if (!match) throw new Error(t('transfer.noFolio', { number: wanted }));
        toFolioId = match.id;
      }
      return api.call('transferFolio', {
        params: { folioId: folio.id },
        body: {
          fromWindow: windowNumber,
          toFolioId,
          toWindow: where === 'window' ? Number(toWindow) : 1,
          amountMinor: minor ?? '0',
          reason: reason.trim(),
        },
      });
    },
    onSuccess: (result) => {
      setMessage(isPending(result) ? t('folios.sentForApproval') : t('transfer.done'));
      setAmount('');
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['folios'] });
      void queryClient.invalidateQueries({ queryKey: ['check-out'] });
    },
  });
  return (
    <form
      aria-label={t('transfer.title')}
      className="mt-6 grid items-end gap-3 rounded-md border border-border bg-surface p-4 sm:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        if (ready) move.mutate();
      }}
    >
      <h2 className="font-semibold sm:col-span-4">
        {t('transfer.heading', { n: windowNumber, owes: f.money(owes) })}
      </h2>
      <div className="flex flex-col gap-1">
        <Label htmlFor="tr-where">{t('transfer.to')}</Label>
        <select
          id="tr-where"
          className={selectClass}
          value={where}
          onChange={(e) => setWhere(e.target.value as 'window' | 'folio')}
        >
          {others.length > 0 && <option value="window">{t('transfer.window')}</option>}
          <option value="folio">{t('transfer.folio')}</option>
        </select>
      </div>
      {where === 'window' ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="tr-window">{t('folios.windowLabel')}</Label>
          <select
            id="tr-window"
            className={selectClass}
            value={toWindow}
            onChange={(e) => setToWindow(e.target.value)}
          >
            {others.map((w) => (
              <option key={w.number} value={w.number}>
                {t('checkOut.window', { n: w.number, payer: w.payerName })}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <Label htmlFor="tr-number">{t('transfer.number')}</Label>
          <Input
            id="tr-number"
            placeholder="F00012"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor="tr-amount">{t('payments.amount')}</Label>
        <Input
          id="tr-amount"
          inputMode="decimal"
          placeholder={f.money(owes)}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="tr-reason">{t('folios.reason')}</Label>
        <Input
          id="tr-reason"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="sm:col-span-4">
        <Button type="submit" variant="secondary" disabled={!ready || move.isPending}>
          {t('transfer.button')}
        </Button>
      </div>
      {move.error && (
        <Alert tone="critical" className="sm:col-span-4">
          {move.error instanceof Error && !('code' in move.error)
            ? move.error.message
            : errorMessage(move.error)}
        </Alert>
      )}
      {message && (
        <Alert tone="success" className="sm:col-span-4">
          {message}
        </Alert>
      )}
    </form>
  );
}
