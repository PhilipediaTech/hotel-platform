import {
  FAULT_CATEGORIES,
  PRIORITIES,
  type FaultCategory,
  type Priority,
  type TaskAction,
  type TaskDetail,
  type TaskItem,
} from '@hotel/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api, ApiError } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { uploadFile } from '../lib/files.ts';
import { errorMessage } from '../lib/form.ts';
import tasksStrings from '../i18n/en/tasks.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';
import { sendOrQueue, type Queueable } from '../offline/queue.ts';
import { useOfflineWho } from '../offline/use-offline-key.ts';

registerStrings(tasksStrings);

// S18 Tasks queue and detail, S19 QR fault report (PRD M6-01–M6-05, M5-07; T-082). The queue
// lists open, own or all tasks with their SLA timer; a new task is a template and a tap. The
// detail page shows the timeline and only the actions the API says the user may take now
// (acknowledge, start, hold, resolve with photos, verify, reopen, assign). The QR page opens
// from a room's sticker with the room filled in.

type Task = z.output<typeof TaskItem>;
type Detail = z.output<typeof TaskDetail>;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const textareaClass = 'min-h-20 rounded-md border border-border bg-surface p-2 text-sm';
const DEADLINES = [30, 60, 120, 240, 480, 1440] as const;

const STATUS_TONE: Record<string, string> = {
  REPORTED: 'bg-brand-subtle text-brand-strong',
  TRIAGED: 'bg-brand-subtle text-brand-strong',
  ASSIGNED: 'bg-brand-subtle text-brand-strong',
  ACKNOWLEDGED: 'bg-brand-subtle text-brand-strong',
  IN_PROGRESS: 'bg-brand-subtle text-brand-strong',
  ON_HOLD: 'bg-surface-muted text-text-muted',
  RESOLVED: 'bg-success-subtle text-success',
  VERIFIED: 'bg-success-subtle text-success',
  CLOSED: 'bg-surface-muted text-text-muted',
};

function useTaskKey(...parts: string[]) {
  const { currentPropertyId } = useSession();
  return ['tasks', currentPropertyId ?? '', ...parts];
}

/** Re-renders every 30 seconds, so SLA timers count down. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function useDuration() {
  const { t } = useTranslation();
  return (ms: number) => {
    const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
    if (minutes < 60) return t('tasks.minutes', { count: minutes });
    if (minutes < 60 * 24) {
      return t('tasks.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
    }
    return t('tasks.days', { count: Math.floor(minutes / (60 * 24)) });
  };
}

/** "Due in 25 min", "Overdue by 1 h 5 min", or no deadline (M6-05 SLA timer). */
function SlaTimer({ task, now }: { task: Task; now: number }) {
  const { t } = useTranslation();
  const duration = useDuration();
  if (!task.dueAt) return <span className="text-text-muted">{t('tasks.noDeadline')}</span>;
  const open = !['RESOLVED', 'VERIFIED', 'CLOSED'].includes(task.status);
  if (!open) return null;
  const left = new Date(task.dueAt).getTime() - now;
  return left > 0 ? (
    <span className="text-text-muted">{t('tasks.dueIn', { time: duration(left) })}</span>
  ) : (
    <span className="font-medium text-critical">
      {t('tasks.overdueBy', { time: duration(left) })}
    </span>
  );
}

function Badges({ task }: { task: Task }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap gap-1 text-xs font-medium">
      <span className={cn('rounded px-2 py-0.5', STATUS_TONE[task.status])}>
        {t(`tasks.status.${task.status}`)}
      </span>
      <span
        className={cn(
          'rounded px-2 py-0.5',
          task.priority === 'CRITICAL' || task.priority === 'HIGH'
            ? 'bg-critical-subtle text-critical'
            : 'bg-surface-muted text-text-muted',
        )}
      >
        {t(`tasks.priority.${task.priority}`)}
      </span>
      {task.escalationLevel > 0 && (
        <span className="rounded bg-critical-subtle px-2 py-0.5 text-critical">
          {t('tasks.escalated', { level: task.escalationLevel })}
        </span>
      )}
    </span>
  );
}

// ── S18 Tasks queue ────────────────────────────────────────────────────────────────────

type View = 'open' | 'mine' | 'all';

