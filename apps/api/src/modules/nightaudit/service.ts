import {
  localDate,
  NIGHT_AUDIT_STEPS,
  type STEP_STATUSES,
  type NightAuditBody,
  type NightAuditException,
  type NightAuditItem,
} from '@hotel/shared';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDay } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { postPackageNight, postRoomNight, PostingProblem } from './room-charges.ts';

// Night audit (PRD M4 rule 8 and its acceptance criteria; tab 4 POST /night-audits ●, GET
// /night-audits/{id}, POST /night-audits/{id}/resume ●; open issue 14; T-073). A run walks
// the ten steps from its current step. Every step is idempotent, so a rerun or a resumed run
// does no work twice: a step with blocking exceptions (or an error) stops the run as FAILED at
// that step, and resume starts again there. Steps 1–3 only look; from step 4 the day is
// AUDITING (the desk's postings wait) until step 10 closes it and opens the next.
// T-073a: steps 1–5 and 10; steps 6–9 (no-show fees, rate lock, leakage, reports) are T-073b.

export interface NightAuditDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
  logger?: Logger;
}

type Exception = z.input<typeof NightAuditException>;
type Result = Record<string, string | number>;
interface Outcome {
  exceptions: Exception[];
  result: Result;
  skipped?: boolean;
}
interface Env {
  deps: NightAuditDeps;
  tenant: TenantContext;
  runId: string;
  date: string;
}

/** Test seam: throws at a named point to simulate a crash ("step:6", "posting:2"). */
export const nightAuditFaults: { at: ((point: string) => void) | null } = { at: null };
const fault = (point: string) => nightAuditFaults.at?.(point);

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const nextDate = (date: string) => day(new Date(dbDate(date).getTime() + 86_400_000));
const guestName = (g: { firstName: string; lastName: string }) =>
  `${g.firstName} ${g.lastName}`.trim();

// ── Steps ───────────────────────────────────────────────────────────────────────────────

/** Step 1: every cashier has closed (counted) their shift. */
async function openShifts({ deps }: Env): Promise<Outcome> {
  const shifts = await deps.tenantDb.cashierShift.findMany({
    where: { status: { in: ['OPEN', 'CLOSING'] }, userId: { not: null } },
    include: { user: true },
    orderBy: { openedAt: 'asc' },
  });
  const exceptions: Exception[] = shifts.map((s) => {
    const who = s.user?.name ?? 'A cashier';
    return s.status === 'OPEN'
      ? {
          type: 'SHIFT_OPEN',
          blocking: true,
          message: `${who}’s shift is still open: close it with a count`,
          shiftId: s.id,
          subject: who,
        }
      : {
          type: 'SHIFT_SIGN_OFF',
          blocking: false,
          message: `${who}’s shift is counted and waits for a supervisor’s sign-off`,
          shiftId: s.id,
          subject: who,
        };
  });
  return { exceptions, result: { openShifts: shifts.filter((s) => s.status === 'OPEN').length } };
}

/** Step 2: guests who have not arrived (listed for step 6) and guests past their departure. */
async function arrivalsAndDepartures({ deps, date }: Env): Promise<Outcome> {
  const on = dbDate(date);
  const [unarrived, overdue] = await Promise.all([
    deps.tenantDb.stay.findMany({
      where: { status: { in: ['CONFIRMED', 'TENTATIVE'] }, arrival: { lte: on } },
      include: { guest: true, reservation: true },
      orderBy: { arrival: 'asc' },
    }),
    deps.tenantDb.stay.findMany({
      where: {
        status: 'CHECKED_IN',
        OR: [
          { isDayUse: false, departure: { lte: on } },
          { isDayUse: true, arrival: { lte: on } },
        ],
      },
      include: { guest: true, room: true },
    }),
  ]);
  const exceptions: Exception[] = [
    ...overdue.map((s) => ({
      type: 'DUE_OUT',
      blocking: true,
      message: s.isDayUse
        ? `${guestName(s.guest)} is still in day-use room ${s.room?.number ?? ''}: end the day-use`
        : `${guestName(s.guest)} was due out on ${day(s.departure)}: check them out or extend the stay`,
      stayId: s.id,
      ...(s.folioId ? { folioId: s.folioId } : {}),
      ...(s.roomId ? { roomId: s.roomId } : {}),
      subject: guestName(s.guest),
    })),
    ...unarrived.map((s) => ({
      type: 'UNARRIVED',
      blocking: false,
      message: `${guestName(s.guest)} (${s.reservation.confirmationNo}) has not arrived: check them in, cancel, or leave them to the no-show step`,
      stayId: s.id,
      reservationId: s.reservationId,
      subject: guestName(s.guest),
    })),
  ];
  return { exceptions, result: { unarrived: unarrived.length, dueOut: overdue.length } };
}

