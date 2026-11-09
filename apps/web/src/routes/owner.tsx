import type { OwnerPropertyCard } from '@hotel/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import type { z } from 'zod';
import { useSession, useSessionActions } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import ownerStrings from '../i18n/en/owner.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { AskFigures } from './ask-figures.tsx';

registerStrings(ownerStrings);

// S04 Owner home (PRD M6-11, M4-15; T-091). A card per property: occupancy, revenue today
// and this month, cash and transfers, open alerts and waiting approvals (each opens that
// property's screen), and the last closed day's flash report with its definitions (M10 rule).

type Card = z.output<typeof OwnerPropertyCard>;

function useMoney() {
  const { i18n } = useTranslation();
  return (minor: string, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(
      Number(minor) / 100,
    );
}

const percent = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

function day(date: string, language: string) {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-surface-muted p-2">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
      {hint && <dd className="text-xs text-text-muted">{hint}</dd>}
    </div>
  );
}

function PropertyCard({ card }: { card: Card }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const session = useSession();
  const { switchProperty } = useSessionActions();
  const navigate = useNavigate();
  const canOpen = session.properties.some((p) => p.id === card.id);
  const open = (path: string) => {
    if (card.id !== session.currentPropertyId) switchProperty(card.id);
    void navigate(path);
  };
  const f = card.lastFlash;
  return (
    <article aria-label={card.name} className="rounded-md border border-border bg-surface p-4">
      <header className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-lg font-semibold">{card.name}</h2>
        <span className="text-sm text-text-muted">
          {t('owner.today', { date: day(card.businessDate, i18n.language) })}
        </span>
      </header>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Figure
          label={t('owner.occupancy')}
          value={percent(card.occupancyBps)}
          hint={t('owner.rooms', { occupied: card.roomsOccupied, available: card.roomsAvailable })}
        />
        <Figure
          label={t('owner.revenueToday')}
          value={money(card.revenueTodayMinor, card.currency)}
        />
        <Figure
          label={t('owner.revenueMonth')}
          value={money(card.revenueMonthMinor, card.currency)}
        />
        <Figure label={t('owner.cash')} value={money(card.cashTodayMinor, card.currency)} />
        <Figure
          label={t('owner.transfers')}
          value={money(card.transfersTodayMinor, card.currency)}
        />
        <Figure label={t('owner.alerts')} value={String(card.openAlerts)} />
        <Figure label={t('owner.approvals')} value={String(card.pendingApprovals)} />
      </dl>
      {canOpen && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => open('/leakage')}>
            {t('owner.openAlerts')} ({card.openAlerts})
          </Button>
          <Button variant="secondary" size="sm" onClick={() => open('/approvals')}>
            {t('owner.openApprovals')} ({card.pendingApprovals})
          </Button>
        </div>
      )}
      <section className="mt-4 border-t border-border pt-3">
        {f ? (
          <>
            <h3 className="font-semibold">
              {t('owner.flash.title', { date: day(f.businessDate, i18n.language) })}
            </h3>
            <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Figure label={t('owner.flash.occupancy')} value={percent(f.occupancyBps)} />
              <Figure label={t('owner.flash.roomsSold')} value={String(f.roomsSold)} />
              <Figure
                label={t('owner.flash.roomRevenue')}
                value={money(f.roomRevenueMinor, card.currency)}
              />
              <Figure label={t('owner.flash.adr')} value={money(f.adrMinor, card.currency)} />
              <Figure label={t('owner.flash.revpar')} value={money(f.revparMinor, card.currency)} />
              <Figure
                label={t('owner.flash.payments')}
                value={money(f.paymentsMinor, card.currency)}
              />
            </dl>
            <p className="mt-2 text-xs text-text-muted">{t('owner.flash.definitions')}</p>
          </>
        ) : (
          <p className="text-sm text-text-muted">{t('owner.flash.none')}</p>
        )}
      </section>
    </article>
  );
}

export function OwnerHomePage() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const home = useQuery({
    queryKey: ['owner', currentPropertyId ?? '', 'home'],
    queryFn: () => api.call('getOwnerHome', {}),
  });
  const cards = home.data?.properties ?? [];
  return (
    <section className="max-w-5xl">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t('owner.title')}</h1>
        <Button variant="ghost" size="sm" onClick={() => void home.refetch()}>
          {t('owner.refresh')}
        </Button>
      </div>
      {home.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(home.error)}
        </Alert>
      )}
      {home.data && cards.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('owner.empty')}</p>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {cards.map((c) => (
          <PropertyCard key={c.id} card={c} />
        ))}
      </div>
      <AskFigures />
    </section>
  );
}