export function TasksPage() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const now = useNow();
  const view: View =
    params.get('assignee') === 'me' ? 'mine' : params.get('view') === 'all' ? 'all' : 'open';
  const overdue = params.get('overdue') === 'true';
  const filters = {
    ...(view === 'all' ? {} : { status: 'open' as const }),
    ...(view === 'mine' ? { assignee: 'me' as const } : {}),
    ...(overdue ? { overdue: 'true' as const } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: useTaskKey('list', view, String(overdue)),
    queryFn: ({ pageParam }) =>
      api.call('listTasks', { query: { ...filters, ...(pageParam ? { cursor: pageParam } : {}) } }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const canCreate = permissions.includes('task.create') || permissions.includes('task.report');
  const show = (next: View) => {
    const p = new URLSearchParams();
    if (next === 'mine') p.set('assignee', 'me');
    if (next === 'all') p.set('view', 'all');
    if (overdue) p.set('overdue', 'true');
    setParams(p);
  };
  const tasks: Task[] = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <section className="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('tasks.title')}</h1>
        {canCreate && (
          <Link
            to="/tasks/new"
            className="inline-flex h-11 items-center rounded-md bg-brand px-4 text-sm font-medium text-on-brand"
          >
            {t('tasks.newTask')}
          </Link>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div role="group" aria-label={t('tasks.views')} className="flex gap-1">
          {(['open', 'mine', 'all'] as const).map((v) => (
            <Button
              key={v}
              variant={view === v ? 'primary' : 'secondary'}
              aria-pressed={view === v}
              onClick={() => show(v)}
            >
              {t(`tasks.view.${v}`)}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={overdue}
            onChange={(e) => {
              const p = new URLSearchParams(params);
              if (e.target.checked) p.set('overdue', 'true');
              else p.delete('overdue');
              setParams(p);
            }}
          />
          {t('tasks.overdueOnly')}
        </label>
      </div>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {list.data && tasks.length === 0 && (
        <p className="mt-4 text-sm text-text-muted">{t('tasks.empty')}</p>
      )}
      <ul aria-label={t('tasks.list')} className="mt-4 flex flex-col gap-2">
        {tasks.map((task) => (
          <li key={task.id} className="rounded-md border border-border bg-surface p-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Link to={`/tasks/${task.id}`} className="font-semibold text-brand underline">
                {t('tasks.numberTitle', { number: task.number, title: task.title })}
              </Link>
              <Badges task={task} />
            </div>
            <p className="mt-1 flex flex-wrap gap-x-2 text-text-muted">
              <span>{t(`tasks.type.${task.type}`)}</span>
              <span>· {task.department.name}</span>
              {task.room && <span>· {t('tasks.room', { number: task.room.number })}</span>}
              <span>· {task.assignee?.name ?? t('tasks.unassigned')}</span>
              <span>
                · <SlaTimer task={task} now={now} />
              </span>
            </p>
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <Button
          variant="secondary"
          className="mt-3"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('tasks.loadMore')}
        </Button>
      )}
    </section>
  );
}

// ── Photos ─────────────────────────────────────────────────────────────────────────────

function PhotoInput(props: { id: string; files: File[]; onChange: (files: File[]) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id}>{t('tasks.new.photos')}</Label>
      <input
        id={props.id}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="text-sm"
        onChange={(e) => props.onChange([...(e.target.files ?? [])].slice(0, 5))}
      />
      <p className="text-xs text-text-muted">{t('tasks.new.photosHint')}</p>
    </div>
  );
}

const uploadAll = (files: File[]) => Promise.all(files.map((f) => uploadFile('Task', f)));

function Photo({ fileId, n }: { fileId: string; n: number }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <Button
        variant="ghost"
        size="sm"
        className="underline"
        onClick={() => {
          setError(null);
          api.call('getFileDownloadUrl', { params: { fileId } }).then(
            ({ url }) => window.open(url, '_blank', 'noopener'),
            (err: unknown) =>
              setError(
                err instanceof ApiError && err.code === 'FILE_NOT_READY'
                  ? t('tasks.photoNotReady')
                  : errorMessage(err),
              ),
          );
        }}
      >
        {t('tasks.photo', { n })}
      </Button>
      {error && <span className="text-xs text-critical">{error}</span>}
    </span>
  );
}

// ── S18 New task ───────────────────────────────────────────────────────────────────────

export function NewTaskPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { permissions } = useSession();
  const [params] = useSearchParams();
  const templates = useQuery({
    queryKey: useTaskKey('templates'),
    queryFn: () => api.call('listTaskTemplates'),
  });
  const options = useQuery({
    queryKey: useTaskKey('form-options'),
    queryFn: () => api.call('getTaskFormOptions'),
  });
  const active = (templates.data?.data ?? []).filter((x) => x.active);
  const wanted = params.get('type');
  const [templateId, setTemplateId] = useState('');
  const chosen = templateId || active.find((x) => x.type === wanted)?.id || '';
  const [roomId, setRoomId] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [priority, setPriority] = useState<Priority | ''>('');
  const [assigneeId, setAssigneeId] = useState('');
  const [deadline, setDeadline] = useState('');
  const [missing, setMissing] = useState(false);
  const manager = permissions.includes('task.assign');
  const create = useMutation({
    mutationFn: async () => {
      const fileIds = await uploadAll(files);
      return api.call('createTask', {
        body: {
          templateId: chosen,
          ...(roomId ? { roomId } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(fileIds.length ? { fileIds } : {}),
          ...(priority ? { priority } : {}),
          ...(assigneeId ? { assigneeId } : {}),
          ...(deadline
            ? { dueAt: new Date(Date.now() + Number(deadline) * 60_000).toISOString() }
            : {}),
        },
      });
    },
    onSuccess: (task) => void navigate(`/tasks/${task.id}`),
  });
  return (
    <section className="max-w-2xl">
      <h1 className="text-xl font-semibold">{t('tasks.new.title')}</h1>
      {(templates.error ?? options.error) && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(templates.error ?? options.error)}
        </Alert>
      )}
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen) {
            setMissing(true);
            return;
          }
          create.mutate();
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('tasks.new.template')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {active.map((x) => (
              <label
                key={x.id}
                className={cn(
                  'flex min-h-touch cursor-pointer items-center gap-2 rounded-md border bg-surface px-3 text-sm',
                  chosen === x.id ? 'border-brand' : 'border-border',
                )}
              >
                <input
                  type="radio"
                  name="template"
                  className="size-5"
                  checked={chosen === x.id}
                  onChange={() => {
                    setTemplateId(x.id);
                    setMissing(false);
                  }}
                />
                <span>
                  {x.name}
                  <span className="block text-xs text-text-muted">{x.department.name}</span>
                </span>
              </label>
            ))}
          </div>
          {missing && <p className="text-sm text-critical">{t('tasks.new.chooseTemplate')}</p>}
        </fieldset>
        <div className="flex flex-col gap-1">
          <Label htmlFor="task-room">{t('tasks.new.room')}</Label>
          <select
            id="task-room"
            className={selectClass}
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          >
            <option value="">{t('tasks.new.noRoom')}</option>
            {options.data?.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.number}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="task-description">{t('tasks.new.description')}</Label>
          <textarea
            id="task-description"
            className={textareaClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <PhotoInput id="task-photos" files={files} onChange={setFiles} />
        {manager && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="task-priority">{t('tasks.new.priority')}</Label>
              <select
                id="task-priority"
                className={selectClass}
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority | '')}
              >
                <option value="">{t('tasks.new.templatePriority')}</option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`tasks.priority.${p}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="task-assignee">{t('tasks.new.assignee')}</Label>
              <select
                id="task-assignee"
                className={selectClass}
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
              >
                <option value="">{t('tasks.new.nobody')}</option>
                {options.data?.assignees.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.department ? `${a.name} (${a.department})` : a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="task-deadline">{t('tasks.new.deadline')}</Label>
              <select
                id="task-deadline"
                className={selectClass}
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              >
                <option value="">{t('tasks.new.templateDeadline')}</option>
                {DEADLINES.map((m) => (
                  <option key={m} value={m}>
                    {t(`tasks.deadlineIn.${m}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        {create.error && <Alert tone="critical">{errorMessage(create.error)}</Alert>}
        <Button type="submit" size="touch" className="self-start" disabled={create.isPending}>
          {t('tasks.new.create')}
        </Button>
      </form>
    </section>
  );
}

// ── S18 Task detail ────────────────────────────────────────────────────────────────────

export function TaskPage() {
  const { t } = useTranslation();
  const { taskId = '' } = useParams();
  const queryClient = useQueryClient();
  const formats = useFormats();
  const now = useNow();
  const key = useTaskKey('detail', taskId);
  const listKey = useTaskKey('list');
  const task = useQuery({
    queryKey: key,
    queryFn: () => api.call('getTask', { params: { taskId } }),
  });
  const onDone = (detail: Detail) => {
    queryClient.setQueryData(key, detail);
    void queryClient.invalidateQueries({ queryKey: listKey });
  };
  if (task.error) return <Alert tone="critical">{errorMessage(task.error)}</Alert>;
  const d = task.data;
  if (!d) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  const row = (label: string, value: ReactNode) => (
    <div className="flex flex-col">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <section className="max-w-3xl">
      <Link to="/tasks" className="text-sm text-brand underline">
        {t('tasks.detail.back')}
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
        <h1 className="text-xl font-semibold">
          {t('tasks.numberTitle', { number: d.number, title: d.title })}
        </h1>
        <Badges task={d} />
      </div>
      {d.description && <p className="mt-2 whitespace-pre-line text-sm">{d.description}</p>}
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        {row(t('tasks.detail.department'), `${d.department.name} · ${t(`tasks.type.${d.type}`)}`)}
        {d.room && row(t('tasks.new.room'), d.room.number)}
        {d.guest && row(t('tasks.detail.guest'), d.guest.name)}
        {row(t('tasks.detail.reportedBy'), d.reportedBy?.name ?? t('tasks.detail.system'))}
        {row(t('tasks.detail.assignee'), d.assignee?.name ?? t('tasks.unassigned'))}
        {row(
          t('tasks.detail.deadline'),
          d.dueAt ? (
            <>
              {formats.when(d.dueAt)} <SlaTimer task={d} now={now} />
            </>
          ) : (
            t('tasks.noDeadline')
          ),
        )}
        {row(t('tasks.detail.created'), formats.when(d.createdAt))}
      </dl>
      <Actions task={d} onDone={onDone} />
      <h2 className="mt-6 text-base font-semibold">{t('tasks.detail.timeline')}</h2>
      <ol aria-label={t('tasks.detail.timeline')} className="mt-2 flex flex-col gap-2">
        {d.events.map((e) => (
          <li key={e.id} className="rounded-md border border-border bg-surface p-3 text-sm">
            <p>
              <span className="text-text-muted">{formats.when(e.at)} · </span>
              {eventText(t, e)}
            </p>
            {e.note && <p className="mt-1 whitespace-pre-line">{e.note}</p>}
            {e.fileIds.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1">
                {e.fileIds.map((f, i) => (
                  <Photo key={f} fileId={f} n={i + 1} />
                ))}
              </p>
            )}
          </li>
        ))}
      </ol>
      {d.canComment && <CommentForm taskId={d.id} number={d.number} onDone={onDone} />}
    </section>
  );
}

