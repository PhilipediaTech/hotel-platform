import { addDays } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { DEPARTMENT_TEMPLATES } from '../identity/role-templates.ts';

// Maintenance insights (Versions V3 "maintenance anomaly insights"; T-180): repeat and
// reopened faults, meter use per occupied room night, diesel per generator run-hour, worked out
// by rules; dismissed with a reason until the evidence changes.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T20:00:00Z');
});

type Insight = {
  key: string;
  fingerprint: string;
  kind: string;
  severity: string;
  subject: { type: string; id: string | null; label: string };
  roomId: string | null;
  value: number;
  usual: number | null;
  taskIds: string[];
  overduePlans: number;
};
type List = { data: Insight[]; dismissed: number };

const at = (date: string, time = '08:00:00') => new Date(`${date}T${time}Z`);

/** Ada in 101 (inHouse), and one room night on the books every day since late September. */
async function hotel() {
  const h = await inHouse(db, clock);
  await db.department.createMany({
    data: DEPARTMENT_TEMPLATES.map((d) => ({
      organisationId: h.org.id,
      propertyId: h.p1.id,
      ...d,
    })),
  });
  const mnt = await db.department.findFirstOrThrow({
    where: { propertyId: h.p1.id, code: 'MNT' },
  });
  const room = await db.room.findFirstOrThrow({ where: { number: '101', propertyId: h.p1.id } });
  const stay = await db.stay.findUniqueOrThrow({ where: { id: h.stayId } });
  for (let d = '2026-09-20'; d < TODAY; d = addDays(d, 1)) {
    await db.stayNight.create({
      data: {
        stayId: stay.id,
        date: new Date(d),
        amountMinor: 0n,
        ratePlanId: stay.ratePlanId,
        ruleVersion: 1,
      },
    });
  }
  let number = 900;
  const fault = (createdAt: Date, roomId = room.id) =>
    db.task.create({
      data: {
        organisationId: h.org.id,
        propertyId: h.p1.id,
        number: ++number,
        type: 'FAULT',
        title: 'AC not cooling',
        departmentId: mnt.id,
        roomId,
        createdAt,
      },
    });
  const list = () => h.ok<List>(h.gm.get('/maintenance/insights'));
  return { ...h, room, fault, list };
}

