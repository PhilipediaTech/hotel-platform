import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { addUpClocks } from './service.ts';

// Timesheets, advances and deductions, payroll export (PRD M7-06 "As a manager, I approve
// timesheets and overtime"; M7-07 "As HR, I record advances and deductions with approval";
// M7-08 "As HR, I export a payroll file for the period"; M7 rules "no pay amount is computed
// from attendance unless a pay rule is configured", "payroll export contains approved items
// only"; acceptance "a monthly-salaried staff member with no rota ... appears in payroll
// export"; T-139).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Sheet = {
  id: string;
  status: string;
  workedMinutes: number;
  overtimeMinutes: number;
  approvedOvertimeMinutes: number | null;
  daysWorked: number;
  openClocks: number;
  days: { date: string; minutes: number; overtimeMinutes: number }[];
};
type Item = { id: string; status: string };
type Row = {
  staff: { name: string };
  employmentType: string;
  payRateMinor: string | null;
  timesheets: number;
  workedMinutes: number;
  approvedOvertimeMinutes: number;
  advancesMinor: string;
  deductionsMinor: string;
};
type Payroll = { rows: Row[]; waiting: { draftTimesheets: number; pendingPayItems: number } };

async function hotel() {
  const h = await inHouse(db, clock);
  const cook = await h.person('staff', h.p1.id);
  const boss = await h.person('dept-manager', h.p1.id);
  const profile = (body: object) =>
    h.ok<{ id: string }>(
      h.gm.send('/staff', { jobTitle: 'Kitchen', startDate: '2026-01-05', ...body }),
    );
  const bisi = await profile({ name: 'Bisi Cook', userId: cook.id, employmentType: 'HOURLY' });
  const ada = await profile({
    name: 'Ada Accountant',
    employmentType: 'MONTHLY_SALARY',
    payRateMinor: '30000000',
  });
  const bose = await profile({
    name: 'Bose Boss',
    userId: boss.id,
    employmentType: 'MONTHLY_SALARY',
  });
  const ojo = await profile({ name: 'Ojo Left', employmentType: 'DAILY_PAID' });
  await h.ok(h.gm.patch(`/staff/${ojo.id}`, { endDate: '2026-10-31' }));
  // Bisi's clocks (Lagos is UTC+1).
  const clocks: [string, string][] = [
    ['IN', '2026-11-02T07:00:00Z'],
    ['OUT', '2026-11-02T17:30:00Z'], // 10.5 h: 150 min overtime
    ['IN', '2026-11-03T07:00:00Z'],
    ['OUT', '2026-11-03T15:00:00Z'], // 8 h
    ['IN', '2026-11-04T07:00:00Z'], // no clock-out
    ['IN', '2026-11-05T07:00:00Z'],
    ['OUT', '2026-11-05T12:00:00Z'], // 5 h
    ['IN', '2026-11-30T20:00:00Z'],
    ['OUT', '2026-12-01T04:00:00Z'], // 8 h overnight, counted on 30 November
  ];
  for (const [kind, at] of clocks) {
    await db.attendanceEvent.create({
      data: {
        propertyId: h.p1.id,
        staffId: bisi.id,
        kind,
        at: new Date(at),
        channel: 'PHONE',
        recordedById: cook.id,
      },
    });
  }
  return {
    ...h,
    bisi,
    ada,
    bose,
    ojo,
    cook: await h.as(cook.id),
    boss: await h.as(boss.id),
    owner: await h.as(h.owner.id),
  };
}

