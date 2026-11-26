import type { OnboardingRow, TrainingSessionItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import helpdeskStrings from '../i18n/en/helpdesk.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';

registerStrings(helpdeskStrings);

// S31 onboarding (Versions V2 "enhanced onboarding"; T-171): each property's way to go-live
// against the 2-working-day target, and training sessions per role for a hotel group.

type Row = z.output<typeof OnboardingRow>;
type Session = z.output<typeof TrainingSessionItem>;
const KEY = ['platform', 'onboarding'];
const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';

export function useWhen() {
  const { i18n } = useTranslation();
  return (at: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(at),
    );
}

function TrackerRow({ row, target }: { row: Row; target: number }) {
  const { t } = useTranslation();
  const when = useWhen();
  const imports = Object.entries(row.imports);
  return (
    <tr className="border-t border-border align-top">
      <th scope="row" className="py-2 pr-3 text-left font-normal">
        <span className="block font-semibold">{row.property.name}</span>
        <span className="block text-text-muted">{row.organisation.name}</span>
        <span className="block text-text-muted">
          {row.wentLiveAt
            ? t('helpdesk.onboarding.wentLive', { when: when(row.wentLiveAt) })
            : t(`helpdesk.onboarding.statuses.${row.property.status}`)}
        </span>
      </th>
      <td className={cn('py-2 pr-3', !row.onTarget && 'font-semibold text-critical')}>
        {t('helpdesk.onboarding.daysValue', { days: row.workingDays, target })}
        {!row.onTarget && ` · ${t('helpdesk.onboarding.over')}`}
      </td>
      <td className="py-2 pr-3">
        {t('helpdesk.onboarding.setupValue', {
          done: row.checklist.done,
          required: row.checklist.required,
        })}
        {row.checklist.todo.length > 0 && (
          <span className="block text-text-muted">{row.checklist.todo.join(', ')}</span>
        )}
      </td>
      <td className="py-2 pr-3">
        {imports.length > 0
          ? imports.map(([kind, n]) => `${kind} ${n}`).join(', ')
          : t('helpdesk.onboarding.noImports')}
      </td>
      <td className="py-2 pr-3">
        {t('helpdesk.onboarding.staffValue', {
          members: row.staff.members,
          invitations: row.staff.invitations,
        })}
      </td>
      <td className="py-2 pr-3">
        {row.training.needed.length > 0
          ? t('helpdesk.onboarding.trainingNeeded', {
              roles: row.training.needed.map((r) => r.name).join(', '),
            })
          : t('helpdesk.onboarding.allTrained')}
        {row.training.next && (
          <span className="block text-text-muted">
            {t('helpdesk.onboarding.next', {
              role: row.training.next.role,
              when: when(row.training.next.scheduledAt),
            })}
          </span>
        )}
      </td>
      <td className="py-2">{row.contact?.name ?? t('helpdesk.onboarding.noContact')}</td>
    </tr>
  );
}

/** Every property's way to go-live: those in setup first. */
export function OnboardingTracker() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.call('listOnboarding') });
  return (
    <section aria-label={t('helpdesk.onboarding.title')} className="mt-8">
      <h2 className="text-lg font-semibold">{t('helpdesk.onboarding.title')}</h2>
      {q.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(q.error)}
        </Alert>
      )}
      {q.data && q.data.data.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">{t('helpdesk.onboarding.empty')}</p>
      )}
      {q.data && q.data.data.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm" aria-label={t('helpdesk.onboarding.title')}>
            <thead>
              <tr className="text-left text-text-muted">
                <th scope="col" className="pr-3">
                  {t('helpdesk.onboarding.property')}
                </th>
                <th scope="col" className="pr-3">
                  {t('helpdesk.onboarding.days')}
                </th>
                <th scope="col" className="pr-3">
                  {t('helpdesk.onboarding.setup')}
                </th>
                <th scope="col" className="pr-3">
                  {t('helpdesk.onboarding.imports')}
                </th>
                <th scope="col" className="pr-3">
                  {t('helpdesk.onboarding.staff')}
                </th>
                <th scope="col" className="pr-3">
                  {t('helpdesk.onboarding.training')}
                </th>
                <th scope="col">{t('helpdesk.onboarding.contact')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.data.map((row) => (
                <TrackerRow key={row.property.id} row={row} target={q.data.targetWorkingDays} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SessionLine({ session, actions }: { session: Session; actions?: React.ReactNode }) {
  const { t } = useTranslation();
  const when = useWhen();
  return (
    <li className="rounded-md border border-border bg-surface p-3 text-sm">
      <span className="block font-semibold">
        {session.role.name} · {session.propertyName ?? t('helpdesk.training.wholeGroup')}
      </span>
      <span className="block text-text-muted">
        {session.cancelledAt
          ? t('helpdesk.training.cancelled')
          : session.heldAt
            ? t('helpdesk.training.held', { when: when(session.heldAt) })
            : t('helpdesk.training.upcoming', { when: when(session.scheduledAt) })}{' '}
        · {t('helpdesk.training.with', { name: session.trainer.name })}
      </span>
      {session.note && <span className="block">{session.note}</span>}
      {actions}
    </li>
  );
}

/** A hotel group's training sessions: book one per role, then mark it held or cancel it. */
export function TrainingPanel({ organisationId }: { organisationId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = ['platform', organisationId, 'training'];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.call('listTenantTraining', { params: { organisationId } }),
  });
  const [roleId, setRoleId] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [at, setAt] = useState('');
  const [note, setNote] = useState('');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: KEY });
  };
  const book = useMutation({
    mutationFn: () =>
      api.call('bookTraining', {
        params: { organisationId },
        body: {
          roleId,
          propertyId: propertyId || null,
          scheduledAt: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          note: note.trim() || null,
        },
      }),
    onSuccess: () => {
      setAt('');
      setNote('');
      refresh();
    },
  });
  const change = useMutation({
    mutationFn: ({ id, to }: { id: string; to: 'held' | 'cancel' }) =>
      to === 'held'
        ? api.call('markTrainingHeld', { params: { sessionId: id } })
        : api.call('cancelTraining', { params: { sessionId: id } }),
    onSuccess: refresh,
  });
  const error = q.error ?? book.error ?? change.error;
  return (
    <section aria-label={t('helpdesk.training.title')}>
      <h3 className="font-semibold">{t('helpdesk.training.title')}</h3>
      {error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(error)}
        </Alert>
      )}
      <form
        aria-label={t('helpdesk.training.book')}
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (roleId && at) book.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="training-role">{t('helpdesk.training.role')}</Label>
          <select
            id="training-role"
            className={selectClass}
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
          >
            <option value="" />
            {q.data?.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="training-property">{t('helpdesk.training.property')}</Label>
          <select
            id="training-property"
            className={selectClass}
            value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}
          >
            <option value="">{t('helpdesk.training.wholeGroup')}</option>
            {q.data?.properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="training-at">{t('helpdesk.training.when')}</Label>
          <Input
            id="training-at"
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="training-note">{t('helpdesk.training.note')}</Label>
          <Input
            id="training-note"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={!roleId || !at || book.isPending}>
          {t('helpdesk.training.book')}
        </Button>
      </form>
      <ul className="mt-2 flex flex-col gap-2">
        {q.data?.data.map((s) => (
          <SessionLine
            key={s.id}
            session={s}
            actions={
              !s.heldAt &&
              !s.cancelledAt && (
                <span className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => change.mutate({ id: s.id, to: 'held' })}>
                    {t('helpdesk.training.markHeld')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => change.mutate({ id: s.id, to: 'cancel' })}
                  >
                    {t('helpdesk.training.cancel')}
                  </Button>
                </span>
              )
            }
          />
        ))}
      </ul>
    </section>
  );
}

/** The hotel's sessions, on its Help page. */
export function MyTraining() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['support', 'training'],
    queryFn: () => api.call('listMyTraining'),
  });
  if (!q.data) return null;
  return (
    <section aria-label={t('helpdesk.training.title')} className="mt-6">
      <h2 className="font-semibold">{t('helpdesk.training.title')}</h2>
      {q.data.data.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">{t('helpdesk.training.none')}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {q.data.data.map((s) => (
            <SessionLine key={s.id} session={s} />
          ))}
        </ul>
      )}
    </section>
  );
}
