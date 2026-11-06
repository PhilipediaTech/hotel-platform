import type { HandoverNoteItem, HandoverSnapshot } from '@hotel/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Label } from '../components/ui/label.tsx';
import handoverStrings from '../i18n/en/handovers.json';
import tasksStrings from '../i18n/en/tasks.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import { useFormats } from './reservations.tsx';

registerStrings(handoverStrings);
registerStrings(tasksStrings);

// S20 Handover (PRD M6-06; T-083). The outgoing supervisor picks the department, sees what is
// open now (the department's open tasks, approvals waiting, cash in the drawers, VIP guests)
// and writes notes; the handover keeps both as they were. The list below shows handovers
// newest first; the incoming supervisor (anyone but the writer) acknowledges each one.

type Note = z.output<typeof HandoverNoteItem>;
type Snapshot = z.output<typeof HandoverSnapshot>;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const textareaClass = 'min-h-28 rounded-md border border-border bg-surface p-2 text-sm';

function useHandoverKey(...parts: string[]) {
  const { currentPropertyId } = useSession();
  return ['handovers', currentPropertyId ?? '', ...parts];
}

/** Money in the given currency (drawers may hold foreign cash). */
function useMoney() {
  const { i18n } = useTranslation();
  const session = useSession();
  const locale =
    session.properties.find((p) => p.id === session.currentPropertyId)?.locale ?? i18n.language;
  return (minor: string, currency: string) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(minor) / 100);
}

function More({ total, shown }: { total: number; shown: number }) {
  const { t } = useTranslation();
  if (total <= shown) return null;
  return <li className="text-text-muted">{t('handovers.snapshot.more', { n: total - shown })}</li>;
}

