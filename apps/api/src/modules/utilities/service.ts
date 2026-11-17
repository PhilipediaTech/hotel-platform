import {
  fuelVariance,
  localDate,
  STANDARD_METERS,
  zonedInstant,
  type FuelKind,
  type FuelMovementBody,
  type FuelMovementItem,
  type GeneratorBody,
  type GeneratorDetail,
  type GeneratorItem,
  type GeneratorRunItem,
  type MeterReadingBody,
  type MeterReadingItem,
} from '@hotel/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { numberParam, raiseAlert, ruleSettings } from '../leakage/engine.ts';
import { syncPlan } from '../maintenance/preventive.ts';

// Utilities (PRD M5-11, M5-12, M5 rule 4; tab 3 generators, generator_runs, fuel_movements,
// meter_readings; S35; T-132). Generators are assets of the register with a diesel tank. Runs
// are logged start and stop (one open at a time); a stop puts the run's hours on the
// generator's run-hours maintenance plans (M5-10). Fuel is received into the tank and issued
// from it; a level check works out the variance since the check before (opening + received −
// issued − closing) and raises FUEL_VARIANCE when the fuel missing is over the threshold
// (5% of the fuel to account for, by default). Meter readings only go up.

export interface UtilitiesDeps {
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;

const PERSON = { select: { id: true, name: true } } as const;
const GENERATOR_INCLUDE = {
  asset: { select: { id: true, tag: true, name: true } },
  runs: {
    include: { startedBy: PERSON, stoppedBy: PERSON },
    orderBy: { startedAt: 'desc' },
  },
  fuelMovements: { include: { byUser: PERSON }, orderBy: [{ at: 'asc' }, { id: 'asc' }] },
} as const satisfies Prisma.GeneratorInclude;
type GeneratorRow = Prisma.GeneratorGetPayload<{ include: typeof GENERATOR_INCLUDE }>;
type RunRow = GeneratorRow['runs'][number];
type FuelRow = GeneratorRow['fuelMovements'][number];

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const DAY_MS = 86_400_000;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

/** An optional instant: now, or up to a day back, never in the future. */
function whenOf(at: string | undefined, now: Date): Date {
  if (!at) return now;
  const when = new Date(at);
  if (when.getTime() > now.getTime() + 60_000) throw invalid('at', 'That time is in the future');
  if (now.getTime() - when.getTime() > DAY_MS) {
    throw invalid('at', 'Log it within a day; older entries need a note to the manager');
  }
  return when;
}

async function timeZoneOf(db: Client, propertyId: string) {
  const rows = await db.$queryRaw<{ time_zone: string }[]>`
    SELECT time_zone FROM properties WHERE id = ${propertyId}::uuid`;
  return rows[0]?.time_zone ?? 'Africa/Lagos';
}

// ── Reading a generator ────────────────────────────────────────────────────────────────

const minutesBetween = (from: Date, to: Date) =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));

function runItem(r: RunRow, now: Date): z.input<typeof GeneratorRunItem> {
  return {
    id: r.id,
    startedAt: iso(r.startedAt),
    stoppedAt: r.stoppedAt ? iso(r.stoppedAt) : null,
    startedBy: r.startedBy,
    stoppedBy: r.stoppedBy,
    minutes: minutesBetween(r.startedAt, r.stoppedAt ?? now),
  };
}

/** Variance of each level check after the first: id → variance. */
function variancesOf(fuel: FuelRow[]) {
  const out = new Map<string, ReturnType<typeof fuelVariance>>();
  let opening: number | null = null;
  let received = 0;
  let issued = 0;
  for (const m of fuel) {
    if (m.kind === 'RECEIVED') received += m.litresMilli;
    else if (m.kind === 'ISSUED') issued += m.litresMilli;
    else {
      if (opening !== null) out.set(m.id, fuelVariance(opening, received, issued, m.litresMilli));
      opening = m.litresMilli;
      received = 0;
      issued = 0;
    }
  }
  return { variances: out, opening, received, issued };
}