type T = ReturnType<typeof useTranslation>['t'];

function eventText(t: T, e: Detail['events'][number]): string {
  const who = e.by?.name ?? t('tasks.detail.system');
  if (e.kind === 'ESCALATE') return t('tasks.event.escalate');
  if (e.kind === 'ASSIGN') return t('tasks.event.assign', { who });
  if (e.kind === 'COMMENT') return t('tasks.event.comment', { who });
  if (e.kind === 'ATTACH') return t('tasks.event.attach', { who });
  if (!e.fromStatus) return t('tasks.event.created', { who });
  return t('tasks.event.status', {
    who,
    from: t(`tasks.status.${e.fromStatus}`),
    to: t(`tasks.status.${e.toStatus ?? e.fromStatus}`),
  });
}

/**
 * Sends a task update now, or keeps it on the device offline (T-093): answers the task, or
 * null when it waits.
 */
function useTaskSender(number: number) {
  const { t } = useTranslation();
  const who = useOfflineWho();
  return async (
    operationId: Queueable,
    input: { params: { taskId: string }; body?: unknown },
    what: string,
  ): Promise<Detail | null> => {
    const sent = await sendOrQueue<Detail>(who, operationId, input, {
      label: t('offline.labels.task', { number, what }),
    });
    return sent.queued ? null : sent.result;
  };
}

