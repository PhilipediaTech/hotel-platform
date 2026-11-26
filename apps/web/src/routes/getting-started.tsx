import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useSession } from '../app/session.ts';
import gettingStartedStrings from '../i18n/en/getting-started.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';

registerStrings(gettingStartedStrings);

// Getting started (Versions V2 "enhanced onboarding"; T-172): the caller's first steps, ticked
// off when they really do them, and for staff.manage how far each person has got.

export const GETTING_STARTED_KEY = ['getting-started'];

/** The caller's own steps, each linking to where it is done. */
export function GettingStartedCard() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: [...GETTING_STARTED_KEY, 'mine'],
    queryFn: () => api.call('listGettingStarted'),
  });
  if (!q.data || q.data.total === 0) return null;
  return (
    <section
      id="getting-started"
      aria-label={t('gettingStarted.title')}
      className="mb-6 rounded-md border border-border bg-surface p-4"
    >
      <h2 className="font-semibold">
        {t('gettingStarted.title')} ·{' '}
        {t('gettingStarted.progress', { done: q.data.done, total: q.data.total })}
      </h2>
      <p className="text-sm text-text-muted">
        {q.data.done === q.data.total ? t('gettingStarted.allDone') : t('gettingStarted.intro')}
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {q.data.steps.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-sm">
            {s.done ? (
              <CheckCircle2
                aria-label={t('gettingStarted.doneMark')}
                className="size-4 text-success"
              />
            ) : (
              <Circle aria-hidden className="size-4 text-text-muted" />
            )}
            {s.done ? (
              <span className="text-text-muted">{t(`gettingStarted.steps.${s.id}`)}</span>
            ) : (
              <Link className="underline" to={s.path}>
                {t(`gettingStarted.steps.${s.id}`)}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** For staff.manage: how far each person here has got. */
export function TeamProgress() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const allowed = permissions.includes('staff.manage');
  const q = useQuery({
    queryKey: [...GETTING_STARTED_KEY, 'team'],
    queryFn: () => api.call('listTeamGettingStarted'),
    enabled: allowed,
  });
  if (!allowed || !q.data) return null;
  return (
    <section aria-label={t('gettingStarted.team')} className="mt-6">
      <h2 className="font-semibold">{t('gettingStarted.team')}</h2>
      {q.data.data.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">{t('gettingStarted.teamEmpty')}</p>
      ) : (
        <table className="mt-2 w-full text-sm" aria-label={t('gettingStarted.team')}>
          <tbody>
            {q.data.data.map((m) => (
              <tr key={m.user.id} className="border-t border-border align-top">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <span className="block font-semibold">{m.user.name}</span>
                  <span className="block text-text-muted">{m.roles.join(', ')}</span>
                </th>
                <td className="py-2 pr-3">
                  {t('gettingStarted.member', { done: m.done, total: m.total })}
                </td>
                <td className="py-2">
                  {m.missing.length === 0
                    ? t('gettingStarted.finished')
                    : t('gettingStarted.stillToDo', {
                        steps: m.missing.map((id) => t(`gettingStarted.steps.${id}`)).join(', '),
                      })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
