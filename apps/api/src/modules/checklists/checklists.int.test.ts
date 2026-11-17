import { isoWeekday } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { runChecklists } from './service.ts';

// Recurring checklists (PRD M6-13 "As a manager, I create recurring checklists (opening checks,
// fire equipment, pool) with schedule and assignee", checklist.manage; T-134).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T07:00:00Z');
});

type Checklist = {
  id: string;
  name: string;
  assignee: { id: string } | null;
  active: boolean;
  lastRun: { dueOn: string; status: string; problems: number } | null;
  missed30: number;
};
type Run = {
  id: string;
  checklist: { id: string; name: string };
  dueOn: string;
  dueAt: string;
  items: string[];
  assignee: { id: string } | null;
  status: string;
  results: { item: string; ok: boolean; note: string | null }[];
  problems: number;
  task: { id: string; number: number } | null;
  completedBy: { id: string } | null;
  canComplete: boolean;
};

/** A supervisor (checklist.manage), two people who work tasks, an attendant who does not. */
async function hotel() {
  const h = await inHouse(db, clock);
  const supervisor = await h.person('hk-supervisor', h.p1.id);
  const staff = await h.person('staff', h.p1.id);
  const tech = await h.person('maintenance', h.p1.id);
  const attendant = await h.person('hk-attendant', h.p1.id);
  const mnt = await db.department.create({
    data: { organisationId: h.org.id, propertyId: h.p1.id, code: 'MNT', name: 'Maintenance' },
  });
  return {
    ...h,
    mnt,
    staffId: staff.id,
    techId: tech.id,
    supervisorId: supervisor.id,
    attendantId: attendant.id,
    supervisor: await h.as(supervisor.id),
    staff: await h.as(staff.id),
    tech: await h.as(tech.id),
    attendant: await h.as(attendant.id),
  };
}

const POOL = ['Chlorine 1–3 ppm', 'pH 7.2–7.8', 'Lifebuoy in place'];

