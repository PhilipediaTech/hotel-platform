import {
  EMPLOYMENT_TYPES,
  type AttendanceKind,
  type AttendanceSettings,
  type EmploymentType,
  type MyAttendance,
} from '@hotel/shared';
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
import { uploadFile } from '../lib/files.ts';
import { errorMessage } from '../lib/form.ts';
import attendanceStrings from '../i18n/en/attendance.json';
import staffStrings from '../i18n/en/staff.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(attendanceStrings);
registerStrings(staffStrings);

// S36 attendance (PRD M7-04; T-138): clocking in and out (a photo on the shared tablet; the
// network or location check on a phone, location only after the privacy notice and consent),
// the day's clocks for managers, and the settings. The API decides; this screen explains.

type Mine = z.output<typeof MyAttendance>;
type Position = { latitude: number; longitude: number; accuracyMeters: number | null };

const textareaClass = 'min-h-24 rounded-md border border-border bg-surface p-2 text-sm';

function useRoot() {
  const { currentPropertyId } = useSession();
  return ['attendance', currentPropertyId ?? ''];
}

/** The device's position, or null when it can't be read. */
function readPosition(): Promise<Position | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracyMeters: Math.round(p.coords.accuracy),
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  });
}

export function AttendancePage() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('at.title')}</h1>
      {permissions.includes('attendance.clock') && <Clock />}
      {permissions.includes('timesheet.approve') && <Day />}
      {permissions.includes('staff.manage') && <SettingsForm />}
    </section>
  );
}

