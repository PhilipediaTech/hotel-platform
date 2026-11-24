import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import channelStrings from '../i18n/en/channels.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(channelStrings);

// S41, T-153: OTA bookings taken in from the channel manager. Those that could not be booked
// safely wait here with their reason; staff try again once it is fixed, or mark them handled.

type Held = Awaited<ReturnType<typeof listHeld>>[number];
const listHeld = () => api.call('listChannelBookings', { query: { held: 'true' } });

export function ChannelBookings(props: {
  checkedAt: string | null;
  error: string | null;
  /** Refreshes the connection (its held count). */
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const { currentPropertyId } = useSession();
  const key = ['channel-bookings', currentPropertyId ?? ''];
  const held = useQuery({ queryKey: key, queryFn: listHeld });
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    props.onChange();
  };
  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <h2 className="font-semibold">{t('channels.bookings.title')}</h2>
      <p className="mt-1 text-sm">
        {props.checkedAt
          ? t('channels.bookings.checked', { when: f.when(props.checkedAt) })
          : t('channels.bookings.notYet')}
      </p>
      {props.error && (
        <Alert tone="critical" className="mt-2">
          {t('channels.bookings.error', { message: props.error })}
        </Alert>
      )}
      {held.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(held.error)}
        </Alert>
      )}
      {held.data && held.data.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">{t('channels.bookings.none')}</p>
      )}
      {held.data && held.data.length > 0 && (
        <>
          <p className="mt-2 text-sm font-medium">
            {t('channels.bookings.held', { count: held.data.length })}
          </p>
          <ul aria-label={t('channels.bookings.heldList')} className="mt-2 flex flex-col gap-3">
            {held.data.map((b) => (
              <HeldBooking key={b.id} booking={b} onDone={refresh} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function HeldBooking({ booking: b, onDone }: { booking: Held; onDone: () => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  const [note, setNote] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: () => api.call('retryChannelBooking', { params: { channelBookingId: b.id } }),
    onSuccess: onDone,
  });
  const dismiss = useMutation({
    mutationFn: () =>
      api.call('dismissChannelBooking', {
        params: { channelBookingId: b.id },
        body: { note: note ?? '' },
      }),
    onSuccess: onDone,
  });
  const ota = [b.otaName, b.otaCode].filter(Boolean).join(' ');
  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <p className="font-medium">
        {b.guestName}
        {ota && <span className="text-text-muted"> · {ota}</span>}
      </p>
      <p className="text-text-muted">
        {t(`channels.bookings.kind.${b.kind}`)}
        {b.arrival && b.departure && ` · ${f.date(b.arrival)} – ${f.date(b.departure)}`}
      </p>
      <p className="mt-1">
        <span className="font-medium">
          {b.holdReason ? t(`channels.bookings.reason.${b.holdReason}`) : ''}
        </span>
        {b.message && <span> · {b.message}</span>}
      </p>
      {(retry.error ?? dismiss.error) && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(retry.error ?? dismiss.error)}
        </Alert>
      )}
      {note === null ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="secondary" disabled={retry.isPending} onClick={() => retry.mutate()}>
            {t('channels.bookings.retry')}
          </Button>
          <Button variant="secondary" onClick={() => setNote('')}>
            {t('channels.bookings.dismiss')}
          </Button>
        </div>
      ) : (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            dismiss.mutate();
          }}
        >
          <Label htmlFor={`note-${b.id}`}>{t('channels.bookings.note')}</Label>
          <Input
            id={`note-${b.id}`}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={dismiss.isPending || note.trim() === ''}>
              {t('channels.bookings.dismissConfirm')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setNote(null)}>
              {t('channels.bookings.cancel')}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