function generatorItem(g: GeneratorRow, now: Date, dayStart: Date): z.input<typeof GeneratorItem> {
  const open = g.runs.find((r) => r.stoppedAt === null);
  const { opening, received, issued } = variancesOf(g.fuelMovements);
  const lastCheck = [...g.fuelMovements].reverse().find((m) => m.kind === 'LEVEL_CHECK');
  let total = 0;
  let today = 0;
  for (const r of g.runs) {
    const end = r.stoppedAt ?? now;
    total += minutesBetween(r.startedAt, end);
    if (end > dayStart) {
      today += minutesBetween(r.startedAt > dayStart ? r.startedAt : dayStart, end);
    }
  }
  return {
    id: g.id,
    name: g.name,
    asset: g.asset,
    tankLitresMilli: g.tankLitresMilli,
    serviceEveryMinutes: g.serviceEveryMinutes,
    running: open ? runItem(open, now) : null,
    minutesToday: today,
    totalMinutes: total,
    lastCheck: lastCheck ? { litresMilli: lastCheck.litresMilli, at: iso(lastCheck.at) } : null,
    receivedMilli: received,
    issuedMilli: issued,
    expectedMilli: opening === null ? null : opening + received - issued,
  };
}

async function alertedOf(db: Client, propertyId: string, ids: string[]) {
  if (ids.length === 0) return new Set<string>();
  const rows = await db.leakageAlert.findMany({
    where: { propertyId, dedupeKey: { in: ids.map((id) => `FUEL_VARIANCE:${id}`) } },
    select: { dedupeKey: true },
  });
  return new Set(rows.map((r) => r.dedupeKey.slice('FUEL_VARIANCE:'.length)));
}

function fuelItem(
  m: FuelRow,
  variance: ReturnType<typeof fuelVariance> | undefined,
  alerted: Set<string>,
): z.input<typeof FuelMovementItem> {
  return {
    id: m.id,
    kind: m.kind as FuelKind,
    litresMilli: m.litresMilli,
    costMinor: m.costMinor?.toString() ?? null,
    supplier: m.supplier,
    by: m.byUser,
    at: iso(m.at),
    variance: variance ? { ...variance, alerted: alerted.has(m.id) } : null,
  };
}

async function loadGenerator(db: Client, generatorId: string) {
  const g = await db.generator.findFirst({
    where: { id: generatorId },
    include: GENERATOR_INCLUDE,
  });
  if (!g) throw new AppError('NOT_FOUND', 'Generator not found.');
  return g;
}

async function dayStartOf(db: Client, propertyId: string, now: Date) {
  const zone = await timeZoneOf(db, propertyId);
  return zonedInstant(localDate(now, zone), '00:00', zone);
}

async function detailOf(
  db: Client,
  tenant: TenantContext,
  clock: Clock,
  generatorId: string,
): Promise<z.input<typeof GeneratorDetail>> {
  const g = await loadGenerator(db, generatorId);
  const now = clock();
  const { variances } = variancesOf(g.fuelMovements);
  const latest = [...g.fuelMovements].reverse().slice(0, 50);
  const alerted = await alertedOf(
    db,
    tenant.propertyId,
    latest.filter((m) => variances.has(m.id)).map((m) => m.id),
  );
  return {
    ...generatorItem(g, now, await dayStartOf(db, tenant.propertyId, now)),
    runs: g.runs.slice(0, 50).map((r) => runItem(r, now)),
    fuel: latest.map((m) => fuelItem(m, variances.get(m.id), alerted)),
  };
}

export async function listGenerators(deps: UtilitiesDeps, tenant: TenantContext) {
  const rows = await deps.tenantDb.generator.findMany({
    include: GENERATOR_INCLUDE,
    orderBy: { name: 'asc' },
  });
  const now = deps.clock();
  const dayStart = await dayStartOf(deps.tenantDb, tenant.propertyId, now);
  return { data: rows.map((g) => generatorItem(g, now, dayStart)) };
}

export function getGenerator(deps: UtilitiesDeps, tenant: TenantContext, generatorId: string) {
  return detailOf(deps.tenantDb, tenant, deps.clock, generatorId);
}

