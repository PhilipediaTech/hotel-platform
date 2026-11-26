import {
  SUPPORT_URGENCIES,
  type SupportTicketDetail,
  type SupportTicketSummary,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
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
import { MyTraining } from './platform-onboarding.tsx';

registerStrings(helpdeskStrings);

// Help (Versions V2 "support tooling"; T-170): ask the support team, follow the answers.
// Everyone sees what they asked; support.manage sees the whole group's.

type Summary = z.output<typeof SupportTicketSummary>;
type Detail = z.output<typeof SupportTicketDetail>;

export const SUPPORT_KEY = ['support'];
const textareaClass = 'min-h-24 rounded-md border border-border bg-surface p-2 text-sm';

function useWhen() {
  const { i18n } = useTranslation();
  return (at: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(at),
    );
}

function StatusChip({ ticket }: { ticket: Summary }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs',
        ticket.status === 'ANSWERED' ? 'bg-brand-subtle text-brand-strong' : 'bg-surface-muted',
      )}
    >
      {t(`helpdesk.statuses.${ticket.status}`)}
    </span>
  );
}

function NewRequest({ page, onSent }: { page: string | null; onSent: (id: string) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [urgency, setUrgency] = useState<(typeof SUPPORT_URGENCIES)[number]>('NORMAL');
  const send = useMutation({
    mutationFn: () =>
      api.call('createSupportTicket', { body: { subject, message, urgency, page } }),
    onSuccess: (ticket) => {
      void queryClient.invalidateQueries({ queryKey: SUPPORT_KEY });
      setSubject('');
      setMessage('');
      onSent(ticket.id);
    },
  });
  const ready = subject.trim() !== '' && message.trim() !== '';
  return (
    <form
      aria-label={t('helpdesk.new')}
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) send.mutate();
      }}
    >
      <h2 className="font-semibold">{t('helpdesk.new')}</h2>
      {page && <p className="text-sm text-text-muted">{t('helpdesk.fromPage', { page })}</p>}
      <div className="flex flex-col gap-1">
        <Label htmlFor="support-subject">{t('helpdesk.subject')}</Label>
        <Input
          id="support-subject"
          maxLength={120}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t('helpdesk.urgency')}</legend>
        {SUPPORT_URGENCIES.map((u) => (
          <label key={u} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="support-urgency"
              checked={urgency === u}
              onChange={() => setUrgency(u)}
            />
            {t(`helpdesk.urgencies.${u}`)}
          </label>
        ))}
        {urgency === 'BLOCKER' && (
          <p className="text-sm text-text-muted">{t('helpdesk.blockerHint')}</p>
        )}
      </fieldset>
      <div className="flex flex-col gap-1">
        <Label htmlFor="support-message">{t('helpdesk.message')}</Label>
        <textarea
          id="support-message"
          maxLength={4000}
          className={textareaClass}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
      {send.error && <Alert tone="critical">{errorMessage(send.error)}</Alert>}
      <div>
        <Button type="submit" disabled={!ready || send.isPending}>
          {send.isPending ? t('helpdesk.sending') : t('helpdesk.send')}
        </Button>
      </div>
    </form>
  );
}

/** The messages of one conversation, the support team's marked as such. */
export function Messages({ ticket }: { ticket: Pick<Detail, 'messages'> }) {
  const { t } = useTranslation();
  const when = useWhen();
  return (
    <ol aria-label={t('helpdesk.conversation')} className="flex flex-col gap-2">
      {ticket.messages.map((m) => (
        <li
          key={m.id}
          className={cn(
            'rounded-md border border-border p-3 text-sm',
            m.fromPlatform ? 'bg-brand-subtle' : 'bg-surface',
          )}
        >
          <p className="text-xs text-text-muted">
            {m.fromPlatform ? `${m.author.name} · ${t('helpdesk.team')}` : m.author.name} ·{' '}
            {when(m.createdAt)}
          </p>
          <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
        </li>
      ))}
    </ol>
  );
}

