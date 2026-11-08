import type { VisitorItem } from '@hotel/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import visitorStrings from '../i18n/en/visitors.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { uploadFile } from '../lib/files.ts';
import { errorMessage } from '../lib/form.ts';
import { useFormats } from './reservations.tsx';

// The front desk's Visitors tab (PRD M14-04; T-057): sign a visitor in against a checked-in
// guest, sign them out, see who is still in. Loaded with its strings when the tab opens.

registerStrings(visitorStrings);

type Visitor = z.output<typeof VisitorItem>;

export const visitorsKey = (propertyId: string | null) => [
  'front-desk',
  propertyId ?? '',
  'visitors',
];

export function VisitorsPanel() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const [date, setDate] = useState('');
  const list = useQuery({
    queryKey: [...visitorsKey(currentPropertyId), date],
    queryFn: () => api.call('listVisitors', { query: date ? { date } : {} }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const rows = list.data?.data ?? [];
  const stillIn = rows.filter((v) => !v.signedOutAt);
  const left = rows.filter((v) => v.signedOutAt);

  return (
    <div className="mt-4 flex flex-col gap-4">
      <SignIn />
      {list.error && <Alert tone="critical">{errorMessage(list.error)}</Alert>}
      <section aria-label={t('visitors.stillIn')}>
        <h2 className="font-semibold">{t('visitors.stillIn')}</h2>
        {list.data && stillIn.length === 0 && (
          <p className="text-sm text-text-muted">{t('visitors.noneIn')}</p>
        )}
        <ul className="mt-2 flex flex-col gap-2">
          {stillIn.map((v) => (
            <Row key={v.id} visitor={v} />
          ))}
        </ul>
        {stillIn.length > 0 && (
          <p className="mt-2 text-xs text-text-muted">{t('visitors.stayingOverHint')}</p>
        )}
      </section>
      <section aria-label={t('visitors.left')}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-semibold">{t('visitors.left')}</h2>
          <div className="flex flex-col gap-1">
            <Label htmlFor="visitors-date">{t('visitors.date')}</Label>
            <Input
              id="visitors-date"
              type="date"
              className="w-44"
              value={date || (list.data?.date ?? '')}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>
        {list.data && left.length === 0 && (
          <p className="text-sm text-text-muted">{t('visitors.noneLeft')}</p>
        )}
        <ul className="mt-2 flex flex-col gap-2">
          {left.map((v) => (
            <Row key={v.id} visitor={v} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function SignIn() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const queryClient = useQueryClient();
  const guests = useQuery({
    queryKey: ['front-desk', currentPropertyId ?? '', 'in-house', 'visitors'],
    queryFn: () => api.call('listInHouse', {}),
  });
  const [stayId, setStayId] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: async () => {
      const idFileId = photo ? await uploadFile('Visitor', photo) : null;
      return api.call('signInVisitor', {
        body: { stayId, name, phone: phone.trim() || null, note: note.trim() || null, idFileId },
      });
    },
    onSuccess: () => {
      setStayId('');
      setName('');
      setPhone('');
      setNote('');
      setPhoto(null);
      if (fileInput.current) fileInput.current.value = '';
      void queryClient.invalidateQueries({ queryKey: visitorsKey(currentPropertyId) });
    },
  });
  const options = guests.data?.data ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form
      aria-label={t('visitors.signIn')}
      onSubmit={submit}
      className="grid max-w-2xl gap-3 rounded-md border border-border p-4 sm:grid-cols-2"
    >
      <h2 className="font-semibold sm:col-span-2">{t('visitors.signIn')}</h2>
      {guests.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(guests.error)}
        </Alert>
      )}
      {guests.data && options.length === 0 && (
        <p className="text-sm text-text-muted sm:col-span-2">{t('visitors.noGuests')}</p>
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor="visitor-guest">{t('visitors.guest')}</Label>
        <select
          id="visitor-guest"
          required
          className="h-10 rounded-md border border-border bg-surface px-2 text-sm"
          value={stayId}
          onChange={(e) => setStayId(e.target.value)}
        >
          <option value="">{t('visitors.chooseGuest')}</option>
          {options.map((s) => (
            <option key={s.stayId} value={s.stayId}>
              {s.roomNumber ? `${s.roomNumber} · ` : ''}
              {s.guest.firstName} {s.guest.lastName}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="visitor-name">{t('visitors.name')}</Label>
        <Input id="visitor-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="visitor-phone">{t('visitors.phone')}</Label>
        <Input
          id="visitor-phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="visitor-note">{t('visitors.note')}</Label>
        <Input id="visitor-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label htmlFor="visitor-photo">{t('visitors.photo')}</Label>
        <input
          id="visitor-photo"
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          className="text-sm"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        />
      </div>
      {save.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {t('visitors.submit')}
        </Button>
      </div>
    </form>
  );
}

function Row({ visitor }: { visitor: Visitor }) {
  const { t } = useTranslation();
  const f = useFormats();
  const { currentPropertyId } = useSession();
  const queryClient = useQueryClient();
  const out = useMutation({
    mutationFn: () => api.call('signOutVisitor', { params: { visitorId: visitor.id }, body: {} }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: visitorsKey(currentPropertyId) }),
  });
  const photo = useMutation({
    mutationFn: () =>
      api.call('getFileDownloadUrl', { params: { fileId: visitor.idFileId ?? '' } }),
    onSuccess: (link) => window.open(link.url, '_blank', 'noopener'),
  });
  const { name, guestName: guest, roomNumber: room } = visitor;
  const error = out.error ?? photo.error;

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3 text-sm">
      <div>
        <p className="font-medium">
          {name}
          {visitor.phone ? (
            <span className="ml-1 text-xs font-normal text-text-muted">{visitor.phone}</span>
          ) : null}
        </p>
        <p className="text-text-muted">
          {room ? t('visitors.visiting', { guest, room }) : t('visitors.visitingNoRoom', { guest })}
        </p>
        <p className="text-xs text-text-muted">
          {visitor.signedOutAt
            ? t('visitors.stayed', {
                from: f.time(visitor.signedInAt),
                to: f.time(visitor.signedOutAt),
              })
            : t('visitors.cameAt', { time: f.when(visitor.signedInAt) })}
          {visitor.note ? ` · ${visitor.note}` : ''}
        </p>
        {error && <p className="text-xs text-critical">{errorMessage(error)}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {visitor.idFileId && (
          <Button
            size="sm"
            variant="ghost"
            disabled={photo.isPending}
            aria-label={t('visitors.viewPhotoNamed', { name })}
            onClick={() => photo.mutate()}
          >
            {t('visitors.viewPhoto')}
          </Button>
        )}
        {!visitor.signedOutAt && (
          <>
            <Link
              to={`/reservations/${visitor.reservationId}`}
              aria-label={t('visitors.stayingOverNamed', { name, guest })}
              className="inline-flex h-8 items-center rounded-md border border-border px-3 hover:bg-surface-muted"
            >
              {t('visitors.stayingOver')}
            </Link>
            <Button
              size="sm"
              disabled={out.isPending}
              aria-label={t('visitors.signOutNamed', { name })}
              onClick={() => out.mutate()}
            >
              {t('visitors.signOut')}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
