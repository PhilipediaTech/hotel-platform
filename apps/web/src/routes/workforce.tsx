import {
  addDays,
  isoWeekday,
  LEAVE_STATUSES,
  LEAVE_TYPES,
  localDate,
  type DutyItem,
  type LeaveItem,
  type LeaveStatus,
  type LeaveType,
  type Rota,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { errorMessage } from '../lib/form.ts';
import workforceStrings from '../i18n/en/workforce.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(workforceStrings);

// S36 Staff and workforce, continued (PRD M7-02 duties, M7-03 rota, M7-05 leave; T-137):
// standing duties for staff without a rota, a department's weekly rota with publishing, and
// leave (my own work and requests, and the requests a manager decides). Approving leave takes
// the person off their rota slots on those dates; the API does it and reports how many.

type Duty = z.output<typeof DutyItem>;
type Leave = z.output<typeof LeaveItem>;
type RotaData = z.output<typeof Rota>;
type StaffRef = { id: string; number: number; name: string };

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const LEAVE_TONE: Record<LeaveStatus, string> = {
  PENDING: 'bg-warning-subtle text-warning',
  APPROVED: 'bg-success-subtle text-success',
  REJECTED: 'bg-critical-subtle text-critical',
  CANCELLED: 'bg-surface-muted',
};

function useRoot() {
  const { currentPropertyId } = useSession();
  return ['workforce', currentPropertyId ?? ''];
}

/** Today at the property, as YYYY-MM-DD. */
function usePropertyToday() {
  const session = useSession();
  const property = session.properties.find((p) => p.id === session.currentPropertyId);
  const [today] = useState(() => localDate(new Date(), property?.timeZone ?? 'UTC'));
  return today;
}

function useDays() {
  const { t } = useTranslation();
  return (weekdays: readonly number[]) =>
    weekdays.length === 0 ? t('wf.everyDay') : weekdays.map((d) => t(`wf.days.${d}`)).join(', ');
}

// ── Duties (M7-02) ─────────────────────────────────────────────────────────────────────

export function DutiesPage() {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const days = useDays();
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: [...root, 'duties'],
    queryFn: () => api.call('listDuties', {}),
  });
  const toggle = useMutation({
    mutationFn: (d: Duty) =>
      api.call('updateDuty', { params: { dutyId: d.id }, body: { active: !d.active } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: root }),
  });
  const data = list.data;
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('wf.duties.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('wf.duties.intro')}</p>
      {!adding && (
        <Button className="mt-3 h-11" onClick={() => setAdding(true)}>
          {t('wf.duties.add')}
        </Button>
      )}
      {adding && data && <DutyForm staff={data.staff} onDone={() => setAdding(false)} />}
      {(list.error ?? toggle.error) && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error ?? toggle.error)}
        </Alert>
      )}
      {data && data.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('wf.duties.none')}</p>
      )}
      <ul aria-label={t('wf.duties.list')} className="mt-3 flex flex-col gap-2">
        {data?.data.map((d) => (
          <li
            key={d.id}
            className={cn(
              'flex flex-wrap items-start justify-between gap-2 rounded-md border border-border bg-surface p-3 text-sm',
              !d.active && 'opacity-70',
            )}
          >
            <div>
              <p className="font-medium">
                {d.title}
                {!d.active && (
                  <span className="ml-2 rounded bg-surface-muted px-2 py-0.5 text-xs">
                    {t('wf.duties.stopped')}
                  </span>
                )}
              </p>
              <p className="text-text-muted">
                {[
                  `ST-${d.staff.number} ${d.staff.name}`,
                  days(d.weekdays),
                  d.startTime ? `${d.startTime}${d.endTime ? `–${d.endTime}` : ''}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {d.notes && <p className="mt-1">{d.notes}</p>}
            </div>
            <Button
              variant="secondary"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(d)}
            >
              {d.active ? t('wf.duties.stop') : t('wf.duties.restart')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DutyForm(props: { staff: StaffRef[]; onDone: () => void }) {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const [staffId, setStaffId] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.call('createDuty', {
        body: {
          staffId,
          title,
          notes,
          weekdays,
          startTime: startTime || null,
          endTime: endTime || null,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: root });
      props.onDone();
    },
  });
  return (
    <form
      aria-label={t('wf.duties.form')}
      className="mt-3 grid gap-3 rounded-md border border-border bg-surface p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="duty-staff">{t('wf.staff')}</Label>
        <select
          id="duty-staff"
          className={selectClass}
          required
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
        >
          <option value="">{t('wf.choose')}</option>
          {props.staff.map((s) => (
            <option key={s.id} value={s.id}>
              ST-{s.number} {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="duty-title">{t('wf.duties.name')}</Label>
        <Input id="duty-title" required value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <fieldset className="sm:col-span-2">
        <legend className="text-sm font-medium">{t('wf.duties.weekdays')}</legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {WEEKDAYS.map((d) => (
            <label key={d} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={weekdays.includes(d)}
                onChange={(e) =>
                  setWeekdays(e.target.checked ? [...weekdays, d] : weekdays.filter((x) => x !== d))
                }
              />
              {t(`wf.days.${d}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1">
        <Label htmlFor="duty-start">{t('wf.duties.from')}</Label>
        <Input
          id="duty-start"
          type="time"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="duty-end">{t('wf.duties.to')}</Label>
        <Input
          id="duty-end"
          type="time"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label htmlFor="duty-notes">{t('wf.duties.notes')}</Label>
        <Input id="duty-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {save.error && (
        <Alert tone="critical" className="sm:col-span-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={save.isPending}>
          {t('wf.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={props.onDone}>
          {t('wf.cancel')}
        </Button>
      </div>
    </form>
  );
}

// ── Rota (M7-03) ───────────────────────────────────────────────────────────────────────

export function RotaPage() {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const f = useFormats();
  const today = usePropertyToday();
  const [from, setFrom] = useState(() => addDays(today, 1 - isoWeekday(today)));
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const to = addDays(from, 6);
  const rota = useQuery({
    queryKey: [...root, 'rota', departmentId ?? '', from],
    queryFn: () =>
      api.call('getRota', { query: { ...(departmentId ? { departmentId } : {}), from, to } }),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [...root, 'rota'] });
  const assign = useMutation({
    mutationFn: (body: { shiftId: string; staffId: string; date: string }) =>
      api.call('assignShift', { body }),
    onSuccess: refresh,
  });
  const unassign = useMutation({
    mutationFn: (assignmentId: string) => api.call('unassignShift', { params: { assignmentId } }),
    onSuccess: refresh,
  });
  const publish = useMutation({
    mutationFn: (body: { from: string; period: 'WEEKLY' | 'MONTHLY' }) =>
      api.call('publishRota', { params: { departmentId: rota.data?.department?.id ?? '' }, body }),
    onSuccess: refresh,
  });
  const data = rota.data;
  const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const monthStart = `${from.slice(0, 8)}01`;
  const error = rota.error ?? assign.error ?? unassign.error ?? publish.error;
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('wf.rota.title')}</h1>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {data && data.departments.length > 0 && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="rota-dept">{t('wf.rota.department')}</Label>
            <select
              id="rota-dept"
              className={selectClass}
              value={data.department?.id ?? ''}
              onChange={(e) => setDepartmentId(e.target.value)}
            >
              {data.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <Button variant="secondary" className="h-11" onClick={() => setFrom(addDays(from, -7))}>
          {t('wf.rota.prev')}
        </Button>
        <p className="self-center text-sm font-medium">
          {t('wf.rota.week', { date: f.date(from) })}
        </p>
        <Button variant="secondary" className="h-11" onClick={() => setFrom(addDays(from, 7))}>
          {t('wf.rota.next')}
        </Button>
      </div>
      {error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(error)}
        </Alert>
      )}
      {data && !data.department && (
        <p className="mt-3 text-sm text-text-muted">{t('wf.rota.noDepartments')}</p>
      )}
      {data?.department && (
        <>
          {data.shifts.every((s) => !s.active) && (
            <Alert tone="info" className="mt-3">
              {t('wf.rota.off')}
            </Alert>
          )}
          {data.shifts.some((s) => s.active) && (
            <RotaGrid
              data={data}
              dates={dates}
              busy={assign.isPending || unassign.isPending}
              onAssign={(body) => assign.mutate(body)}
              onRemove={(id) => unassign.mutate(id)}
            />
          )}
          {data.shifts.some((s) => s.active) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                disabled={publish.isPending}
                onClick={() => publish.mutate({ from, period: 'WEEKLY' })}
              >
                {t('wf.rota.publishWeek')}
              </Button>
              <Button
                variant="secondary"
                disabled={publish.isPending}
                onClick={() => publish.mutate({ from: monthStart, period: 'MONTHLY' })}
              >
                {t('wf.rota.publishMonth', { date: f.date(monthStart) })}
              </Button>
              <p className="text-sm text-text-muted">{t('wf.rota.drafts')}</p>
            </div>
          )}
          {publish.data && (
            <Alert tone="success" className="mt-3">
              {t('wf.rota.published', {
                count: publish.data.published,
                from: f.date(publish.data.from),
                to: f.date(publish.data.to),
              })}
            </Alert>
          )}
          <Shifts data={data} />
        </>
      )}
    </section>
  );
}

function RotaGrid(props: {
  data: RotaData;
  dates: string[];
  busy: boolean;
  onAssign: (body: { shiftId: string; staffId: string; date: string }) => void;
  onRemove: (assignmentId: string) => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  const { data, dates } = props;
  const onLeave = (staffId: string, date: string) =>
    data.leave.some((l) => l.staffId === staffId && l.startDate <= date && l.endDate >= date);
  return (
    <div className="mt-3 overflow-x-auto">
      <table aria-label={t('wf.rota.grid')} className="w-full min-w-[48rem] text-sm">
        <thead>
          <tr>
            <th className="p-2 text-left">{t('wf.rota.shift')}</th>
            {dates.map((d) => (
              <th key={d} className="p-2 text-left font-medium">
                {t(`wf.days.${isoWeekday(d)}`)} {d.slice(8)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.shifts
            .filter((s) => s.active)
            .map((shift) => (
              <tr key={shift.id} className="border-t border-border align-top">
                <th scope="row" className="p-2 text-left font-medium">
                  {shift.name}
                  <span className="block text-xs font-normal text-text-muted">
                    {shift.startTime}–{shift.endTime}
                  </span>
                </th>
                {dates.map((date) => {
                  const slots = data.assignments.filter(
                    (a) => a.shiftId === shift.id && a.date === date,
                  );
                  const live = new Set(
                    slots.filter((a) => a.status !== 'REMOVED').map((a) => a.staff.id),
                  );
                  const free = data.staff.filter((s) => !live.has(s.id) && !onLeave(s.id, date));
                  return (
                    <td key={date} className="p-2">
                      <ul className="flex flex-col gap-1">
                        {slots.map((a) => (
                          <li
                            key={a.id}
                            className={cn(
                              'flex items-center justify-between gap-1 rounded px-1',
                              a.status === 'DRAFT' && 'border border-dashed border-border',
                              a.status === 'PUBLISHED' && 'bg-surface-muted',
                              a.status === 'REMOVED' && 'text-text-muted line-through',
                            )}
                          >
                            <span>
                              {a.staff.name}
                              {a.status === 'DRAFT' && ` (${t('wf.rota.draft')})`}
                              {a.status === 'REMOVED' && ` (${t('wf.rota.onLeave')})`}
                            </span>
                            {a.status !== 'REMOVED' && (
                              <button
                                type="button"
                                className="px-1 text-critical"
                                disabled={props.busy}
                                aria-label={t('wf.rota.removeSlot', {
                                  name: a.staff.name,
                                  shift: shift.name,
                                  date: f.date(date),
                                })}
                                onClick={() => props.onRemove(a.id)}
                              >
                                ×
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                      {free.length > 0 && (
                        <select
                          className="mt-1 h-9 w-full rounded border border-border bg-surface px-1 text-xs"
                          aria-label={t('wf.rota.addTo', {
                            shift: shift.name,
                            date: f.date(date),
                          })}
                          value=""
                          disabled={props.busy}
                          onChange={(e) =>
                            e.target.value &&
                            props.onAssign({ shiftId: shift.id, staffId: e.target.value, date })
                          }
                        >
                          <option value="">+</option>
                          {free.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function Shifts(props: { data: RotaData }) {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const departmentId = props.data.department?.id ?? '';
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [...root, 'rota'] });
  const add = useMutation({
    mutationFn: () =>
      api.call('addRotaShift', { params: { departmentId }, body: { name, startTime, endTime } }),
    onSuccess: () => {
      setName('');
      setStartTime('');
      setEndTime('');
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (s: { id: string; active: boolean }) =>
      api.call('updateRotaShift', { params: { shiftId: s.id }, body: { active: !s.active } }),
    onSuccess: refresh,
  });
  return (
    <section aria-labelledby="rota-shifts" className="mt-6">
      <h2 id="rota-shifts" className="font-semibold">
        {t('wf.rota.shifts')}
      </h2>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {props.data.shifts.map((s) => (
          <li key={s.id} className="flex items-center gap-3">
            <span className={cn(!s.active && 'text-text-muted')}>
              {s.name} · {s.startTime}–{s.endTime}
              {!s.active && ` (${t('wf.rota.stoppedShift')})`}
            </span>
            <Button variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(s)}>
              {s.active ? t('wf.rota.stopShift') : t('wf.rota.startShift')}
            </Button>
          </li>
        ))}
      </ul>
      <form
        aria-label={t('wf.rota.shiftForm')}
        className="mt-2 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="shift-name">{t('wf.rota.shiftName')}</Label>
          <Input id="shift-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="shift-start">{t('wf.rota.start')}</Label>
          <Input
            id="shift-start"
            type="time"
            required
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="shift-end">{t('wf.rota.end')}</Label>
          <Input
            id="shift-end"
            type="time"
            required
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
          />
        </div>
        <Button type="submit" className="h-11" disabled={add.isPending}>
          {t('wf.rota.addShift')}
        </Button>
      </form>
      {(add.error ?? toggle.error) && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(add.error ?? toggle.error)}
        </Alert>
      )}
    </section>
  );
}

// ── Leave (M7-05) ──────────────────────────────────────────────────────────────────────

export function LeavePage() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  return (
    <section className="max-w-4xl">
      <h1 className="text-xl font-semibold">{t('wf.leave.title')}</h1>
      {permissions.includes('leave.request') && <MyWork />}
      {permissions.includes('leave.approve') && <Decide />}
    </section>
  );
}

function LeaveLine(props: { leave: Leave; who: boolean; children?: ReactNode }) {
  const { t } = useTranslation();
  const f = useFormats();
  const l = props.leave;
  return (
    <li className="rounded-md border border-border bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium">
          {props.who && `ST-${l.staff.number} ${l.staff.name} · `}
          {t(`wf.leave.types.${l.type}`)} · {f.date(l.startDate)}
          {l.endDate !== l.startDate && ` – ${f.date(l.endDate)}`} ·{' '}
          {t('wf.leave.days', { count: l.days })}
        </p>
        <span className={cn('rounded px-2 py-0.5 text-xs font-medium', LEAVE_TONE[l.status])}>
          {t(`wf.leave.statuses.${l.status}`)}
        </span>
      </div>
      {l.reason && <p className="mt-1">{l.reason}</p>}
      {l.decidedBy && (
        <p className="mt-1 text-text-muted">
          {t('wf.leave.decidedBy', {
            status: t(`wf.leave.statuses.${l.status}`),
            name: l.decidedBy.name,
          })}
          {l.decisionNote && `: ${l.decisionNote}`}
        </p>
      )}
      {l.shiftsRemoved > 0 && (
        <p className="mt-1 text-text-muted">
          {t('wf.leave.shiftsRemoved', { count: l.shiftsRemoved })}
        </p>
      )}
      {props.children}
    </li>
  );
}

function MyWork() {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const f = useFormats();
  const days = useDays();
  const [requesting, setRequesting] = useState(false);
  const mine = useQuery({
    queryKey: [...root, 'mine'],
    queryFn: () => api.call('getMyWork', {}),
  });
  const withdraw = useMutation({
    mutationFn: (leaveId: string) => api.call('cancelLeave', { params: { leaveId } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: root }),
  });
  const data = mine.data;
  return (
    <section aria-labelledby="wf-mine" className="mt-4">
      <h2 id="wf-mine" className="font-semibold">
        {t('wf.leave.mine')}
      </h2>
      {(mine.error ?? withdraw.error) && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(mine.error ?? withdraw.error)}
        </Alert>
      )}
      {data && !data.staff && (
        <p className="mt-2 text-sm text-text-muted">{t('wf.leave.noProfile')}</p>
      )}
      {data?.staff && (
        <div className="mt-2 grid gap-4">
          {data.duties.length > 0 && (
            <div>
              <h3 className="text-sm font-medium">{t('wf.leave.myDuties')}</h3>
              <ul className="mt-1 text-sm">
                {data.duties.map((d) => (
                  <li key={d.id}>
                    {d.title} · {days(d.weekdays)}
                    {d.startTime && ` · ${d.startTime}${d.endTime ? `–${d.endTime}` : ''}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h3 className="text-sm font-medium">{t('wf.leave.myShifts')}</h3>
            {data.shifts.length === 0 ? (
              <p className="text-sm text-text-muted">{t('wf.leave.noShifts')}</p>
            ) : (
              <ul aria-label={t('wf.leave.myShifts')} className="mt-1 text-sm">
                {data.shifts.map((s) => (
                  <li key={s.id}>
                    {f.date(s.date)} · {s.shift} {s.startTime}–{s.endTime} · {s.department}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{t('wf.leave.myLeave')}</h3>
              {!requesting && (
                <Button onClick={() => setRequesting(true)}>{t('wf.leave.request')}</Button>
              )}
            </div>
            {requesting && <LeaveForm today={data.today} onDone={() => setRequesting(false)} />}
            {data.leave.length === 0 && (
              <p className="text-sm text-text-muted">{t('wf.leave.noLeave')}</p>
            )}
            <ul aria-label={t('wf.leave.myLeave')} className="mt-2 flex flex-col gap-2">
              {data.leave.map((l) => (
                <LeaveLine key={l.id} leave={l} who={false}>
                  {l.status === 'PENDING' && (
                    <Button
                      variant="secondary"
                      className="mt-2"
                      disabled={withdraw.isPending}
                      onClick={() => withdraw.mutate(l.id)}
                    >
                      {t('wf.leave.withdraw')}
                    </Button>
                  )}
                </LeaveLine>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function LeaveForm(props: { today: string; onDone: () => void }) {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const [type, setType] = useState<LeaveType>('ANNUAL');
  const [startDate, setStartDate] = useState(props.today);
  const [endDate, setEndDate] = useState(props.today);
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api.call('requestLeave', { body: { type, startDate, endDate, reason } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: root });
      props.onDone();
    },
  });
  return (
    <form
      aria-label={t('wf.leave.form')}
      className="mt-2 grid gap-3 rounded-md border border-border bg-surface p-3 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="leave-type">{t('wf.leave.type')}</Label>
        <select
          id="leave-type"
          className={selectClass}
          value={type}
          onChange={(e) => setType(e.target.value as LeaveType)}
        >
          {LEAVE_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`wf.leave.types.${x}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="leave-start">{t('wf.leave.start')}</Label>
        <Input
          id="leave-start"
          type="date"
          required
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="leave-end">{t('wf.leave.end')}</Label>
        <Input
          id="leave-end"
          type="date"
          required
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1 sm:col-span-3">
        <Label htmlFor="leave-reason">{t('wf.leave.reason')}</Label>
        <Input id="leave-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {save.error && (
        <Alert tone="critical" className="sm:col-span-3">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" disabled={save.isPending}>
          {t('wf.leave.send')}
        </Button>
        <Button type="button" variant="ghost" onClick={props.onDone}>
          {t('wf.cancel')}
        </Button>
      </div>
    </form>
  );
}

function Decide() {
  const { t } = useTranslation();
  const root = useRoot();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LeaveStatus>('PENDING');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const list = useQuery({
    queryKey: [...root, 'leave', status],
    queryFn: () => api.call('listLeave', { query: { status } }),
  });
  const decide = useMutation({
    mutationFn: (v: { leaveId: string; decision: 'APPROVE' | 'REJECT' }) =>
      api.call('decideLeave', {
        params: { leaveId: v.leaveId },
        body: { decision: v.decision, note: notes[v.leaveId] ?? '' },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: root }),
  });
  return (
    <section aria-labelledby="wf-decide" className="mt-6">
      <h2 id="wf-decide" className="font-semibold">
        {t('wf.leave.decide')}
      </h2>
      <div role="tablist" aria-label={t('wf.leave.decideTabs')} className="mt-2 flex gap-2">
        {LEAVE_STATUSES.map((s) => (
          <Button
            key={s}
            role="tab"
            aria-selected={status === s}
            variant={status === s ? 'primary' : 'secondary'}
            onClick={() => setStatus(s)}
          >
            {t(`wf.leave.statuses.${s}`)}
          </Button>
        ))}
      </div>
      {(list.error ?? decide.error) && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(list.error ?? decide.error)}
        </Alert>
      )}
      {list.data && list.data.data.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">{t('wf.leave.none')}</p>
      )}
      <ul aria-label={t('wf.leave.requests')} className="mt-2 flex flex-col gap-2">
        {list.data?.data.map((l) => (
          <LeaveLine key={l.id} leave={l} who>
            {l.status === 'PENDING' && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`note-${l.id}`}>{t('wf.leave.note')}</Label>
                  <Input
                    id={`note-${l.id}`}
                    value={notes[l.id] ?? ''}
                    onChange={(e) => setNotes({ ...notes, [l.id]: e.target.value })}
                  />
                </div>
                <Button
                  className="h-11"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ leaveId: l.id, decision: 'APPROVE' })}
                >
                  {t('wf.leave.approve')}
                </Button>
                <Button
                  variant="secondary"
                  className="h-11"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ leaveId: l.id, decision: 'REJECT' })}
                >
                  {t('wf.leave.reject')}
                </Button>
              </div>
            )}
          </LeaveLine>
        ))}
      </ul>
    </section>
  );
}