describe('timesheets, pay items and payroll (M7-06, M7-07, M7-08)', () => {
  it('adds up clocks per day with overtime, and approves the overtime accepted', async () => {
    const h = await hotel();
    expect((await h.cook.get('/timesheets?month=2026-11')).status).toBe(403);
    // Within one month only.
    expect(
      errorOf(
        await h.boss.send('/timesheets', {
          staffId: h.bisi.id,
          from: '2026-11-20',
          to: '2026-12-05',
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    const sheet = await h.ok<Sheet>(
      h.boss.send('/timesheets', { staffId: h.bisi.id, from: '2026-11-01', to: '2026-11-30' }),
    );
    expect(sheet).toMatchObject({
      status: 'DRAFT',
      workedMinutes: 630 + 480 + 300 + 480,
      overtimeMinutes: 150,
      daysWorked: 4,
      openClocks: 1,
    });
    expect(sheet.days.map((d) => d.date)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-05',
      '2026-11-30',
    ]);
    expect(
      errorOf(
        await h.boss.send('/timesheets', {
          staffId: h.bisi.id,
          from: '2026-11-15',
          to: '2026-11-21',
        }),
      ).code,
    ).toBe('VALIDATION_ERROR'); // overlaps

    const approve = (body: object, as = h.boss) => as.post(`/timesheets/${sheet.id}/approve`, body);
    expect(errorOf(await approve({ approvedOvertimeMinutes: 200, note: 'ok' })).code).toBe(
      'VALIDATION_ERROR',
    );
    // An open clock-in needs a note.
    expect(errorOf(await approve({ approvedOvertimeMinutes: 120 })).code).toBe('VALIDATION_ERROR');
    const approved = await h.ok<Sheet>(
      approve({
        approvedOvertimeMinutes: 120,
        note: 'Forgot to clock out on the 4th; was off sick',
      }),
    );
    expect(approved).toMatchObject({ status: 'APPROVED', approvedOvertimeMinutes: 120 });
    expect(errorOf(await approve({ approvedOvertimeMinutes: 0, note: 'x' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    expect(errorOf(await h.boss.delete(`/timesheets/${sheet.id}`)).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    expect(await db.auditEvent.count({ where: { action: 'timesheet.approved' } })).toBe(1);

    // Nobody approves their own timesheet.
    const own = await h.ok<Sheet>(
      h.boss.send('/timesheets', { staffId: h.bose.id, from: '2026-11-01', to: '2026-11-30' }),
    );
    expect(
      errorOf(await h.boss.post(`/timesheets/${own.id}/approve`, { approvedOvertimeMinutes: 0 }))
        .code,
    ).toBe('FORBIDDEN');
    // A draft can be added up again, or removed.
    await h.ok(h.boss.post(`/timesheets/${own.id}/recalculate`));
    await h.ok(h.boss.delete(`/timesheets/${own.id}`));
    const list = await h.ok<{
      data: unknown[];
      staff: { name: string }[];
      overtimeAfterMinutes: number;
    }>(h.boss.get('/timesheets?month=2026-11'));
    expect(list.data).toHaveLength(1);
    expect(list.overtimeAfterMinutes).toBe(480);
    // Someone who left in October is not listed for November.
    expect(list.staff.map((s) => s.name)).not.toContain('Ojo Left');
  });

  it('records advances and deductions approved by someone else', async () => {
    const h = await hotel();
    expect((await h.boss.get('/pay-items?month=2026-11')).status).toBe(403);
    const record = (body: object) =>
      h.gm.send('/pay-items', {
        staffId: h.bisi.id,
        month: '2026-11',
        description: 'Advance',
        ...body,
      });
    expect(errorOf(await record({ type: 'ADVANCE', amountMinor: '0' })).code).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      errorOf(await record({ type: 'ADVANCE', amountMinor: '100', staffId: h.ojo.id })).code,
    ).toBe('VALIDATION_ERROR'); // not employed in November
    const advance = await h.ok<Item>(record({ type: 'ADVANCE', amountMinor: '2000000' }));
    expect(advance.status).toBe('PENDING');
    // Four eyes.
    expect(
      errorOf(await h.gm.post(`/pay-items/${advance.id}/decision`, { decision: 'APPROVE' })).code,
    ).toBe('FORBIDDEN');
    expect(
      (await h.ok<Item>(h.owner.post(`/pay-items/${advance.id}/decision`, { decision: 'APPROVE' })))
        .status,
    ).toBe('APPROVED');
    expect(
      errorOf(await h.owner.post(`/pay-items/${advance.id}/decision`, { decision: 'APPROVE' }))
        .code,
    ).toBe('STATE_TRANSITION_INVALID');

    const fine = await h.ok<Item>(
      record({ type: 'DEDUCTION', amountMinor: '500000', description: 'Breakage' }),
    );
    expect(
      errorOf(await h.owner.post(`/pay-items/${fine.id}/decision`, { decision: 'REJECT' })).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      (
        await h.ok<Item>(
          h.owner.post(`/pay-items/${fine.id}/decision`, {
            decision: 'REJECT',
            note: 'Not proven',
          }),
        )
      ).status,
    ).toBe('REJECTED');
    const withdrawn = await h.ok<Item>(record({ type: 'DEDUCTION', amountMinor: '100000' }));
    expect((await h.ok<Item>(h.gm.post(`/pay-items/${withdrawn.id}/cancel`))).status).toBe(
      'CANCELLED',
    );
    expect(await db.auditEvent.count({ where: { action: 'pay_item.approved' } })).toBe(1);
  });

  it('exports everyone employed in the month with approved figures only', async () => {
    const h = await hotel();
    const sheet = await h.ok<Sheet>(
      h.boss.send('/timesheets', { staffId: h.bisi.id, from: '2026-11-01', to: '2026-11-30' }),
    );
    await h.ok(
      h.boss.post(`/timesheets/${sheet.id}/approve`, { approvedOvertimeMinutes: 120, note: 'ok' }),
    );
    await h.ok(
      h.boss.send('/timesheets', { staffId: h.ada.id, from: '2026-11-01', to: '2026-11-30' }),
    );
    const advance = await h.ok<Item>(
      h.gm.send('/pay-items', {
        staffId: h.bisi.id,
        type: 'ADVANCE',
        amountMinor: '2000000',
        month: '2026-11',
        description: 'Salary advance',
      }),
    );
    await h.ok(h.owner.post(`/pay-items/${advance.id}/decision`, { decision: 'APPROVE' }));
    await h.ok(
      h.gm.send('/pay-items', {
        staffId: h.bisi.id,
        type: 'DEDUCTION',
        amountMinor: '300000',
        month: '2026-11',
        description: 'Uniform',
      }),
    ); // left pending

    expect((await h.boss.get('/payroll-exports?month=2026-11')).status).toBe(403);
    const payroll = await h.ok<Payroll>(h.gm.get('/payroll-exports?month=2026-11'));
    const byName = new Map(payroll.rows.map((r) => [r.staff.name, r]));
    expect([...byName.keys()]).toEqual(['Bisi Cook', 'Ada Accountant', 'Bose Boss']);
    expect(byName.get('Bisi Cook')).toMatchObject({
      timesheets: 1,
      workedMinutes: 1890,
      approvedOvertimeMinutes: 120,
      advancesMinor: '2000000',
      deductionsMinor: '0', // the pending one is left out
    });
    // Salaried, no rota, no clocks: still on the payroll, with the recorded rate and no pay computed.
    expect(byName.get('Ada Accountant')).toMatchObject({
      employmentType: 'MONTHLY_SALARY',
      payRateMinor: '30000000',
      timesheets: 0,
      workedMinutes: 0,
    });
    expect(payroll.waiting).toEqual({ draftTimesheets: 1, pendingPayItems: 1 });
    expect(JSON.stringify(payroll)).not.toMatch(/gross|net/i);

    const file = await h.gm.get('/payroll-exports?month=2026-11&format=csv');
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    const text = file.text;
    expect(text).toContain('ST-1,Bisi Cook');
    expect(text).toContain('31.50,2.00,20000.00,0.00');
    expect(await db.auditEvent.count({ where: { action: 'payroll.exported' } })).toBe(1);

    // payroll.export alone is enough for the file (no report.export).
    const role = await db.role.create({
      data: { organisationId: h.org.id, name: 'Payroll clerk', permissions: ['payroll.export'] },
    });
    const clerk = await h.person('staff', h.p1.id);
    await db.membership.updateMany({ where: { userId: clerk.id }, data: { roleId: role.id } });
    const asClerk = await h.as(clerk.id);
    expect((await asClerk.get('/payroll-exports?month=2026-11&format=csv')).status).toBe(200);
  });
});

describe('addUpClocks', () => {
  it('pairs each clock-in with the next clock-out within 16 hours', () => {
    const at = (s: string) => new Date(s);
    const r = addUpClocks(
      [
        { kind: 'IN', at: at('2026-11-02T07:00:00Z') },
        { kind: 'OUT', at: at('2026-11-03T07:00:00Z') }, // 24 h later: open
        { kind: 'OUT', at: at('2026-11-04T10:00:00Z') }, // stray clock-out
        { kind: 'IN', at: at('2026-10-31T20:00:00Z') }, // before the period
        { kind: 'OUT', at: at('2026-11-01T02:00:00Z') },
      ],
      { from: '2026-11-01', to: '2026-11-30' },
      'Africa/Lagos',
      480,
    );
    expect(r).toMatchObject({ workedMinutes: 0, openClocks: 1, daysWorked: 0 });
  });
});
