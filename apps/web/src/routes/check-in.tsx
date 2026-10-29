import {
  ID_TYPES,
  localDate,
  STAY_PURPOSES,
  type RegistrationField,
  type ReservationItem,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api, ApiError } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { uploadFile } from '../lib/files.ts';
import { useFormats } from './reservations.tsx';

// Check-in (PRD M3-08, M3-19, M3 rules 2 and 6; T-051): on the reservation page, a confirmed
// guest arriving today gets their room, the registration fields the property requires, a
// signature on screen or on the printed card, and key cards. The card prints from its own
// page; checked-in stays show their key log.

type Reservation = z.output<typeof ReservationItem>;
type Stay = Reservation['stays'][number];
type Registration = Partial<Record<RegistrationField, string>>;

const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';
const ID_FIELDS: RegistrationField[] = ['idType', 'idNumber', 'idExpiry'];

function useProperty() {
  const session = useSession();
  return session.properties.find((p) => p.id === session.currentPropertyId);
}

/**
 * M3 rule 2: confirmed, arriving today or overdue, and the desk may check in. A day-use stay
 * (T-052) checks in on its date until its time is up.
 */
export function canCheckIn(
  stay: Stay,
  today: string,
  permissions: readonly string[],
  now = new Date(),
) {
  const open = stay.dayUse
    ? stay.arrival === today && Date.parse(stay.dayUse.endsAt) > now.getTime()
    : stay.arrival <= today && stay.departure > today;
  return stay.status === 'CONFIRMED' && open && permissions.includes('reservation.checkin');
}

