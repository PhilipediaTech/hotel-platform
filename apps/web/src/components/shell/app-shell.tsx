import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { bottomBarItems, railItems, type NavItem } from '../../app/navigation.ts';
import { useSession } from '../../app/session.ts';
import { cn } from '../../lib/cn.ts';
import { OfflineBanner, UpdateBanner } from './banners.tsx';
import { PropertyContext, TopBar } from './top-bar.tsx';

function railLinkClass({ isActive }: { isActive: boolean }) {
  return cn(
    'flex h-10 items-center rounded-md px-3 text-sm',
    isActive
      ? 'bg-brand-subtle font-semibold text-brand-strong'
      : 'text-text hover:bg-surface-muted',
  );
}

function LeftRail() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  return (
    <nav
      aria-label={t('shell.mainNav')}
      className="hidden w-60 shrink-0 overflow-y-auto border-r border-border bg-surface p-3 md:block print:hidden"
    >
      {railItems(permissions).map(({ group, items }) => (
        <section key={group} className="mb-4">
          <h2 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t(`navGroup.${group}`)}
          </h2>
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <NavLink to={item.path} className={railLinkClass}>
                  {t(`nav.${item.id}`)}
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

function BottomTabBar({ items }: { items: NavItem[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <nav
      aria-label={t('shell.quickNav')}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
    >
      <ul className="flex">
        {items.map((item) => (
          <li key={item.id} className="flex-1">
            <NavLink
              to={item.path}
              className={({ isActive }) =>
                cn(
                  'flex min-h-touch items-center justify-center px-1 text-center text-xs',
                  isActive ? 'font-semibold text-brand-strong' : 'text-text-muted',
                )
              }
            >
              {t(`nav.${item.id}`)}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** App shell (tab 5): top bar, left rail on desktop, bottom tab bar on phones, banners. */
export function AppShell() {
  const { t } = useTranslation();
  const session = useSession();
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        {t('shell.skipToContent')}
      </a>
      {/* Printed pages (QR sheets, documents) show only the content. */}
      <div className="print:hidden">
        <TopBar />
        {/* Phones: the property context chip does not fit in the top bar. */}
        <PropertyContext className="flex border-b border-border bg-surface px-4 py-1 sm:hidden" />
        <OfflineBanner />
        <UpdateBanner />
        {session.preview && (
          <p className="bg-surface-sunken px-4 py-1 text-xs text-text-muted">
            {t('shell.devPreview')}
          </p>
        )}
      </div>
      <div className="flex flex-1">
        <LeftRail />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 pb-20 md:p-6 md:pb-6 print:p-0">
          <Outlet />
        </main>
      </div>
      <BottomTabBar items={bottomBarItems(session.permissions)} />
    </div>
  );
}
