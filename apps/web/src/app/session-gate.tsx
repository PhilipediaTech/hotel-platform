import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { api, ApiError, setApiPropertyId } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import {
  ME_QUERY_KEY,
  SessionActionsContext,
  SessionContext,
  toShellSession,
  type SessionActions,
} from './session.ts';

const propertyKey = (userId: string) => `hotel.currentProperty.${userId}`;

// The chosen property is a per-device convenience; storage may be unavailable (private mode).
function readStoredProperty(userId: string): string | null {
  try {
    return window.localStorage.getItem(propertyKey(userId));
  } catch {
    return null;
  }
}

function storeProperty(userId: string, propertyId: string): void {
  try {
    window.localStorage.setItem(propertyKey(userId), propertyId);
  } catch {
    // Not remembered on this device; the first property is used next time.
  }
}

/** Only same-app paths, so `?next=` can't send people to another site. */
export function safeNext(next: string | null): string {
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function FullPage({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center p-4">{children}</div>;
}

/**
 * Wraps every signed-in screen: loads GET /me, sends anonymous visitors to /sign-in (and
 * back afterwards), and provides the session and its actions to the shell.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: () => api.call('getMe'),
    staleTime: 5 * 60_000,
  });
  const [chosenProperty, setChosenProperty] = useState<string | null>(null);

  const signOut = useMutation({
    // "Switch user" (→ /pin) keeps the shared device open for the next person.
    mutationFn: (next: '/sign-in' | '/pin') =>
      api.call('signOut', { body: { keepDevice: next === '/pin' } }),
    onSettled: (_data, _error, next) => {
      // Whatever the server said, this browser forgets the user.
      setApiPropertyId(null);
      queryClient.clear();
      void navigate(next, { replace: true });
    },
  });

  const userId = me.data?.user.id;
  const session = useMemo(() => {
    if (!me.data) return null;
    const wanted = chosenProperty ?? readStoredProperty(me.data.user.id);
    return toShellSession(me.data, wanted);
  }, [me.data, chosenProperty]);

  const actions = useMemo<SessionActions>(
    () => ({
      signOut: () => signOut.mutate('/sign-in'),
      switchUser: () => signOut.mutate('/pin'),
      switchProperty: (propertyId) => {
        if (userId) storeProperty(userId, propertyId);
        setChosenProperty(propertyId);
        // Everything cached belongs to the old property, except who the user is.
        void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== ME_QUERY_KEY[0] });
      },
    }),
    [signOut, userId, queryClient],
  );

  const next = encodeURIComponent(`${location.pathname}${location.search}`);
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to={`/sign-in?next=${next}`} replace />;
  }
  if (me.data && !me.data.session.mfaPassed) {
    // Signed in, but the role needs MFA first (M1-06).
    return <Navigate to={`/mfa?next=${next}`} replace />;
  }
  if (me.error) {
    return (
      <FullPage>
        <Alert tone="critical" className="max-w-md">
          <p>{errorMessage(me.error)}</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => void me.refetch()}>
            {t('errors.retry')}
          </Button>
        </Alert>
      </FullPage>
    );
  }
  if (!session) {
    return (
      <FullPage>
        <Loader2 aria-hidden className="size-6 animate-spin text-text-muted" />
        <span className="sr-only">{t('shell.loading')}</span>
      </FullPage>
    );
  }

  setApiPropertyId(session.currentPropertyId);
  return (
    <SessionContext value={session}>
      <SessionActionsContext value={actions}>{children}</SessionActionsContext>
    </SessionContext>
  );
}