function QueuedNote({ show }: { show: boolean }) {
  const { t } = useTranslation();
  return show ? <Alert tone="info">{t('offline.queuedNow')}</Alert> : null;
}

function Actions({ task, onDone }: { task: Detail; onDone: (d: Detail) => void }) {
  const { t } = useTranslation();
  const has = (a: TaskAction) => task.actions.includes(a);
  const params = { taskId: task.id };
  const sendTask = useTaskSender(task.number);
  const [queued, setQueued] = useState(false);
  const simple = useMutation({
    mutationFn: (action: 'acknowledgeTask' | 'startTask' | 'verifyTask') =>
      action === 'verifyTask'
        ? api.call('verifyTask', { params, body: {} })
        : sendTask(
            action,
            { params },
            t(`tasks.action.${action === 'startTask' ? 'start' : 'acknowledge'}`),
          ),
    onSuccess: (d: Detail | null) => (d ? onDone(d) : setQueued(true)),
  });
  const done = (d: Detail | null) => (d ? onDone(d) : setQueued(true));
  if (task.actions.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-surface-muted p-3">
      <div className="flex flex-wrap gap-2">
        {has('acknowledge') && (
          <Button size="touch" onClick={() => simple.mutate('acknowledgeTask')}>
            {t('tasks.action.acknowledge')}
          </Button>
        )}
        {has('start') && (
          <Button size="touch" onClick={() => simple.mutate('startTask')}>
            {task.status === 'ON_HOLD' ? t('tasks.action.resume') : t('tasks.action.start')}
          </Button>
        )}
        {has('verify') && (
          <Button size="touch" onClick={() => simple.mutate('verifyTask')}>
            {t('tasks.action.verify')}
          </Button>
        )}
      </div>
      {simple.error && <Alert tone="critical">{errorMessage(simple.error)}</Alert>}
      <QueuedNote show={queued} />
      {has('resolve') && <ResolveForm task={task} onDone={done} />}
      {has('hold') && (
        <ReasonForm
          id="hold"
          label={t('tasks.action.holdReason')}
          button={t('tasks.action.hold')}
          send={(reason) =>
            sendTask('holdTask', { params, body: { reason } }, t('tasks.action.hold'))
          }
          onDone={done}
        />
      )}
      {has('reopen') && (
        <ReasonForm
          id="reopen"
          label={t('tasks.action.reopenReason')}
          button={t('tasks.action.reopen')}
          send={(reason) => api.call('reopenTask', { params, body: { reason } })}
          onDone={done}
        />
      )}
      {has('assign') && <AssignForm task={task} onDone={onDone} />}
    </div>
  );
}

