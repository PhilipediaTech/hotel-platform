import type { UnmatchedTransferItem } from '@hotel/shared';
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
import { errorMessage } from '../lib/form.ts';
import { useFormats } from './reservations.tsx';
import foliosStrings from '../i18n/en/folios.json';
import { registerStrings } from '../i18n/index.ts';

registerStrings(foliosStrings);

// Unmatched transfers (PRD M4 rule 7; tab 4 GET /unmatched-transfers, POST
// /unmatched-transfers/{id}/match; T-071), a view of the folios screen (S11): money that came
// to a virtual account with no owner able to take it. Each is matched to an open folio found
// by number, guest or room; after 24 hours unmatched it is marked overdue (the Leakage Guard
// has raised an alert).

type Transfer = z.output<typeof UnmatchedTransferItem>;

export function UnmatchedTransfers() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const key = ['unmatched-transfers', currentPropertyId ?? ''];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api.call('listUnmatchedTransfers', { query: {} }),
  });
  const data = list.data?.data ?? [];
  const open = data.filter((x) => x.matchedPaymentId === null);
  const matched = data.filter((x) => x.matchedPaymentId !== null);
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('unmatched.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('unmatched.intro')}</p>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {list.data && open.length === 0 && <p className="mt-4 text-sm">{t('unmatched.none')}</p>}
      <ul className="mt-4 flex flex-col gap-3" aria-label={t('unmatched.toMatch')}>
        {open.map((x) => (
          <TransferRow key={x.id} transfer={x} queryKey={key} />
        ))}
      </ul>
      {matched.length > 0 && (
        <>
          <h2 className="mt-6 font-semibold">{t('unmatched.matched')}</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm" aria-label={t('unmatched.matched')}>
            {matched.map((x) => (
              <li key={x.id}>
                <Summary transfer={x} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Summary({ transfer: x }: { transfer: Transfer }) {
  const { t } = useTranslation();
  const f = useFormats();
  return (
    <span className="flex flex-wrap items-baseline gap-2">
      <span className="font-medium">{f.money(x.amountMinor)}</span>
      <span>{x.senderName ?? t('unmatched.unknownSender')}</span>
      <span className="text-text-muted">
        {f.when(x.receivedAt)} · {x.reference}
      </span>
      {x.overdue && (
        <span className="rounded bg-critical-subtle px-2 py-0.5 text-xs font-medium text-critical">
          {t('unmatched.overdue')}
        </span>
      )}
    </span>
  );
}

function TransferRow({ transfer, queryKey }: { transfer: Transfer; queryKey: string[] }) {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const { currentPropertyId } = useSession();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const folios = useQuery({
    queryKey: ['folios', currentPropertyId ?? '', 'list', 'OPEN', '', q],
    queryFn: () => api.call('listFolios', { query: { status: 'OPEN', q } }),
    enabled: q !== '',
  });
  const match = useMutation({
    mutationFn: (folioId: string) =>
      api.call('matchUnmatchedTransfer', {
        params: { unmatchedTransferId: transfer.id },
        body: { folioId, ...(note.trim() ? { note: note.trim() } : {}) },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ['folios'] });
    },
  });
  return (
    <li className="rounded-md border border-border bg-surface p-3">
      <Summary transfer={transfer} />
      <form
        className="mt-2 flex flex-wrap items-end gap-3"
        aria-label={t('unmatched.findFolio', { amount: f.money(transfer.amountMinor) })}
        onSubmit={(e) => {
          e.preventDefault();
          setQ(text.trim());
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor={`um-q-${transfer.id}`}>{t('unmatched.find')}</Label>
          <Input
            id={`um-q-${transfer.id}`}
            className="w-56"
            placeholder={t('folios.findHint')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`um-note-${transfer.id}`}>{t('unmatched.note')}</Label>
          <Input
            id={`um-note-${transfer.id}`}
            className="w-56"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={text.trim() === ''}>
          {t('unmatched.search')}
        </Button>
      </form>
      {folios.data && (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {folios.data.data.length === 0 && <li>{t('unmatched.noFolio')}</li>}
          {folios.data.data.map((folio) => (
            <li key={folio.id} className="flex flex-wrap items-center gap-2">
              <span>
                {folio.number} · {folio.name}
                {folio.roomNumber
                  ? ` · ${t('unmatched.room', { room: folio.roomNumber })}`
                  : ''} · {f.money(folio.balanceMinor)}
              </span>
              <Button size="sm" disabled={match.isPending} onClick={() => match.mutate(folio.id)}>
                {t('unmatched.matchHere')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {match.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(match.error)}
        </Alert>
      )}
    </li>
  );
}
