import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Missed clocks (T-138a): a manager adds a clock-in or clock-out someone forgot, with a note,
// so timesheets (M7-06) no longer have to be approved with uncounted open clocks.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T18:00:00Z');
});

type Sheet = { id: string; workedMinutes: number; openClocks: number; status: string };

async function hotel() {
  const h = await inHouse(db, clock);
  const cook = await h.person('staff', h.p1.id);
  const boss = await h.person('dept-manager', h.p1.id);
  const profile = (name: string, userId: string) =>
    h.ok<{ id: string }>(
      h.gm.send('/staff', {
        name,
        userId,
        jobTitle: 'Kitchen',
        employmentType: 'HOURLY',
        startDate: '2026-01-05',
      }),
    );
  const bisi = await profile('Bisi Cook', cook.id);
  const bose = await profile('Bose Boss', boss.id);
  // Bisi clocked in at 08:00 Lagos time and forgot to clock out.
  await db.attendanceEvent.create({
    data: {
      propertyId: h.p1.id,
      staffId: bisi.id,
      kind: 'IN',
      at: new Date('2026-11-10T07:00:00Z'),
      channel: 'PHONE',
      recordedById: cook.id,
    },
  });
  return { ...h, bisi, bose, cook: await h.as(cook.id), boss: await h.as(boss.id) };
}

describe('missed clocks (T-138a)', () => {
  it('adds a missed clock-out, and the draft timesheet counts the shift', async () => {
    const h = await hotel();
    const sheet = await h.ok<Sheet>(
      h.boss.send('/timesheets', { staffId: h.bisi.id, from: '2026-11-01', to: '2026-11-30' }),
    );
    expect(sheet).toMatchObject({ workedMinutes: 0, openClocks: 1 });

    const add = (body: object, as = h.boss) =>
      as.send('/attendance/corrections', { staffId: h.bisi.id, ...body });
    expect(
      (await add({ kind: 'OUT', at: '2026-11-10T15:00:00Z', note: 'Forgot' }, h.cook)).status,
    ).toBe(403);
    expect(errorOf(await add({ kind: 'OUT', at: '2026-11-10T15:00:00Z' })).code).toBe(
      'VALIDATION_ERROR',
    ); // a note is needed
    expect(
      errorOf(await add({ kind: 'OUT', at: '2026-11-10T19:00:00Z', note: 'Future' })).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      errorOf(await add({ kind: 'OUT', at: '2026-08-01T15:00:00Z', note: 'Too old' })).code,
    ).toBe('VALIDATION_ERROR');
    // Clocks must still alternate.
    expect(
      errorOf(await add({ kind: 'IN', at: '2026-11-10T06:00:00Z', note: 'Twice in' })).code,
    ).toBe('VALIDATION_ERROR');

    const added = await h.ok<{ channel: string; note: string; recordedBy: { name: string } }>(
      add({ kind: 'OUT', at: '2026-11-10T15:00:00Z', note: 'Forgot to clock out; left at 4pm' }),
    );
    expect(added).toMatchObject({ channel: 'MANUAL', note: 'Forgot to clock out; left at 4pm' });
    const list = await h.ok<{ data: Sheet[] }>(h.boss.get('/timesheets?month=2026-11'));
    expect(list.data[0]).toMatchObject({ workedMinutes: 480, openClocks: 0 });
    expect(await db.auditEvent.count({ where: { action: 'attendance.clock_added' } })).toBe(1);
    expect(
      errorOf(await add({ kind: 'OUT', at: '2026-11-10T16:00:00Z', note: 'Again' })).code,
    ).toBe('VALIDATION_ERROR'); // nothing open to close

    // The day's clocks show it, with who added it.
    const day = await h.ok<{ events: { channel: string }[]; staff: { id: string }[] }>(
      h.boss.get('/attendance?date=2026-11-10'),
    );
    expect(day.events.map((e) => e.channel)).toEqual(['PHONE', 'MANUAL']);
    expect(day.staff.map((s) => s.id)).toContain(h.bisi.id);

    // Nobody corrects their own clocks.
    expect(
      errorOf(
        await h.boss.send('/attendance/corrections', {
          staffId: h.bose.id,
          kind: 'IN',
          at: '2026-11-10T07:00:00Z',
          note: 'Mine',
        }),
      ).code,
    ).toBe('FORBIDDEN');

    // An approved timesheet stays as approved.
    await h.ok(h.boss.post(`/timesheets/${sheet.id}/approve`, { approvedOvertimeMinutes: 0 }));
    expect(
      errorOf(await add({ kind: 'IN', at: '2026-11-10T16:00:00Z', note: 'Came back' })).code,
    ).toBe('STATE_TRANSITION_INVALID');
  });
});
