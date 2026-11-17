import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { DEPARTMENT_TEMPLATES } from '../identity/role-templates.ts';

// Utilities (PRD M5-11 "As maintenance, I log generator start/stop, diesel received and issued,
// and fuel checks"; M5-12 "I record meter readings for electricity, water and gas per shift";
// M5 rule 4 fuel variance; tab 4 row "Utilities"; T-132).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T20:00:00Z');
});

type Run = { id: string; minutes: number; stoppedAt: string | null };
type Fuel = {
  id: string;
  kind: string;
  variance: { varianceMilli: number; varianceBps: number; alerted: boolean } | null;
};
type Generator = {
  id: string;
  running: Run | null;
  minutesToday: number;
  totalMinutes: number;
  lastCheck: { litresMilli: number } | null;
  receivedMilli: number;
  issuedMilli: number;
  expectedMilli: number | null;
  runs: Run[];
  fuel: Fuel[];
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
  const femi = await h.person('maintenance', h.p1.id);
  const attendant = await h.person('hk-attendant', h.p1.id);
  const as = await h.as(femi.id);
  const asset = await h.ok<{ id: string }>(
    as.send('/assets', { tag: 'GEN-1', name: 'Perkins 60kVA', category: 'Generator' }),
  );
  return {
    ...h,
    femiId: femi.id,
    femi: as,
    attendant: await h.as(attendant.id),
    assetId: asset.id,
  };
}

const addGenerator = (h: Awaited<ReturnType<typeof hotel>>) =>
  h.ok<Generator>(
    h.femi.send('/generators', {
      assetId: h.assetId,
      name: 'Main generator',
      tankLitresMilli: 1_000_000,
    }),
  );