/** The open tasks, approvals, cash and VIPs a handover carries. */
function SnapshotView({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const f = useFormats();
  const money = useMoney();
  const { openTasks, approvals, cash, vips } = snapshot;
  const heading = 'font-semibold';
  return (
    <div className="grid gap-4 text-sm sm:grid-cols-2">
      <section aria-label={t('handovers.snapshot.tasks', { n: openTasks.total })}>
        <h3 className={heading}>{t('handovers.snapshot.tasks', { n: openTasks.total })}</h3>
        {openTasks.total === 0 ? (
          <p className="text-text-muted">{t('handovers.snapshot.noTasks')}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {openTasks.items.map((task) => (
              <li key={task.id}>
                <Link to={`/tasks/${task.id}`} className="text-brand underline">
                  {t('handovers.snapshot.taskLine', { number: task.number, title: task.title })}
                </Link>{' '}
                <span className="text-text-muted">
                  · {t(`tasks.status.${task.status}`)}
                  {task.room && (
                    <> · {t('handovers.snapshot.room', { number: task.room })}</>
                  )} · {task.assignee ?? t('handovers.snapshot.unassigned')}
                </span>
                {task.overdue && (
                  <span className="ml-1 rounded bg-critical-subtle px-1.5 text-xs font-medium text-critical">
                    {t('handovers.snapshot.overdue')}
                  </span>
                )}
              </li>
            ))}
            <More total={openTasks.total} shown={openTasks.items.length} />
          </ul>
        )}
      </section>

      <section aria-label={t('handovers.snapshot.approvals', { n: approvals.total })}>
        <h3 className={heading}>{t('handovers.snapshot.approvals', { n: approvals.total })}</h3>
        {approvals.total === 0 ? (
          <p className="text-text-muted">{t('handovers.snapshot.noApprovals')}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {approvals.items.map((a) => (
              <li key={a.id}>
                {a.label}
                {a.amountMinor && <> · {f.money(a.amountMinor)}</>}{' '}
                <span className="text-text-muted">
                  · {t('handovers.snapshot.requestedBy', { name: a.requestedBy })}
                </span>
              </li>
            ))}
            <More total={approvals.total} shown={approvals.items.length} />
          </ul>
        )}
      </section>

      <section aria-label={t('handovers.snapshot.cash')}>
        <h3 className={heading}>{t('handovers.snapshot.cash')}</h3>
        {cash.drawers.length === 0 ? (
          <p className="text-text-muted">{t('handovers.snapshot.noCash')}</p>
        ) : (
          <table className="mt-1 w-full text-left">
            <tbody>
              {cash.drawers.map((d) => (
                <tr key={d.shiftId} className="border-b border-border">
                  <td className="py-1 pr-2">
                    {d.cashier}
                    <span className="block text-xs text-text-muted">
                      {t(`handovers.snapshot.drawerStatus.${d.status}`, { defaultValue: d.status })}
                    </span>
                  </td>
                  <td className="py-1 text-right">
                    {d.cash.map((c) => (
                      <span key={c.currency} className="block">
                        {money(c.amountMinor, c.currency)}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-1 pr-2">{t('handovers.snapshot.total')}</td>
                <td className="py-1 text-right">
                  {cash.totals.map((c) => (
                    <span key={c.currency} className="block">
                      {money(c.amountMinor, c.currency)}
                    </span>
                  ))}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section aria-label={t('handovers.snapshot.vips', { n: vips.total })}>
        <h3 className={heading}>{t('handovers.snapshot.vips', { n: vips.total })}</h3>
        {vips.total === 0 ? (
          <p className="text-text-muted">{t('handovers.snapshot.noVips')}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {vips.items.map((v) => (
              <li key={`${v.guestId}-${v.arrival}`}>
                {v.name}
                {v.room && <> · {t('handovers.snapshot.room', { number: v.room })}</>}{' '}
                <span className="text-text-muted">
                  ·{' '}
                  {v.status === 'IN_HOUSE'
                    ? t('handovers.snapshot.inHouse', { date: f.date(v.departure) })
                    : t('handovers.snapshot.arriving')}
                </span>
              </li>
            ))}
            <More total={vips.total} shown={vips.items.length} />
          </ul>
        )}
      </section>
    </div>
  );
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────

function WriteHandover() {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const [departmentId, setDepartmentId] = useState('');
  const [notes, setNotes] = useState('');
  const [written, setWritten] = useState(false);
  const listKey = useHandoverKey('list');
  const draft = useQuery({
    queryKey: useHandoverKey('draft', departmentId),
    queryFn: () => api.call('getHandoverDraft', { query: departmentId ? { departmentId } : {} }),
    // Keep the form on screen while another department's draft loads.
    placeholderData: (previous) => previous,
  });
  const chosen = departmentId || draft.data?.departmentId || '';
  const write = useMutation({
    mutationFn: () =>
      api.call('writeHandoverNote', { body: { departmentId: chosen, notes: notes.trim() } }),
    onSuccess: async () => {
      setNotes('');
      setWritten(true);
      await queryClient.invalidateQueries({ queryKey: listKey });
    },
  });
  return (
    <form
      aria-label={t('handovers.write.title')}
      className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setWritten(false);
        write.mutate();
      }}
    >
      <h2 className="text-lg font-semibold">{t('handovers.write.title')}</h2>
      {draft.error && <Alert tone="critical">{errorMessage(draft.error)}</Alert>}
      {draft.data && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="handover-department">{t('handovers.write.department')}</Label>
              <select
                id="handover-department"
                className={selectClass}
                value={chosen}
                onChange={(e) => setDepartmentId(e.target.value)}
              >
                {draft.data.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <p className="pb-3 text-sm text-text-muted">
              {t('handovers.write.businessDate', { date: f.date(draft.data.businessDate) })}
            </p>
          </div>
          <div>
            <h3 className="font-semibold">{t('handovers.write.openNow')}</h3>
            <p className="mb-2 text-xs text-text-muted">{t('handovers.write.openNowHint')}</p>
            <SnapshotView snapshot={draft.data.snapshot} />
          </div>
        </>
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor="handover-notes">{t('handovers.write.notes')}</Label>
        <textarea
          id="handover-notes"
          className={textareaClass}
          maxLength={4000}
          required
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <p className="text-xs text-text-muted">{t('handovers.write.notesHint')}</p>
      </div>
      {write.error && <Alert tone="critical">{errorMessage(write.error)}</Alert>}
      {written && <Alert tone="success">{t('handovers.write.written')}</Alert>}
      <div>
        <Button type="submit" disabled={!chosen || notes.trim() === '' || write.isPending}>
          {t('handovers.write.submit')}
        </Button>
      </div>
    </form>
  );
}

// ── The list ─────────────────────────────────────────────────────────────────────────────

function HandoverCard({ note }: { note: Note }) {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const listKey = useHandoverKey('list');
  const acknowledge = useMutation({
    mutationFn: () => api.call('acknowledgeHandoverNote', { params: { handoverId: note.id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: listKey }),
  });
  const acked = note.acknowledgedBy && note.acknowledgedAt;
  return (
    <li className="rounded-md border border-border bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-semibold">
          {t('handovers.item.heading', {
            department: note.department.name,
            date: f.date(note.businessDate),
          })}
        </h3>
        <span
          className={cn(
            'rounded px-2 py-0.5 text-xs font-medium',
            acked ? 'bg-success-subtle text-success' : 'bg-warning-subtle text-warning',
          )}
        >
          {acked
            ? t('handovers.item.acknowledgedBy', {
                name: note.acknowledgedBy?.name ?? '',
                when: f.when(note.acknowledgedAt ?? ''),
              })
            : t('handovers.item.waiting')}
        </span>
      </div>
      <p className="text-text-muted">
        {t('handovers.item.writtenBy', { name: note.writtenBy.name, when: f.when(note.createdAt) })}
      </p>
      <p className="mt-2 whitespace-pre-wrap">{note.notes}</p>
      <details className="mt-2">
        <summary className="cursor-pointer text-brand">{t('handovers.item.snapshot')}</summary>
        <div className="mt-2">
          <SnapshotView snapshot={note.snapshot} />
        </div>
      </details>
      {acknowledge.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(acknowledge.error)}
        </Alert>
      )}
      {note.canAcknowledge ? (
        <Button
          className="mt-2"
          disabled={acknowledge.isPending}
          onClick={() => acknowledge.mutate()}
        >
          {t('handovers.item.acknowledge')}
        </Button>
      ) : (
        !acked && <p className="mt-2 text-xs text-text-muted">{t('handovers.item.yours')}</p>
      )}
    </li>
  );
}

export function HandoversPage() {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const list = useInfiniteQuery({
    queryKey: useHandoverKey('list', String(pending)),
    queryFn: ({ pageParam }) =>
      api.call('listHandoverNotes', {
        query: {
          ...(pending ? { pending: 'true' as const } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const notes: Note[] = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('handovers.title')}</h1>
      <WriteHandover />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('handovers.list.title')}</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={pending}
            onChange={(e) => setPending(e.target.checked)}
          />
          {t('handovers.list.pendingOnly')}
        </label>
      </div>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {list.data && notes.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('handovers.list.empty')}</p>
      )}
      <ul aria-label={t('handovers.list.label')} className="mt-3 flex flex-col gap-2">
        {notes.map((note) => (
          <HandoverCard key={note.id} note={note} />
        ))}
      </ul>
      {list.hasNextPage && (
        <Button
          variant="secondary"
          className="mt-3"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('handovers.list.loadMore')}
        </Button>
      )}
    </section>
  );
}
