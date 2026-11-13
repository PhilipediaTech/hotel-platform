import {
  OBSERVED_STATUSES,
  type BoardRoom,
  type HkAssignmentItem,
  type ObservedStatus,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useState } from 'react';
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
import housekeepingStrings from '../i18n/en/housekeeping.json';
import { registerStrings } from '../i18n/index.ts';
import { SNAPSHOT_REFRESH_MS, withSnapshot } from '../offline/snapshots.ts';
import { SavedCopyNote } from '../offline/saved-copy-note.tsx';
import { useOfflineKey, useOfflineWho } from '../offline/use-offline-key.ts';
import { sendOrQueue } from '../offline/queue.ts';

registerStrings(housekeepingStrings);

// S16 Room board and S17 My rooms (PRD M5-01–M5-05; T-080, T-081). The board shows every room
// with its housekeeping and front-office status, today's clean, attendant and priority, by
// floor, plus its morning report and any discrepancy; the supervisor selects rooms and gives
// them to an attendant. My rooms is the attendant's phone screen: start, pause and complete
// each room, tick its checklist, note minibar use, and send the morning room-status report.
// A supervisor inspects cleaned rooms from the board (M5-06; T-129): pass, or fail with
// reasons, which puts the room back on its attendant's list.

type Room = z.output<typeof BoardRoom>;
type Assignment = z.output<typeof HkAssignmentItem>;
type Inspection = NonNullable<Room['inspection']>;

/** Common reasons a room fails, offered as ticks; the inspector can add their own. */
const FAIL_REASONS = [
  'bathroom',
  'bed',
  'dust',
  'towels',
  'amenities',
  'minibar',
  'odour',
  'damage',
] as const;

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';
const HK_TONE: Record<string, string> = {
  DIRTY: 'bg-critical-subtle text-critical',
  CLEANING: 'bg-brand-subtle text-brand-strong',
  CLEAN: 'bg-success-subtle text-success',
  INSPECTED: 'bg-success-subtle text-success',
  OUT_OF_ORDER: 'bg-surface-muted text-text-muted',
  OUT_OF_SERVICE: 'bg-surface-muted text-text-muted',
};

function useHkKey(name: string) {
  const { currentPropertyId } = useSession();
  return ['housekeeping', currentPropertyId ?? '', name];
}

// ── S16 Room board ─────────────────────────────────────────────────────────────────────

