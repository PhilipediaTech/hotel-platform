import {
  STAY_ALERT_KINDS,
  type RouteInput,
  type StayAlert,
  type StayAlertKind,
  type updateProperty,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { stayAlertsKey, useStayAlerts } from '../app/stay-alerts.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import alertStrings from '../i18n/en/front-desk-alerts.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { toMinor } from '../lib/money.ts';
import { useFormats } from './reservations.tsx';

// The front desk's Alerts tab (PRD M14-01; T-055): late check-outs with the one-tap late fee,
// departures due soon, tentative holds about to expire and tomorrow's arrivals without their
// deposit. Managers with property.setup set the timings, the fee and the WhatsApp kinds here.
// Loaded only when the tab opens, so its strings stay out of the first load.

registerStrings(alertStrings);

type Item = z.output<typeof StayAlert>;
type PatchBody = NonNullable<RouteInput<typeof updateProperty>['body']>;

const KIND_TONE: Record<StayAlertKind, string> = {
  LATE_CHECK_OUT: 'bg-critical-subtle text-critical',
  DUE_OUT_SOON: 'bg-warning-subtle text-warning',
  HOLD_EXPIRING: 'bg-warning-subtle text-warning',
  DEPOSIT_MISSING: 'bg-warning-subtle text-warning',
};

export function StayAlertsPanel() {
  const { t } = useTranslation();
  const { currentPropertyId, permissions } = useSession();
  const alerts = useStayAlerts(currentPropertyId, true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const canSet = permissions.includes('property.setup');

  return (
    <div className="mt-4">
      {canSet && (
        <Button size="sm" variant="secondary" onClick={() => setSettingsOpen((o) => !o)}>
          {settingsOpen ? t('stayAlerts.settings.close') : t('stayAlerts.settings.open')}
        </Button>
      )}
      {settingsOpen && currentPropertyId && <AlertSettings propertyId={currentPropertyId} />}
      {alerts.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(alerts.error)}
        </Alert>
      )}
      {alerts.data && alerts.data.data.length === 0 && (
        <p className="mt-4 text-sm text-text-muted">{t('stayAlerts.none')}</p>
      )}
      {alerts.data && alerts.data.data.length > 0 && (
        <ul aria-label={t('stayAlerts.list')} className="mt-4 flex flex-col gap-2">
          {alerts.data.data.map((a) => (
            <AlertRow
              key={`${a.kind}:${a.stayId}`}
              alert={a}
              feeMinor={alerts.data.lateCheckOutFeeMinor}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AlertRow({ alert, feeMinor }: { alert: Item; feeMinor: string | null }) {
  const { t } = useTranslation();
  const f = useFormats();
  const { permissions, currentPropertyId } = useSession();
  const queryClient = useQueryClient();
  const fee = useMutation({
    mutationFn: () =>
      api.call('postLateCheckOutFee', { params: { stayId: alert.stayId }, body: {} }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: stayAlertsKey(currentPropertyId) }),
  });
  const name = alert.guestName;
  const what =
    alert.kind === 'DEPOSIT_MISSING'
      ? t('stayAlerts.what.DEPOSIT_MISSING', {
          date: f.date(alert.arrival),
          amount: f.money(alert.depositDueMinor),
        })
      : t(`stayAlerts.what.${alert.kind}`, { time: alert.at ? f.time(alert.at) : '' });
  const leaving = alert.kind === 'LATE_CHECK_OUT' || alert.kind === 'DUE_OUT_SOON';

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3 text-sm">
      <div>
        <span className={cn('rounded px-1.5 text-xs', KIND_TONE[alert.kind])}>
          {t(`stayAlerts.kinds.${alert.kind}`)}
        </span>
        <p className="mt-1 font-medium">
          {alert.roomNumber ? `${alert.roomNumber} · ` : ''}
          {name}
          <span className="ml-1 text-xs font-normal text-text-muted">{alert.confirmationNo}</span>
        </p>
        <p className="text-text-muted">{what}</p>
        {alert.lateFeePosted && <p className="text-xs text-success">{t('stayAlerts.feePosted')}</p>}
        {fee.isSuccess && (
          <p role="status" className="text-xs text-success">
            {t('stayAlerts.feeDone', { amount: f.money(fee.data.amountMinor), name })}
          </p>
        )}
        {fee.error && <p className="text-xs text-critical">{errorMessage(fee.error)}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {alert.kind === 'LATE_CHECK_OUT' &&
          feeMinor &&
          !alert.lateFeePosted &&
          !fee.isSuccess &&
          permissions.includes('folio.charge') && (
            <Button
              size="sm"
              variant="secondary"
              disabled={fee.isPending}
              aria-label={t('stayAlerts.postFeeNamed', { amount: f.money(feeMinor), name })}
              onClick={() => fee.mutate()}
            >
              {t('stayAlerts.postFee', { amount: f.money(feeMinor) })}
            </Button>
          )}
        {leaving && permissions.includes('reservation.checkout') ? (
          <Link
            to={`/stays/${alert.stayId}/check-out`}
            aria-label={t('frontDesk.checkOutNamed', { name })}
            className="inline-flex h-8 items-center rounded-md bg-brand px-3 text-on-brand hover:bg-brand-strong"
          >
            {t('stayAlerts.checkOut')}
          </Link>
        ) : (
          <Link
            to={`/reservations/${alert.reservationId}`}
            aria-label={t('stayAlerts.openNamed', { name })}
            className="inline-flex h-8 items-center rounded-md border border-border px-3 hover:bg-surface-muted"
          >
            {t('stayAlerts.open')}
          </Link>
        )}
      </div>
    </li>
  );
}

function AlertSettings({ propertyId }: { propertyId: string }) {
  const queryClient = useQueryClient();
  const property = useQuery({
    queryKey: ['property', propertyId],
    queryFn: () => api.call('getProperty', { params: { propertyId } }),
  });
  const current = property.data?.stayAlerts;
  if (property.error) {
    return (
      <Alert tone="critical" className="mt-3">
        {errorMessage(property.error)}
      </Alert>
    );
  }
  if (!current) return null;
  return (
    <SettingsForm
      key={JSON.stringify(current)}
      initial={current}
      onSaved={() => {
        void queryClient.invalidateQueries({ queryKey: ['property', propertyId] });
        void queryClient.invalidateQueries({ queryKey: stayAlertsKey(propertyId) });
      }}
      propertyId={propertyId}
    />
  );
}

function SettingsForm({
  initial,
  propertyId,
  onSaved,
}: {
  initial: NonNullable<PatchBody['stayAlerts']>;
  propertyId: string;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [dueOut, setDueOut] = useState(String(initial.dueOutMinutes));
  const [hold, setHold] = useState(String(initial.holdWarningMinutes));
  const [fee, setFee] = useState(
    initial.lateCheckOutFeeMinor ? (Number(initial.lateCheckOutFeeMinor) / 100).toString() : '',
  );
  const [kinds, setKinds] = useState<StayAlertKind[]>([...initial.whatsapp]);
  const [badFee, setBadFee] = useState(false);
  const save = useMutation({
    mutationFn: (stayAlerts: NonNullable<PatchBody['stayAlerts']>) =>
      api.call('updateProperty', { params: { propertyId }, body: { stayAlerts } }),
    onSuccess: onSaved,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const feeMinor = fee.trim() ? toMinor(fee) : null;
    if (fee.trim() && !feeMinor) {
      setBadFee(true);
      return;
    }
    setBadFee(false);
    save.mutate({
      dueOutMinutes: Number(dueOut),
      holdWarningMinutes: Number(hold),
      lateCheckOutFeeMinor: feeMinor,
      whatsapp: STAY_ALERT_KINDS.filter((k) => kinds.includes(k)),
    });
  };

  return (
    <form
      aria-label={t('stayAlerts.settings.title')}
      onSubmit={submit}
      className="mt-3 flex max-w-xl flex-col gap-3 rounded-md border border-border p-4"
    >
      <h2 className="font-semibold">{t('stayAlerts.settings.title')}</h2>
      <div className="flex flex-col gap-1">
        <Label htmlFor="sa-due">{t('stayAlerts.settings.dueOut')}</Label>
        <Input
          id="sa-due"
          type="number"
          min={15}
          max={240}
          className="w-32"
          value={dueOut}
          onChange={(e) => setDueOut(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="sa-hold">{t('stayAlerts.settings.hold')}</Label>
        <Input
          id="sa-hold"
          type="number"
          min={15}
          max={720}
          className="w-32"
          value={hold}
          onChange={(e) => setHold(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="sa-fee">{t('stayAlerts.settings.fee')}</Label>
        <Input
          id="sa-fee"
          inputMode="decimal"
          className="w-40"
          placeholder={t('stayAlerts.settings.feeHint')}
          value={fee}
          aria-invalid={badFee || undefined}
          onChange={(e) => setFee(e.target.value)}
        />
        {badFee && <span className="text-xs text-critical">{t('stayAlerts.settings.badFee')}</span>}
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t('stayAlerts.settings.whatsapp')}</legend>
        {STAY_ALERT_KINDS.map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={kinds.includes(k)}
              onChange={(e) =>
                setKinds((ks) => (e.target.checked ? [...ks, k] : ks.filter((x) => x !== k)))
              }
            />
            {t(`stayAlerts.kinds.${k}`)}
          </label>
        ))}
        <p className="text-xs text-text-muted">{t('stayAlerts.settings.whatsappHint')}</p>
      </fieldset>
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
      {save.isSuccess && (
        <p role="status" className="text-sm text-success">
          {t('stayAlerts.settings.saved')}
        </p>
      )}
      <div>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {t('stayAlerts.settings.save')}
        </Button>
      </div>
    </form>
  );
}