describe('recurring checklists (M6-13)', () => {
  it('makes the day’s run for its assignee, and problems open a task', async () => {
    const h = await hotel();
    // Managing needs checklist.manage; doing runs needs task.work.
    expect((await h.staff.get('/checklists')).status).toBe(403);
    expect((await h.attendant.get('/checklist-runs')).status).toBe(403);
    // A weekly checklist names its day.
    expect(
      errorOf(
        await h.supervisor.send('/checklists', {
          name: 'Fire extinguishers',
          departmentId: h.mnt.id,
          items: ['Gauge in green'],
          frequency: 'WEEKLY',
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    // Only someone who works tasks can be given one.
    expect(
      errorOf(
        await h.supervisor.send('/checklists', {
          name: 'Pool checks',
          departmentId: h.mnt.id,
          items: POOL,
          frequency: 'DAILY',
          assigneeId: h.attendantId,
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');

    const pool = await h.ok<Checklist>(
      h.supervisor.send('/checklists', {
        name: 'Pool checks',
        departmentId: h.mnt.id,
        items: POOL,
        frequency: 'DAILY',
        dueTime: '09:00',
        assigneeId: h.staffId,
      }),
    );
    // Due today, so today's run exists at once.
    expect(pool).toMatchObject({
      assignee: { id: h.staffId },
      lastRun: { dueOn: '2026-11-10', status: 'PENDING', problems: 0 },
    });
    // A weekly checklist for tomorrow's weekday has no run today.
    const tomorrow = (isoWeekday('2026-11-10') % 7) + 1;
    const fire = await h.ok<Checklist>(
      h.supervisor.send('/checklists', {
        name: 'Fire extinguishers',
        departmentId: h.mnt.id,
        items: ['Gauge in green', 'Pin and seal intact'],
        frequency: 'WEEKLY',
        weekday: tomorrow,
      }),
    );
    expect(fire.lastRun).toBeNull();

    // The run is the staff member's; the technician does not see it.
    expect((await h.ok<{ data: Run[] }>(h.tech.get('/checklist-runs'))).data).toEqual([]);
    const [run] = (await h.ok<{ data: Run[] }>(h.staff.get('/checklist-runs'))).data;
    expect(run).toMatchObject({
      checklist: { name: 'Pool checks' },
      dueOn: '2026-11-10',
      dueAt: '2026-11-10T08:00:00Z', // 09:00 in Lagos
      items: POOL,
      status: 'PENDING',
      canComplete: true,
    });
    if (!run) throw new Error('no run');
    expect(
      (
        await h.tech.send(`/checklist-runs/${run.id}/complete`, {
          results: [{ ok: true }, { ok: true }, { ok: true }],
        })
      ).status,
    ).toBe(404);

    // Every check is answered, and a problem says what is wrong.
    expect(
      errorOf(
        await h.staff.send(`/checklist-runs/${run.id}/complete`, {
          results: [{ ok: true }, { ok: true }],
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      errorOf(
        await h.staff.send(`/checklist-runs/${run.id}/complete`, {
          results: [{ ok: true }, { ok: false }, { ok: true }],
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');

    // Changing the checklist now leaves today's run as it was.
    await h.ok(h.supervisor.patch(`/checklists/${pool.id}`, { items: ['Only one check'] }));

    const done = await h.ok<Run>(
      h.staff.send(`/checklist-runs/${run.id}/complete`, {
        results: [{ ok: true }, { ok: false, note: 'pH 8.1, dosed acid' }, { ok: true }],
      }),
    );
    expect(done).toMatchObject({
      status: 'DONE',
      problems: 1,
      completedBy: { id: h.staffId },
      canComplete: false,
      results: [
        { item: POOL[0], ok: true, note: null },
        { item: POOL[1], ok: false, note: 'pH 8.1, dosed acid' },
        { item: POOL[2], ok: true, note: null },
      ],
    });
    const task = await db.task.findUniqueOrThrow({ where: { id: done.task?.id ?? '' } });
    expect(task).toMatchObject({
      type: 'CHECKLIST',
      departmentId: h.mnt.id,
      title: 'Pool checks: 1 problem',
      description: '• pH 7.2–7.8: pH 8.1, dosed acid',
      reportedById: h.staffId,
    });
    // Done once.
    expect(
      errorOf(
        await h.staff.send(`/checklist-runs/${run.id}/complete`, {
          results: [{ ok: true }, { ok: true }, { ok: true }],
        }),
      ).code,
    ).toBe('STATE_TRANSITION_INVALID');
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'checklist_run.completed', entityId: run.id },
    });
    expect(audit.after).toMatchObject({ problems: 1, late: false });
  });

  it('marks a run not done by the end of its day as missed', async () => {
    const h = await hotel();
    const opening = await h.ok<Checklist>(
      h.supervisor.send('/checklists', {
        name: 'Opening checks',
        departmentId: h.mnt.id,
        items: ['Lobby lights on', 'Generator fuel above half'],
        frequency: 'DAILY',
        dueTime: '07:00',
      }),
    );
    // Unassigned: anyone who works tasks sees it.
    const [first] = (await h.ok<{ data: Run[] }>(h.tech.get('/checklist-runs'))).data;
    expect(first).toMatchObject({ assignee: null, canComplete: true });
    if (!first) throw new Error('no run');

    // The next morning the hourly worker marks it missed and makes the new day's run.
    now = new Date('2026-11-11T06:00:00Z');
    // Sessions lapse overnight: sign in again.
    const tech = await h.as(h.techId);
    const supervisor = await h.as(h.supervisorId);
    expect(await runChecklists(db, clock)).toBe(2);
    expect(await runChecklists(db, clock)).toBe(0);
    expect(
      errorOf(
        await tech.send(`/checklist-runs/${first.id}/complete`, {
          results: [{ ok: true }, { ok: true }],
        }),
      ).code,
    ).toBe('STATE_TRANSITION_INVALID');
    const yesterday = await h.ok<{ data: Run[] }>(tech.get('/checklist-runs?date=2026-11-10'));
    expect(yesterday.data.map((r) => r.status)).toEqual(['MISSED']);
    const today = await h.ok<{ data: Run[] }>(tech.get('/checklist-runs'));
    expect(today.data.map((r) => [r.dueOn, r.status])).toEqual([['2026-11-11', 'PENDING']]);

    const list = await h.ok<{ data: Checklist[] }>(supervisor.get('/checklists'));
    expect(list.data.find((c) => c.id === opening.id)).toMatchObject({
      lastRun: { dueOn: '2026-11-11', status: 'PENDING' },
      missed30: 1,
    });

    // Paused, it makes no more runs.
    await h.ok(supervisor.patch(`/checklists/${opening.id}`, { active: false }));
    now = new Date('2026-11-12T06:00:00Z');
    expect(await runChecklists(db, clock)).toBe(1); // only the 11th marked missed
    const later = await h.as(h.techId);
    expect((await h.ok<{ data: Run[] }>(later.get('/checklist-runs'))).data).toEqual([]);
  });
});