function Clock() {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const f = useFormats();
  const [photo, setPhoto] = useState<File | null>(null);
  const [noLocation, setNoLocation] = useState(false);
  const mine = useQuery({
    queryKey: [...root, 'me'],
    queryFn: () => api.call('getMyAttendance', {}),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: root });
  const consent = useMutation({
    mutationFn: (value: boolean) => api.call('setLocationConsent', { body: { consent: value } }),
    onSuccess: refresh,
  });
  const clock = useMutation({
    mutationFn: async (v: { kind: AttendanceKind; me: Mine }) => {
      setNoLocation(false);
      const photoFileId =
        v.me.needsPhoto && photo ? await uploadFile('AttendanceEvent', photo) : null;
      let location: Position | null = null;
      if (v.me.locationCheck && v.me.consentGiven) {
        location = await readPosition();
        if (!location && !v.me.networkCheck) setNoLocation(true);
      }
      return api.call('clockAttendance', { body: { kind: v.kind, photoFileId, location } });
    },
    onSuccess: () => {
      setPhoto(null);
      refresh();
    },
  });
  const me = mine.data;
  const kind: AttendanceKind = me?.inSince ? 'OUT' : 'IN';
  return (
    <section
      aria-labelledby="at-mine"
      className="mt-4 rounded-md border border-border bg-surface p-4"
    >
      <h2 id="at-mine" className="font-semibold">
        {t('at.mine')}
      </h2>
      {mine.error && <Alert tone="critical">{errorMessage(mine.error)}</Alert>}
      {me && (
        <div className="mt-2 grid gap-3 text-sm">
          <p className="text-text-muted">{t(`at.channels.${me.channel}`)}</p>
          {me.blocked ? (
            <Alert tone="info">{t(`at.blocked.${me.blocked}`)}</Alert>
          ) : (
            <>
              <p className="font-medium">
                {me.inSince ? t('at.inSince', { time: f.time(me.inSince) }) : t('at.out')}
              </p>
              {me.networkCheck && !me.locationCheck && <p>{t('at.network')}</p>}
              {me.networkCheck && me.locationCheck && <p>{t('at.networkOrLocation')}</p>}
              {!me.networkCheck && me.locationCheck && <p>{t('at.locationOnly')}</p>}
              {me.locationCheck && (
                <div className="rounded-md border border-border p-3">
                  <h3 className="font-medium">{t('at.consentTitle')}</h3>
                  <p className="mt-1 whitespace-pre-line">{me.privacyNotice}</p>
                  {me.consentGiven ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span>{t('at.consentGiven')}</span>
                      <Button
                        variant="ghost"
                        disabled={consent.isPending}
                        onClick={() => consent.mutate(false)}
                      >
                        {t('at.withdraw')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      className="mt-2"
                      disabled={consent.isPending}
                      onClick={() => consent.mutate(true)}
                    >
                      {t('at.agree')}
                    </Button>
                  )}
                </div>
              )}
              {me.needsPhoto && (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="at-photo">{t('at.photo')}</Label>
                  <input
                    id="at-photo"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="user"
                    onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                  />
                  <p className="text-text-muted">{t('at.photoHint')}</p>
                </div>
              )}
              <div>
                <Button
                  className="h-12 px-6"
                  disabled={clock.isPending || (me.needsPhoto && !photo)}
                  onClick={() => clock.mutate({ kind, me })}
                >
                  {kind === 'IN' ? t('at.clockIn') : t('at.clockOut')}
                </Button>
              </div>
            </>
          )}
          {noLocation && <Alert tone="critical">{t('at.noLocation')}</Alert>}
          {(clock.error ?? consent.error) && (
            <Alert tone="critical">{errorMessage(clock.error ?? consent.error)}</Alert>
          )}
          {me.staff && (
            <div>
              <h3 className="font-medium">{t('at.recent')}</h3>
              {me.recent.length === 0 ? (
                <p className="text-text-muted">{t('at.noRecent')}</p>
              ) : (
                <ul aria-label={t('at.recent')} className="mt-1">
                  {me.recent.map((e) => (
                    <li key={e.id}>
                      {f.when(e.at)} · {t(`at.kinds.${e.kind}`)} · {t(`at.channels.${e.channel}`)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Day() {
  const { t } = useTranslation();
  const root = useRoot();
  const f = useFormats();
  const [date, setDate] = useState('');
  const day = useQuery({
    queryKey: [...root, 'day', date],
    queryFn: () => api.call('listAttendance', { query: date ? { date } : {} }),
  });
  const photo = useMutation({
    mutationFn: (fileId: string) => api.call('getFileDownloadUrl', { params: { fileId } }),
    onSuccess: (link) => window.open(link.url, '_blank', 'noopener'),
  });
  const data = day.data;
  return (
    <section aria-labelledby="at-day" className="mt-6">
      <h2 id="at-day" className="font-semibold">
        {t('at.day')}
      </h2>
      <div className="mt-2 flex flex-col gap-1">
        <Label htmlFor="at-date">{t('at.date')}</Label>
        <Input
          id="at-date"
          type="date"
          className="max-w-48"
          value={date || data?.date || ''}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      {(day.error ?? photo.error) && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(day.error ?? photo.error)}
        </Alert>
      )}
      {data && (
        <div className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <h3 className="font-medium">{t('at.inNow')}</h3>
            {data.inNow.length === 0 ? (
              <p className="text-text-muted">{t('at.nobodyIn')}</p>
            ) : (
              <ul aria-label={t('at.inNow')}>
                {data.inNow.map((p) => (
                  <li key={p.id}>
                    ST-{p.number} {p.name} · {t('at.since', { time: f.when(p.since) })}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="font-medium">{t('at.dayList')}</h3>
            {data.events.length === 0 ? (
              <p className="text-text-muted">{t('at.none')}</p>
            ) : (
              <ul aria-label={t('at.dayList')} className="flex flex-col gap-1">
                {data.events.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      {f.time(e.at)} · {e.staff.name} · {t(`at.kinds.${e.kind}`)} ·{' '}
                      {[
                        t(`at.channels.${e.channel}`),
                        e.deviceLabel,
                        e.ip,
                        e.located ? t('at.located') : null,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    </span>
                    {e.photoFileId && (
                      <Button
                        variant="ghost"
                        disabled={photo.isPending}
                        onClick={() => e.photoFileId && photo.mutate(e.photoFileId)}
                      >
                        {t('at.viewPhoto')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SettingsForm() {
  const root = useRoot();
  const current = useQuery({
    queryKey: [...root, 'settings'],
    queryFn: () => api.call('getAttendanceSettings', {}),
  });
  if (!current.data) {
    return current.error ? (
      <Alert tone="critical" className="mt-6">
        {errorMessage(current.error)}
      </Alert>
    ) : null;
  }
  return (
    <SettingsFields
      key={JSON.stringify(current.data.settings)}
      initial={current.data.settings}
      yourAddress={current.data.yourAddress}
    />
  );
}

function SettingsFields(props: { initial: AttendanceSettings; yourAddress: string | null }) {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const [s, setS] = useState(props.initial);
  const [addresses, setAddresses] = useState(props.initial.network.addresses.join('\n'));
  const save = useMutation({
    mutationFn: () =>
      api.call('updateAttendanceSettings', {
        body: {
          ...s,
          network: {
            ...s.network,
            addresses: addresses
              .split('\n')
              .map((a) => a.trim())
              .filter(Boolean),
          },
        },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: root }),
  });
  const here = useMutation({
    mutationFn: readPosition,
    onSuccess: (p) => {
      if (p) {
        setS({ ...s, location: { ...s.location, latitude: p.latitude, longitude: p.longitude } });
      }
    },
  });
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  return (
    <form
      aria-label={t('at.settings')}
      className="mt-6 grid gap-3 rounded-md border border-border bg-surface p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="font-semibold">{t('at.settings')}</h2>
      <fieldset>
        <legend className="font-medium">{t('at.types')}</legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {EMPLOYMENT_TYPES.map((type: EmploymentType) => (
            <label key={type} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={s.employmentTypes.includes(type)}
                onChange={(e) =>
                  setS({
                    ...s,
                    employmentTypes: e.target.checked
                      ? [...s.employmentTypes, type]
                      : s.employmentTypes.filter((x) => x !== type),
                  })
                }
              />
              {t(`st.types.${type}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={s.phoneAllowed}
          onChange={(e) => setS({ ...s, phoneAllowed: e.target.checked })}
        />
        {t('at.phoneAllowed')}
      </label>
      {s.phoneAllowed && (
        <>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.network.enabled}
              onChange={(e) => setS({ ...s, network: { ...s.network, enabled: e.target.checked } })}
            />
            {t('at.networkOn')}
          </label>
          {s.network.enabled && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="at-addresses">{t('at.addresses')}</Label>
              <textarea
                id="at-addresses"
                className={textareaClass}
                value={addresses}
                onChange={(e) => setAddresses(e.target.value)}
              />
              {props.yourAddress && (
                <Button
                  type="button"
                  variant="ghost"
                  className="self-start"
                  onClick={() =>
                    setAddresses(
                      addresses ? `${addresses}\n${props.yourAddress}` : (props.yourAddress ?? ''),
                    )
                  }
                >
                  {t('at.addMine', { address: props.yourAddress })}
                </Button>
              )}
            </div>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.location.enabled}
              onChange={(e) =>
                setS({ ...s, location: { ...s.location, enabled: e.target.checked } })
              }
            />
            {t('at.locationOn')}
          </label>
          {s.location.enabled && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="at-lat">{t('at.latitude')}</Label>
                <Input
                  id="at-lat"
                  inputMode="decimal"
                  value={s.location.latitude ?? ''}
                  onChange={(e) =>
                    setS({ ...s, location: { ...s.location, latitude: num(e.target.value) } })
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="at-lng">{t('at.longitude')}</Label>
                <Input
                  id="at-lng"
                  inputMode="decimal"
                  value={s.location.longitude ?? ''}
                  onChange={(e) =>
                    setS({ ...s, location: { ...s.location, longitude: num(e.target.value) } })
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="at-radius">{t('at.radius')}</Label>
                <Input
                  id="at-radius"
                  type="number"
                  value={s.location.radiusMeters}
                  onChange={(e) =>
                    setS({
                      ...s,
                      location: { ...s.location, radiusMeters: Number(e.target.value) },
                    })
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                className="self-start"
                disabled={here.isPending}
                onClick={() => here.mutate()}
              >
                {t('at.useHere')}
              </Button>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="at-notice">{t('at.notice')}</Label>
            <textarea
              id="at-notice"
              className={textareaClass}
              value={s.privacyNotice}
              onChange={(e) => setS({ ...s, privacyNotice: e.target.value })}
            />
          </div>
        </>
      )}
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">{t('at.saved')}</Alert>}
      <div>
        <Button type="submit" disabled={save.isPending}>
          {t('at.save')}
        </Button>
      </div>
    </form>
  );
}