/** In-house overnight stays for the night of `date`. */
function inHouse(deps: NightAuditDeps, date: string) {
  const on = dbDate(date);
  return deps.tenantDb.stay.findMany({
    where: {
      status: 'CHECKED_IN',
      isDayUse: false,
      arrival: { lte: on },
      departure: { gt: on },
    },
    include: { guest: true, room: true },
    orderBy: [{ room: { number: 'asc' } }, { id: 'asc' }],
  });
}

/**
 * Step 3: the front office's occupied rooms against housekeeping. Until room status reports
 * arrive with housekeeping, the room's own status and blocks are what housekeeping says.
 */
async function roomStatus({ deps, date }: Env): Promise<Outcome> {
  const on = dbDate(date);
  const stays = await inHouse(deps, date);
  const blocks = await deps.tenantDb.roomBlock.findMany({
    where: {
      releasedAt: null,
      startDate: { lte: on },
      endDate: { gt: on },
      roomId: { in: stays.flatMap((s) => (s.roomId ? [s.roomId] : [])) },
    },
  });
  const exceptions: Exception[] = [];
  for (const s of stays) {
    const room = s.room;
    if (!room) continue;
    const blocked = blocks.find((b) => b.roomId === room.id);
    if (room.hkStatus === 'OUT_OF_ORDER' || room.hkStatus === 'OUT_OF_SERVICE' || blocked) {
      const kind = (blocked?.kind ?? room.hkStatus).toLowerCase().replaceAll('_', ' ');
      exceptions.push({
        type: 'ROOM_STATUS_MISMATCH',
        blocking: false,
        message: `Room ${room.number} is ${kind} but ${guestName(s.guest)} is in house`,
        roomId: room.id,
        stayId: s.id,
        subject: `Room ${room.number}`,
      });
    }
  }
  return { exceptions, result: { occupied: stays.length, discrepancies: exceptions.length } };
}

/** Day-use stays of `date` (checked in or out): posted at check-in; posted here if not. */
function dayUses(deps: NightAuditDeps, date: string) {
  return deps.tenantDb.stay.findMany({
    where: {
      isDayUse: true,
      status: { in: ['CHECKED_IN', 'CHECKED_OUT'] },
      arrival: dbDate(date),
      roomCharges: { none: {} },
    },
    include: { guest: true, room: true },
  });
}

type Poster = typeof postRoomNight | typeof postPackageNight;

/** Posts one night per stay, each in its own transaction; problems become exceptions. */
async function postEach(
  env: Env,
  stays: {
    id: string;
    arrival: Date;
    isDayUse: boolean;
    guest: { firstName: string; lastName: string };
    folioId: string | null;
  }[],
  post: Poster,
) {
  const { deps, tenant, date } = env;
  const exceptions: Exception[] = [];
  let posted = 0;
  let amount = 0n;
  for (const [i, s] of stays.entries()) {
    const night = s.isDayUse ? day(s.arrival) : date;
    try {
      const done = await deps.tenantDb.$transaction(async (tx) => {
        const now = deps.clock();
        return post(
          { tx, tenant, approvalRequestId: null, now },
          { stayId: s.id, night, businessDate: date, clock: deps.clock },
        );
      });
      if (typeof done === 'number') posted += done;
      else if (done.posted) {
        posted += 1;
        amount += done.amountMinor;
      }
    } catch (err) {
      if (!(err instanceof PostingProblem)) throw err;
      exceptions.push({
        type: err.type,
        blocking: true,
        message: `${guestName(s.guest)}: ${err.message}`,
        stayId: s.id,
        ...(s.folioId ? { folioId: s.folioId } : {}),
        subject: guestName(s.guest),
      });
    }
    fault(`posting:${i + 1}`);
  }
  return { exceptions, posted, amount };
}

/** Step 4: room and tax for every in-house stay (once per night: room_charge_postings). */
async function roomAndTax(env: Env): Promise<Outcome> {
  const { deps, date } = env;
  // From here the day is being audited: the desk's postings wait until it closes.
  await deps.tenantDb.businessDay.updateMany({
    where: { date: dbDate(date), status: 'OPEN' },
    data: { status: 'AUDITING' },
  });
  const stays = [...(await inHouse(deps, date)), ...(await dayUses(deps, date))];
  const { exceptions, posted, amount } = await postEach(env, stays, postRoomNight);
  const nights = await deps.tenantDb.roomChargePosting.count({
    where: { businessDate: dbDate(date) },
  });
  return {
    exceptions,
    result: {
      stays: stays.length,
      postedNow: posted,
      postedTotal: nights,
      roomRevenueNowMinor: amount.toString(),
    },
  };
}

