import {
  renderMessage,
  type MessageDeliveryItem,
  type MessageLanguage,
  type MessageTemplateItem,
} from '@hotel/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import messagesStrings from '../i18n/en/messages.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { useFormats } from './reservations.tsx';

registerStrings(messagesStrings);

// S29 Messaging, templates part (PRD M11-05; T-024). A GM picks a message, reads its email
// and WhatsApp wording, writes the email in the organisation's own words per language,
// sends a test with the sample values, and sees recent messages with their status. The
// two-way inbox is V1.2.

type Template = z.output<typeof MessageTemplateItem>;
type Delivery = z.output<typeof MessageDeliveryItem>;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const textareaClass = 'min-h-40 rounded-md border border-border bg-surface p-2 text-sm';

const STATUS_TONE: Record<string, string> = {
  QUEUED: 'bg-surface-muted text-text-muted',
  SENT: 'bg-brand-subtle text-brand-strong',
  DELIVERED: 'bg-success-subtle text-success',
  READ: 'bg-success-subtle text-success',
  FAILED: 'bg-critical-subtle text-critical',
};

function useKey(...parts: string[]) {
  const { currentPropertyId } = useSession();
  return ['messages', currentPropertyId ?? '', ...parts];
}

/** The text with the sample values, as a guest would read it. */
function preview(t: Template, text: string): string {
  try {
    return renderMessage(text, Object.fromEntries(t.variables.map((v) => [v.name, v.example])));
  } catch {
    return text;
  }
}

function EmailEditor({ template, onDone }: { template: Template; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = useKey('templates');
  const [subject, setSubject] = useState(template.subject ?? '');
  const [body, setBody] = useState(template.body);
  const [done, setDone] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.call('saveMessageTemplate', {
        body: {
          code: template.code,
          channel: 'EMAIL',
          language: template.language,
          subject,
          body,
        },
      }),
    onSuccess: async () => {
      setDone(t('messages.saved'));
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const reset = useMutation({
    mutationFn: () =>
      api.call('resetMessageTemplate', {
        params: { code: template.code, channel: 'EMAIL', language: template.language },
      }),
    onSuccess: async () => {
      setDone(t('messages.resetDone'));
      await queryClient.invalidateQueries({ queryKey: key });
      onDone();
    },
  });
  const id = `${template.code}-${template.language}`;
  return (
    <form
      aria-label={t('messages.channel.EMAIL')}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setDone('');
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-subject`}>{t('messages.subject')}</Label>
        <Input
          id={`${id}-subject`}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={200}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-body`}>{t('messages.body')}</Label>
        <textarea
          id={`${id}-body`}
          className={textareaClass}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={4000}
        />
      </div>
      <p className="text-xs text-text-muted">
        {t('messages.variables')}:{' '}
        {template.variables.map((v) => (
          <code key={v.name} className="mr-2" title={v.label}>
            {`{{${v.name}}}`}
          </code>
        ))}
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-text-muted">{t('messages.preview')}</summary>
        <p className="mt-2 font-medium">{preview(template, subject)}</p>
        <p className="mt-1 whitespace-pre-wrap">{preview(template, body)}</p>
      </details>
      {(save.error ?? reset.error) && (
        <Alert tone="critical">{errorMessage(save.error ?? reset.error)}</Alert>
      )}
      {done && <Alert tone="success">{done}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending}>
          {t('messages.save')}
        </Button>
        {template.customised && (
          <Button
            variant="secondary"
            disabled={reset.isPending}
            onClick={() => {
              setDone('');
              reset.mutate();
            }}
          >
            {t('messages.reset')}
          </Button>
        )}
      </div>
    </form>
  );
}

function TestSend({ template }: { template: Template }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = useKey('deliveries');
  const [to, setTo] = useState('');
  const [queued, setQueued] = useState(false);
  const isCode = template.category === 'AUTHENTICATION';
  const send = useMutation({
    mutationFn: () =>
      api.call('sendTestMessage', {
        body: {
          code: template.code,
          channel: template.channel === 'EMAIL' ? 'EMAIL' : 'WHATSAPP',
          language: template.language,
          to: to.trim(),
        },
      }),
    onSuccess: async () => {
      setQueued(true);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
  if (isCode) return <p className="text-sm text-text-muted">{t('messages.test.codes')}</p>;
  const id = `test-${template.code}-${template.channel}-${template.language}`;
  return (
    <form
      aria-label={t('messages.test.title')}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setQueued(false);
        send.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{t('messages.test.to')}</Label>
        <Input
          id={id}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder={
            template.channel === 'EMAIL' ? t('messages.test.toEmail') : t('messages.test.toPhone')
          }
          inputMode={template.channel === 'EMAIL' ? 'email' : 'tel'}
        />
      </div>
      <Button type="submit" variant="secondary" disabled={send.isPending || !to.trim()}>
        {t('messages.test.send')}
      </Button>
      {send.error && (
        <Alert tone="critical" className="w-full">
          {errorMessage(send.error)}
        </Alert>
      )}
      {queued && (
        <Alert tone="success" className="w-full">
          {t('messages.test.queued')}
        </Alert>
      )}
    </form>
  );
}

function TemplateDetail({
  code,
  templates,
  languages,
}: {
  code: string;
  templates: Template[];
  languages: { code: MessageLanguage; label: string }[];
}) {
  const { t } = useTranslation();
  const mine = templates.filter((x) => x.code === code);
  const emails = mine.filter((x) => x.channel === 'EMAIL');
  const whatsapp = mine.find((x) => x.channel === 'WHATSAPP');
  const [language, setLanguage] = useState<MessageLanguage>('en');
  const email = emails.find((x) => x.language === language);
  // A language with no wording yet starts from the English text.
  const english = emails.find((x) => x.language === 'en');
  const editing: Template | undefined =
    email ?? (english ? { ...english, language, customised: false } : undefined);
  const label = mine[0]?.label ?? code;
  return (
    <article aria-label={label} className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">{label}</h2>
      {editing && (
        <section className="rounded-md border border-border bg-surface p-3">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h3 className="font-semibold">{t('messages.channel.EMAIL')}</h3>
            <span className="text-xs text-text-muted">
              {editing.customised ? t('messages.customised') : t('messages.default')}
            </span>
            <Label htmlFor={`${code}-language`} className="ml-auto">
              {t('messages.language')}
            </Label>
            <select
              id={`${code}-language`}
              className={selectClass}
              value={language}
              onChange={(e) => setLanguage(e.target.value as MessageLanguage)}
            >
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                  {emails.some((x) => x.language === l.code && x.customised) ? ' ✓' : ''}
                </option>
              ))}
            </select>
          </div>
          <EmailEditor
            key={`${editing.language}-${editing.customised}`}
            template={editing}
            onDone={() => setLanguage(language)}
          />
          <div className="mt-4 border-t border-border pt-3">
            <TestSend template={editing} />
          </div>
        </section>
      )}
      {whatsapp && (
        <section className="rounded-md border border-border bg-surface p-3">
          <h3 className="font-semibold">{t('messages.channel.WHATSAPP')}</h3>
          <p className="mt-1 text-xs text-text-muted">
            {t('messages.readOnly', {
              name: whatsapp.providerTemplateName ?? '',
              category: whatsapp.category ?? '',
            })}
          </p>
          <p className="mt-2 whitespace-pre-wrap rounded bg-surface-muted p-2 text-sm">
            {preview(whatsapp, whatsapp.body)}
          </p>
          <div className="mt-4 border-t border-border pt-3">
            <TestSend template={whatsapp} />
          </div>
        </section>
      )}
    </article>
  );
}

function Deliveries() {
  const { t } = useTranslation();
  const f = useFormats();
  const key = useKey('deliveries');
  const list = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) =>
      api.call('listMessageDeliveries', {
        query: { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) },
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows: Delivery[] = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <section className="mt-8">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">{t('messages.deliveries.title')}</h2>
        <Button variant="ghost" size="sm" onClick={() => void list.refetch()}>
          {t('messages.deliveries.refresh')}
        </Button>
      </div>
      {list.error && <Alert tone="critical">{errorMessage(list.error)}</Alert>}
      {list.data && rows.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">{t('messages.deliveries.empty')}</p>
      )}
      <ul aria-label={t('messages.deliveries.title')} className="mt-2 flex flex-col gap-2">
        {rows.map((d) => (
          <li key={d.id} className="rounded-md border border-border bg-surface p-3 text-sm">
            <span className="flex flex-wrap items-center gap-2">
              <span className={cn('rounded px-1.5 text-xs font-medium', STATUS_TONE[d.status])}>
                {t(`messages.status.${d.status}`)}
              </span>
              <span className="font-medium">{d.templateCode}</span>
              <span className="text-text-muted">{t(`messages.channel.${d.channel}`)}</span>
              {d.test && (
                <span className="text-xs text-text-muted">{t('messages.deliveries.test')}</span>
              )}
              <span className="ml-auto text-text-muted">{f.when(d.createdAt)}</span>
            </span>
            <span className="mt-1 block text-text-muted">
              {d.recipient} · {t('messages.deliveries.attempts', { count: d.attempts })}
            </span>
            {d.lastError && <span className="mt-1 block text-critical">{d.lastError}</span>}
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <Button
          variant="secondary"
          className="mt-2"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('messages.deliveries.more')}
        </Button>
      )}
    </section>
  );
}