function Conversation({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const q = useQuery({
    queryKey: [...SUPPORT_KEY, id],
    queryFn: async () => {
      const ticket = await api.call('getSupportTicket', { params: { ticketId: id } });
      // Opening it read the answers: the list and the Help badge follow.
      void queryClient.invalidateQueries({ queryKey: [...SUPPORT_KEY, 'list'] });
      return ticket;
    },
  });
  const done = (ticket: Detail) => {
    queryClient.setQueryData([...SUPPORT_KEY, id], ticket);
    void queryClient.invalidateQueries({ queryKey: [...SUPPORT_KEY, 'list'] });
  };
  const send = useMutation({
    mutationFn: () =>
      api.call('replySupportTicket', { params: { ticketId: id }, body: { message: reply } }),
    onSuccess: (ticket) => {
      setReply('');
      done(ticket);
    },
  });
  const resolve = useMutation({
    mutationFn: () => api.call('resolveSupportTicket', { params: { ticketId: id } }),
    onSuccess: done,
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  if (!q.data) return null;
  const ticket = q.data;
  return (
    <article aria-label={ticket.subject} className="flex flex-col gap-3">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t('helpdesk.back')}
        </Button>
      </div>
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        {ticket.subject} <StatusChip ticket={ticket} />
      </h2>
      <Messages ticket={ticket} />
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (reply.trim()) send.mutate();
        }}
      >
        <Label htmlFor="support-reply">{t('helpdesk.reply')}</Label>
        <textarea
          id="support-reply"
          maxLength={4000}
          className={textareaClass}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
        />
        {(send.error ?? resolve.error) && (
          <Alert tone="critical">{errorMessage(send.error ?? resolve.error)}</Alert>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={!reply.trim() || send.isPending}>
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

export function SupportPage() {
  const { t } = useTranslation();
  const when = useWhen();
  const [search, setSearch] = useSearchParams();
  const open = search.get('ticket');
  const page = search.get('from');
  const list = useQuery({
    queryKey: [...SUPPORT_KEY, 'list'],
    queryFn: () => api.call('listSupportTickets'),
  });
  const show = (id: string | null) => {
    const next = new URLSearchParams(search);
    if (id) next.set('ticket', id);
    else next.delete('ticket');
    setSearch(next);
  };
  const contact = list.data?.contact;
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('helpdesk.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('helpdesk.intro')}</p>
      {list.data && (
        <p className="mt-2 text-sm">
          {contact
            ? contact.email
              ? t('helpdesk.contactEmail', { name: contact.name, email: contact.email })
              : t('helpdesk.contact', { name: contact.name })
            : t('helpdesk.noContact')}
        </p>
      )}
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      <div className="mt-4">
        {open ? (
          <Conversation key={open} id={open} onBack={() => show(null)} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <NewRequest page={page} onSent={show} />
            <section aria-label={list.data?.seesAll ? t('helpdesk.all') : t('helpdesk.mine')}>
              <h2 className="font-semibold">
                {list.data?.seesAll ? t('helpdesk.all') : t('helpdesk.mine')}
              </h2>
              {list.data && list.data.data.length === 0 && (
                <p className="mt-2 text-sm text-text-muted">{t('helpdesk.none')}</p>
              )}
              <ul className="mt-2 flex flex-col gap-2">
                {list.data?.data.map((x) => (
                  <li key={x.id}>
                    <button
                      type="button"
                      className="w-full rounded-md border border-border bg-surface p-3 text-left text-sm"
                      onClick={() => show(x.id)}
                    >
                      <span className="flex items-center gap-2 font-semibold">
                        {x.subject} <StatusChip ticket={x} />
                        {x.unread && (
                          <span className="text-xs text-critical">{t('helpdesk.newReply')}</span>
                        )}
                      </span>
                      <span className="block text-text-muted">
                        {t('helpdesk.openedBy', { name: x.openedBy.name, when: when(x.createdAt) })}
                        {x.urgency === 'BLOCKER' && ` · ${t('helpdesk.urgencies.BLOCKER')}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </div>
      {!open && <MyTraining />}
    </section>
  );
}