export function CheckInPanel({
  reservation,
  stay,
  onDone,
  startOpen = false,
}: {
  reservation: Reservation;
  stay: Stay;
  onDone: () => void;
  /** Open at once (a walk-in or day-use just sold: T-052). */
  startOpen?: boolean;
}) {
  const { t } = useTranslation();
  const property = useProperty();
  const required = property?.registrationFields ?? [];
  const [open, setOpen] = useState(startOpen);
  const [roomId, setRoomId] = useState('');
  const [reg, setReg] = useState<Registration>({});
  const [scan, setScan] = useState<File | null>(null);
  const [onScreen, setOnScreen] = useState(false);
  const [keys, setKeys] = useState('1');
  const pad = useRef<HTMLCanvasElement | null>(null);
  const [signed, setSigned] = useState(false);
  const rooms = useQuery({
    queryKey: ['rooms', reservation.id, 'for-stay', stay.id, stay.version],
    queryFn: async () =>
      (await api.call('listAssignableRooms', { params: { stayId: stay.id } })).data,
    enabled: open && !stay.roomId,
  });
  const set = (field: RegistrationField) => (value: string) =>
    setReg((r) => ({ ...r, [field]: value }));
  const missing = required.filter((f) => !reg[f]?.trim());
  const ready =
    (stay.roomId !== null || roomId !== '') && missing.length === 0 && (!onScreen || signed);

  const checkIn = useMutation({
    mutationFn: async () => {
      const idFileId =
        scan && required.some((f) => ID_FIELDS.includes(f))
          ? await uploadFile('IdDocument', scan)
          : undefined;
      let signatureFileId: string | undefined;
      if (onScreen && pad.current) {
        const blob = await new Promise<Blob | null>((resolve) => pad.current?.toBlob(resolve));
        if (blob) {
          signatureFileId = await uploadFile(
            'RegistrationCard',
            new File([blob], 'signature.png', { type: 'image/png' }),
          );
        }
      }
      const registration = Object.fromEntries(
        required.filter((f) => reg[f]?.trim()).map((f) => [f, reg[f]?.trim()]),
      );
      return api.call(
        'checkIn',
        {
          params: { stayId: stay.id },
          body: {
            ...(roomId ? { roomId } : {}),
            registration: { ...registration, ...(idFileId ? { idFileId } : {}) },
            ...(signatureFileId ? { signatureFileId } : {}),
            keysIssued: Number(keys) || 0,
          },
        },
        { ifMatch: `"${stay.version}"` },
      );
    },
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });

  if (!open) {
    return (
      <Button className="mt-2" size="sm" onClick={() => setOpen(true)}>
        {t('checkIn.open')}
      </Button>
    );
  }

  const fieldError =
    checkIn.error instanceof ApiError && checkIn.error.code === 'ROOM_NOT_READY'
      ? t('checkIn.notReady')
      : null;

  return (
    <form
      aria-label={t('checkIn.title', { name: `${stay.guest.firstName} ${stay.guest.lastName}` })}
      className="mt-3 flex flex-col gap-4 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) checkIn.mutate();
      }}
    >
      <h3 className="font-semibold">
        {t('checkIn.title', { name: `${stay.guest.firstName} ${stay.guest.lastName}` })}
      </h3>

      {stay.roomNumber ? (
        <p className="text-sm">{t('checkIn.room', { room: stay.roomNumber })}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`ci-room-${stay.id}`}>{t('reservations.room.label')}</Label>
          <select
            id={`ci-room-${stay.id}`}
            className={selectClass}
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          >
            <option value="">{t('reservations.room.pick')}</option>
            {(rooms.data ?? []).map((r) => (
              <option key={r.id} value={r.id} disabled={r.problems.length > 0}>
                {r.number} · {t(`rooms.hk.${r.hkStatus}`)}
                {r.problems.length > 0
                  ? ` · ${r.problems.map((p) => t(`reservations.room.problems.${p}`)).join(', ')}`
                  : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {required.length > 0 && (
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-medium">{t('checkIn.registration')}</legend>
          {required.includes('nationality') && (
            <TextField
              id={`ci-nat-${stay.id}`}
              label={t('checkIn.fields.nationality')}
              hint={t('checkIn.nationalityHint')}
              value={reg.nationality ?? ''}
              maxLength={2}
              onChange={set('nationality')}
            />
          )}
          {required.includes('address') && (
            <TextField
              id={`ci-addr-${stay.id}`}
              label={t('checkIn.fields.address')}
              value={reg.address ?? ''}
              maxLength={300}
              onChange={set('address')}
            />
          )}
          {required.includes('purpose') && (
            <Choice
              id={`ci-purpose-${stay.id}`}
              label={t('checkIn.fields.purpose')}
              value={reg.purpose ?? ''}
              onChange={set('purpose')}
              options={STAY_PURPOSES.map((p) => ({ value: p, label: t(`checkIn.purposes.${p}`) }))}
            />
          )}
          {required.includes('idType') && (
            <Choice
              id={`ci-idtype-${stay.id}`}
              label={t('checkIn.fields.idType')}
              value={reg.idType ?? ''}
              onChange={set('idType')}
              options={ID_TYPES.map((p) => ({ value: p, label: t(`checkIn.idTypes.${p}`) }))}
            />
          )}
          {required.includes('idNumber') && (
            <TextField
              id={`ci-idno-${stay.id}`}
              label={t('checkIn.fields.idNumber')}
              value={reg.idNumber ?? ''}
              maxLength={40}
              autoComplete="off"
              onChange={set('idNumber')}
            />
          )}
          {required.includes('idExpiry') && (
            <TextField
              id={`ci-idexp-${stay.id}`}
              label={t('checkIn.fields.idExpiry')}
              type="date"
              value={reg.idExpiry ?? ''}
              onChange={set('idExpiry')}
            />
          )}
          {required.some((f) => ID_FIELDS.includes(f)) && (
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor={`ci-scan-${stay.id}`}>{t('checkIn.scan')}</Label>
              <input
                id={`ci-scan-${stay.id}`}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="text-sm"
                onChange={(e) => setScan(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-text-muted">{t('checkIn.idPrivacy')}</p>
            </div>
          )}
        </fieldset>
      )}

      <fieldset>
        <legend className="mb-1 text-sm font-medium">{t('checkIn.signature')}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`ci-sign-${stay.id}`}
            checked={!onScreen}
            onChange={() => setOnScreen(false)}
          />
          {t('checkIn.signPaper')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`ci-sign-${stay.id}`}
            checked={onScreen}
            onChange={() => setOnScreen(true)}
          />
          {t('checkIn.signScreen')}
        </label>
        {onScreen && <SignaturePad canvas={pad} onSigned={setSigned} />}
      </fieldset>

      <TextField
        id={`ci-keys-${stay.id}`}
        label={t('checkIn.keys')}
        type="number"
        min={0}
        max={10}
        value={keys}
        onChange={setKeys}
      />

      {checkIn.error && <Alert tone="critical">{fieldError ?? errorMessage(checkIn.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!ready || checkIn.isPending}>
          {t('checkIn.submit')}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t('guests.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** A signature drawn with a finger, pen or mouse; sent as a PNG. */
function SignaturePad({
  canvas,
  onSigned,
}: {
  canvas: React.RefObject<HTMLCanvasElement | null>;
  onSigned: (signed: boolean) => void;
}) {
  const { t } = useTranslation();
  const drawing = useRef(false);
  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return [
      ((e.clientX - box.left) * e.currentTarget.width) / box.width,
      ((e.clientY - box.top) * e.currentTarget.height) / box.height,
    ] as const;
  };
  return (
    <div className="mt-2">
      <canvas
        ref={canvas}
        width={600}
        height={160}
        aria-label={t('checkIn.padLabel')}
        className="w-full max-w-xl touch-none rounded-md border border-border bg-white"
        onPointerDown={(e) => {
          const ctx = e.currentTarget.getContext('2d');
          if (!ctx) return;
          drawing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          ctx.lineWidth = 2.5;
          ctx.lineCap = 'round';
          ctx.strokeStyle = '#111';
          ctx.beginPath();
          ctx.moveTo(...point(e));
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext('2d');
          ctx?.lineTo(...point(e));
          ctx?.stroke();
          onSigned(true);
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          const c = canvas.current;
          c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
          onSigned(false);
        }}
      >
        {t('checkIn.clear')}
      </Button>
    </div>
  );
}

/** M3-19: the stay's key log; issue more cards to a checked-in guest. */
export function StayKeys({ stay }: { stay: Stay }) {
  const { t } = useTranslation();
  const { permissions, currentPropertyId } = useSession();
  const f = useFormats();
  const queryClient = useQueryClient();
  const key = ['keys', currentPropertyId ?? '', stay.id];
  const keys = useQuery({
    queryKey: key,
    queryFn: async () => (await api.call('listKeys', { params: { stayId: stay.id } })).data,
  });
  const issue = useMutation({
    mutationFn: () => api.call('issueKeys', { params: { stayId: stay.id }, body: { count: 1 } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const total = (keys.data ?? []).reduce((n, k) => n + k.count, 0);
  return (
    <div className="mt-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span>{t('checkIn.keysIssued', { count: total })}</span>
        <Link to={`/stays/${stay.id}/card`} className="text-brand underline">
          {t('checkIn.printCard')}
        </Link>
        {permissions.includes('key.issue') && (
          <Button
            size="sm"
            variant="secondary"
            disabled={issue.isPending}
            onClick={() => issue.mutate()}
          >
            {t('checkIn.issueKey')}
          </Button>
        )}
      </p>
      {(keys.data ?? []).length > 0 && (
        <ul aria-label={t('checkIn.keyLog')} className="mt-1 text-xs text-text-muted">
          {(keys.data ?? []).map((k) => (
            <li key={k.id}>
              {t('checkIn.keyLine', {
                count: k.count,
                room: k.roomNumber,
                by: k.issuedBy ?? '—',
                when: f.when(k.issuedAt),
              })}
            </li>
          ))}
        </ul>
      )}
      {issue.error && (
        <Alert tone="critical" className="mt-1">
          {errorMessage(issue.error)}
        </Alert>
      )}
    </div>
  );
}

/** The printable registration card of a checked-in stay (M3-08). */
export function RegistrationCardPage() {
  const { t } = useTranslation();
  const { stayId = '' } = useParams();
  const f = useFormats();
  const card = useQuery({
    queryKey: ['registration-card', stayId],
    queryFn: () => api.call('getRegistrationCard', { params: { stayId } }),
  });
  const signature = useQuery({
    queryKey: ['registration-card', stayId, 'signature'],
    queryFn: async () =>
      (
        await api.call('getFileDownloadUrl', {
          params: { fileId: card.data?.signatureFileId ?? '' },
        })
      ).url,
    enabled: Boolean(card.data?.signatureFileId),
    retry: false,
  });
  if (card.error) return <Alert tone="critical">{errorMessage(card.error)}</Alert>;
  const c = card.data;
  if (!c) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  const row = (label: string, value: string | null) =>
    value ? (
      <>
        <dt className="text-text-muted">{label}</dt>
        <dd>{value}</dd>
      </>
    ) : null;
  return (
    <section className="max-w-2xl">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <h1 className="text-xl font-semibold">{t('checkIn.cardTitle')}</h1>
        <Button onClick={() => window.print()}>{t('checkIn.print')}</Button>
      </div>
      <article className="mt-4 rounded-md border border-border bg-surface p-6 print:border-0">
        <header className="mb-4">
          <p className="text-lg font-semibold">{c.property.name}</p>
          <p className="text-sm text-text-muted">{c.property.address}</p>
          <p className="mt-2 text-sm">
            {t('checkIn.cardHeading', { no: c.confirmationNo, room: c.roomNumber })}
          </p>
        </header>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          {row(t('checkIn.guest'), `${c.guest.firstName} ${c.guest.lastName}`)}
          {row(t('booking.phone'), c.guest.phone)}
          {row(t('booking.email'), c.guest.email)}
          {row(t('checkIn.roomType'), c.roomTypeName)}
          {row(t('checkIn.dates'), `${f.date(c.arrival)} → ${f.date(c.departure)}`)}
          {row(
            t('checkIn.guests'),
            t('reservations.guestsCount', { adults: c.adults, children: c.children }),
          )}
          {row(t('checkIn.fields.nationality'), c.nationality)}
          {row(t('checkIn.fields.address'), c.address)}
          {row(t('checkIn.fields.purpose'), c.purpose && t(`checkIn.purposes.${c.purpose}`))}
          {row(t('checkIn.fields.idType'), c.idType && t(`checkIn.idTypes.${c.idType}`))}
          {row(t('checkIn.fields.idNumber'), c.idNumberMasked)}
          {row(t('checkIn.fields.idExpiry'), c.idExpiry && f.date(c.idExpiry))}
          {row(t('checkIn.checkedIn'), `${f.when(c.checkedInAt)} · ${c.checkedInBy ?? ''}`)}
        </dl>
        <div className="mt-8">
          <p className="text-xs text-text-muted">{t('checkIn.declaration')}</p>
          {c.signature === 'SCREEN' && signature.data ? (
            <img src={signature.data} alt={t('checkIn.signatureAlt')} className="mt-2 h-24" />
          ) : (
            <div className="mt-10 border-b border-text-muted" aria-hidden />
          )}
          <p className="mt-1 text-xs text-text-muted">
            {c.signature === 'SCREEN' && !signature.data
              ? t('checkIn.signatureChecking')
              : t('checkIn.guestSignature')}
          </p>
        </div>
      </article>
    </section>
  );
}

function TextField({
  id,
  label,
  hint,
  onChange,
  ...input
}: {
  id: string;
  label: string;
  hint?: string;
  onChange: (v: string) => void;
} & Omit<React.ComponentProps<'input'>, 'onChange' | 'id'>) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...input} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

function Choice(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      <select
        id={props.id}
        className={selectClass}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        <option value="">{t('reservations.room.pick')}</option>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Today at the current property, for the check-in button. */
/** The property's business date (T-054), or its local date until it goes live. */
export function usePropertyToday(): string {
  const property = useProperty();
  return property?.businessDate ?? localDate(new Date(), property?.timeZone ?? 'Africa/Lagos');
}