function ReasonForm(props: {
  id: string;
  label: string;
  button: string;
  send: (reason: string) => Promise<Detail | null>;
  onDone: (d: Detail | null) => void;
}) {
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () => props.send(reason.trim()),
    onSuccess: (d) => {
      setReason('');
      props.onDone(d);
    },
  });
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <Label htmlFor={`task-${props.id}`}>{props.label}</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={`task-${props.id}`}
          className="min-w-60 flex-1"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
        />
        <Button type="submit" variant="secondary" size="touch" disabled={send.isPending}>
          {props.button}
        </Button>
      </div>
      {send.error && <Alert tone="critical">{errorMessage(send.error)}</Alert>}
    </form>
  );
}

function ResolveForm({ task, onDone }: { task: Detail; onDone: (d: Detail | null) => void }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const sendResolve = useTaskSender(task.number);
  const resolve = useMutation({
    mutationFn: async () => {
      // Without photos it can wait offline; photos need the connection to upload.
      if (files.length === 0) {
        return sendResolve(
          'resolveTask',
          { params: { taskId: task.id }, body: { note: note.trim() } },
          t('tasks.action.resolve'),
        );
      }
      const fileIds = await uploadAll(files);
      return api.call('resolveTask', {
        params: { taskId: task.id },
        body: { note: note.trim(), ...(fileIds.length ? { fileIds } : {}) },
      });
    },
    onSuccess: onDone,
  });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        resolve.mutate();
      }}
    >
      <Label htmlFor="task-resolve">{t('tasks.action.resolveNote')}</Label>
      <textarea
        id="task-resolve"
        className={textareaClass}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        required
        minLength={3}
      />
      <PhotoInput id="task-resolve-photos" files={files} onChange={setFiles} />
      {resolve.error && <Alert tone="critical">{errorMessage(resolve.error)}</Alert>}
      <Button type="submit" size="touch" className="self-start" disabled={resolve.isPending}>
        {t('tasks.action.resolve')}
      </Button>
    </form>
  );
}