export function MessagesPage() {
  const { t } = useTranslation();
  const session = useSession();
  const canManage = session.permissions.includes('template.manage');
  const key = useKey('templates');
  const list = useQuery({
    queryKey: key,
    queryFn: () => api.call('listMessageTemplates', {}),
    enabled: canManage,
  });
  const [selected, setSelected] = useState('BOOKING_CONFIRMED');
  if (!canManage) {
    return (
      <section className="max-w-3xl">
        <h1 className="text-xl font-semibold">{t('messages.title')}</h1>
        <Alert tone="info" className="mt-3">
          {t('messages.noAccess')}
        </Alert>
      </section>
    );
  }
  const templates = list.data?.templates ?? [];
  const codes = [...new Map(templates.map((x) => [x.code, x])).values()];
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('messages.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('messages.intro')}</p>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {list.data && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[16rem_1fr]">
          <nav aria-label={t('messages.templates')}>
            {(['GUEST', 'STAFF'] as const).map((audience) => (
              <div key={audience} className="mb-3">
                <h2 className="mb-1 text-xs font-semibold uppercase text-text-muted">
                  {t(`messages.audience.${audience}`)}
                </h2>
                <ul className="flex flex-col gap-1">
                  {codes
                    .filter((x) => x.audience === audience)
                    .map((x) => (
                      <li key={x.code}>
                        <button
                          type="button"
                          aria-pressed={selected === x.code}
                          className={cn(
                            'w-full rounded-md border border-border bg-surface px-3 py-2 text-left text-sm',
                            selected === x.code && 'border-brand',
                          )}
                          onClick={() => setSelected(x.code)}
                        >
                          {x.label}
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </nav>
          <TemplateDetail
            key={selected}
            code={selected}
            templates={templates}
            languages={list.data.languages}
          />
        </div>
      )}
      <Deliveries />
    </section>
  );
}
