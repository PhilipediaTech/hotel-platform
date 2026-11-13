import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { DEPARTMENT_TEMPLATES } from '../identity/role-templates.ts';
import { runPreventivePlans } from './preventive.ts';

// Preventive maintenance (PRD M5-10 "As a manager, I schedule preventive maintenance by
// calendar or run hours", pm.manage; T-131).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Plan = {
  id: string;
  title: string;
  trigger: string;
  nextDueOn: string | null;
  lastDoneOn: string | null;
  meterHours: number | null;
  lastServiceHours: number | null;
  hoursLeft: number | null;
  dueState: string;
  active: boolean;
  assignee: { id: string } | null;
  openTask: { id: string; number: number; status: string } | null;
};
type Task = {
  id: string;
  title: string;
  type: string;
  status: string;
  description: string | null;
  room: { number: string } | null;
  asset: { tag: string } | null;
  assignee: { id: string } | null;
  dueAt: string | null;
};

async function hotel() {
  const h = await inHouse(db, clock);
  await db.department.createMany({
    data: DEPARTMENT_TEMPLATES.map((d) => ({
      organisationId: h.org.id,
      propertyId: h.p1.id,
      ...d,
    })),
  });
  const r101 = await db.room.findFirstOrThrow({ where: { number: '101', propertyId: h.p1.id } });
  const femi = await h.person('maintenance', h.p1.id);
  const attendant = await h.person('hk-attendant', h.p1.id);
  const as = await h.as(femi.id);
  const ac = await h.ok<{ id: string }>(
    as.send('/assets', {
      tag: 'AC-101',
      name: 'Split AC',
      category: 'Air conditioning',
      roomId: r101.id,
    }),
  );
  const gen = await h.ok<{ id: string }>(
    as.send('/assets', { tag: 'GEN-1', name: 'Perkins 60kVA', category: 'Generator' }),
  );
  return {
    ...h,
    femiId: femi.id,
    femi: as,
    attendant: await h.as(attendant.id),
    acId: ac.id,
    genId: gen.id,
  };
}

const plansOf = async (h: Awaited<ReturnType<typeof hotel>>) =>
  (await h.ok<{ data: Plan[]; today: string }>(h.femi.get('/preventive-plans'))).data;
const pmTasks = (propertyId: string) =>
  db.task.count({ where: { propertyId, title: { startsWith: 'Preventive:' } } });

async function finish(h: Awaited<ReturnType<typeof hotel>>, taskId: string) {
  await h.ok(h.femi.send(`/tasks/${taskId}/acknowledge`));
  await h.ok(h.femi.send(`/tasks/${taskId}/start`));
  await h.ok(h.femi.send(`/tasks/${taskId}/resolve`, { note: 'Done' }));
  await h.ok(h.gm.send(`/tasks/${taskId}/verify`, {}));
}

