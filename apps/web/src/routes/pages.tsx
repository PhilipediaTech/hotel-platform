import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, isRouteErrorResponse, useRouteError } from 'react-router';
import { startPath, type NavItem } from '../app/navigation.ts';
import { useSession } from '../app/session.ts';

/** `/` sends each user to their role's home screen, or to setup while it is unfinished. */
export function HomeRedirect() {
  const { permissions, properties, currentPropertyId } = useSession();
  const status = properties.find((p) => p.id === currentPropertyId)?.status ?? null;
  return <Navigate to={startPath(permissions, status)} replace />;
}

/** Stands in for a screen until its ticket builds it. */
export function PlaceholderPage({ item }: { item: NavItem }) {
  const { t } = useTranslation();
  return (
    <section>
      <h1 className="text-xl font-semibold">{t(`nav.${item.id}`)}</h1>
      <p className="mt-2 text-sm text-text-muted">
        {t('placeholder.arrives', { screen: item.screen, ticket: item.ticket })}
      </p>
    </section>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <section>
      <h1 className="text-xl font-semibold">{t('notFound.title')}</h1>
      <Link to="/" className="mt-2 inline-block text-sm text-brand underline">
        {t('notFound.home')}
      </Link>
    </section>
  );
}

export function RouteErrorPage() {
  const { t } = useTranslation();
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  return (
    <section
      role="alert"
      className="m-6 flex items-start gap-3 rounded-md bg-critical-subtle p-4 text-critical"
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0" />
      <div>
        <h1 className="font-semibold">{t('error.title')}</h1>
        <button
          type="button"
          className="mt-1 text-sm underline"
          onClick={() => window.location.reload()}
        >
          {t('error.reload')}
        </button>
      </div>
    </section>
  );
}
