import {
  OBSERVED_STATUSES,
  type BoardRoom,
  type HkAssignmentItem,
  type ObservedStatus,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
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

registerStrings(housekeepingStrings);

// S16 Room board and S17 My rooms (PRD M5-01–M5-05; T-080, T-081). The board shows every room
// with its housekeeping and front-office status, today's clean, attendant and priority, by
// floor, plus its morning report and any discrepancy; the supervisor selects rooms and gives
// them to an attendant. My rooms is the attendant's phone screen: start, pause and complete
// each room, tick its checklist, note minibar use, and send the morning room-status report.

type Room = z.output<typeof BoardRoom>;
type Assignment = z.output<typeof HkAssignmentItem>;

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
  const key = useHkKey('board');
  const board = useQuery({
    queryKey: [...key, floor],
    queryFn: () => api.call('getHousekeepingBoard', { query: floor ? { floor } : {} }),
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
  const data = board.data;
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
          {assign.error && (
            <Alert tone="critical" className="mt-3">
              {errorMessage(assign.error)}
            </Alert>
          )}
          <ul aria-label={t('hk.rooms')} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.rooms.map((r) => (
              <RoomTile
                key={r.roomId}
                room={r}
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
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const r = props.room;
  const a = r.assignment;
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
    </li>
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
  const mine = useQuery({
    queryKey: key,
    queryFn: () => api.call('listMyAssignments', {}),
  });
  const data = mine.data?.data ?? [];
  return (
    <section className="max-w-xl">
      <h1 className="text-xl font-semibold">{t('hk.myRooms')}</h1>
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
  const send = useMutation({
    mutationFn: () =>
      api.call('submitStatusReport', {
        body: {
          entries: Object.entries(chosen).map(([roomId, observed]) => ({ roomId, observed })),
        },
      }),
    onSuccess: () => {
      setChosen({});
      void queryClient.invalidateQueries({ queryKey: key });
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
      {send.data && (
        <Alert tone={send.data.alertsRaised > 0 ? 'critical' : 'success'} className="mt-3">
          {send.data.alertsRaised > 0
            ? t('hk.reportSent', { count: send.data.alertsRaised })
            : t('hk.reportSentNone')}
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
  const update = useMutation({
    mutationFn: (body: object) =>
      api.call('updateAssignment', { params: { assignmentId: a.id }, body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey }),
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
      {update.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(update.error)}
        </Alert>
      )}
    </li>
  );
}