describe('generator runs (M5-11)', () => {
  it('logs start and stop, and feeds the run hours to its maintenance plans', async () => {
    const h = await hotel();
    expect((await h.attendant.get('/generators')).status).toBe(403);
    const gen = await addGenerator(h);
    // One generator per asset.
    expect(
      errorOf(
        await h.femi.send('/generators', {
          assetId: h.assetId,
          name: 'Again',
          tankLitresMilli: 1_000_000,
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');

    // Oil change every 250 hours, serviced at 1000, meter now 1230 (20 hours to go).
    const plan = await h.ok<{ id: string; hoursLeft: number; openTask: unknown }>(
      h.femi.send('/preventive-plans', {
        title: 'Change oil',
        assetId: h.assetId,
        trigger: 'RUN_HOURS',
        everyHours: 250,
        lastServiceHours: 1000,
        meterHours: 1230,
        leadHours: 10,
        assigneeId: h.femiId,
      }),
    );
    expect(plan).toMatchObject({ hoursLeft: 20, openTask: null });

    // Started at 10:30 Lagos; not in the future; not twice.
    expect(
      errorOf(await h.femi.send(`/generators/${gen.id}/runs`, { at: '2026-11-10T21:00:00Z' })).code,
    ).toBe('VALIDATION_ERROR');
    const started = await h.ok<Generator>(
      h.femi.send(`/generators/${gen.id}/runs`, { at: '2026-11-10T09:30:00Z' }),
    );
    expect(started.running).toMatchObject({ minutes: 630, stoppedAt: null });
    expect(errorOf(await h.femi.send(`/generators/${gen.id}/runs`, {})).code).toBe(
      'STATE_TRANSITION_INVALID',
    );

    // Stopped now: 10 h 30 min, so the plan's meter moves 10 hours and its job opens.
    const runId = started.running?.id ?? '';
    const stopped = await h.ok<Generator>(h.femi.patch(`/generator-runs/${runId}/stop`, {}));
    expect(stopped).toMatchObject({ running: null, minutesToday: 630, totalMinutes: 630 });
    expect(stopped.runs[0]).toMatchObject({ minutes: 630, stoppedAt: '2026-11-10T20:00:00Z' });
    expect(errorOf(await h.femi.patch(`/generator-runs/${runId}/stop`, {})).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    const after = await db.preventivePlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(after.meterHours).toBe(1240);
    expect(after.openTaskId).not.toBeNull();

    // A second short run crosses no whole hour: the meter stays.
    now = new Date('2026-11-10T20:40:00Z');
    const again = await h.ok<Generator>(h.femi.send(`/generators/${gen.id}/runs`, {}));
    now = new Date('2026-11-10T21:05:00Z');
    await h.ok(h.femi.patch(`/generator-runs/${again.running?.id ?? ''}/stop`, {}));
    expect((await db.preventivePlan.findUniqueOrThrow({ where: { id: plan.id } })).meterHours).toBe(
      1240,
    );
    expect(await db.auditEvent.count({ where: { action: 'generator.stopped' } })).toBe(2);
  });
});

describe('fuel and the variance rule (M5-11, M5 rule 4)', () => {
  it('works out the variance at each check and raises an alert above 5%', async () => {
    const h = await hotel();
    const gen = await addGenerator(h);
    // Each entry a minute after the one before.
    const fuel = (body: object) => {
      now = new Date(now.getTime() + 60_000);
      return h.ok<{ movement: Fuel; generator: Generator }>(
        h.femi.send('/fuel-movements', { generatorId: gen.id, ...body }),
      );
    };

    // The first check sets the opening level.
    const first = await fuel({ kind: 'LEVEL_CHECK', litresMilli: 800_000 });
    expect(first.movement.variance).toBeNull();
    // A delivery with its cost and supplier; issues carry neither.
    await fuel({
      kind: 'RECEIVED',
      litresMilli: 500_000,
      costMinor: '50000000',
      supplier: 'Total Energies',
    });
    expect(
      errorOf(
        await h.femi.send('/fuel-movements', {
          generatorId: gen.id,
          kind: 'ISSUED',
          litresMilli: 1000,
          costMinor: '100',
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    const issued = await fuel({ kind: 'ISSUED', litresMilli: 400_000 });
    expect(issued.generator).toMatchObject({
      receivedMilli: 500_000,
      issuedMilli: 400_000,
      expectedMilli: 900_000,
    });

    // 880 litres against 900 expected: 20 missing of 1,300 (1.5%), no alert.
    const ok = await fuel({ kind: 'LEVEL_CHECK', litresMilli: 880_000 });
    expect(ok.movement.variance).toMatchObject({
      varianceMilli: 20_000,
      varianceBps: 154,
      alerted: false,
    });

    // A check can't read more than the tank holds.
    expect(
      errorOf(
        await h.femi.send('/fuel-movements', {
          generatorId: gen.id,
          kind: 'LEVEL_CHECK',
          litresMilli: 1_200_000,
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');

    // 200 issued, 600 found against 680 expected: 80 missing of 880 (9.1%): an alert.
    await fuel({ kind: 'ISSUED', litresMilli: 200_000 });
    const short = await fuel({ kind: 'LEVEL_CHECK', litresMilli: 600_000 });
    expect(short.movement.variance).toMatchObject({
      varianceMilli: 80_000,
      varianceBps: 909,
      alerted: true,
    });
    expect(short.generator).toMatchObject({
      lastCheck: { litresMilli: 600_000 },
      receivedMilli: 0,
      issuedMilli: 0,
      expectedMilli: 600_000,
    });
    const alert = await db.leakageAlert.findFirstOrThrow({ where: { ruleCode: 'FUEL_VARIANCE' } });
    expect(alert).toMatchObject({ severity: 'NORMAL', entityType: 'generator', entityId: gen.id });
    expect(alert.evidence).toMatchObject({
      generator: 'Main generator',
      missingLitres: '80',
      accountableLitres: '880',
      percent: '9.1',
      since: '2026-11-10',
    });

    // Raised to 10%, the same shortfall passes.
    await db.leakageRule.create({
      data: { propertyId: h.p1.id, code: 'FUEL_VARIANCE', params: { maxPercent: 10 } },
    });
    await fuel({ kind: 'ISSUED', litresMilli: 100_000 });
    const again = await fuel({ kind: 'LEVEL_CHECK', litresMilli: 450_000 });
    expect(again.movement.variance).toMatchObject({ varianceMilli: 50_000, alerted: false });
    expect(await db.leakageAlert.count({ where: { ruleCode: 'FUEL_VARIANCE' } })).toBe(1);

    const detail = await h.ok<Generator>(h.femi.get(`/generators/${gen.id}`));
    expect(detail.fuel.map((m) => [m.kind, m.variance?.alerted ?? null])).toEqual([
      ['LEVEL_CHECK', false],
      ['ISSUED', null],
      ['LEVEL_CHECK', true],
      ['ISSUED', null],
      ['LEVEL_CHECK', false],
      ['ISSUED', null],
      ['RECEIVED', null],
      ['LEVEL_CHECK', null],
    ]);
  });
});

describe('meter readings (M5-12)', () => {
  it('records readings that only go up, with the usage between them', async () => {
    const h = await hotel();
    type Reading = { meter: string; reading: string; usage: string | null };
    await h.ok(
      h.femi.send('/meter-readings', {
        meter: 'GRID',
        reading: '10500',
        at: '2026-11-10T08:00:00Z',
      }),
    );
    expect(
      errorOf(await h.femi.send('/meter-readings', { meter: 'grid', reading: '10380' })).code,
    ).toBe('VALIDATION_ERROR');
    const second = await h.ok<Reading>(
      h.femi.send('/meter-readings', { meter: 'grid', reading: '10620' }),
    );
    expect(second).toMatchObject({ meter: 'GRID', reading: '10620', usage: '120' });
    now = new Date('2026-11-10T20:05:00Z');
    await h.ok(h.femi.send('/meter-readings', { meter: 'Borehole pump', reading: '77' }));
    expect((await h.attendant.send('/meter-readings', { meter: 'GAS', reading: '1' })).status).toBe(
      403,
    );

    const list = await h.ok<{ data: Reading[]; meters: string[] }>(h.femi.get('/meter-readings'));
    expect(list.meters).toEqual(['GRID', 'WATER', 'GAS', 'BOREHOLE_PUMP']);
    expect(list.data.map((r) => [r.meter, r.reading, r.usage])).toEqual([
      ['BOREHOLE_PUMP', '77', null],
      ['GRID', '10620', '120'],
      ['GRID', '10500', null],
    ]);
    const grid = await h.ok<{ data: Reading[] }>(h.femi.get('/meter-readings?meter=GRID'));
    expect(grid.data).toHaveLength(2);
  });
});