describe('maintenance insights (T-180)', () => {
  it('finds repeat and reopened faults, and dismisses them until there is a new one', async () => {
    const h = await hotel();
    // Two faults on 101 this month and one two months ago: not yet a repeat.
    await h.fault(at('2026-09-01'));
    await h.fault(at('2026-11-01'));
    const reopened = await h.fault(at('2026-11-05'));
    expect((await h.list()).data).toEqual([]);
    // A third this month, and the one from the 5th was reopened: the fix didn't hold.
    const third = await h.fault(at('2026-11-09'));
    await db.taskEvent.create({
      data: { taskId: reopened.id, kind: 'reopen', at: at('2026-11-08') },
    });

    const { data } = await h.list();
    // Newest evidence first: the reopening (8th) before the repeat (from the 1st).
    expect(data.map((i) => [i.kind, i.subject.label, i.value])).toEqual([
      ['REOPENED_FAULT', `Room 101 (#${reopened.number})`, 1],
      ['REPEAT_FAULTS', 'Room 101', 3],
    ]);
    const repeat = data[1] as Insight;
    expect(repeat).toMatchObject({
      key: `REPEAT_FAULTS:ROOM:${h.room.id}`,
      fingerprint: third.id,
      roomId: h.room.id,
      usual: null,
    });
    expect(repeat.taskIds).toHaveLength(3);

    // Dismissed with a reason: kept, audited and hidden.
    const dismiss = (body: object) => h.gm.post('/maintenance/insights/dismiss', body);
    expect(
      (await dismiss({ key: repeat.key, fingerprint: repeat.fingerprint, reason: 'x' })).status,
    ).toBe(400);
    expect(
      (
        await dismiss({
          key: repeat.key,
          fingerprint: repeat.fingerprint,
          reason: 'Compressor replaced on the 9th',
        })
      ).status,
    ).toBe(201);
    const after = await h.list();
    expect(after.dismissed).toBe(1);
    expect(after.data.map((i) => i.kind)).toEqual(['REOPENED_FAULT']);
    expect(
      await db.insightDismissal.findFirstOrThrow({ where: { key: repeat.key } }),
    ).toMatchObject({ reason: 'Compressor replaced on the 9th', byUserId: h.gmId });
    expect(await db.auditEvent.count({ where: { action: 'insight.dismissed' } })).toBe(1);
    expect(
      errorOf(
        await dismiss({ key: repeat.key, fingerprint: repeat.fingerprint, reason: 'Again please' }),
      ).code,
    ).toBe('NOT_FOUND');

    // A new fault is new evidence: the insight is back.
    now = new Date('2026-11-11T09:00:00Z');
    await h.fault(at('2026-11-11', '08:30:00'));
    const gm = await h.as(h.gmId);
    const back = await h.ok<List>(gm.get('/maintenance/insights'));
    expect(back.data.find((i) => i.kind === 'REPEAT_FAULTS')).toMatchObject({ value: 4 });

    // For those who look after the asset register.
    const hk = await h.person('hk-attendant', h.p1.id);
    expect((await (await h.as(hk.id)).get('/maintenance/insights')).status).toBe(403);
  });

  it('flags a meter whose use per occupied room night is out of pattern three times running', async () => {
    const h = await hotel();
    // GRID: 10 units a day (one room night a day) from 1 to 7 November, then 30 a day.
    // WATER stays steady.
    let grid = 1000n;
    let water = 500n;
    for (let d = '2026-11-01'; d <= TODAY; d = addDays(d, 1)) {
      for (const [meter, reading] of [
        ['GRID', grid],
        ['WATER', water],
      ] as const) {
        await db.meterReading.create({
          data: { propertyId: h.p1.id, meter, reading, byUserId: h.gmId, at: at(d) },
        });
      }
      grid += d >= '2026-11-07' ? 30n : 10n;
      water += 5n;
    }
    const { data } = await h.list();
    expect(data).toEqual([
      expect.objectContaining({
        kind: 'METER_USE',
        key: 'METER_USE:METER:GRID',
        subject: { type: 'METER', id: null, label: 'GRID' },
        // Hundredths of a unit per occupied room night.
        value: 3000,
        usual: 1000,
      }),
    ]);
  });

  it('flags diesel per run-hour above its usual, with overdue servicing first', async () => {
    const h = await hotel();
    const femi = await h.person('maintenance', h.p1.id);
    const asFemi = await h.as(femi.id);
    const asset = await h.ok<{ id: string }>(
      asFemi.send('/assets', { tag: 'GEN-1', name: 'Perkins 60kVA', category: 'Generator' }),
    );
    const gen = await h.ok<{ id: string }>(
      asFemi.send('/generators', {
        assetId: asset.id,
        name: 'Main generator',
        tankLitresMilli: 1_000_000,
      }),
    );
    // Level checks every two days, 10 run-hours between each: 100 litres each time, then 250.
    const checks: [string, number][] = [
      ['2026-11-01', 900_000],
      ['2026-11-03', 800_000],
      ['2026-11-05', 700_000],
      ['2026-11-07', 600_000],
      ['2026-11-09', 350_000],
    ];
    for (const [i, [d, litresMilli]] of checks.entries()) {
      await db.fuelMovement.create({
        data: {
          generatorId: gen.id,
          kind: 'LEVEL_CHECK',
          litresMilli,
          byUserId: femi.id,
          at: at(d),
        },
      });
      if (i < checks.length - 1) {
        await db.generatorRun.create({
          data: {
            generatorId: gen.id,
            startedAt: at(d, '10:00:00'),
            stoppedAt: at(d, '20:00:00'),
            startedById: femi.id,
          },
        });
      }
    }
    await db.preventivePlan.create({
      data: {
        propertyId: h.p1.id,
        title: 'Service the generator',
        assetId: asset.id,
        trigger: 'CALENDAR',
        everyDays: 30,
        nextDueOn: new Date('2026-11-01'),
      },
    });
    // A repeat fault elsewhere comes after it: overdue servicing goes first.
    for (const d of ['2026-11-02', '2026-11-04', '2026-11-06']) await h.fault(at(d));

    const { data } = await h.list();
    expect(data.map((i) => i.kind)).toEqual(['GENERATOR_FUEL', 'REPEAT_FAULTS']);
    expect(data[0]).toMatchObject({
      key: `GENERATOR_FUEL:GENERATOR:${gen.id}`,
      subject: { type: 'GENERATOR', id: gen.id, label: 'Main generator' },
      // Thousandths of a litre per run-hour.
      value: 25_000,
      usual: 10_000,
      overduePlans: 1,
      severity: 'NORMAL',
    });
  });
});
