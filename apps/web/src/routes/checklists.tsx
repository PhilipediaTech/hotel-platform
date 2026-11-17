import {
  CHECKLIST_FREQUENCIES,
  type ChecklistFrequency,
  type ChecklistItem,
  type ChecklistRunItem,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import checklistStrings from '../i18n/en/checklists.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(checklistStrings);

// Recurring checklists (PRD M6-13; T-134). "To do" lists a day's runs: the ones given to the
// caller and to no one, or every run for a manager; a run is done by answering each check OK
// or a problem with a note (problems open a task). "Set up" (checklist.manage) creates and
// changes checklists: checks, schedule, due time and assignee.

type Run = z.output<typeof ChecklistRunItem>;
type Checklist = z.output<typeof ChecklistItem>;
type Option = { id: string; name: string };

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const textareaClass = 'min-h-32 rounded-md border border-border bg-surface p-2 text-sm';

const STATUS_TONE: Record<string, string> = {
  PENDING: 'bg-warning-subtle text-warning',
  DONE: 'bg-success-subtle text-success',
  MISSED: 'bg-critical-subtle text-critical',
};

function useKey(...parts: string[]) {
  const { currentPropertyId } = useSession();
  return ['checklists', currentPropertyId ?? '', ...parts];
}

export function ChecklistsPage() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const manager = permissions.includes('checklist.manage');
  const [params, setParams] = useSearchParams();
  const view = manager && params.get('view') === 'manage' ? 'manage' : 'today';
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('cl.title')}</h1>
      {manager && (
        <div role="tablist" aria-label={t('cl.views')} className="mt-3 flex gap-2">
          {(['today', 'manage'] as const).map((v) => (
            <Button
              key={v}
              role="tab"
              aria-selected={view === v}
              variant={view === v ? 'primary' : 'secondary'}
              className="h-11"
              onClick={() => setParams(v === 'today' ? {} : { view: v })}
            >
              {t(`cl.${v}`)}
            </Button>
          ))}
        </div>
      )}
      {view === 'today' ? <RunsView /> : <ManageView />}
    </section>
  );
}

// ── To do ──────────────────────────────────────────────────────────────────────────────

