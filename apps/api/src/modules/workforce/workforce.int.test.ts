import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Duties, rotas and leave (PRD M7-02 "As a manager, I assign standing duties to salaried staff
// without a rota"; M7-03 "As a manager, I enable optional rotas per department and publish
// weekly or monthly schedules"; M7-05 "As staff, I request leave; my manager approves or
// rejects"; acceptance: "a leave approval removes the staff member from rota slots on those
// dates"; T-137).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Leave = { id: string; status: string; days: number; shiftsRemoved: number };
type Slot = { id: string; staff: { id: string }; date: string; status: string };
type Rota = {
  shifts: { id: string; name: string }[];
  assignments: (Slot & { leaveRequestId: string | null })[];
  leave: { staffId: string }[];
  departments: { id: string; hasRota: boolean }[];
};
type Mine = {
  staff: { id: string } | null;
  duties: { title: string }[];
  shifts: { date: string; shift: string }[];
  leave: Leave[];
};

async function hotel() {
  const h = await inHouse(db, clock);
  const gmId = (await db.membership.findFirstOrThrow({ where: { roleId: h.role('gm') } })).userId;
  const fb = await db.department.create({
    data: { organisationId: h.org.id, propertyId: h.p1.id, code: 'FB', name: 'Food and beverage' },
  });
  const cook = await h.person('staff', h.p1.id);
  const boss = await h.person('dept-manager', h.p1.id);
  const gm = await h.as(gmId);
  const profile = (name: string, userId: string | null, employmentType = 'MONTHLY_SALARY') =>
    h.ok<{ id: string }>(
      gm.send('/staff', {
        name,
        userId,
        departmentId: fb.id,
        jobTitle: 'Kitchen',
        managerId: boss.id,
        employmentType,
        startDate: '2026-01-05',
      }),
    );
  const bisi = await profile('Bisi Cook', cook.id);
  const ada = await profile('Ada Manager', boss.id);
  const ojo = await profile('Ojo Porter', null, 'DAILY_PAID');
  return {
    ...h,
    fb,
    gm,
    bisi,
    ada,
    ojo,
    cook: await h.as(cook.id),
    boss: await h.as(boss.id),
  };
}

describe('duties, rotas and leave (M7-02, M7-03, M7-05)', () => {
  it('gives standing duties without a rota', async () => {
    const h = await hotel();
    expect((await h.fd.get('/duties')).status).toBe(403);
    expect((await h.boss.get('/duties')).status).toBe(403); // no staff.duty
    const duty = await h.ok<{ id: string; weekdays: number[] }>(
      h.gm.send('/duties', {
        staffId: h.bisi.id,
        title: 'Open the bar store',
        weekdays: [6, 1, 1],
        startTime: '08:00',
      }),
    );
    expect(duty.weekdays).toEqual([1, 6]);
    expect(
      errorOf(await h.gm.send('/duties', { staffId: h.bisi.id, title: 'x', startTime: '25:00' }))
        .code,
    ).toBe('VALIDATION_ERROR');
    // A salaried member with no rota sees the duty in their own work.
    let mine = await h.ok<Mine>(h.cook.get('/leave-requests/mine'));
    expect(mine.staff?.id).toBe(h.bisi.id);
    expect(mine.duties.map((d) => d.title)).toEqual(['Open the bar store']);
    expect(mine.shifts).toEqual([]);

    await h.ok(h.gm.patch(`/duties/${duty.id}`, { active: false }));
    mine = await h.ok<Mine>(h.cook.get('/leave-requests/mine'));
    expect(mine.duties).toEqual([]);
    expect(await db.auditEvent.count({ where: { action: 'duty.stopped' } })).toBe(1);
    const list = await h.ok<{ data: { active: boolean }[] }>(h.gm.get('/duties'));
    expect(list.data).toMatchObject([{ active: false }]);

    // Someone who has left gets no new duty.
    await h.ok(h.gm.patch(`/staff/${h.ojo.id}`, { endDate: '2026-11-01' }));
    expect(errorOf(await h.gm.send('/duties', { staffId: h.ojo.id, title: 'Sweep' })).code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('publishes a rota, and approved leave takes the person off those dates', async () => {
    const h = await hotel();
    const week = '/rotas?departmentId=' + h.fb.id + '&from=2026-11-16&to=2026-11-22';
    expect((await h.cook.get(week)).status).toBe(403);
    let rota = await h.ok<Rota>(h.boss.get(week));
    // With no department named, the first one.
    expect(
      (
        await h.ok<{ department: { id: string } | null }>(
          h.boss.get('/rotas?from=2026-11-16&to=2026-11-22'),
        )
      ).department?.id,
    ).toBe(h.fb.id);
    // No shifts: this department works without a rota.
    expect(rota.shifts).toEqual([]);
    expect(rota.departments.find((d) => d.id === h.fb.id)?.hasRota).toBe(false);
    expect(
      errorOf(await h.boss.get(`/rotas?departmentId=${h.fb.id}&from=2026-11-01&to=2027-01-31`))
        .code,
    ).toBe('VALIDATION_ERROR');

    const morning = await h.ok<{ id: string }>(
      h.boss.send(`/rotas/${h.fb.id}/shifts`, {
        name: 'Morning',
        startTime: '07:00',
        endTime: '15:00',
      }),
    );
    expect(
      errorOf(
        await h.boss.send(`/rotas/${h.fb.id}/shifts`, {
          name: 'morning',
          startTime: '15:00',
          endTime: '23:00',
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      errorOf(
        await h.boss.send(`/rotas/${h.fb.id}/shifts`, {
          name: 'Odd',
          startTime: '07:00',
          endTime: '07:00',
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');

    const assign = (staffId: string, date: string) =>
      h.boss.send('/rotas/assignments', { shiftId: morning.id, staffId, date });
    for (const date of ['2026-11-16', '2026-11-17', '2026-11-18']) {
      await h.ok(assign(h.bisi.id, date));
    }
    const ojoSlot = await h.ok<Slot>(assign(h.ojo.id, '2026-11-17'));
    expect(ojoSlot.status).toBe('DRAFT');
    expect(errorOf(await assign(h.bisi.id, '2026-11-16')).code).toBe('VALIDATION_ERROR');

    // Drafts are not shown to staff until published.
    expect((await h.ok<Mine>(h.cook.get('/leave-requests/mine'))).shifts).toEqual([]);
    expect(
      await h.ok(
        h.boss.post(`/rotas/${h.fb.id}/publish`, { from: '2026-11-16', period: 'WEEKLY' }),
      ),
    ).toEqual({ from: '2026-11-16', to: '2026-11-22', published: 4 });
    expect(
      (await h.ok<Mine>(h.cook.get('/leave-requests/mine'))).shifts.map((s) => s.date),
    ).toEqual(['2026-11-16', '2026-11-17', '2026-11-18']);

    // Leave: asked by staff, decided by someone else with leave.approve.
    const leave = await h.ok<Leave>(
      h.cook.send('/leave-requests', {
        type: 'ANNUAL',
        startDate: '2026-11-17',
        endDate: '2026-11-18',
        reason: 'Family wedding',
      }),
    );
    expect(leave).toMatchObject({ status: 'PENDING', days: 2 });
    expect(
      errorOf(
        await h.cook.send('/leave-requests', {
          type: 'SICK',
          startDate: '2026-11-18',
          endDate: '2026-11-20',
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    expect((await h.cook.get('/leave-requests')).status).toBe(403);
    // No profile linked to the login: nothing to request leave against.
    expect((await h.ok<Mine>(h.fd.get('/leave-requests/mine'))).staff).toBeNull();
    expect(
      errorOf(
        await h.fd.send('/leave-requests', {
          type: 'ANNUAL',
          startDate: '2026-12-01',
          endDate: '2026-12-01',
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');

    // Nobody decides their own leave.
    const own = await h.ok<Leave>(
      h.boss.send('/leave-requests', {
        type: 'ANNUAL',
        startDate: '2026-12-01',
        endDate: '2026-12-02',
      }),
    );
    expect(
      errorOf(await h.boss.post(`/leave-requests/${own.id}/decision`, { decision: 'APPROVE' }))
        .code,
    ).toBe('FORBIDDEN');
    // A rejection says why.
    expect(
      errorOf(await h.gm.post(`/leave-requests/${own.id}/decision`, { decision: 'REJECT' })).code,
    ).toBe('VALIDATION_ERROR');
    const pending = await h.ok<{ data: { id: string }[] }>(h.boss.get('/leave-requests'));
    expect(pending.data.map((l) => l.id)).toEqual([leave.id, own.id]);

    const approved = await h.ok<Leave>(
      h.boss.post(`/leave-requests/${leave.id}/decision`, { decision: 'APPROVE' }),
    );
    expect(approved).toMatchObject({ status: 'APPROVED', shiftsRemoved: 2 });
    rota = await h.ok<Rota>(h.boss.get(week));
    const bisiSlots = rota.assignments.filter((a) => a.staff.id === h.bisi.id);
    expect(bisiSlots.map((a) => [a.date, a.status, a.leaveRequestId])).toEqual([
      ['2026-11-16', 'PUBLISHED', null],
      ['2026-11-17', 'REMOVED', leave.id],
      ['2026-11-18', 'REMOVED', leave.id],
    ]);
    expect(rota.leave.map((l) => l.staffId)).toEqual([h.bisi.id]);
    expect(
      (await h.ok<Mine>(h.cook.get('/leave-requests/mine'))).shifts.map((s) => s.date),
    ).toEqual(['2026-11-16']);
    // Not put back on a shift during approved leave.
    expect(errorOf(await assign(h.bisi.id, '2026-11-18')).code).toBe('VALIDATION_ERROR');
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'leave.approved' } });
    expect(JSON.stringify(audit.after)).toContain('2026-11-17');

    // Decided once; withdrawn only while pending.
    expect(
      errorOf(await h.gm.post(`/leave-requests/${leave.id}/decision`, { decision: 'APPROVE' }))
        .code,
    ).toBe('STATE_TRANSITION_INVALID');
    expect(errorOf(await h.cook.post(`/leave-requests/${leave.id}/cancel`)).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    expect(errorOf(await h.boss.post(`/leave-requests/${leave.id}/cancel`)).code).toBe('NOT_FOUND');
    const later = await h.ok<Leave>(
      h.cook.send('/leave-requests', {
        type: 'OTHER',
        startDate: '2026-12-24',
        endDate: '2026-12-24',
      }),
    );
    expect((await h.ok<Leave>(h.cook.post(`/leave-requests/${later.id}/cancel`))).status).toBe(
      'CANCELLED',
    );

    // A slot taken off by leave stays as the record; a published slot removed by hand is audited.
    const removed = bisiSlots[1]?.id ?? '';
    expect(errorOf(await h.boss.delete(`/rotas/assignments/${removed}`)).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    await h.ok(h.boss.delete(`/rotas/assignments/${ojoSlot.id}`));
    expect(await db.auditEvent.count({ where: { action: 'rota.slot_removed' } })).toBe(1);

    // Stopping the only shift turns the rota off.
    await h.ok(h.boss.patch(`/rotas/shifts/${morning.id}`, { active: false }));
    rota = await h.ok<Rota>(h.boss.get(week));
    expect(rota.departments.find((d) => d.id === h.fb.id)?.hasRota).toBe(false);
    expect(errorOf(await assign(h.ojo.id, '2026-11-19')).code).toBe('VALIDATION_ERROR');
  });
});
