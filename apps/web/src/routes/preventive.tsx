import {
  addDays,
  pmOccurrences,
  PRIORITIES,
  type PmDueState,
  type PreventivePlanItem,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import maintenanceStrings from '../i18n/en/maintenance.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(maintenanceStrings);

// S34 PM calendar (PRD M5-10; T-131). Calendar plans on an agenda of the coming weeks (each
// plan's next date, then every N days); run-hours plans with their meter, hours left and a
// reading form. A plan within its lead has its job open: it links to the task page.

type Plan = z.output<typeof PreventivePlanItem>;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const WINDOW_DAYS = 42;
const num = (n: number) => n.toLocaleString('en-NG');
const TONE: Record<PmDueState, string> = {
  OK: 'bg-surface-muted text-text-muted',
  DUE_SOON: 'bg-warning-subtle text-warning',
  OVERDUE: 'bg-critical-subtle text-critical',
};

function usePlansKey() {
  const { currentPropertyId } = useSession();
  return ['maintenance', currentPropertyId ?? '', 'plans'];
}

export function PlansView() {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [offset, setOffset] = useState(0);
  const plans = useQuery({
    queryKey: usePlansKey(),
    queryFn: () => api.call('listPreventivePlans', {}),
  });
  const data = plans.data;
  const calendar = data?.data.filter((p) => p.trigger === 'CALENDAR') ?? [];
  const hours = data?.data.filter((p) => p.trigger === 'RUN_HOURS') ?? [];
  return (
    <div className="mt-4">
      {!adding && (
        <Button className="h-11" onClick={() => setAdding(true)}>
          {t('mnt.pm.add')}
        </Button>
      )}
      {adding && <PlanForm onDone={() => setAdding(false)} />}
      {plans.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(plans.error)}
        </Alert>
      )}
      {data && data.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('mnt.pm.none')}</p>
      )}
      {data && calendar.length > 0 && (
        <Agenda
          plans={calendar}
          today={data.today}
          offset={offset}
          onShift={(by) => setOffset((o) => Math.max(0, o + by))}
        />
      )}
      {data && hours.length > 0 && (
        <section className="mt-6">
          <h2 className="text-base font-semibold">{t('mnt.pm.byHours')}</h2>
          <ul aria-label={t('mnt.pm.byHours')} className="mt-2 flex flex-col gap-2">
            {hours.map((p) => (
              <PlanRow key={p.id} plan={p} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The coming weeks: overdue plans first, then each date with the plans that fall on it. */
function Agenda(props: {
  plans: Plan[];
  today: string;
  offset: number;
  onShift: (by: number) => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const from = addDays(props.today, props.offset);
  const to = addDays(from, WINDOW_DAYS - 1);
  const active = props.plans.filter((p) => p.active && p.nextDueOn && p.everyDays);
  const overdue = active.filter((p) => p.dueState === 'OVERDUE');
  const byDate = new Map<string, Plan[]>();
  for (const p of active) {
    for (const d of pmOccurrences(p.nextDueOn ?? '', p.everyDays ?? 0, from, to)) {
      byDate.set(d, [...(byDate.get(d) ?? []), p]);
    }
  }
  const dates = [...byDate.keys()].sort();
  const paused = props.plans.filter((p) => !p.active);
  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          {t('mnt.pm.calendar', { from: f.date(from), to: f.date(to) })}
        </h2>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="h-11"
            disabled={props.offset === 0}
            onClick={() => props.onShift(-WINDOW_DAYS)}
          >
            {t('mnt.pm.earlier')}
          </Button>
          <Button variant="secondary" className="h-11" onClick={() => props.onShift(WINDOW_DAYS)}>
            {t('mnt.pm.later')}
          </Button>
        </div>
      </div>
      {props.offset === 0 && overdue.length > 0 && (
        <div className="mt-3">
          <h3 className="text-sm font-semibold text-critical">{t('mnt.pm.overdue')}</h3>
          <ul aria-label={t('mnt.pm.overdue')} className="mt-1 flex flex-col gap-2">
            {overdue.map((p) => (
              <PlanRow key={p.id} plan={p} />
            ))}
          </ul>
        </div>
      )}
      {dates.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">{t('mnt.pm.nothingDue')}</p>
      ) : (
        <ol aria-label={t('mnt.pm.agenda')} className="mt-3 flex flex-col gap-3">
          {dates.map((d) => (
            <li key={d}>
              <h3 className="text-sm font-semibold">{f.date(d)}</h3>
              <ul className="mt-1 flex flex-col gap-2">
                {(byDate.get(d) ?? []).map((p) => (
                  <PlanRow key={p.id} plan={p} upcoming={d !== p.nextDueOn} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {paused.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">{t('mnt.pm.paused')}</h3>
          <ul aria-label={t('mnt.pm.paused')} className="mt-1 flex flex-col gap-2">
            {paused.map((p) => (
              <PlanRow key={p.id} plan={p} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** A plan: what, on what, how often, where it stands, its job, and its actions. */
function PlanRow(props: { plan: Plan; upcoming?: boolean }) {
  const { t } = useTranslation();
  const f = useFormats();
  const queryClient = useQueryClient();
  const key = usePlansKey();
  const p = props.plan;
  const [reading, setReading] = useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });
  const toggle = useMutation({
    mutationFn: () =>
      api.call('updatePreventivePlan', { params: { planId: p.id }, body: { active: !p.active } }),
    onSuccess: refresh,
  });
  const read = useMutation({
    mutationFn: (hours: number) =>
      api.call('recordPlanHours', { params: { planId: p.id }, body: { hours } }),
    onSuccess: () => {
      setReading('');
      refresh();
    },
  });
  const hoursValid = /^\d+$/.test(reading.trim());
  const error = toggle.error ?? read.error;
  return (
    <li className="rounded-md border border-border bg-surface p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">
          {p.title}
          {p.asset ? ` · ${p.asset.tag}` : ''}
        </span>
        {!props.upcoming && p.active && (
          <span className={cn('rounded px-2 py-0.5 text-xs font-medium', TONE[p.dueState])}>
            {t(`mnt.pm.state.${p.dueState}`)}
          </span>
        )}
      </div>
      <p className="mt-1 text-text-muted">
        {[
          p.trigger === 'CALENDAR'
            ? t('mnt.pm.everyDays', { count: p.everyDays ?? 0 })
            : t('mnt.pm.everyHours', { count: p.everyHours ?? 0 }),
          p.trigger === 'RUN_HOURS' && p.meterHours !== null
            ? t('mnt.pm.meter', { hours: num(p.meterHours) })
            : null,
          p.trigger === 'RUN_HOURS' && p.hoursLeft !== null
            ? p.hoursLeft >= 0
              ? t('mnt.pm.hoursLeft', { hours: num(p.hoursLeft) })
              : t('mnt.pm.hoursOver', { hours: num(-p.hoursLeft) })
            : null,
          p.trigger === 'CALENDAR' && p.nextDueOn && !props.upcoming
            ? t('mnt.pm.nextDue', { date: f.date(p.nextDueOn) })
            : null,
          p.lastDoneOn ? t('mnt.pm.lastDone', { date: f.date(p.lastDoneOn) }) : null,
          p.assignee?.name,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {p.openTask && !props.upcoming && (
        <Link to={`/tasks/${p.openTask.id}`} className="mt-1 inline-block text-brand underline">
          {t('mnt.pm.job', {
            number: p.openTask.number,
            status: t(`mnt.jobs.status.${p.openTask.status}`, { defaultValue: p.openTask.status }),
          })}
        </Link>
      )}
      {!props.upcoming && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {p.trigger === 'RUN_HOURS' && p.active && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (hoursValid) read.mutate(Number(reading.trim()));
              }}
            >
              <div className="flex flex-col gap-1">
                <Label htmlFor={`pm-reading-${p.id}`}>{t('mnt.pm.reading')}</Label>
                <Input
                  id={`pm-reading-${p.id}`}
                  inputMode="numeric"
                  className="w-32"
                  value={reading}
                  onChange={(e) => setReading(e.target.value)}
                />
              </div>
              <Button
                type="submit"
                variant="secondary"
                className="h-11"
                disabled={!hoursValid || read.isPending}
              >
                {t('mnt.pm.saveReading')}
              </Button>
            </form>
          )}
          <Button
            variant="ghost"
            className="h-11"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate()}
          >
            {p.active ? t('mnt.pm.pause') : t('mnt.pm.resume')}
          </Button>
        </div>
      )}
      {error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(error)}
        </Alert>
      )}
    </li>
  );
}

/** A new plan: by the calendar or by run hours (pm.manage). */
function PlanForm(props: { onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = usePlansKey();
  const { currentPropertyId } = useSession();
  const assets = useQuery({
    queryKey: ['maintenance', currentPropertyId ?? '', 'assets', '', ''],
    queryFn: () => api.call('listAssets', {}),
  });
  const options = useQuery({
    queryKey: ['maintenance', currentPropertyId ?? '', 'form-options'],
    queryFn: () => api.call('getTaskFormOptions', {}),
  });
  const [form, setForm] = useState({
    title: '',
    instructions: '',
    trigger: 'CALENDAR' as 'CALENDAR' | 'RUN_HOURS',
    assetId: '',
    everyDays: '90',
    firstDueOn: '',
    everyHours: '250',
    lastServiceHours: '',
    meterHours: '',
    lead: '3',
    assigneeId: '',
    priority: 'NORMAL',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((s) => ({ ...s, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.call('createPreventivePlan', { body: body as never }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      props.onDone();
    },
  });
  const whole = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null);
  const calendar = form.trigger === 'CALENDAR';
  const submit = () => {
    const lead = whole(form.lead);
    const every = whole(calendar ? form.everyDays : form.everyHours);
    const last = calendar ? null : whole(form.lastServiceHours);
    const meter = calendar || form.meterHours.trim() === '' ? null : whole(form.meterHours);
    if (
      lead === null ||
      every === null ||
      (!calendar && last === null) ||
      (!calendar && form.meterHours.trim() !== '' && meter === null)
    ) {
      setProblem(t('mnt.pm.badNumber'));
      return;
    }
    setProblem(null);
    save.mutate({
      title: form.title,
      instructions: form.instructions,
      assetId: form.assetId || null,
      trigger: form.trigger,
      ...(calendar
        ? { everyDays: every, firstDueOn: form.firstDueOn || null, leadDays: lead }
        : { everyHours: every, lastServiceHours: last, meterHours: meter, leadHours: lead }),
      assigneeId: form.assigneeId || null,
      priority: form.priority,
    });
  };
  const field = (k: keyof typeof form, label: string, extra: object = {}) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`pm-${k}`}>{label}</Label>
      <Input id={`pm-${k}`} value={form[k]} onChange={set(k)} {...extra} />
    </div>
  );
  return (
    <form
      aria-label={t('mnt.pm.form')}
      className="mt-3 grid gap-3 rounded-md border border-border bg-surface p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {field('title', t('mnt.pm.title'))}
      <div className="flex flex-col gap-1">
        <Label htmlFor="pm-assetId">{t('mnt.pm.asset')}</Label>
        <select
          id="pm-assetId"
          className={selectClass}
          value={form.assetId}
          onChange={set('assetId')}
        >
          <option value="">{t('mnt.pm.noAsset')}</option>
          {assets.data?.data
            .filter((a) => a.status !== 'RETIRED')
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.tag} · {a.name}
              </option>
            ))}
        </select>
      </div>
      <fieldset className="flex flex-wrap gap-4 sm:col-span-2">
        <legend className="text-sm font-medium">{t('mnt.pm.trigger')}</legend>
        {(['CALENDAR', 'RUN_HOURS'] as const).map((v) => (
          <label key={v} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio"
              name="pm-trigger"
              className="size-5"
              checked={form.trigger === v}
              onChange={() =>
                setForm((s) => ({ ...s, trigger: v, lead: v === 'CALENDAR' ? '3' : '10' }))
              }
            />
            {t(`mnt.pm.triggers.${v}`)}
          </label>
        ))}
      </fieldset>
      {calendar ? (
        <>
          {field('everyDays', t('mnt.pm.everyDaysField'), { inputMode: 'numeric' })}
          {field('firstDueOn', t('mnt.pm.firstDueOn'), { type: 'date' })}
          {field('lead', t('mnt.pm.leadDays'), { inputMode: 'numeric' })}
        </>
      ) : (
        <>
          {field('everyHours', t('mnt.pm.everyHoursField'), { inputMode: 'numeric' })}
          {field('lastServiceHours', t('mnt.pm.lastServiceHours'), { inputMode: 'numeric' })}
          {field('meterHours', t('mnt.pm.meterHours'), { inputMode: 'numeric' })}
          {field('lead', t('mnt.pm.leadHours'), { inputMode: 'numeric' })}
        </>
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor="pm-assigneeId">{t('mnt.pm.assignee')}</Label>
        <select
          id="pm-assigneeId"
          className={selectClass}
          value={form.assigneeId}
          onChange={set('assigneeId')}
        >
          <option value="">{t('mnt.pm.noAssignee')}</option>
          {options.data?.assignees.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="pm-priority">{t('mnt.pm.priority')}</Label>
        <select
          id="pm-priority"
          className={selectClass}
          value={form.priority}
          onChange={set('priority')}
        >
          {PRIORITIES.map((v) => (
            <option key={v} value={v}>
              {t(`mnt.pm.priorities.${v}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label htmlFor="pm-instructions">{t('mnt.pm.instructions')}</Label>
        <textarea
          id="pm-instructions"
          className="min-h-20 rounded-md border border-border bg-surface p-2 text-sm"
          value={form.instructions}
          onChange={set('instructions')}
        />
      </div>
      {problem && (
        <Alert tone="critical" className="sm:col-span-2">
          {problem}
        </Alert>
      )}
      {save.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {t('mnt.pm.save')}
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={props.onDone}>
          {t('mnt.cancel')}
        </Button>
      </div>
    </form>
  );
}
