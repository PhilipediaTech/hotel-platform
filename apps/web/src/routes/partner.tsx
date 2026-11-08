import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert } from '../components/ui/alert.tsx';
import partnerStrings from '../i18n/en/partners.json';
import platformStrings from '../i18n/en/platform.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';

registerStrings(partnerStrings);
registerStrings(platformStrings);

// S47 (added beyond tab 5) a referral partner's own page (PRD M14-08; T-110): their code and link, their hotels
// (name, plan and status only) and their earnings.

function useMoney() {
  const { i18n } = useTranslation();
  return (minor: string, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(
      Number(minor) / 100,
    );
}

export function PartnerPage() {
  const { t } = useTranslation();
  const money = useMoney();
  const q = useQuery({ queryKey: ['partner', 'home'], queryFn: () => api.call('getPartnerHome') });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  if (!q.data) return null;
  const p = q.data;
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('partners.home.title')}</h1>
      <div className="rounded-md border border-border bg-surface p-4 text-sm">
        <p className="font-semibold">{p.name}</p>
        <p className="mt-1">
          {t('partners.home.terms', { rate: p.commissionBps / 100, months: p.durationMonths })}
        </p>
        {p.active ? (
          <>
            <p className="mt-3">
              {t('partners.code')}: <strong>{p.code}</strong>
            </p>
            <p className="break-all">
              {t('partners.link')}: {p.signUpLink}
            </p>
            <p className="mt-1 text-text-muted">{t('partners.home.copyHint')}</p>
          </>
        ) : (
          <Alert tone="info" className="mt-3">
            {t('partners.home.retiredNote')}
          </Alert>
        )}
      </div>
      <div className="rounded-md border border-border bg-surface p-4 text-sm">
        <h2 className="font-semibold">{t('partners.ledger')}</h2>
        {p.totals.map((x) => (
          <p key={x.currency} className="mt-1">
            {t('partners.owed', {
              owed: money(x.owedMinor, x.currency),
              earned: money(x.earnedMinor, x.currency),
            })}
          </p>
        ))}
        {p.commissions.length === 0 && (
          <p className="mt-1 text-text-muted">{t('partners.noLedger')}</p>
        )}
        <ul className="mt-2">
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
        {p.payouts.length > 0 && (
          <>
            <h3 className="mt-3 font-semibold">{t('partners.payouts')}</h3>
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
      <div className="rounded-md border border-border bg-surface p-4 text-sm">
        <h2 className="font-semibold">{t('partners.hotels')}</h2>
        <p className="text-text-muted">{t('partners.home.hotelsNote')}</p>
        {p.hotels.length === 0 && <p className="mt-1">{t('partners.noHotels')}</p>}
        <ul className="mt-2">
          {p.hotels.map((h) => (
            <li key={h.name}>
              {h.name} · {h.plan ? t(`platform.plans.${h.plan}`) : t('partners.noPlan')}
              {h.status ? `, ${t(`platform.statuses.${h.status}`)}` : ''}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