/** Step 5: package components for in-house stays on package plans. No fixed charges yet. */
async function packages(env: Env): Promise<Outcome> {
  const { deps, date } = env;
  const stays = (await inHouse(deps, date)).filter((s) => s.ratePlanId);
  const plans = await deps.tenantDb.ratePlan.findMany({
    where: { id: { in: [...new Set(stays.map((s) => s.ratePlanId))] }, kind: 'PACKAGE' },
    select: { id: true },
  });
  const packaged = stays.filter((s) => plans.some((p) => p.id === s.ratePlanId));
  const { exceptions, posted } = await postEach(env, packaged, postPackageNight);
  return { exceptions, result: { packageStays: packaged.length, linesPosted: posted } };
}

/** Steps 6–9 come with T-073b. */
function later(): Promise<Outcome> {
  return Promise.resolve({ exceptions: [], result: { note: 'Comes with T-073b' }, skipped: true });
}

/** Step 10: close the day and open the next (idempotent: a closed day stays closed). */
async function closeDay({ deps, tenant, date }: Env): Promise<Outcome> {
  const now = deps.clock();
  const closed = await deps.tenantDb.$transaction(async (tx) => {
    const rows = await tx.businessDay.updateMany({
      where: { date: dbDate(date), status: { not: 'CLOSED' } },
      data: { status: 'CLOSED', closedAt: now, closedById: tenant.userId },
    });
    if (rows.count === 0) return false;
    await tx.$executeRaw`
      INSERT INTO business_days (property_id, date, status, opened_at)
      VALUES (${tenant.propertyId}::uuid, ${nextDate(date)}::date, 'OPEN', ${now})
      ON CONFLICT DO NOTHING`;
    await recordAudit(tx, {
      action: 'business_day.closed',
      entityType: 'business_day',
      entityId: date,
      after: { closed: date, opened: nextDate(date) },
    });
    await recordEvent(tx, {
      type: 'business_day.closed',
      payload: { businessDate: date, nextBusinessDate: nextDate(date) },
    });
    return true;
  });
  return {
    exceptions: [],
    result: { closed: date, opened: nextDate(date), closedNow: closed ? 1 : 0 },
  };
}

const STEP_WORK: Record<number, (env: Env) => Promise<Outcome>> = {
  1: openShifts,
  2: arrivalsAndDepartures,
  3: roomStatus,
  4: roomAndTax,
  5: packages,
  6: later,
  7: later,
  8: later,
  9: later,
  10: closeDay,
};

// ── Runs ────────────────────────────────────────────────────────────────────────────────

const RUN = {
  startedBy: { select: { name: true } },
  steps: { orderBy: { step: 'asc' } },
} as const satisfies Prisma.NightAuditRunInclude;

async function loadRun(deps: NightAuditDeps, id: string) {
  const run = await deps.tenantDb.nightAuditRun.findUnique({ where: { id }, include: RUN });
  if (!run) throw new AppError('NOT_FOUND', 'Night audit not found');
  return run;
}

function runItem(run: Awaited<ReturnType<typeof loadRun>>): z.input<typeof NightAuditItem> {
  return {
    id: run.id,
    businessDate: day(run.businessDate),
    status: run.status,
    currentStep: run.currentStep,
    startedBy: run.startedBy?.name ?? null,
    startedAt: iso(run.startedAt),
    finishedAt: run.finishedAt ? iso(run.finishedAt) : null,
    error: run.error,
    steps: run.steps.map((s) => ({
      step: s.step,
      name: s.name,
      status: s.status as (typeof STEP_STATUSES)[number],
      exceptions: s.exceptions as Exception[],
      result: s.result as Result,
      startedAt: s.startedAt ? iso(s.startedAt) : null,
      finishedAt: s.finishedAt ? iso(s.finishedAt) : null,
    })),
  };
}

