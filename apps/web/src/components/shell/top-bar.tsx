import { Bell, Building2, CalendarDays, CircleUser, Search, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useSession, type ShellProperty } from '../../app/session.ts';
import { cn } from '../../lib/cn.ts';
import { Button, buttonVariants } from '../ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';

/** Formats a YYYY-MM-DD business date without involving the device time zone. */
export function formatBusinessDate(isoDate: string, locale: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Short time-zone name as the property's locale writes it, e.g. "WAT" for Africa/Lagos in en-NG. */
export function timeZoneLabel(timeZone: string, locale: string, at: Date = new Date()): string {
  return (
    new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? timeZone
  );
}

/**
 * Business date, currency and time zone of the current property. Tab 5 rule 8: property
 * time zone and currency always visible; dates in the property's locale, not the UI language.
 */
export function PropertyContext({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const property: ShellProperty | undefined = session.properties.find(
    (p) => p.id === session.currentPropertyId,
  );
  const locale = property?.locale ?? i18n.language;
  const date = session.businessDate
    ? formatBusinessDate(session.businessDate, locale)
    : t('shell.businessDateNotSet');

  return (
    <span
      className={cn('items-center gap-1 text-sm', className)}
      aria-label={t('shell.propertyContext')}
    >
      <CalendarDays aria-hidden className="size-4 shrink-0 text-text-muted" />
      <span>{date}</span>
      {property && (
        <span className="text-text-muted">
          {' · '}
          {property.baseCurrency}
          {' · '}
          {timeZoneLabel(property.timeZone, locale)}
        </span>
      )}
    </span>
  );
}

function CountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-critical px-1 text-center text-xs font-semibold leading-5 text-on-brand">
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function TopBar() {
  const { t } = useTranslation();
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);

  return (
    <header className="flex h-14 items-center gap-2 border-b border-border bg-surface px-4">
      {/* Property switcher */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="max-w-56 justify-start"
            aria-label={t('shell.property')}
          >
            <Building2 aria-hidden className="size-4 shrink-0" />
            <span className="truncate">{property?.name ?? t('shell.property')}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t('shell.property')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={session.currentPropertyId ?? ''}>
            {session.properties.map((p) => (
              <DropdownMenuRadioItem key={p.id} value={p.id}>
                {p.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Business date (from business_days, never the device clock), currency, time zone.
          On phones the shell shows the same chip as a strip under the bar. */}
      <PropertyContext className="hidden rounded-full bg-surface-muted px-3 py-1 sm:inline-flex" />

      {/* Global search: no search API exists yet (spec issue 31) */}
      <div className="mx-2 hidden flex-1 md:block">
        <label className="relative block">
          <span className="sr-only">{t('shell.search')}</span>
          <Search
            aria-hidden
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted"
          />
          <input
            type="search"
            disabled
            placeholder={t('shell.searchUnavailable')}
            className="h-10 w-full max-w-md rounded-md border border-border bg-surface-muted pl-9 pr-3 text-sm"
          />
        </label>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Link
          to="/approvals"
          className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'relative')}
          aria-label={t('shell.approvalsCount', { count: session.pendingApprovals })}
        >
          <ShieldCheck aria-hidden className="size-5" />
          <CountBadge count={session.pendingApprovals} />
        </Link>
        <Link
          to="/leakage"
          className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'relative')}
          aria-label={t('shell.alertsCount', { count: session.openAlerts })}
        >
          <Bell aria-hidden className="size-5" />
          <CountBadge count={session.openAlerts} />
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('shell.accountMenu')}>
              <CircleUser aria-hidden className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{session.userName}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled title={t('shell.signOutUnavailable')}>
              {t('shell.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
