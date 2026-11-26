import { SUPPORT_FIRST_RESPONSE_MINUTES, type PlatformSupportTicket } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Label } from '../components/ui/label.tsx';
import helpdeskStrings from '../i18n/en/helpdesk.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { Messages } from './support.tsx';

registerStrings(helpdeskStrings);

// S31 support (Versions V2 "support tooling"; T-170): the queue of the hotels' requests,
// blockers first, with how long each has waited against the 15-minute first answer; and each
// hotel group's named onboarding contact.

type Item = z.output<typeof PlatformSupportTicket>;
const KEY = ['platform', 'support'];
const FILTERS = ['ACTIVE', 'OPEN', 'ANSWERED', 'RESOLVED'] as const;
const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';

const minutesSince = (at: string, now: number) =>
  Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));

function useAdmins() {
  return useQuery({
    queryKey: ['platform', 'admins'],
    queryFn: () => api.call('listPlatformAdmins'),
  });
}

/** How long the hotel has waited, or how long the first answer took. */
function Clock({ ticket, now }: { ticket: Item; now: number }) {
  const { t } = useTranslation();
  if (ticket.firstResponseAt) {
    const took = Math.floor(
      (Date.parse(ticket.firstResponseAt) - Date.parse(ticket.createdAt)) / 60_000,
    );
    return (
      <span className="text-text-muted">{t('helpdesk.firstResponse', { minutes: took })}</span>
    );
  }
  const waited = minutesSince(ticket.createdAt, now);
  return waited >= SUPPORT_FIRST_RESPONSE_MINUTES ? (
    <span className="font-semibold text-critical">
      {t('helpdesk.overdue', { minutes: SUPPORT_FIRST_RESPONSE_MINUTES })}
    </span>
  ) : (
    <span className="text-text-muted">{t('helpdesk.waiting', { minutes: waited })}</span>
  );
}

function QueueTicket({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const admins = useAdmins();
  const [answer, setAnswer] = useState('');
  const q = useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.call('getPlatformSupportTicket', { params: { ticketId: id } }),
  });
  const done = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const send = useMutation({
    mutationFn: () =>
      api.call('replyPlatformSupportTicket', {
        params: { ticketId: id },
        body: { message: answer },
      }),
    onSuccess: () => {
      setAnswer('');
      done();
    },
  });
  const assign = useMutation({
    mutationFn: (adminUserId: string | null) =>
      api.call('assignPlatformSupportTicket', { params: { ticketId: id }, body: { adminUserId } }),
    onSuccess: done,
  });
  const resolve = useMutation({
    mutationFn: () => api.call('resolvePlatformSupportTicket', { params: { ticketId: id } }),
    onSuccess: done,
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  if (!q.data) return null;
  const ticket = q.data;
  const error = send.error ?? assign.error ?? resolve.error;
  return (
    <article aria-label={ticket.subject} className="flex flex-col gap-3">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t('helpdesk.back')}
        </Button>
      </div>
      <h3 className="text-lg font-semibold">
        {ticket.organisation.name}: {ticket.subject}
      </h3>
      <p className="text-sm text-text-muted">
        {t(`helpdesk.statuses.${ticket.status}`)} · {t(`helpdesk.urgencies.${ticket.urgency}`)}
        {ticket.propertyName && ` · ${ticket.propertyName}`}
        {ticket.page && ` · ${t('helpdesk.fromPage', { page: ticket.page })}`}
      </p>
      <div className="flex items-center gap-2">
        <Label htmlFor="support-assignee">{t('helpdesk.assignee')}</Label>
        <select
          id="support-assignee"
          className={selectClass}
          value={ticket.assignedAdmin?.id ?? ''}
          onChange={(e) => assign.mutate(e.target.value || null)}
        >
          <option value="">{t('helpdesk.nobody')}</option>
          {admins.data?.data.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <Messages ticket={ticket} />
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (answer.trim()) send.mutate();
        }}
      >
        <Label htmlFor="support-answer">{t('helpdesk.answer')}</Label>
        <textarea
          id="support-answer"
          maxLength={4000}
          className="min-h-24 rounded-md border border-border bg-surface p-2 text-sm"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
        {error && <Alert tone="critical">{errorMessage(error)}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" disabled={!answer.trim() || send.isPending}>
            {t('helpdesk.sendReply')}
          </Button>
          {ticket.status !== 'RESOLVED' && (
            <Button
              variant="secondary"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate()}
            >
              {t('helpdesk.resolve')}
            </Button>
          )}
        </div>
      </form>
    </article>
  );
}