export async function createGenerator(
  deps: UtilitiesDeps,
  tenant: TenantContext,
  body: z.output<typeof GeneratorBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const asset = await tx.asset.findFirst({ where: { id: body.assetId } });
    if (!asset) throw invalid('assetId', 'Choose an asset of this property');
    if (asset.status === 'RETIRED') throw invalid('assetId', 'This asset is retired');
    if (await tx.generator.findFirst({ where: { assetId: body.assetId } })) {
      throw invalid('assetId', 'This asset is already a generator');
    }
    const g = await tx.generator.create({
      data: body as unknown as Prisma.GeneratorUncheckedCreateInput, // tenant IDs come from the client
    });
    await recordAudit(tx, {
      action: 'generator.created',
      entityType: 'generator',
      entityId: g.id,
      after: { ...body },
    });
    return detailOf(tx, tenant, deps.clock, g.id);
  });
}

// ── Runs ───────────────────────────────────────────────────────────────────────────────

const lockGenerator = (tx: Tx, generatorId: string) =>
  tx.$queryRaw`SELECT id FROM generators WHERE id = ${generatorId}::uuid FOR UPDATE`;

export async function startRun(
  deps: UtilitiesDeps,
  tenant: TenantContext,
  generatorId: string,
  body: { at?: string | undefined },
) {
  const now = deps.clock();
  const at = whenOf(body.at, now);
  return deps.tenantDb.$transaction(async (tx) => {
    const g = await tx.generator.findFirst({ where: { id: generatorId } });
    if (!g) throw new AppError('NOT_FOUND', 'Generator not found.');
    await lockGenerator(tx, generatorId);
    const runs = await tx.generator.findFirstOrThrow({
      where: { id: generatorId },
      select: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    const last = runs.runs[0];
    if (last && !last.stoppedAt) {
      throw new AppError('STATE_TRANSITION_INVALID', `${g.name} is already running.`, {
        runId: last.id,
      });
    }
    if (last?.stoppedAt && at < last.stoppedAt) {
      throw invalid('at', 'It was still running then: start after the last stop');
    }
    await tx.generator.update({
      where: { id: generatorId },
      data: { runs: { create: { startedAt: at, startedById: tenant.userId } } },
    });
    await recordAudit(tx, {
      action: 'generator.started',
      entityType: 'generator',
      entityId: generatorId,
      after: { startedAt: iso(at) },
    });
    return detailOf(tx, tenant, deps.clock, generatorId);
  });
}

/** Completed run minutes of a generator. */
async function completedMinutes(tx: Tx, generatorId: string) {
  const g = await tx.generator.findFirstOrThrow({
    where: { id: generatorId },
    select: { runs: { where: { stoppedAt: { not: null } } } },
  });
  return g.runs.reduce((s, r) => s + minutesBetween(r.startedAt, r.stoppedAt ?? r.startedAt), 0);
}

/**
 * M5-10 and M5-11 together: a stop moves the hour meter of the generator's run-hours plans on
 * by the whole hours it crossed, and each plan may open its job.
 */
async function feedPlans(
  tx: Tx,
  tenant: TenantContext,
  clock: Clock,
  generator: { id: string; assetId: string },
  before: number,
  after: number,
) {
  const hours = Math.floor(after / 60) - Math.floor(before / 60);
  if (hours <= 0) return;
  const plans = await tx.preventivePlan.findMany({
    where: { assetId: generator.assetId, trigger: 'RUN_HOURS', meterHours: { not: null } },
  });
  for (const p of plans) {
    const meterHours = (p.meterHours ?? 0) + hours;
    await tx.preventivePlan.update({
      where: { id: p.id },
      data: { meterHours, meterReadAt: clock() },
    });
    await recordAudit(tx, {
      action: 'preventive_plan.hours_read',
      entityType: 'preventive_plan',
      entityId: p.id,
      before: { meterHours: p.meterHours },
      after: { meterHours, fromGeneratorRuns: generator.id },
    });
    await syncPlan(tx, tenant.propertyId, p.id, clock);
  }
}

export async function stopRun(
  deps: UtilitiesDeps,
  tenant: TenantContext,
  runId: string,
  body: { at?: string | undefined },
) {
  const now = deps.clock();
  const at = whenOf(body.at, now);
  return deps.tenantDb.$transaction(async (tx) => {
    // Runs have no property column: find the run through this property's generators.
    const g = await tx.generator.findFirst({
      where: { runs: { some: { id: runId } } },
      select: { id: true, assetId: true, name: true },
    });
    if (!g) throw new AppError('NOT_FOUND', 'Run not found.');
    await lockGenerator(tx, g.id);
    const { runs } = await tx.generator.findFirstOrThrow({
      where: { id: g.id },
      select: { runs: { where: { id: runId } } },
    });
    const run = runs[0];
    if (!run) throw new AppError('NOT_FOUND', 'Run not found.');
    if (run.stoppedAt) {
      throw new AppError('STATE_TRANSITION_INVALID', 'This run was already stopped.');
    }
    if (at < run.startedAt) throw invalid('at', 'The stop is before the start');
    const before = await completedMinutes(tx, g.id);
    await tx.generator.update({
      where: { id: g.id },
      data: {
        runs: {
          update: { where: { id: runId }, data: { stoppedAt: at, stoppedById: tenant.userId } },
        },
      },
    });
    const minutes = minutesBetween(run.startedAt, at);
    await recordAudit(tx, {
      action: 'generator.stopped',
      entityType: 'generator',
      entityId: g.id,
      after: { runId, startedAt: iso(run.startedAt), stoppedAt: iso(at), minutes },
    });
    await feedPlans(tx, tenant, deps.clock, g, before, before + minutes);
    return detailOf(tx, tenant, deps.clock, g.id);
  });
}

// ── Fuel ───────────────────────────────────────────────────────────────────────────────

const litres = (milli: number) =>
  (milli / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 });

export async function recordFuel(
  deps: UtilitiesDeps,
  tenant: TenantContext,
  body: z.output<typeof FuelMovementBody>,
) {
  const now = deps.clock();
  const at = whenOf(body.at, now);
  return deps.tenantDb.$transaction(async (tx) => {
    const g = await tx.generator.findFirst({ where: { id: body.generatorId } });
    if (!g) throw invalid('generatorId', 'Choose a generator of this property');
    await lockGenerator(tx, g.id);
    if (body.kind === 'LEVEL_CHECK' && body.litresMilli > g.tankLitresMilli) {
      throw invalid('litresMilli', `The tank holds ${litres(g.tankLitresMilli)} litres`);
    }
    // Movements have no property column: written through their (scoped) generator.
    const created = { id: randomUUID() };
    await tx.generator.update({
      where: { id: g.id },
      data: {
        fuelMovements: {
          create: {
            id: created.id,
            kind: body.kind,
            litresMilli: body.litresMilli,
            costMinor: body.costMinor === null ? null : BigInt(body.costMinor),
            supplier: body.supplier,
            byUserId: tenant.userId,
            at,
          },
        },
      },
    });
    const full = await loadGenerator(tx, g.id);
    const { variances } = variancesOf(full.fuelMovements);
    const variance = variances.get(created.id);
    if (variance) {
      const settings = await ruleSettings(tx, tenant.propertyId, 'FUEL_VARIANCE');
      const limitBps = numberParam(settings, 'maxPercent') * 100;
      if (variance.varianceMilli > 0 && variance.varianceBps > limitBps) {
        const index = full.fuelMovements.findIndex((m) => m.id === created.id);
        const previous = full.fuelMovements
          .slice(0, index)
          .reverse()
          .find((m) => m.kind === 'LEVEL_CHECK');
        const zone = await timeZoneOf(tx, tenant.propertyId);
        await raiseAlert(tx, {
          propertyId: tenant.propertyId,
          ruleCode: 'FUEL_VARIANCE',
          businessDate: localDate(at, zone),
          severity: variance.varianceBps > 2 * limitBps ? 'HIGH' : 'NORMAL',
          entityType: 'generator',
          entityId: g.id,
          subjectUserId: null,
          evidence: {
            generator: g.name,
            checkId: created.id,
            since: previous ? localDate(previous.at, zone) : null,
            openingLitres: litres(variance.openingMilli),
            receivedLitres: litres(variance.receivedMilli),
            issuedLitres: litres(variance.issuedMilli),
            closingLitres: litres(variance.closingMilli),
            missingLitres: litres(variance.varianceMilli),
            accountableLitres: litres(variance.accountableMilli),
            percent: (variance.varianceBps / 100).toFixed(1),
            checkedById: tenant.userId,
          },
          dedupeKey: `FUEL_VARIANCE:${created.id}`,
          settings,
          event: { generatorId: g.id },
        });
      }
    }
    await recordAudit(tx, {
      action: 'fuel.logged',
      entityType: 'generator',
      entityId: g.id,
      after: {
        movementId: created.id,
        kind: body.kind,
        litresMilli: body.litresMilli,
        costMinor: body.costMinor,
        supplier: body.supplier,
        at: iso(at),
        ...(variance ? { varianceMilli: variance.varianceMilli } : {}),
      },
    });
    const alerted = await alertedOf(tx, tenant.propertyId, variance ? [created.id] : []);
    const row = full.fuelMovements.find((m) => m.id === created.id);
    if (!row) throw new Error('Fuel movement missing after insert');
    return {
      movement: fuelItem(row, variance, alerted),
      generator: generatorItem(full, now, await dayStartOf(tx, tenant.propertyId, now)),
    };
  });
}

// ── Meters ─────────────────────────────────────────────────────────────────────────────

type ReadingRow = Prisma.MeterReadingGetPayload<{ include: { byUser: typeof PERSON } }>;

function readingItems(rows: ReadingRow[]): z.input<typeof MeterReadingItem>[] {
  // rows newest first; each reading's usage is against the next older one of its meter.
  return rows.map((r, i) => {
    const previous = rows.slice(i + 1).find((p) => p.meter === r.meter);
    return {
      id: r.id,
      meter: r.meter,
      reading: r.reading.toString(),
      usage: previous ? (r.reading - previous.reading).toString() : null,
      hoursSincePrevious: previous
        ? Math.round((r.at.getTime() - previous.at.getTime()) / 360_000) / 10
        : null,
      by: r.byUser,
      at: iso(r.at),
    };
  });
}

export async function listReadings(
  deps: UtilitiesDeps,
  _tenant: TenantContext,
  query: { meter?: string | undefined },
) {
  const [rows, used] = await Promise.all([
    deps.tenantDb.meterReading.findMany({
      where: query.meter ? { meter: query.meter } : {},
      include: { byUser: PERSON },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 200,
    }),
    deps.tenantDb.meterReading.findMany({ distinct: ['meter'], select: { meter: true } }),
  ]);
  const meters = [
    ...STANDARD_METERS,
    ...used.map((u) => u.meter).filter((m) => !(STANDARD_METERS as readonly string[]).includes(m)),
  ];
  return { data: readingItems(rows).slice(0, 100), meters: [...new Set(meters)] };
}

export async function recordReading(
  deps: UtilitiesDeps,
  tenant: TenantContext,
  body: z.output<typeof MeterReadingBody>,
) {
  const now = deps.clock();
  const at = whenOf(body.at, now);
  const reading = BigInt(body.reading);
  return deps.tenantDb.$transaction(async (tx) => {
    const lock = `meter:${tenant.propertyId}:${body.meter}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lock}))::text AS locked`;
    const [before, after] = await Promise.all([
      tx.meterReading.findFirst({
        where: { meter: body.meter, at: { lte: at } },
        orderBy: { at: 'desc' },
      }),
      tx.meterReading.findFirst({
        where: { meter: body.meter, at: { gt: at } },
        orderBy: { at: 'asc' },
      }),
    ]);
    if (before && reading < before.reading) {
      throw invalid(
        'reading',
        `The meter read ${before.reading.toString()} before; it only goes up`,
      );
    }
    if (after && reading > after.reading) {
      throw invalid(
        'reading',
        `A later reading is ${after.reading.toString()}; this cannot be more`,
      );
    }
    const created = await tx.meterReading.create({
      data: {
        meter: body.meter,
        reading,
        byUserId: tenant.userId,
        at,
      } as unknown as Prisma.MeterReadingUncheckedCreateInput, // tenant IDs come from the client
      include: { byUser: PERSON },
    });
    await recordAudit(tx, {
      action: 'meter.read',
      entityType: 'meter_reading',
      entityId: created.id,
      after: { meter: body.meter, reading: body.reading, at: iso(at) },
    });
    const rows = before
      ? [created, { ...before, byUser: { id: before.byUserId, name: '' } }]
      : [created];
    const [item] = readingItems(rows);
    if (!item) throw new Error('Reading missing after insert');
    return item;
  });
}
