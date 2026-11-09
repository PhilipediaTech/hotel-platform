import type { ThreadItem, ThreadMessage } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Label } from '../components/ui/label.tsx';
import strings from '../i18n/en/inbox.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';

registerStrings(strings);

// The two-way WhatsApp inbox (PRD M11-04; S29; T-115). Conversations are linked to the guest
// and booking automatically. Free text works for 24 hours after the guest's last message;
// after that only the approved follow-up can reach them.

type Thread = z.output<typeof ThreadItem>;
type Message = z.output<typeof ThreadMessage>;

const POLL_MS = 15_000;

function useTime() {
  const { i18n } = useTranslation();
  return (at: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(at),
    );
}

function Bubble({ m }: { m: Message }) {
  const { t } = useTranslation();
  const when = useTime();
  const out = m.direction === 'OUT';
  return (
    <li className={cn('flex', out && 'justify-end')}>
      <div
        className={cn(
          'max-w-[80%] rounded-md border border-border p-2 text-sm',
          out ? 'bg-brand-subtle' : 'bg-surface',
        )}
      >
        <p className="whitespace-pre-line break-words">{m.body}</p>
        <p className="mt-1 text-xs text-text-muted">
          {m.kind === 'ASSISTANT'
            ? t('inbox.assistant')
            : out
              ? (m.sentBy ?? t('inbox.you'))
              : t('inbox.guest')}{' '}
          · {when(m.createdAt)}
        </p>
        {m.kind === 'TEMPLATE' && <p className="text-xs text-text-muted">{t('inbox.template')}</p>}
        {m.status === 'FAILED' && <p className="text-xs text-critical">{t('inbox.failed')}</p>}
      </div>
    </li>
  );
}

function Conversation({ id, keyBase }: { id: string; keyBase: unknown[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const key = [...keyBase, id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.call('getMessageThread', { params: { threadId: id } }),
    refetchInterval: POLL_MS,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keyBase });
  const unread = q.data?.unreadCount ?? 0;
  useEffect(() => {
    if (unread === 0) return;
    void api
      .call('markThreadRead', { params: { threadId: id }, body: {} })
      .then(() => queryClient.invalidateQueries({ queryKey: keyBase }));
    // keyBase is rebuilt each render but only names the property.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, unread]);
  const send = useMutation({
    mutationFn: () =>
      api.call('sendThreadMessage', { params: { threadId: id }, body: { body: text } }),
    onSuccess: () => {
      setText('');
      refresh();
    },
  });
  const followUp = useMutation({
    mutationFn: () => api.call('sendThreadFollowUp', { params: { threadId: id }, body: {} }),
    onSuccess: refresh,
  });
  const assistant = useMutation({
    mutationFn: (active: boolean) =>
      api.call('setThreadAssistant', { params: { threadId: id }, body: { active } }),
    onSuccess: refresh,
  });
  if (q.error) return <Alert tone="critical">{errorMessage(q.error)}</Alert>;
  if (!q.data) return null;
  const th = q.data;
  const inputId = `inbox-reply-${id}`;
  return (
    <article
      aria-label={th.guest?.name ?? th.phone}
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
    >
      <header>
        <h2 className="font-semibold">{th.guest?.name ?? t('inbox.unknown')}</h2>
        <p className="text-sm text-text-muted">{th.phone}</p>
        {th.reservation && (
          <Link className="text-sm text-brand underline" to={`/reservations/${th.reservation.id}`}>
            {t('inbox.booking', { no: th.reservation.confirmationNo })}
          </Link>
        )}
      </header>
      <div>
        <Button
          size="sm"
          variant="secondary"
          disabled={assistant.isPending}
          onClick={() => assistant.mutate(th.assistantPaused)}
        >
          {th.assistantPaused ? t('inbox.handBack') : t('inbox.takeOver')}
        </Button>
      </div>
      <ul className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto">
        {th.messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
      </ul>
      {th.windowOpen ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) send.mutate();
          }}
        >
          <Label htmlFor={inputId}>{t('inbox.reply')}</Label>
          <textarea
            id={inputId}
            className="min-h-20 rounded-md border border-border bg-surface p-2 text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div>
            <Button type="submit" disabled={send.isPending || !text.trim()}>
              {t('inbox.send')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <Alert tone="info">{t('inbox.windowClosed')}</Alert>
          <div>
            <Button disabled={followUp.isPending} onClick={() => followUp.mutate()}>
              {t('inbox.followUp')}
            </Button>
          </div>
          {followUp.isSuccess && <Alert tone="success">{t('inbox.followUpSent')}</Alert>}
        </div>
      )}
      {(send.error ?? followUp.error) && (
        <Alert tone="critical">{errorMessage(send.error ?? followUp.error)}</Alert>
      )}
    </article>
  );
}

export function InboxPage() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const keyBase = ['inbox', currentPropertyId ?? ''];
  const list = useQuery({
    queryKey: [...keyBase, 'list', unreadOnly],
    queryFn: () => api.call('listMessageThreads', { query: unreadOnly ? { unread: 'true' } : {} }),
    refetchInterval: POLL_MS,
  });
  const threads: Thread[] = list.data?.data ?? [];
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('inbox.title')}</h1>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={unreadOnly}
          onChange={(e) => setUnreadOnly(e.target.checked)}
        />
        {t('inbox.unreadOnly')}
      </label>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-[20rem_1fr]">
        <nav aria-label={t('inbox.title')}>
          {list.data && threads.length === 0 && <p className="text-sm">{t('inbox.none')}</p>}
          <ul className="flex flex-col gap-2">
            {threads.map((th) => (
              <li key={th.id}>
                <button
                  type="button"
                  aria-pressed={selected === th.id}
                  className={cn(
                    'w-full rounded-md border border-border bg-surface p-3 text-left text-sm',
                    selected === th.id && 'border-brand',
                  )}
                  onClick={() => setSelected(th.id)}
                >
                  <span className="block font-semibold">{th.guest?.name ?? th.phone}</span>
                  <span className="block truncate text-text-muted">{th.lastPreview}</span>
                  {th.needsStaff && (
                    <span className="block font-medium text-critical">{t('inbox.needsStaff')}</span>
                  )}
                  {th.unreadCount > 0 && (
                    <span className="block font-medium text-brand">
                      {t('inbox.unread', { count: th.unreadCount })}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {selected ? (
          <Conversation key={selected} id={selected} keyBase={keyBase} />
        ) : (
          threads.length > 0 && <p className="text-sm text-text-muted">{t('inbox.pick')}</p>
        )}
      </div>
    </section>
  );
}