describe('preventive maintenance by calendar (M5-10)', () => {
  it('opens one job when due, and moves the plan on when the job is verified', async () => {
    const h = await hotel();
    expect((await h.attendant.get('/preventive-plans')).status).toBe(403);
    expect(
      (
        await h.attendant.send('/preventive-plans', {
          title: 'Clean filters',
          trigger: 'CALENDAR',
          everyDays: 30,
          firstDueOn: '2026-11-12',
        })
      ).status,
    ).toBe(403);
    // A calendar plan needs its interval and first date.
    expect(
      errorOf(
        await h.femi.send('/preventive-plans', { title: 'Clean filters', trigger: 'CALENDAR' }),
      ).code,
    ).toBe('VALIDATION_ERROR');

    // Due in two days (lead 3): the job opens at once, on the asset and its room.
    const filters = await h.ok<Plan>(
      h.femi.send('/preventive-plans', {
        title: 'Clean AC filters',
        instructions: 'Wash and dry both filters; check the drain.',
        assetId: h.acId,
        trigger: 'CALENDAR',
        everyDays: 90,
        firstDueOn: '2026-11-12',
        assigneeId: h.femiId,
      }),
    );
    expect(filters).toMatchObject({ dueState: 'DUE_SOON', openTask: { status: 'ASSIGNED' } });
    const job = await h.ok<Task>(h.femi.get(`/tasks/${filters.openTask?.id}`));
    expect(job).toMatchObject({
      title: 'Preventive: Clean AC filters (AC-101)',
      type: 'GENERAL',
      room: { number: '101' },
      asset: { tag: 'AC-101' },
      assignee: { id: h.femiId },
    });
    expect(job.description).toContain('Due 2026-11-12.');
    expect(job.dueAt).toBe('2026-11-12T22:59:00Z');

    // Not due for a while: no job yet.
    const pump = await h.ok<Plan>(
      h.femi.send('/preventive-plans', {
        title: 'Grease pool pump',
        trigger: 'CALENDAR',
        everyDays: 30,
        firstDueOn: '2026-12-20',
      }),
    );
    expect(pump).toMatchObject({ dueState: 'OK', openTask: null });

    // The worker run opens nothing new, however often it runs.
    await runPreventivePlans(db, clock);
    await runPreventivePlans(db, clock);
    expect(await pmTasks(h.p1.id)).toBe(1);

    // The filters job is done and verified: the next date counts from today.
    await finish(h, job.id);
    expect(await runPreventivePlans(db, clock)).toBe(1);
    const after = (await plansOf(h)).find((p) => p.id === filters.id);
    expect(after).toMatchObject({
      lastDoneOn: '2026-11-10',
      nextDueOn: '2027-02-08',
      openTask: null,
      dueState: 'OK',
    });
    const serviced = await db.auditEvent.findFirstOrThrow({
      where: { action: 'preventive_plan.serviced' },
    });
    expect(serviced).toMatchObject({ actorType: 'SYSTEM', entityId: filters.id });

    // Five weeks on, the pump comes due within its lead and the worker opens its job.
    now = new Date('2026-12-18T09:00:00Z');
    await runPreventivePlans(db, clock);
    // (Five weeks on, the test sign-in has expired: read the plan directly.)
    const pumpNow = await db.preventivePlan.findUniqueOrThrow({
      where: { id: pump.id },
      include: { openTask: true },
    });
    expect(pumpNow.openTask?.status).toBe('REPORTED');
    expect(await pmTasks(h.p1.id)).toBe(2);
  });

  it('pauses, moves and refuses plans on retired assets', async () => {
    const h = await hotel();
    const plan = await h.ok<Plan>(
      h.femi.send('/preventive-plans', {
        title: 'Service lift',
        trigger: 'CALENDAR',
        everyDays: 30,
        firstDueOn: '2026-12-01',
      }),
    );
    // Paused, then moved into the lead: no job while paused; resuming opens it.
    await h.ok(h.femi.patch(`/preventive-plans/${plan.id}`, { active: false }));
    const moved = await h.ok<Plan>(
      h.femi.patch(`/preventive-plans/${plan.id}`, { nextDueOn: '2026-11-11' }),
    );
    expect(moved).toMatchObject({ active: false, nextDueOn: '2026-11-11', openTask: null });
    await runPreventivePlans(db, clock);
    expect(await pmTasks(h.p1.id)).toBe(0);
    const resumed = await h.ok<Plan>(
      h.femi.patch(`/preventive-plans/${plan.id}`, { active: true }),
    );
    expect(resumed.openTask).not.toBeNull();
    expect(
      await db.auditEvent.count({
        where: { action: 'preventive_plan.updated', entityId: plan.id },
      }),
    ).toBe(3);

    // A calendar plan has no run hours.
    expect(
      errorOf(await h.femi.patch(`/preventive-plans/${plan.id}`, { everyHours: 100 })).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      errorOf(await h.femi.send(`/preventive-plans/${plan.id}/hours`, { hours: 5 })).code,
    ).toBe('STATE_TRANSITION_INVALID');

    await h.ok(h.femi.patch(`/assets/${h.genId}`, { status: 'RETIRED' }));
    expect(
      errorOf(
        await h.femi.send('/preventive-plans', {
          title: 'Change oil',
          assetId: h.genId,
          trigger: 'RUN_HOURS',
          everyHours: 250,
          lastServiceHours: 0,
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
  });
});

describe('preventive maintenance by run hours (M5-10)', () => {
  it('opens the job when the meter comes within the lead, and counts on from the service', async () => {
    const h = await hotel();
    // Run hours are counted on an asset.
    expect(
      errorOf(
        await h.femi.send('/preventive-plans', {
          title: 'Change oil',
          trigger: 'RUN_HOURS',
          everyHours: 250,
          lastServiceHours: 1000,
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    const oil = await h.ok<Plan>(
      h.femi.send('/preventive-plans', {
        title: 'Change oil and filter',
        assetId: h.genId,
        trigger: 'RUN_HOURS',
        everyHours: 250,
        lastServiceHours: 1000,
        meterHours: 1100,
        leadHours: 10,
        assigneeId: h.femiId,
      }),
    );
    expect(oil).toMatchObject({ hoursLeft: 150, dueState: 'OK', openTask: null });

    // A reading can't go back; one within 10 hours of the service opens the job.
    expect(
      errorOf(await h.femi.send(`/preventive-plans/${oil.id}/hours`, { hours: 1090 })).code,
    ).toBe('VALIDATION_ERROR');
    const read = await h.ok<Plan>(
      h.femi.send(`/preventive-plans/${oil.id}/hours`, { hours: 1245 }),
    );
    expect(read).toMatchObject({ meterHours: 1245, hoursLeft: 5, dueState: 'DUE_SOON' });
    expect(read.openTask).not.toBeNull();
    const job = await h.ok<Task>(h.femi.get(`/tasks/${read.openTask?.id}`));
    expect(job).toMatchObject({ title: 'Preventive: Change oil and filter (GEN-1)', dueAt: null });
    expect(job.description).toContain('Due at 1,250 run hours (meter reads 1,245).');

    // Past due while the job is worked; one job only.
    const past = await h.ok<Plan>(
      h.femi.send(`/preventive-plans/${oil.id}/hours`, { hours: 1262 }),
    );
    expect(past).toMatchObject({ hoursLeft: -12, dueState: 'OVERDUE' });
    expect(await pmTasks(h.p1.id)).toBe(1);

    // Serviced at 1262 hours: the next service is due at 1512.
    await finish(h, job.id);
    await runPreventivePlans(db, clock);
    const done = (await plansOf(h)).find((p) => p.id === oil.id);
    expect(done).toMatchObject({
      lastServiceHours: 1262,
      hoursLeft: 250,
      lastDoneOn: '2026-11-10',
      openTask: null,
      dueState: 'OK',
    });
  });
});
