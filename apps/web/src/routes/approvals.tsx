import type { ApprovalRequestItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { APPROVALS_QUERY_KEY, useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';

// Approvals inbox (tab 5 "Approvals inbox", PRD M1-10; T-022): pending requests with their
// context; approve or reject with a note. Decided requests stay listed under "Decided".

type Request = z.output<typeof ApprovalRequestItem>;

const VIEWS = ['pending', 'decided'] as const;

function useFormatters() {
  const { i18n } = useTranslation();
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const locale = property?.locale ?? i18n.language;
  const timeZone = property?.timeZone ?? 'UTC';
  return {
    when: (iso: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
        new Date(iso),
      ),
    money: (minor: string) =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: property?.baseCurrency ?? 'NGN',
      }).format(Number(minor) / 100),
  };
}

export function ApprovalsPage() {
  const { t } = useTranslation();
  const session = useSession();
  const [view, setView] = useState<(typeof VIEWS)[number]>('pending');
  const requests = useQuery({
    queryKey: [...APPROVALS_QUERY_KEY, session.currentPropertyId ?? '', view],
    queryFn: () =>
      api.call('listApprovals', {
        query: { limit: 100, ...(view === 'pending' ? { status: 'PENDING' as const } : {}) },
      }),
  });
  const rows =
    view === 'pending'
      ? (requests.data?.data ?? [])
      : (requests.data?.data ?? []).filter((r) => r.status !== 'PENDING');

  return (
    <section>
      <h1 className="text-xl font-semibold">{t('approvals.title')}</h1>
      <div
        role="tablist"
        aria-label={t('approvals.title')}
        className="mt-4 flex gap-1 border-b border-border"
      >
        {VIEWS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={view === name}
            onClick={() => setView(name)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              view === name
                ? 'border-brand font-semibold text-brand-strong'
                : 'border-transparent text-text-muted',
            )}
          >
            {t(`approvals.views.${name}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-4">
        {requests.error ? (
          <Alert tone="critical">{errorMessage(requests.error)}</Alert>
        ) : !requests.data ? (
          <p className="text-sm text-text-muted">{t('shell.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-text-muted">{t(`approvals.empty.${view}`)}</p>
        ) : (
          <ul
            aria-label={t('approvals.requests')}
            className="divide-y divide-border rounded-md border border-border bg-surface"
          >
            {rows.map((r) => (
              <RequestRow key={r.id} request={r} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const STATUS_ICON = {
  PENDING: Clock,
  APPROVED: CheckCircle2,
  EXECUTED: CheckCircle2,
  REJECTED: XCircle,
  EXPIRED: XCircle,
  FAILED: XCircle,
} as const;

function RequestRow({ request }: { request: Request }) {
  const { t } = useTranslation();
  const f = useFormatters();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [otp, setOtp] = useState('');
  const done = () => queryClient.invalidateQueries({ queryKey: APPROVALS_QUERY_KEY });
  const body = () => ({
    ...(note.trim() ? { note: note.trim() } : {}),
    ...(otp ? { otp } : {}),
  });
  const approve = useMutation({
    mutationFn: () =>
      api.call('approveApproval', { params: { approvalId: request.id }, body: body() }),
    onSettled: done,
  });
  const reject = useMutation({
    mutationFn: () =>
      api.call('rejectApproval', {
        params: { approvalId: request.id },
        body: { note: note.trim(), ...(otp ? { otp } : {}) },
      }),
    onSettled: done,
  });
  const failed = approve.error ?? reject.error;
  const Icon = STATUS_ICON[request.status];
  const details = Object.entries(request.payload);

  return (
    <li className="p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {t(`approvals.actions.${request.action}`, { defaultValue: request.action })}
            {request.amountMinor !== null && ` · ${f.money(request.amountMinor)}`}
          </p>
          <p className="text-sm text-text-muted">
            {t('approvals.requestedBy', {
              name: request.requestedBy.name,
              when: f.when(request.createdAt),
            })}
          </p>
          <p className="mt-1 text-sm">“{request.reason}”</p>
          {details.length > 0 && (
            <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 text-xs text-text-muted">
              {details.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="font-mono">{key}</dt>
                  <dd className="font-mono break-all">
                    {typeof value === 'string' ? value : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <p className="flex items-center gap-1 text-sm">
          <Icon aria-hidden className="size-4" />
          {request.status === 'PENDING'
            ? t('approvals.expires', { when: f.when(request.expiresAt) })
            : t(`approvals.status.${request.status}`)}
        </p>
      </div>
      {request.status !== 'PENDING' && request.decidedBy && (
        <p className="mt-1 text-xs text-text-muted">
          {t('approvals.decidedBy', {
            name: request.decidedBy.name,
            when: request.decidedAt ? f.when(request.decidedAt) : '',
          })}
          {request.decisionChannel === 'WHATSAPP_OTP' && ` · ${t('approvals.byCode')}`}
          {request.decisionNote && ` · “${request.decisionNote}”`}
        </p>
      )}
      {request.canDecide && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t('approvals.decide')}
        >
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor={`note-${request.id}`}>{t('approvals.note')}</Label>
            <Input
              id={`note-${request.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="flex w-32 flex-col gap-1">
            <Label htmlFor={`otp-${request.id}`}>{t('approvals.code')}</Label>
            <Input
              id={`otp-${request.id}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <Button disabled={approve.isPending || reject.isPending} onClick={() => approve.mutate()}>
            {t('approvals.approve')}
          </Button>
          <Button
            variant="secondary"
            disabled={approve.isPending || reject.isPending || !note.trim()}
            title={note.trim() ? undefined : t('approvals.rejectNeedsNote')}
            onClick={() => reject.mutate()}
          >
            {t('approvals.reject')}
          </Button>
        </form>
      )}
      {failed && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(failed)}
        </Alert>
      )}
    </li>
  );
}