export function HousekeepingPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { permissions } = useSession();
  const [floor, setFloor] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attendantId, setAttendantId] = useState('');
  const [toInspect, setToInspect] = useState(false);
  const key = useHkKey('board');
  const savedAs = useOfflineKey(`hk-board:${floor}`);
  const board = useQuery({
    queryKey: [...key, floor],
    queryFn: withSnapshot(savedAs, () =>
      api.call('getHousekeepingBoard', { query: floor ? { floor } : {} }),
    ),
    refetchInterval: SNAPSHOT_REFRESH_MS,
  });
  const assign = useMutation({
    mutationFn: (to: string | null) =>
      api.call('assignRooms', { body: { roomIds: [...selected], attendantId: to } }),
    onSuccess: () => {
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const canAssign = permissions.includes('hk.assign');
  const canInspect = permissions.includes('hk.inspect');
  const canSetUp = permissions.includes('property.setup');
  const data = board.data;
  const waiting = data?.rooms.filter((r) => r.awaitingInspection).length ?? 0;
  const shown = data ? data.rooms.filter((r) => !toInspect || r.awaitingInspection) : [];
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">{t('hk.title')}</h1>
      <SavedCopyNote savedAs={savedAs} />
      {board.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(board.error)}
        </Alert>
      )}
      {data && (
        <>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            {data.floors.length > 0 && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="hk-floor">{t('hk.floor')}</Label>
                <select
                  id="hk-floor"
                  className={selectClass}
                  value={floor}
                  onChange={(e) => setFloor(e.target.value)}
                >
                  <option value="">{t('hk.allFloors')}</option>
                  {data.floors.map((f) => (
                    <option key={f} value={f}>
                      {t('hk.floorN', { floor: f })}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {canInspect && (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={toInspect}
                  onChange={(e) => setToInspect(e.target.checked)}
                />
                {t('hk.inspect.onlyWaiting', { count: waiting })}
              </label>
            )}
            {canAssign && (
              <form
                aria-label={t('hk.assign')}
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (selected.size > 0) assign.mutate(attendantId || null);
                }}
              >
                <div className="flex flex-col gap-1">
                  <Label htmlFor="hk-attendant">{t('hk.attendant')}</Label>
                  <select
                    id="hk-attendant"
                    className={selectClass}
                    value={attendantId}
                    onChange={(e) => setAttendantId(e.target.value)}
                  >
                    <option value="">{t('hk.nobody')}</option>
                    {data.attendants.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="submit" disabled={selected.size === 0 || assign.isPending}>
                  {t('hk.assignSelected', { count: selected.size })}
                </Button>
              </form>
            )}
          </div>
          {canSetUp ? (
            <InspectionSetting required={data.settings.inspectionRequired} onSaved={refresh} />
          ) : (
            data.settings.inspectionRequired && (
              <p className="mt-3 text-sm text-text-muted">{t('hk.inspect.requiredNote')}</p>
            )
          )}
          {assign.error && (
            <Alert tone="critical" className="mt-3">
              {errorMessage(assign.error)}
            </Alert>
          )}
          <ul aria-label={t('hk.rooms')} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {shown.map((r) => (
              <RoomTile
                key={r.roomId}
                room={r}
                required={data.settings.inspectionRequired}
                canInspect={canInspect}
                onInspected={refresh}
                selectable={canAssign && r.assignment?.status !== 'DONE'}
                selected={selected.has(r.roomId)}
                onToggle={() => toggle(r.roomId)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RoomTile(props: {
  room: Room;
  required: boolean;
  canInspect: boolean;
  onInspected: () => void;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const r = props.room;
  const a = r.assignment;
  const [inspecting, setInspecting] = useState(false);
  const inspectable = r.hkStatus === 'CLEAN' || r.hkStatus === 'INSPECTED';
  return (
    <li
      className={cn(
        'rounded-md border bg-surface p-3 text-sm',
        props.selected ? 'border-brand' : 'border-border',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-base font-semibold">
          {props.selectable && (
            <input
              type="checkbox"
              className="size-5"
              checked={props.selected}
              onChange={props.onToggle}
              aria-label={t('hk.select', { room: r.number })}
            />
          )}
          {r.number}
        </label>
        <span className={cn('rounded px-2 py-0.5 text-xs font-medium', HK_TONE[r.hkStatus])}>
          {t(`rooms.hk.${r.hkStatus}`)}
        </span>
      </div>
      <p className="mt-1 text-text-muted">
        {r.roomType} · {t(`hk.fo.${r.foStatus}`)}
        {r.dueOut ? ` · ${t('hk.dueOut')}` : ''}
        {r.arrival ? ` · ${t('hk.arrival')}` : ''}
      </p>
      {r.priority === 'HIGH' && (
        <p className="mt-1 text-xs font-medium text-critical">{t('hk.priorityHigh')}</p>
      )}
      {a ? (
        <p className="mt-1">
          {t(`hk.kind.${a.kind}`)} · {t(`hk.status.${a.status}`)} ·{' '}
          {a.attendant?.name ?? t('hk.unassigned')}
        </p>
      ) : (
        <p className="mt-1 text-text-muted">{t('hk.notListed')}</p>
      )}
      {r.observed && (
        <p className="mt-1 text-text-muted">
          {t('hk.reported', { status: t(`hk.observed.${r.observed}`) })}
        </p>
      )}
      {r.discrepancy && <Discrepancy rule={r.discrepancy} />}
      {r.awaitingInspection && (
        <p className="mt-1 text-xs font-medium text-warning">
          {props.required ? t('hk.inspect.waitingRequired') : t('hk.inspect.waiting')}
        </p>
      )}
      {r.inspection && <InspectionNote inspection={r.inspection} />}
      {props.canInspect && inspectable && !inspecting && (
        <Button
          variant="secondary"
          className="mt-2 h-11"
          aria-label={t('hk.inspect.openNamed', { room: r.number })}
          onClick={() => setInspecting(true)}
        >
          {t('hk.inspect.open')}
        </Button>
      )}
      {inspecting && (
        <InspectForm
          room={r}
          onClose={() => setInspecting(false)}
          onDone={() => {
            setInspecting(false);
            props.onInspected();
          }}
        />
      )}
    </li>
  );
}

/** The room's latest inspection today: passed, or failed with its reasons (T-129). */
function InspectionNote({ inspection: i }: { inspection: Inspection }) {
  const { t } = useTranslation();
  return i.passed ? (
    <p className="mt-1 flex items-start gap-1 text-xs text-success">
      <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      {t('hk.inspect.passedBy', { name: i.inspector.name })}
    </p>
  ) : (
    <p className="mt-1 flex items-start gap-1 text-xs font-medium text-critical">
      <XCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      {t('hk.inspect.failedBy', { name: i.inspector.name, reasons: i.failReasons.join('; ') })}
    </p>
  );
}

/** S16 inspection (M5-06; T-129): pass, or fail with ticked and written reasons. */
function InspectForm(props: { room: Room; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [other, setOther] = useState('');
  const reasons = [
    ...FAIL_REASONS.filter((r) => ticked.has(r)).map((r) => t(`hk.inspect.reasons.${r}`)),
    ...(other.trim().length >= 2 ? [other.trim()] : []),
  ];
  const send = useMutation({
    mutationFn: (passed: boolean) =>
      api.call('recordInspection', {
        body: { roomId: props.room.roomId, passed, failReasons: passed ? [] : reasons },
      }),
    onSuccess: props.onDone,
  });
  const otherId = `fail-other-${props.room.roomId}`;
  return (
    <form
      aria-label={t('hk.inspect.formNamed', { room: props.room.number })}
      className="mt-2 flex flex-col gap-2 border-t border-border pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (reasons.length > 0) send.mutate(false);
      }}
    >
      <Button
        type="button"
        className="h-11"
        disabled={send.isPending}
        onClick={() => send.mutate(true)}
      >
        {t('hk.inspect.pass')}
      </Button>
      <fieldset>
        <legend className="text-xs font-medium">{t('hk.inspect.whatFailed')}</legend>
        {FAIL_REASONS.map((r) => (
          <label key={r} className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              className="size-5"
              checked={ticked.has(r)}
              onChange={(e) =>
                setTicked((s) => {
                  const next = new Set(s);
                  if (e.target.checked) next.add(r);
                  else next.delete(r);
                  return next;
                })
              }
            />
            {t(`hk.inspect.reasons.${r}`)}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1">
        <Label htmlFor={otherId}>{t('hk.inspect.other')}</Label>
        <Input
          id={otherId}
          maxLength={120}
          value={other}
          onChange={(e) => setOther(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="secondary"
          className="h-11"
          disabled={reasons.length === 0 || send.isPending}
        >
          {t('hk.inspect.fail')}
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={props.onClose}>
          {t('hk.inspect.cancel')}
        </Button>
      </div>
      {send.error && <Alert tone="critical">{errorMessage(send.error)}</Alert>}
    </form>
  );
}

/** Whether rooms must pass inspection before a guest gets them (T-129; property.setup). */
function InspectionSetting(props: { required: boolean; onSaved: () => void }) {
  const { t } = useTranslation();
  const save = useMutation({
    mutationFn: (inspectionRequired: boolean) =>
      api.call('updateHousekeepingSettings', { body: { inspectionRequired } }),
    onSuccess: props.onSaved,
  });
  return (
    <div className="mt-3">
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={save.isPending ? save.variables : props.required}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.checked)}
        />
        {t('hk.inspect.required')}
      </label>
      <p className="text-xs text-text-muted">{t('hk.inspect.requiredHint')}</p>
      {save.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(save.error)}
        </Alert>
      )}
    </div>
  );
}

/** A morning-report discrepancy (T-081): text and icon, never colour alone. */
function Discrepancy({ rule }: { rule: string }) {
  const { t } = useTranslation();
  return (
    <p className="mt-1 flex items-start gap-1 text-xs font-medium text-critical">
      <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      {t(`hk.discrepancy.${rule}`)}
    </p>
  );
}

// ── S17 My rooms ───────────────────────────────────────────────────────────────────────

export function MyRoomsPage() {
  const { t } = useTranslation();
  const key = useHkKey('mine');
  const savedAs = useOfflineKey('hk-mine');
  const mine = useQuery({
    queryKey: key,
    queryFn: withSnapshot(savedAs, () => api.call('listMyAssignments', {})),
    refetchInterval: SNAPSHOT_REFRESH_MS,
  });
  const data = mine.data?.data ?? [];
  return (
    <section className="max-w-xl">
      <h1 className="text-xl font-semibold">{t('hk.myRooms')}</h1>
      <SavedCopyNote savedAs={savedAs} />
      {mine.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(mine.error)}
        </Alert>
      )}
      {mine.data && data.length === 0 && <p className="mt-4 text-sm">{t('hk.noRooms')}</p>}
      <ul className="mt-4 flex flex-col gap-4" aria-label={t('hk.myRooms')}>
        {data.map((a) => (
          <MyRoom key={a.id} assignment={a} queryKey={key} />
        ))}
      </ul>
      <MorningReport />
    </section>
  );
}

/** S17 morning room-status report (PRD M5-05; T-081): what the attendant sees in each room. */
function MorningReport() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = useHkKey('status-reports');
  const [floor, setFloor] = useState('');
  const [chosen, setChosen] = useState<Record<string, ObservedStatus>>({});
  const list = useQuery({
    queryKey: [...key, floor],
    queryFn: () => api.call('listStatusReports', { query: floor ? { floor } : {} }),
  });
  const who = useOfflineWho();
  const [queued, setQueued] = useState(false);
  const send = useMutation({
    mutationFn: () =>
      sendOrQueue<{ alertsRaised: number }>(
        who,
        'submitStatusReport',
        {
          body: {
            entries: Object.entries(chosen).map(([roomId, observed]) => ({ roomId, observed })),
          },
        },
        { label: t('offline.labels.report', { count: Object.keys(chosen).length }) },
      ),
    onSuccess: (sent) => {
      setChosen({});
      setQueued(sent.queued);
      if (!sent.queued) void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const count = Object.keys(chosen).length;
  const data = list.data;
  return (
    <section aria-labelledby="hk-morning" className="mt-8">
      <h2 id="hk-morning" className="text-lg font-semibold">
        {t('hk.morningReport')}
      </h2>
      <p className="mt-1 text-sm text-text-muted">{t('hk.morningReportHint')}</p>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {data && (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (count > 0) send.mutate();
          }}
        >
          {data.floors.length > 0 && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="hk-report-floor">{t('hk.floor')}</Label>
              <select
                id="hk-report-floor"
                className={selectClass}
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
              >
                <option value="">{t('hk.allFloors')}</option>
                {data.floors.map((f) => (
                  <option key={f} value={f}>
                    {t('hk.floorN', { floor: f })}
                  </option>
                ))}
              </select>
            </div>
          )}
          <ul className="mt-3 flex flex-col gap-3">
            {data.data.map((r) => (
              <li key={r.roomId} className="rounded-md border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-base font-semibold">
                    {t('hk.roomN', { room: r.number })}
                  </span>
                  <span className="text-xs text-text-muted">
                    {t('hk.frontOffice', { status: t(`hk.fo.${r.foStatus}`) })}
                  </span>
                </div>
                <select
                  aria-label={t('hk.statusFor', { room: r.number })}
                  className={cn(selectClass, 'mt-2 w-full')}
                  value={chosen[r.roomId] ?? ''}
                  onChange={(e) => {
                    const value = e.target.value as ObservedStatus | '';
                    setChosen((c) => {
                      const next = { ...c };
                      if (value) next[r.roomId] = value;
                      else delete next[r.roomId];
                      return next;
                    });
                  }}
                >
                  <option value="">
                    {r.observed
                      ? t('hk.reported', { status: t(`hk.observed.${r.observed}`) })
                      : t('hk.notReported')}
                  </option>
                  {OBSERVED_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`hk.observed.${s}`)}
                    </option>
                  ))}
                </select>
                {r.discrepancy && <Discrepancy rule={r.discrepancy} />}
              </li>
            ))}
          </ul>
          <Button type="submit" className="mt-3 h-11 px-5" disabled={count === 0 || send.isPending}>
            {t('hk.sendReport', { count })}
          </Button>
        </form>
      )}
      {send.data && !send.data.queued && (
        <Alert tone={send.data.result.alertsRaised > 0 ? 'critical' : 'success'} className="mt-3">
          {send.data.result.alertsRaised > 0
            ? t('hk.reportSent', { count: send.data.result.alertsRaised })
            : t('hk.reportSentNone')}
        </Alert>
      )}
      {queued && (
        <Alert tone="info" className="mt-3">
          {t('offline.queuedNow')}
        </Alert>
      )}
      {send.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(send.error)}
        </Alert>
      )}
    </section>
  );
}

function MyRoom({ assignment: a, queryKey }: { assignment: Assignment; queryKey: string[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [item, setItem] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState(a.notes ?? '');
  const who = useOfflineWho();
  const [queued, setQueued] = useState(false);
  const update = useMutation({
    mutationFn: (body: object) =>
      sendOrQueue(
        who,
        'updateAssignment',
        { params: { assignmentId: a.id }, body },
        { label: t('offline.labels.room', { room: a.roomNumber }) },
      ),
    onSuccess: (sent) => {
      setQueued(sent.queued);
      if (!sent.queued) void queryClient.invalidateQueries({ queryKey });
    },
  });
  const done = a.status === 'DONE';
  const working = a.status === 'IN_PROGRESS';
  const all = a.checklist.every((c) => c.done);
  return (
    <li
      aria-label={t('hk.roomN', { room: a.roomNumber })}
      className="rounded-md border border-border bg-surface p-4"
    >
      <div className="flex items-center justify-between">
        <span className="text-lg font-semibold">
          {t('hk.roomN', { room: a.roomNumber })} · {t(`hk.kind.${a.kind}`)}
        </span>
        <span className="text-sm text-text-muted">{t(`hk.status.${a.status}`)}</span>
      </div>
      {a.inspection && !a.inspection.passed && !done && (
        <Alert tone="critical" className="mt-2">
          {t('hk.inspect.sentBack', { reasons: a.inspection.failReasons.join('; ') })}
        </Alert>
      )}
      {!done && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!working && (
            <Button className="h-11 px-5" onClick={() => update.mutate({ action: 'START' })}>
              {a.status === 'PAUSED' ? t('hk.resume') : t('hk.start')}
            </Button>
          )}
          {working && (
            <Button
              className="h-11 px-5"
              variant="secondary"
              onClick={() => update.mutate({ action: 'PAUSE' })}
            >
              {t('hk.pause')}
            </Button>
          )}
          {a.status !== 'PENDING' && (
            <Button
              className="h-11 px-5"
              disabled={!all || update.isPending}
              onClick={() => update.mutate({ action: 'COMPLETE' })}
            >
              {t('hk.complete')}
            </Button>
          )}
        </div>
      )}
      <fieldset className="mt-3" disabled={done}>
        <legend className="text-sm font-medium">{t('hk.checklist')}</legend>
        <ul className="mt-1 flex flex-col gap-1">
          {a.checklist.map((c, i) => (
            <li key={c.item}>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={c.done}
                  onChange={(e) =>
                    update.mutate({
                      checklist: a.checklist.map((x, j) =>
                        j === i ? { ...x, done: e.target.checked } : x,
                      ),
                    })
                  }
                />
                {c.item}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {!done && (
        <>
          <form
            aria-label={t('hk.minibar')}
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const q = Number(quantity);
              if (item.trim() && Number.isInteger(q) && q > 0) {
                update.mutate({ minibar: [...a.minibar, { item: item.trim(), quantity: q }] });
                setItem('');
                setQuantity('1');
              }
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor={`mb-${a.id}`}>{t('hk.minibarItem')}</Label>
              <Input id={`mb-${a.id}`} value={item} onChange={(e) => setItem(e.target.value)} />
            </div>
            <div className="flex w-20 flex-col gap-1">
              <Label htmlFor={`mbq-${a.id}`}>{t('hk.quantity')}</Label>
              <Input
                id={`mbq-${a.id}`}
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <Button type="submit" variant="secondary" className="h-11">
              {t('hk.addMinibar')}
            </Button>
          </form>
          {a.minibar.length > 0 && (
            <p className="mt-1 text-sm text-text-muted">
              {a.minibar.map((m) => `${m.quantity} × ${m.item}`).join(', ')}
            </p>
          )}
          <form
            className="mt-3 flex flex-col gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ notes: notes.trim() === '' ? null : notes.trim() });
            }}
          >
            <Label htmlFor={`notes-${a.id}`}>{t('hk.notes')}</Label>
            <textarea
              id={`notes-${a.id}`}
              className="min-h-20 rounded-md border border-border bg-surface p-2 text-sm"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <Button type="submit" variant="secondary" className="h-11 self-start">
              {t('hk.saveNotes')}
            </Button>
          </form>
        </>
      )}
      {queued && (
        <Alert tone="info" className="mt-3">
          {t('offline.queuedNow')}
        </Alert>
      )}
      {update.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(update.error)}
        </Alert>
      )}
    </li>
  );
}