/** Walks the run from its current step until it completes or a step stops it. */
async function execute(deps: NightAuditDeps, tenant: TenantContext, runId: string) {
  const run = await loadRun(deps, runId);
  const env: Env = { deps, tenant, runId, date: day(run.businessDate) };
  for (let step = run.currentStep; step <= 10; step += 1) {
    const where = { runId_step: { runId, step } };
    await deps.tenantDb.nightAuditRun.update({
      where: { id: runId },
      data: {
        status: 'RUNNING',
        currentStep: step,
        error: null,
        steps: { update: { where, data: { startedAt: deps.clock(), finishedAt: null } } },
      },
    });
    let outcome: Outcome;
    try {
      fault(`step:${step}`);
      const work = STEP_WORK[step];
      if (!work) throw new Error(`No work for step ${step}`);
      outcome = await work(env);
    } catch (err) {
      const message =
        err instanceof AppError ? err.message : `Step ${step} stopped on an unexpected error`;
      if (!(err instanceof AppError)) {
        deps.logger?.error({ runId, step, db: pgErrorInfo(err) }, 'night audit step failed');
      }
      await deps.tenantDb.nightAuditRun.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          error: `${message}. Resume to try step ${step} again.`,
          steps: {
            update: {
              where,
              data: {
                status: 'FAILED',
                exceptions: [{ type: 'ERROR', blocking: true, message }] as Prisma.InputJsonValue,
                finishedAt: deps.clock(),
              },
            },
          },
        },
      });
      return;
    }
    const blocked = outcome.exceptions.some((e) => e.blocking);
    await deps.tenantDb.nightAuditRun.update({
      where: { id: runId },
      data: {
        ...(blocked
          ? {
              status: 'FAILED',
              error: `Step ${step} has exceptions to resolve; then resume.`,
            }
          : step === 10
            ? { status: 'COMPLETED', finishedAt: deps.clock() }
            : { currentStep: step + 1 }),
        steps: {
          update: {
            where,
            data: {
              status: blocked ? 'BLOCKED' : outcome.skipped ? 'SKIPPED' : 'DONE',
              exceptions: outcome.exceptions as Prisma.InputJsonValue,
              result: outcome.result,
              finishedAt: deps.clock(),
            },
          },
        },
      },
    });
    if (blocked) return;
  }
}

export async function getNightAudit(deps: NightAuditDeps, id: string) {
  return runItem(await loadRun(deps, id));
}

export async function startNightAudit(
  deps: NightAuditDeps,
  tenant: TenantContext,
  body: z.output<typeof NightAuditBody>,
) {
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
  });
  if (property.status !== 'LIVE') {
    throw new AppError('STATE_TRANSITION_INVALID', 'Night audit runs once the property is live');
  }
  const current = await businessDay(deps.tenantDb, tenant.propertyId, deps.clock);
  const existing = await deps.tenantDb.nightAuditRun.findFirst({
    where: { businessDate: dbDate(body.businessDate) },
  });
  if (existing) {
    throw new AppError(
      'AUDIT_IN_PROGRESS',
      existing.status === 'COMPLETED'
        ? `Night audit for ${body.businessDate} has already run`
        : `Night audit for ${body.businessDate} has started: resume it`,
      { nightAuditId: existing.id, status: existing.status },
    );
  }
  if (body.businessDate !== current.date) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Night audit runs for the current business date, ${current.date}`,
      {
        issues: [
          {
            path: 'body.businessDate',
            code: 'custom',
            message: `Night audit runs for the current business date, ${current.date}`,
          },
        ],
      },
    );
  }
  const today = localDate(deps.clock(), property.timeZone);
  if (current.date > today) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      `${current.date} has not started yet: its night audit runs from that date`,
      { businessDate: current.date, today },
    );
  }
  let runId: string;
  try {
    const run = await deps.tenantDb.$transaction(async (tx) => {
      const created = await tx.nightAuditRun.create({
        data: {
          propertyId: tenant.propertyId,
          businessDate: dbDate(body.businessDate),
          startedById: tenant.userId,
          startedAt: deps.clock(),
          steps: {
            create: NIGHT_AUDIT_STEPS.map((s) => ({ step: s.step, name: s.name })),
          },
        },
      });
      await recordAudit(tx, {
        action: 'night_audit.started',
        entityType: 'night_audit',
        entityId: created.id,
        after: { businessDate: body.businessDate },
      });
      return created;
    });
    runId = run.id;
  } catch (err) {
    if (pgErrorInfo(err)?.sqlState === '23505') {
      throw new AppError('AUDIT_IN_PROGRESS', `Night audit for ${body.businessDate} has started`);
    }
    throw err;
  }
  await execute(deps, tenant, runId);
  return getNightAudit(deps, runId);
}

export async function resumeNightAudit(deps: NightAuditDeps, tenant: TenantContext, id: string) {
  const run = await loadRun(deps, id);
  if (run.status === 'COMPLETED') {
    throw new AppError('STATE_TRANSITION_INVALID', 'This night audit has finished', {
      status: run.status,
    });
  }
  await recordAudit(deps.tenantDb, {
    action: 'night_audit.resumed',
    entityType: 'night_audit',
    entityId: run.id,
    after: { step: run.currentStep },
  });
  await execute(deps, tenant, run.id);
  return getNightAudit(deps, run.id);
}

/** The run for a business date, if one has started (GET /business-day). */
export async function runIdFor(db: TenantDb, date: string): Promise<string | null> {
  const run = await db.nightAuditRun.findFirst({
    where: { businessDate: dbDate(date) },
    select: { id: true },
  });
  return run?.id ?? null;
}