function RunsView() {
  const { t } = useTranslation();
  const [date, setDate] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const key = useKey('runs');
  const runs = useQuery({
    queryKey: [...key, date ?? 'today'],
    queryFn: () => api.call('listChecklistRuns', { query: date ? { date } : {} }),
  });
  const data = runs.data;
  return (
    <div className="mt-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="cl-date">{t('cl.date')}</Label>
        <Input
          id="cl-date"
          type="date"
          className="w-48"
          value={date ?? data?.today ?? ''}
          max={data?.today}
          onChange={(e) => setDate(e.target.value || null)}
        />
      </div>
      {runs.isError && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(runs.error)}
        </Alert>
      )}
      {data && data.data.length === 0 && <p className="mt-4 text-text-muted">{t('cl.noRuns')}</p>}
      {data && data.data.length > 0 && (
        <ul aria-label={t('cl.runs')} className="mt-4 flex flex-col gap-3">
          {data.data.map((run) => (
            <li key={run.id} className="rounded-md border border-border bg-surface p-3">
              <RunCard
                run={run}
                open={open === run.id}
                onOpen={() => setOpen(open === run.id ? null : run.id)}
                onDone={() => setOpen(null)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunCard(props: { run: Run; open: boolean; onOpen: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  const { run } = props;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{run.checklist.name}</p>
          <p className="text-sm text-text-muted">
            {run.checklist.department} · {t('cl.due', { time: f.time(run.dueAt) })} ·{' '}
            {run.assignee?.name ?? t('cl.anyone')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {run.overdue && (
            <span className="rounded px-2 py-0.5 text-xs bg-critical-subtle text-critical">
              {t('cl.overdue')}
            </span>
          )}
          <span className={cn('rounded px-2 py-0.5 text-xs', STATUS_TONE[run.status])}>
            {t(`cl.statuses.${run.status}`)}
          </span>
          {run.canComplete && !props.open && (
            <Button className="h-11" onClick={props.onOpen}>
              {t('cl.start')}
            </Button>
          )}
        </div>
      </div>
      {run.status === 'DONE' && (
        <div className="mt-2 text-sm">
          <p className="text-text-muted">
            {t('cl.doneBy', {
              name: run.completedBy?.name ?? '—',
              time: run.completedAt ? f.time(run.completedAt) : '—',
            })}
            {run.problems > 0 && <> · {t('cl.problems', { count: run.problems })}</>}
            {run.task && <> · {t('cl.task', { number: run.task.number })}</>}
          </p>
          {run.results
            .filter((r) => !r.ok)
            .map((r) => (
              <p key={r.item} className="text-critical">
                {r.item}: {r.note}
              </p>
            ))}
        </div>
      )}
      {props.open && <RunForm run={run} onCancel={props.onOpen} onDone={props.onDone} />}
    </div>
  );
}

function RunForm(props: { run: Run; onCancel: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = useKey('runs');
  const [answers, setAnswers] = useState<({ ok: boolean; note: string } | null)[]>(
    props.run.items.map(() => null),
  );
  const [missing, setMissing] = useState(false);
  const complete = useMutation({
    mutationFn: (results: { ok: boolean; note: string }[]) =>
      api.call('completeChecklistRun', { params: { runId: props.run.id }, body: { results } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      props.onDone();
    },
  });
  const set = (i: number, value: { ok: boolean; note: string }) =>
    setAnswers((a) => a.map((x, j) => (j === i ? value : x)));
  return (
    <form
      aria-label={t('cl.form')}
      className="mt-3 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (answers.some((a) => a === null)) {
          setMissing(true);
          return;
        }
        setMissing(false);
        complete.mutate(answers as { ok: boolean; note: string }[]);
      }}
    >
      {props.run.items.map((item, i) => {
        const a = answers[i] ?? null;
        return (
          <fieldset key={item} className="flex flex-col gap-2 border-t border-border pt-2">
            <legend className="text-sm font-medium">{item}</legend>
            <div className="flex gap-2">
              <Button
                type="button"
                className="h-11"
                aria-pressed={a?.ok === true}
                variant={a?.ok === true ? 'primary' : 'secondary'}
                onClick={() => set(i, { ok: true, note: '' })}
              >
                {t('cl.ok')}
              </Button>
              <Button
                type="button"
                className="h-11"
                aria-pressed={a?.ok === false}
                variant={a?.ok === false ? 'primary' : 'secondary'}
                onClick={() => set(i, { ok: false, note: a?.note ?? '' })}
              >
                {t('cl.problem')}
              </Button>
            </div>
            {a?.ok === false && (
              <div className="flex flex-col gap-1">
                <Label htmlFor={`cl-note-${i}`}>{t('cl.whatsWrong')}</Label>
                <Input
                  id={`cl-note-${i}`}
                  required
                  value={a.note}
                  onChange={(e) => set(i, { ok: false, note: e.target.value })}
                />
              </div>
            )}
          </fieldset>
        );
      })}
      {missing && <Alert tone="critical">{t('cl.answerAll')}</Alert>}
      {complete.isError && <Alert tone="critical">{errorMessage(complete.error)}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" className="h-11" disabled={complete.isPending}>
          {t('cl.submit')}
        </Button>
        <Button type="button" variant="secondary" className="h-11" onClick={props.onCancel}>
          {t('cl.cancel')}
        </Button>
      </div>
    </form>
  );
}

// ── Set up ─────────────────────────────────────────────────────────────────────────────

function useScheduleText() {
  const { t } = useTranslation();
  return (c: Checklist) => {
    const weekdays = t('cl.weekdays', { returnObjects: true }) as unknown as string[];
    const day = c.frequency === 'WEEKLY' ? (weekdays[(c.weekday ?? 1) - 1] ?? '') : c.monthDay;
    return t(`cl.schedule.${c.frequency}`, { time: c.dueTime, day });
  };
}

function ManageView() {
  const { t } = useTranslation();
  const f = useFormats();
  const schedule = useScheduleText();
  const queryClient = useQueryClient();
  const key = useKey('list');
  const [editing, setEditing] = useState<Checklist | 'new' | null>(null);
  const list = useQuery({ queryKey: key, queryFn: () => api.call('listChecklists') });
  const toggle = useMutation({
    mutationFn: (c: Checklist) =>
      api.call('updateChecklist', { params: { checklistId: c.id }, body: { active: !c.active } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keyRoot(key) }),
  });
  const data = list.data;
  return (
    <div className="mt-4">
      {list.isError && <Alert tone="critical">{errorMessage(list.error)}</Alert>}
      {toggle.isError && <Alert tone="critical">{errorMessage(toggle.error)}</Alert>}
      {editing === null && (
        <Button className="h-11" onClick={() => setEditing('new')}>
          {t('cl.add')}
        </Button>
      )}
      {editing !== null && data && (
        <ChecklistForm
          checklist={editing === 'new' ? null : editing}
          departments={data.departments}
          assignees={data.assignees}
          onDone={() => setEditing(null)}
        />
      )}
      {data && data.data.length === 0 && <p className="mt-4 text-text-muted">{t('cl.none')}</p>}
      {data && data.data.length > 0 && (
        <ul aria-label={t('cl.list')} className="mt-4 flex flex-col gap-3">
          {data.data.map((c) => (
            <li
              key={c.id}
              className={cn(
                'rounded-md border border-border bg-surface p-3',
                !c.active && 'opacity-70',
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {c.name}
                    {!c.active && (
                      <span className="ml-2 text-sm text-text-muted">({t('cl.paused')})</span>
                    )}
                  </p>
                  <p className="text-sm text-text-muted">
                    {c.department.name} · {schedule(c)} · {c.assignee?.name ?? t('cl.anyone')} ·{' '}
                    {c.items.length}
                  </p>
                  {c.lastRun && (
                    <p className="text-sm text-text-muted">
                      {t('cl.last', {
                        date: f.date(c.lastRun.dueOn),
                        status: t(`cl.statuses.${c.lastRun.status}`),
                      })}
                    </p>
                  )}
                  {c.missed30 > 0 && (
                    <p className="text-sm text-critical">
                      {t('cl.missed30', { count: c.missed30 })}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" className="h-11" onClick={() => setEditing(c)}>
                    {t('cl.edit')}
                  </Button>
                  <Button
                    variant="secondary"
                    className="h-11"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate(c)}
                  >
                    {c.active ? t('cl.pause') : t('cl.resume')}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** ['checklists', property]: both views refresh after a change. */
const keyRoot = (key: string[]) => key.slice(0, 2);

function ChecklistForm(props: {
  checklist: Checklist | null;
  departments: Option[];
  assignees: Option[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const root = keyRoot(useKey());
  const c = props.checklist;
  const weekdays = t('cl.weekdays', { returnObjects: true }) as unknown as string[];
  const [name, setName] = useState(c?.name ?? '');
  const [departmentId, setDepartmentId] = useState(c?.department.id ?? '');
  const [items, setItems] = useState(c?.items.join('\n') ?? '');
  const [frequency, setFrequency] = useState<ChecklistFrequency>(c?.frequency ?? 'DAILY');
  const [weekday, setWeekday] = useState(String(c?.weekday ?? 1));
  const [monthDay, setMonthDay] = useState(String(c?.monthDay ?? 1));
  const [dueTime, setDueTime] = useState(c?.dueTime ?? '09:00');
  const [assigneeId, setAssigneeId] = useState(c?.assignee?.id ?? '');
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        departmentId,
        items: items
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        frequency,
        weekday: frequency === 'WEEKLY' ? Number(weekday) : null,
        monthDay: frequency === 'MONTHLY' ? Number(monthDay) : null,
        dueTime,
        assigneeId: assigneeId || null,
      };
      return c
        ? api.call('updateChecklist', { params: { checklistId: c.id }, body })
        : api.call('createChecklist', { body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: root });
      props.onDone();
    },
  });
  return (
    <form
      aria-label={t('cl.editor')}
      className="mt-2 flex flex-col gap-3 rounded-md border border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="cl-name">{t('cl.name')}</Label>
        <Input id="cl-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="cl-dept">{t('cl.department')}</Label>
        <select
          id="cl-dept"
          required
          className={selectClass}
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
        >
          <option value="">{t('cl.choose')}</option>
          {props.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="cl-items">{t('cl.items')}</Label>
        <textarea
          id="cl-items"
          required
          className={textareaClass}
          value={items}
          onChange={(e) => setItems(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="cl-freq">{t('cl.frequency')}</Label>
          <select
            id="cl-freq"
            className={selectClass}
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as ChecklistFrequency)}
          >
            {CHECKLIST_FREQUENCIES.map((fr) => (
              <option key={fr} value={fr}>
                {t(`cl.frequencies.${fr}`)}
              </option>
            ))}
          </select>
        </div>
        {frequency === 'WEEKLY' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="cl-weekday">{t('cl.weekday')}</Label>
            <select
              id="cl-weekday"
              className={selectClass}
              value={weekday}
              onChange={(e) => setWeekday(e.target.value)}
            >
              {weekdays.map((d, i) => (
                <option key={d} value={String(i + 1)}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        )}
        {frequency === 'MONTHLY' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="cl-monthday">{t('cl.monthDay')}</Label>
            <Input
              id="cl-monthday"
              type="number"
              min={1}
              max={28}
              className="w-24"
              value={monthDay}
              onChange={(e) => setMonthDay(e.target.value)}
            />
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="cl-time">{t('cl.dueTime')}</Label>
          <Input
            id="cl-time"
            type="time"
            className="w-32"
            value={dueTime}
            onChange={(e) => setDueTime(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="cl-assignee">{t('cl.assignee')}</Label>
          <select
            id="cl-assignee"
            className={selectClass}
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
          >
            <option value="">{t('cl.anyone')}</option>
            {props.assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {save.isError && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {t('cl.save')}
        </Button>
        <Button type="button" variant="secondary" className="h-11" onClick={props.onDone}>
          {t('cl.cancel')}
        </Button>
      </div>
    </form>
  );
}
