import { SIGN_UP_COUNTRIES, type PartnerItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import partnerStrings from '../i18n/en/partners.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';

registerStrings(partnerStrings);

// Referral partners on S31 (PRD M14-06–M14-08; T-110): platform staff add partners, see each
// one's hotels and ledger, mark payouts paid, and tie a hotel group to a partner.

type Partner = z.output<typeof PartnerItem>;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const KEY = ['platform', 'partners'];

export function useMoney() {
  const { i18n } = useTranslation();
  return (minor: string, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(
      Number(minor) / 100,
    );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  type = 'text',
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

function AddPartner() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const blank = {
    name: '',
    country: 'NG',
    contact: '',
    email: '',
    phone: '',
    payout: '',
    rate: '',
    months: '',
  };
  const [f, setF] = useState(blank);
  const set = (key: keyof typeof blank) => (value: string) => setF({ ...f, [key]: value });
  const create = useMutation({
    mutationFn: () =>
      api.call('createPartner', {
        body: {
          name: f.name,
          country: f.country as keyof typeof SIGN_UP_COUNTRIES,
          contactName: f.contact || null,
          email: f.email,
          phone: f.phone || null,
          payoutDetails: f.payout || null,
          commissionBps: Math.round(Number(f.rate) * 100),
          durationMonths: Number(f.months),
        },
      }),
    onSuccess: () => {
      setF(blank);
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  return (
    <form
      noValidate
      className="grid gap-3 md:grid-cols-2"
      aria-label={t('partners.add')}
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Field id="pa-name" label={t('partners.name')} value={f.name} onChange={set('name')} />
      <div className="flex flex-col gap-1">
        <Label htmlFor="pa-country">{t('partners.country')}</Label>
        <select
          id="pa-country"
          className={selectClass}
          value={f.country}
          onChange={(e) => set('country')(e.target.value)}
        >
          {Object.entries(SIGN_UP_COUNTRIES).map(([code, c]) => (
            <option key={code} value={code}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <Field
        id="pa-contact"
        label={t('partners.contact')}
        value={f.contact}
        onChange={set('contact')}
      />
      <Field
        id="pa-email"
        label={t('partners.email')}
        type="email"
        value={f.email}
        onChange={set('email')}
      />
      <Field id="pa-phone" label={t('partners.phone')} value={f.phone} onChange={set('phone')} />
      <Field
        id="pa-payout"
        label={t('partners.payout')}
        hint={t('partners.payoutHint')}
        value={f.payout}
        onChange={set('payout')}
      />
      <Field
        id="pa-rate"
        label={t('partners.rate')}
        type="number"
        value={f.rate}
        onChange={set('rate')}
      />
      <Field
        id="pa-months"
        label={t('partners.months')}
        hint={t('partners.monthsHint')}
        type="number"
        value={f.months}
        onChange={set('months')}
      />
      <div className="md:col-span-2">
        <Button type="submit" disabled={create.isPending}>
          {t('partners.create')}
        </Button>
        {create.error && (
          <Alert tone="critical" className="mt-2">
            {errorMessage(create.error)}
          </Alert>
        )}
      </div>
    </form>
  );
}

function PartnerDetailPanel({ id }: { id: string }) {
  const { t } = useTranslation();
  const money = useMoney();
  const queryClient = useQueryClient();
  const [reference, setReference] = useState('');
  const q = useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.call('getPartner', { params: { partnerId: id } }),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const pay = useMutation({
    mutationFn: (currency: string) =>
      api.call('recordPartnerPayout', { params: { partnerId: id }, body: { currency, reference } }),
    onSuccess: () => {
      setReference('');
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (active: boolean) =>
      api.call('updatePartner', { params: { partnerId: id }, body: { active } }),
    onSuccess: refresh,
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  if (!q.data) return null;
  const p = q.data;
  const owed = p.totals.filter((x) => BigInt(x.owedMinor) > 0n);
  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3 text-sm">
      <p>
        {t('partners.code')}: <strong>{p.code}</strong>
      </p>
      <p className="break-all">
        {t('partners.link')}: {p.signUpLink}
      </p>
      {p.payoutDetails && (
        <p>
          {t('partners.payout')}: {p.payoutDetails}
        </p>
      )}
      <div>
        <Button size="sm" variant="secondary" onClick={() => toggle.mutate(!p.active)}>
          {p.active ? t('partners.retire') : t('partners.restore')}
        </Button>
      </div>
      <h4 className="font-semibold">{t('partners.hotels')}</h4>
      {p.hotelList.length === 0 && <p className="text-text-muted">{t('partners.noHotels')}</p>}
      <ul>
        {p.hotelList.map((h) => (
          <li key={h.organisationId}>
            {h.name} · {h.plan ? `${t(`platform.plans.${h.plan}`)}` : t('partners.noPlan')}
            {h.status ? `, ${t(`platform.statuses.${h.status}`)}` : ''}
          </li>
        ))}
      </ul>
      <h4 className="font-semibold">{t('partners.ledger')}</h4>
      {p.commissions.length === 0 && <p className="text-text-muted">{t('partners.noLedger')}</p>}
      <ul>
        {p.commissions.map((l) => (
          <li key={l.id}>
            {t('partners.ledgerLine', {
              hotel: l.hotel,
              period: l.periodStart.slice(0, 7),
              amount: money(l.amountMinor, l.currency),
              rate: l.commissionBps / 100,
            })}
            {l.paid && <span className="ml-2 text-text-muted">{t('partners.paidTag')}</span>}
          </li>
        ))}
      </ul>
      {owed.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`pa-ref-${id}`}>{t('partners.reference')}</Label>
            <Input
              id={`pa-ref-${id}`}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          {owed.map((x) => (
            <Button
              key={x.currency}
              disabled={pay.isPending || reference.trim().length < 2}
              onClick={() => pay.mutate(x.currency)}
            >
              {t('partners.markPaid', { amount: money(x.owedMinor, x.currency) })}
            </Button>
          ))}
        </div>
      )}
      {pay.error && <Alert tone="critical">{errorMessage(pay.error)}</Alert>}
      {p.payouts.length > 0 && (
        <>
          <h4 className="font-semibold">{t('partners.payouts')}</h4>
          <ul>
            {p.payouts.map((x) => (
              <li key={x.id}>
                {t('partners.payoutLine', {
                  amount: money(x.amountMinor, x.currency),
                  date: x.paidAt.slice(0, 10),
                  reference: x.reference,
                })}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function PartnersPanel() {
  const { t } = useTranslation();
  const money = useMoney();
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: KEY, queryFn: () => api.call('listPartners') });
  const partners: Partner[] = list.data?.data ?? [];
  return (
    <section className="mt-8" aria-labelledby="partners-title">
      <h2 id="partners-title" className="text-lg font-semibold">
        {t('partners.title')}
      </h2>
      {list.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(list.error)}
        </Alert>
      )}
      {list.data && partners.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">{t('partners.none')}</p>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {partners.map((p) => (
          <li key={p.id} className="rounded-md border border-border bg-surface p-3">
            <button
              type="button"
              className="w-full text-left text-sm"
              aria-expanded={open === p.id}
              onClick={() => setOpen(open === p.id ? null : p.id)}
            >
              <span className="block font-semibold">
                {p.name} · {p.country}
                {!p.active && <span className="ml-2 text-critical">{t('partners.retired')}</span>}
              </span>
              <span className="block text-text-muted">
                {t('partners.line', {
                  rate: p.commissionBps / 100,
                  months: p.durationMonths,
                  count: p.hotels,
                })}
              </span>
              {p.totals.map((x) => (
                <span key={x.currency} className="block text-text-muted">
                  {t('partners.owed', {
                    owed: money(x.owedMinor, x.currency),
                    earned: money(x.earnedMinor, x.currency),
                  })}
                </span>
              ))}
            </button>
            {open === p.id && <PartnerDetailPanel id={p.id} />}
          </li>
        ))}
      </ul>
      <h3 className="mt-6 font-semibold">{t('partners.add')}</h3>
      <div className="mt-2 rounded-md border border-border bg-surface p-4">
        <AddPartner />
      </div>
    </section>
  );
}

/** The tie between a hotel group and a partner (M14-07), on the group's panel. */
export function TenantPartnerForm({ organisationId }: { organisationId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = [...KEY, 'tenant', organisationId];
  const current = useQuery({
    queryKey: key,
    queryFn: () => api.call('getTenantPartner', { params: { organisationId } }),
  });
  const list = useQuery({ queryKey: KEY, queryFn: () => api.call('listPartners') });
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const selected = partnerId ?? current.data?.partner?.id ?? '';
  const save = useMutation({
    mutationFn: () =>
      api.call('setTenantPartner', {
        params: { organisationId },
        body: { partnerId: selected || null, reason: reason.trim() || null },
      }),
    onSuccess: () => {
      setReason('');
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  return (
    <section aria-label={t('partners.tieTitle')}>
      <h3 className="font-semibold">{t('partners.tieTitle')}</h3>
      {current.data?.firstPaidAt && (
        <p className="text-sm text-text-muted">{t('partners.paidNote')}</p>
      )}
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <select
          aria-label={t('partners.tieTitle')}
          className={selectClass}
          value={selected}
          onChange={(e) => setPartnerId(e.target.value)}
        >
          <option value="">{t('partners.noPartner')}</option>
          {(list.data?.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="flex min-w-60 flex-col gap-1">
          <Label htmlFor={`pa-reason-${organisationId}`}>{t('partners.reason')}</Label>
          <Input
            id={`pa-reason-${organisationId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={save.isPending}>
          {t('partners.save')}
        </Button>
      </form>
      {save.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(save.error)}
        </Alert>
      )}
    </section>
  );
}
