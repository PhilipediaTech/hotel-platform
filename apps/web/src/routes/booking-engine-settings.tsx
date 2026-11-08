import type { BookingEngineSettingsItem, PromoItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import strings from '../i18n/en/booking-engine.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { uploadFile } from '../lib/files.ts';
import { apiFieldErrors, errorMessage } from '../lib/form.ts';

registerStrings(strings);

// S40 Booking engine settings (PRD M11-03; T-112): the page's address, words, photos, ways to
// pay, promo codes and the embed snippet. Which plans are public is set on each rate plan.

type Settings = z.output<typeof BookingEngineSettingsItem>;
type Promo = z.output<typeof PromoItem>;

const SETTINGS_KEY = ['booking-engine', 'settings'];
const PROMO_KEY = ['booking-engine', 'promos'];
const textareaClass = 'min-h-24 rounded-md border border-border bg-surface p-3 text-sm';

function Check({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function SettingsForm({ saved }: { saved: Settings }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [f, setF] = useState(saved);
  const [deposit, setDeposit] = useState(String(saved.depositBps / 100));
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setF((x) => ({ ...x, [key]: value }));
  const save = useMutation({
    mutationFn: () =>
      api.call('saveBookingEngineSettings', {
        body: {
          slug: f.slug ?? '',
          enabled: f.enabled,
          headline: f.headline || null,
          description: f.description || null,
          policies: f.policies || null,
          photoFileIds: f.photoFileIds,
          allowPayFull: f.allowPayFull,
          allowDeposit: f.allowDeposit,
          depositBps: Math.round(Number(deposit) * 100),
          allowPayAtHotel: f.allowPayAtHotel,
        },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile('BookingEngine', file),
    onSuccess: (id) => setF((x) => ({ ...x, photoFileIds: [...x.photoFileIds, id] })),
  });
  const fieldError = save.error
    ? apiFieldErrors(save.error).find((e) => e.field === 'slug')?.message
    : undefined;
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Check
        id="be-enabled"
        label={t('bookingEngine.enabled')}
        checked={f.enabled}
        onChange={(v) => set('enabled', v)}
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor="be-slug">{t('bookingEngine.slug')}</Label>
        <Input id="be-slug" value={f.slug ?? ''} onChange={(e) => set('slug', e.target.value)} />
        <p className="text-xs text-text-muted">{t('bookingEngine.slugHint')}</p>
        {fieldError && <p className="text-sm text-critical">{fieldError}</p>}
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="be-headline">{t('bookingEngine.headline')}</Label>
        <Input
          id="be-headline"
          value={f.headline ?? ''}
          onChange={(e) => set('headline', e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="be-description">{t('bookingEngine.description')}</Label>
        <textarea
          id="be-description"
          className={textareaClass}
          value={f.description ?? ''}
          onChange={(e) => set('description', e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="be-policies">{t('bookingEngine.policies')}</Label>
        <textarea
          id="be-policies"
          className={textareaClass}
          value={f.policies ?? ''}
          onChange={(e) => set('policies', e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="be-photo">{t('bookingEngine.photos')}</Label>
        <input
          id="be-photo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="text-sm"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
          }}
        />
        <p className="text-xs text-text-muted">
          {t('bookingEngine.photoCount', { count: f.photoFileIds.length })}
        </p>
        {upload.error && <Alert tone="critical">{errorMessage(upload.error)}</Alert>}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">{t('bookingEngine.payment')}</legend>
        <Check
          id="be-full"
          label={t('bookingEngine.payFull')}
          checked={f.allowPayFull}
          onChange={(v) => set('allowPayFull', v)}
        />
        <Check
          id="be-deposit"
          label={t('bookingEngine.payDeposit')}
          checked={f.allowDeposit}
          onChange={(v) => set('allowDeposit', v)}
        />
        {f.allowDeposit && (
          <div className="flex max-w-40 flex-col gap-1">
            <Label htmlFor="be-deposit-pct">{t('bookingEngine.depositPercent')}</Label>
            <Input
              id="be-deposit-pct"
              type="number"
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
            />
          </div>
        )}
        <Check
          id="be-hotel"
          label={t('bookingEngine.payAtHotel')}
          checked={f.allowPayAtHotel}
          onChange={(v) => set('allowPayAtHotel', v)}
        />
      </fieldset>
      <p className="text-sm text-text-muted">{t('bookingEngine.plansHint')}</p>
      <div>
        <Button type="submit" disabled={save.isPending}>
          {t('bookingEngine.save')}
        </Button>
      </div>
      {save.error && !fieldError && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">{t('bookingEngine.saved')}</Alert>}
    </form>
  );
}

function PromoCodes() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: PROMO_KEY, queryFn: () => api.call('listPromoCodes') });
  const [code, setCode] = useState('');
  const [percent, setPercent] = useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: PROMO_KEY });
  const add = useMutation({
    mutationFn: () =>
      api.call('createPromoCode', {
        body: { code, discountBps: Math.round(Number(percent) * 100) },
      }),
    onSuccess: () => {
      setCode('');
      setPercent('');
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (p: Promo) =>
      api.call('updatePromoCode', { params: { promoId: p.id }, body: { active: !p.active } }),
    onSuccess: refresh,
  });
  const promos: Promo[] = list.data?.data ?? [];
  return (
    <section aria-labelledby="be-promos">
      <h2 id="be-promos" className="font-semibold">
        {t('bookingEngine.promos')}
      </h2>
      {list.data && promos.length === 0 && (
        <p className="text-sm text-text-muted">{t('bookingEngine.noPromos')}</p>
      )}
      <ul className="mt-2 flex flex-col gap-2 text-sm">
        {promos.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2">
            <span>
              <strong>{p.code}</strong>{' '}
              {t('bookingEngine.promoLine', { percent: p.discountBps / 100, used: p.usedCount })}
            </span>
            <Button size="sm" variant="secondary" onClick={() => toggle.mutate(p)}>
              {p.active ? t('bookingEngine.turnOff') : t('bookingEngine.turnOn')}
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="be-code">{t('bookingEngine.code')}</Label>
          <Input id="be-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <div className="flex max-w-32 flex-col gap-1">
          <Label htmlFor="be-percent">{t('bookingEngine.percentOff')}</Label>
          <Input
            id="be-percent"
            type="number"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={add.isPending}>
          {t('bookingEngine.addPromo')}
        </Button>
      </form>
      {add.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(add.error)}
        </Alert>
      )}
    </section>
  );
}

export function BookingEngineSettingsPage() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api.call('getBookingEngineSettings'),
  });
  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('bookingEngine.title')}</h1>
      {q.error && <Alert tone="critical">{errorMessage(q.error)}</Alert>}
      {q.data && (
        <>
          <div className="rounded-md border border-border bg-surface p-4">
            <SettingsForm key={JSON.stringify(q.data)} saved={q.data} />
          </div>
          <div className="rounded-md border border-border bg-surface p-4">
            <PromoCodes />
          </div>
          {q.data.embedSnippet && (
            <div className="rounded-md border border-border bg-surface p-4 text-sm">
              <h2 className="font-semibold">{t('bookingEngine.embed')}</h2>
              <p className="mt-1 break-all">{q.data.pageUrl}</p>
              <p className="mt-2 text-text-muted">{t('bookingEngine.embedHint')}</p>
              <pre className="mt-2 overflow-x-auto rounded bg-background p-2 text-xs">
                {q.data.embedSnippet}
              </pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}