function AssignForm({ task, onDone }: { task: Detail; onDone: (d: Detail) => void }) {
  const { t } = useTranslation();
  const options = useQuery({
    queryKey: useTaskKey('form-options'),
    queryFn: () => api.call('getTaskFormOptions'),
  });
  const [assigneeId, setAssigneeId] = useState(task.assignee?.id ?? '');
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [deadline, setDeadline] = useState('');
  const assign = useMutation({
    mutationFn: () =>
      api.call('assignTask', {
        params: { taskId: task.id },
        body: {
          assigneeId: assigneeId || null,
          priority,
          ...(deadline === 'none'
            ? { dueAt: null }
            : deadline
              ? { dueAt: new Date(Date.now() + Number(deadline) * 60_000).toISOString() }
              : {}),
        },
      }),
    onSuccess: onDone,
  });
  return (
    <form
      aria-label={t('tasks.action.assign')}
      className="grid items-end gap-3 sm:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        assign.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="assign-to">{t('tasks.new.assignee')}</Label>
        <select
          id="assign-to"
          className={selectClass}
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
        >
          <option value="">{t('tasks.new.nobody')}</option>
          {options.data?.assignees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.department ? `${a.name} (${a.department})` : a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="assign-priority">{t('tasks.new.priority')}</Label>
        <select
          id="assign-priority"
          className={selectClass}
          value={priority}
          onChange={(e) => setPriority(e.target.value as Priority)}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t(`tasks.priority.${p}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="assign-deadline">{t('tasks.new.deadline')}</Label>
        <select
          id="assign-deadline"
          className={selectClass}
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
        >
          <option value="">{t('tasks.detail.keepDeadline')}</option>
          {DEADLINES.map((m) => (
            <option key={m} value={m}>
              {t(`tasks.deadlineIn.${m}`)}
            </option>
          ))}
          <option value="none">{t('tasks.detail.noDeadline')}</option>
        </select>
      </div>
      <Button type="submit" size="touch" disabled={assign.isPending}>
        {t('tasks.action.assign')}
      </Button>
      {assign.error && (
        <Alert tone="critical" className="sm:col-span-4">
          {errorMessage(assign.error)}
        </Alert>
      )}
    </form>
  );
}

function CommentForm({
  taskId,
  number,
  onDone,
}: {
  taskId: string;
  number: number;
  onDone: (d: Detail) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [formKey, setFormKey] = useState(0);
  const sendComment = useTaskSender(number);
  const [queued, setQueued] = useState(false);
  const comment = useMutation({
    mutationFn: async () => {
      // A note alone can wait offline (the QA journey's "note queued"); photos cannot.
      if (files.length === 0) {
        return sendComment(
          'addTaskComment',
          { params: { taskId }, body: { note: note.trim() } },
          t('tasks.action.comment'),
        );
      }
      const fileIds = await uploadAll(files);
      return api.call('addTaskComment', {
        params: { taskId },
        body: {
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(fileIds.length ? { fileIds } : {}),
        },
      });
    },
    onSuccess: (d: Detail | null) => {
      setNote('');
      setFiles([]);
      setFormKey((k) => k + 1);
      setQueued(d === null);
      if (d) onDone(d);
    },
  });
  return (
    <form
      key={formKey}
      className="mt-4 flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim() || files.length) comment.mutate();
      }}
    >
      <Label htmlFor="task-comment">{t('tasks.action.commentNote')}</Label>
      <textarea
        id="task-comment"
        className={textareaClass}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <PhotoInput id="task-comment-photos" files={files} onChange={setFiles} />
      {comment.error && <Alert tone="critical">{errorMessage(comment.error)}</Alert>}
      <QueuedNote show={queued} />
      <Button type="submit" variant="secondary" className="self-start" disabled={comment.isPending}>
        {t('tasks.action.comment')}
      </Button>
    </form>
  );
}

// ── S19 QR fault report ────────────────────────────────────────────────────────────────

const nextDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export function QrFaultPage() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const formats = useFormats();
  const room = useQuery({
    queryKey: useTaskKey('qr', token),
    queryFn: () => api.call('getQrRoom', { params: { token } }),
    retry: false,
  });
  const [category, setCategory] = useState<FaultCategory>('OTHER');
  const [severity, setSeverity] = useState<Priority>('NORMAL');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [outOfOrder, setOutOfOrder] = useState(false);
  const [until, setUntil] = useState('');
  const report = useMutation({
    mutationFn: async () => {
      const fileIds = await uploadAll(files);
      const back = until || (room.data ? nextDay(room.data.today) : '');
      return api.call('reportQrFault', {
        params: { token },
        body: {
          category,
          severity,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(fileIds.length ? { fileIds } : {}),
          ...(severity === 'CRITICAL' && outOfOrder ? { outOfOrderUntil: back } : {}),
        },
      });
    },
  });
  if (room.error) return <Alert tone="critical">{errorMessage(room.error)}</Alert>;
  const r = room.data;
  if (!r) return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  const done = report.data;
  return (
    <section className="max-w-xl">
      <h1 className="text-xl font-semibold">{t('tasks.qr.title')}</h1>
      <p className="mt-1 text-sm">
        {t('tasks.qr.location', { number: r.number, type: r.roomType })}
        {r.floor ? ` · ${t('tasks.qr.floor', { floor: r.floor })}` : ''}
      </p>
      {done ? (
        <div className="mt-4 flex flex-col gap-3">
          <Alert tone="success">{t('tasks.qr.sent', { number: done.task.number })}</Alert>
          {done.outOfOrder &&
            (done.outOfOrder.blocked ? (
              <Alert tone="info">
                {t('tasks.qr.blocked', {
                  number: r.number,
                  until: formats.date(done.outOfOrder.until),
                })}
              </Alert>
            ) : (
              <Alert tone="critical">
                {t('tasks.qr.notBlocked', { reason: done.outOfOrder.reason ?? '' })}
              </Alert>
            ))}
          <div className="flex flex-wrap gap-2">
            <Link to={`/tasks/${done.task.id}`} className="text-sm text-brand underline">
              {t('tasks.qr.open')}
            </Link>
            <Button variant="secondary" onClick={() => report.reset()}>
              {t('tasks.qr.another')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            report.mutate();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="fault-category">{t('tasks.qr.category')}</Label>
            <select
              id="fault-category"
              className={selectClass}
              value={category}
              onChange={(e) => setCategory(e.target.value as FaultCategory)}
            >
              {FAULT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`tasks.category.${c}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="fault-severity">{t('tasks.qr.severity')}</Label>
            <select
              id="fault-severity"
              className={selectClass}
              value={severity}
              onChange={(e) => setSeverity(e.target.value as Priority)}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`tasks.priority.${p}`)}
                </option>
              ))}
            </select>
          </div>
          {severity === 'CRITICAL' && (
            <div className="flex flex-col gap-2 rounded-md bg-critical-subtle p-3 text-sm">
              <p>{t('tasks.qr.criticalHint')}</p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={outOfOrder}
                  onChange={(e) => setOutOfOrder(e.target.checked)}
                />
                {t('tasks.qr.outOfOrder')}
              </label>
              {outOfOrder && (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="fault-until">{t('tasks.qr.outOfOrderUntil')}</Label>
                  <Input
                    id="fault-until"
                    type="date"
                    min={nextDay(r.today)}
                    value={until || nextDay(r.today)}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                </div>
              )}
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="fault-description">{t('tasks.qr.description')}</Label>
            <textarea
              id="fault-description"
              className={textareaClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <PhotoInput id="fault-photos" files={files} onChange={setFiles} />
          {report.error && <Alert tone="critical">{errorMessage(report.error)}</Alert>}
          <Button type="submit" size="touch" className="self-start" disabled={report.isPending}>
            {t('tasks.qr.submit')}
          </Button>
        </form>
      )}
    </section>
  );
}