/** The support queue: waiting on us first, blockers before the rest, oldest first. */
export function SupportQueue({ now: fixedNow }: { now?: number }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ACTIVE');
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({
    queryKey: [...KEY, 'list', filter],
    queryFn: () => api.call('listPlatformSupportTickets', { query: { status: filter } }),
    refetchInterval: 60_000,
  });
  // Waiting times as of the last fetch (refreshed each minute).
  const now = fixedNow ?? list.dataUpdatedAt;
  return (
    <section aria-label={t('helpdesk.queue')} className="mt-8">
      <h2 className="text-lg font-semibold">{t('helpdesk.queue')}</h2>
      {open ? (
        <QueueTicket key={open} id={open} onBack={() => setOpen(null)} />
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2">
            <Label htmlFor="support-filter">{t('helpdesk.queueFilter')}</Label>
            <select
              id="support-filter"
              className={selectClass}
              value={filter}
              onChange={(e) => setFilter(e.target.value as (typeof FILTERS)[number])}
            >
              {FILTERS.map((f) => (
                <option key={f} value={f}>
                  {t(`helpdesk.filters.${f}`)}
                </option>
              ))}
            </select>
          </div>
          {list.error && (
            <Alert tone="critical" className="mt-2">
              {errorMessage(list.error)}
            </Alert>
          )}
          {list.data && list.data.data.length === 0 && (
            <p className="mt-2 text-sm text-text-muted">{t('helpdesk.queueEmpty')}</p>
          )}
          <ul className="mt-2 flex flex-col gap-2">
            {list.data?.data.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  className={cn(
                    'w-full rounded-md border border-border bg-surface p-3 text-left text-sm',
                    x.urgency === 'BLOCKER' && x.status === 'OPEN' && 'border-critical',
                  )}
                  onClick={() => setOpen(x.id)}
                >
                  <span className="block font-semibold">
                    {x.organisation.name}: {x.subject}
                    {x.unread && <span className="ml-2 text-xs text-critical">●</span>}
                  </span>
                  <span className="block">
                    {t(`helpdesk.statuses.${x.status}`)} · {t(`helpdesk.urgencies.${x.urgency}`)} ·{' '}
                    {x.openedBy.name} · <Clock ticket={x} now={now} />
                  </span>
                  {x.assignedAdmin && (
                    <span className="block text-text-muted">
                      {t('helpdesk.assignee')}: {x.assignedAdmin.name}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The platform admin who looks after a hotel group (T-170). */
export function OnboardingContactForm({
  tenant,
}: {
  tenant: { id: string; onboardingContact: { id: string; name: string } | null };
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const admins = useAdmins();
  const [contact, setContact] = useState(tenant.onboardingContact?.id ?? '');
  const save = useMutation({
    mutationFn: () =>
      api.call('setOnboardingContact', {
        params: { organisationId: tenant.id },
        body: { adminUserId: contact || null },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform', tenant.id] }),
  });
  return (
    <section aria-label={t('helpdesk.onboardingContact')}>
      <h3 className="font-semibold">{t('helpdesk.onboardingContact')}</h3>
      <p className="text-sm text-text-muted">{t('helpdesk.onboardingHint')}</p>
      <form
        className="mt-2 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <select
          aria-label={t('helpdesk.onboardingContact')}
          className={selectClass}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
        >
          <option value="">{t('helpdesk.nobody')}</option>
          {admins.data?.data.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={save.isPending}>
          {t('helpdesk.save')}
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
