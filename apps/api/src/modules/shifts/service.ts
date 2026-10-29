import {
  DEFAULT_SHIFT_TOLERANCE_MINOR,
  type CloseShiftBody,
  type CurrentShift,
  type HandoverItem,
  type ShiftItem,
  type ShiftQuery,
} from '@hotel/shared';
import type { z } from 'zod';
import type { PayMethod, Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Cashier shifts (PRD M4-10–M4-12, M4 rule 4; tab 4 row "Shifts"; S14; T-061). A cashier opens
// one shift at a time with a counted float. Cash leaves the drawer by handover: to the safe
// (confirmed at once) or to a colleague, who confirms it into their open shift. The close is
// blind: the cashier counts each method and only the response reveals what was expected.
// Expected = float + handovers confirmed in − handovers out (cash) + payments taken per method. A
// variance above the property's tolerance keeps the shift in CLOSING: the cashier gives a
// reason, a leakage alert is raised, and a supervisor other than the cashier signs it off.

export interface ShiftDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = Tx | TenantDb;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const abs = (n: bigint) => (n < 0n ? -n : n);

const SHIFT = {
  user: { select: { name: true } },
  signedOffBy: { select: { name: true } },
  counts: { orderBy: [{ method: 'asc' }, { currency: 'asc' }] },
  handovers: { include: { toUser: { select: { name: true } } }, orderBy: { at: 'asc' } },
} satisfies Prisma.CashierShiftInclude;

type FullShift = Prisma.CashierShiftGetPayload<{ include: typeof SHIFT }>;

/** The property's variance tolerance per method (settings.shiftVarianceToleranceMinor). */
async function toleranceOf(db: Client, propertyId: string): Promise<bigint> {
  const property = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  const settings = (property.settings ?? {}) as Record<string, unknown>;
  const value = settings.shiftVarianceToleranceMinor;
  const text =
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : DEFAULT_SHIFT_TOLERANCE_MINOR;
  return /^\d{1,18}$/.test(text) ? BigInt(text) : BigInt(DEFAULT_SHIFT_TOLERANCE_MINOR);
}

async function baseCurrency(db: Client, propertyId: string): Promise<string> {
  const property = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  return property.baseCurrency;
}

/** Handovers confirmed to the shift's cashier while the shift was open. */
async function handoversIn(
  db: Client,
  shift: { userId: string | null; openedAt: Date; closedAt: Date | null },
) {
  if (!shift.userId) return [];
  const shifts = await db.cashierShift.findMany({
    where: {
      handovers: {
        some: {
          toUserId: shift.userId,
          confirmedAt: { gte: shift.openedAt, ...(shift.closedAt ? { lte: shift.closedAt } : {}) },
        },
      },
    },
    include: SHIFT,
  });
  return shifts.flatMap((from) =>
    from.handovers
      .filter(
        (h) =>
          h.toUserId === shift.userId &&
          h.confirmedAt !== null &&
          h.confirmedAt >= shift.openedAt &&
          (!shift.closedAt || h.confirmedAt <= shift.closedAt),
      )
      .map((h) => ({ ...h, fromShift: from })),
  );
}

/** What the drawer should hold, per method and currency (`CASH NGN` → minor units). */
async function expected(db: Client, shift: FullShift, currency: string) {
  const out = new Map<string, bigint>();
  const add = (method: PayMethod, cur: string, amount: bigint) =>
    out.set(`${method} ${cur}`, (out.get(`${method} ${cur}`) ?? 0n) + amount);
  add('CASH', currency, shift.floatMinor);
  for (const h of shift.handovers) add('CASH', h.currency, -h.amountMinor);
  for (const h of await handoversIn(db, shift)) add('CASH', h.currency, h.amountMinor);
  // Payments taken on the shift (T-062), at what was received in each currency.
  const payments = await db.payment.groupBy({
    by: ['method', 'currency'],
    where: { shiftId: shift.id },
    _sum: { amountMinor: true },
  });
  for (const p of payments) add(p.method, p.currency, p._sum.amountMinor ?? 0n);
  return out;
}

const handoverItem = (
  h: {
    id: string;
    amountMinor: bigint;
    currency: string;
    at: Date;
    confirmedAt: Date | null;
    toUser: { name: string } | null;
  },
  from: string,
): z.input<typeof HandoverItem> => ({
  id: h.id,
  from,
  to: h.toUser?.name ?? null,
  amountMinor: String(h.amountMinor),
  currency: h.currency,
  at: iso(h.at),
  confirmedAt: h.confirmedAt ? iso(h.confirmedAt) : null,
});

const cashierName = (s: FullShift) => s.user?.name ?? 'System';

async function shiftItem(db: Client, s: FullShift): Promise<z.input<typeof ShiftItem>> {
  const [tolerance, currency] = await Promise.all([
    toleranceOf(db, s.propertyId),
    baseCurrency(db, s.propertyId),
  ]);
  let lines: z.input<typeof ShiftItem>['lines'];
  if (s.counts.length > 0) {
    lines = s.counts.map((c) => ({
      method: c.method,
      currency: c.currency,
      expectedMinor: String(c.expectedMinor),
      countedMinor: String(c.countedMinor),
      varianceMinor: String(c.varianceMinor),
    }));
  } else {
    lines = [...(await expected(db, s, currency))].map(([key, amount]) => {
      const [method, cur] = key.split(' ') as [PayMethod, string];
      return {
        method,
        currency: cur,
        expectedMinor: String(amount),
        countedMinor: null,
        varianceMinor: null,
      };
    });
  }
  return {
    id: s.id,
    userId: s.userId,
    cashier: cashierName(s),
    status: s.status,
    openedAt: iso(s.openedAt),
    closedAt: s.closedAt ? iso(s.closedAt) : null,
    floatMinor: String(s.floatMinor),
    currency,
    lines,
    toleranceMinor: String(tolerance),
    requiresSignOff: s.status === 'CLOSING',
    varianceNote: s.varianceNote,
    signedOffBy: s.signedOffBy?.name ?? null,
  };
}

async function loadShift(db: Client, shiftId: string): Promise<FullShift> {
  const shift = await db.cashierShift.findUnique({ where: { id: shiftId }, include: SHIFT });
  if (!shift) throw new AppError('NOT_FOUND', 'Shift not found');
  return shift;
}

/** Serialises changes to one shift (close races, handovers during a close). */
async function lockShift(tx: Tx, shiftId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM cashier_shifts WHERE id = ${shiftId}::uuid FOR UPDATE`;
}

const openShiftOf = (db: Client, userId: string) =>
  db.cashierShift.findFirst({ where: { userId, status: 'OPEN', outletId: null }, include: SHIFT });

// ── The cashier's view ───────────────────────────────────────────────────────────────────

export async function currentShift(
  deps: ShiftDeps,
  tenant: TenantContext,
): Promise<z.input<typeof CurrentShift>> {
  const db = deps.tenantDb;
  const me = tenant.userId;
  const [shift, waiting, pending, colleagues, currency] = await Promise.all([
    openShiftOf(db, me),
    db.cashierShift.findMany({
      where: { userId: me, status: 'CLOSING' },
      include: SHIFT,
      orderBy: { openedAt: 'asc' },
    }),
    db.cashierShift.findMany({
      where: { handovers: { some: { toUserId: me, confirmedAt: null } } },
      include: SHIFT,
    }),
    db.cashierShift.findMany({
      where: { status: 'OPEN', outletId: null, userId: { not: null } },
      include: { user: { select: { id: true, name: true } } },
    }),
    baseCurrency(db, tenant.propertyId),
  ]);
  return {
    shift: shift
      ? {
          id: shift.id,
          status: 'OPEN',
          openedAt: iso(shift.openedAt),
          floatMinor: String(shift.floatMinor),
          currency,
          handoversOut: shift.handovers.map((h) => handoverItem(h, cashierName(shift))),
          handoversIn: (await handoversIn(db, shift)).map((h) =>
            handoverItem(h, cashierName(h.fromShift)),
          ),
          paymentCounts: (
            await db.payment.groupBy({
              by: ['method'],
              where: { shiftId: shift.id },
              _count: { _all: true },
              orderBy: { method: 'asc' },
            })
          ).map((p) => ({ method: p.method, count: p._count._all })),
        }
      : null,
    awaitingSignOff: await Promise.all(waiting.map((s) => shiftItem(db, s))),
    incoming: pending.flatMap((from) =>
      from.handovers
        .filter((h) => h.toUserId === me && h.confirmedAt === null)
        .map((h) => handoverItem(h, cashierName(from))),
    ),
    colleagues: colleagues
      .filter((s) => s.user && s.user.id !== me)
      .map((s) => ({ userId: s.user!.id, name: s.user!.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function openShift(deps: ShiftDeps, tenant: TenantContext, floatMinor: string) {
  try {
    await deps.tenantDb.$transaction(async (tx) => {
      if (await openShiftOf(tx, tenant.userId)) {
        throw new AppError('STATE_TRANSITION_INVALID', 'You already have an open shift');
      }
      const shift = await tx.cashierShift.create({
        data: {
          userId: tenant.userId,
          floatMinor: BigInt(floatMinor),
          openedAt: deps.clock(),
        } as unknown as Prisma.CashierShiftUncheckedCreateInput, // tenant IDs come from the client
      });
      await recordAudit(tx, {
        action: 'shift.opened',
        entityType: 'cashier_shift',
        entityId: shift.id,
        after: { floatMinor },
      });
    });
  } catch (err) {
    // Two opens at once: the partial unique index lets one through.
    if (pgErrorInfo(err)?.constraint === 'cashier_shifts_one_open') {
      throw new AppError('STATE_TRANSITION_INVALID', 'You already have an open shift');
    }
    throw err;
  }
  return currentShift(deps, tenant);
}

// ── Close, reason, sign-off (M4-11) ──────────────────────────────────────────────────────

export async function closeShift(
  deps: ShiftDeps,
  tenant: TenantContext,
  shiftId: string,
  body: z.output<typeof CloseShiftBody>,
) {
  await deps.tenantDb.$transaction(async (tx) => {
    await lockShift(tx, shiftId);
    const shift = await loadShift(tx, shiftId);
    if (shift.userId !== tenant.userId && !tenant.permissions.has('shift.signoff')) {
      throw new AppError('FORBIDDEN', 'Only the cashier or a supervisor closes a shift');
    }
    if (shift.status !== 'OPEN') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This shift is already closed', {
        status: shift.status,
      });
    }
    const [currency, tolerance, date] = await Promise.all([
      baseCurrency(tx, shift.propertyId),
      toleranceOf(tx, shift.propertyId),
      businessDate(tx, shift.propertyId, deps.clock),
    ]);
    const exp = await expected(tx, shift, currency);
    const counted = new Map(
      body.counts.map((c) => [`${c.method} ${c.currency}`, BigInt(c.countedMinor)]),
    );
    const keys = [...new Set([...exp.keys(), ...counted.keys()])].sort();
    const lines = keys.map((key) => {
      const [method, cur] = key.split(' ') as [PayMethod, string];
      const expectedMinor = exp.get(key) ?? 0n;
      const countedMinor = counted.get(key) ?? 0n;
      return {
        method,
        currency: cur,
        expectedMinor,
        countedMinor,
        varianceMinor: countedMinor - expectedMinor,
      };
    });
    const over = lines.filter((l) => abs(l.varianceMinor) > tolerance);
    const now = deps.clock();
    await tx.cashierShift.update({
      where: { id: shift.id },
      data: {
        status: over.length > 0 ? 'CLOSING' : 'CLOSED',
        closedAt: now,
        varianceNote: body.varianceNote,
        counts: { create: lines },
      },
    });
    const evidence = {
      toleranceMinor: String(tolerance),
      lines: lines.map((l) => ({
        method: l.method,
        currency: l.currency,
        expectedMinor: String(l.expectedMinor),
        countedMinor: String(l.countedMinor),
        varianceMinor: String(l.varianceMinor),
      })),
    };
    await recordAudit(tx, {
      action: 'shift.closed',
      entityType: 'cashier_shift',
      entityId: shift.id,
      before: { status: 'OPEN' },
      after: { status: over.length > 0 ? 'CLOSING' : 'CLOSED', ...evidence },
      reason: body.varianceNote ?? undefined,
    });
    if (over.length > 0) {
      // The shift acceptance criterion: a variance above tolerance raises a leakage alert.
      const worst = over.reduce((a, b) => (abs(b.varianceMinor) > abs(a.varianceMinor) ? b : a));
      const alert = await tx.leakageAlert.create({
        data: {
          ruleCode: 'SHIFT_VARIANCE',
          businessDate: dbDate(date),
          severity: abs(worst.varianceMinor) > tolerance * 10n ? 'HIGH' : 'NORMAL',
          entityType: 'cashier_shift',
          entityId: shift.id,
          subjectUserId: shift.userId,
          evidence,
          dedupeKey: `SHIFT_VARIANCE:${shift.id}`,
        } as unknown as Prisma.LeakageAlertUncheckedCreateInput, // tenant IDs come from the client
      });
      await recordEvent(tx, {
        type: 'leakage.alert_raised',
        payload: { alertId: alert.id, ruleCode: 'SHIFT_VARIANCE', shiftId: shift.id },
      });
    }
  });
  return shiftItem(deps.tenantDb, await loadShift(deps.tenantDb, shiftId));
}

export async function addVarianceNote(
  deps: ShiftDeps,
  tenant: TenantContext,
  shiftId: string,
  note: string,
) {
  await deps.tenantDb.$transaction(async (tx) => {
    await lockShift(tx, shiftId);
    const shift = await loadShift(tx, shiftId);
    if (shift.userId !== tenant.userId && !tenant.permissions.has('shift.signoff')) {
      throw new AppError('FORBIDDEN', 'Only the cashier gives the reason');
    }
    if (shift.status !== 'CLOSING') {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'Only a shift waiting for sign-off takes a reason',
        {
          status: shift.status,
        },
      );
    }
    await tx.cashierShift.update({ where: { id: shift.id }, data: { varianceNote: note } });
    await recordAudit(tx, {
      action: 'shift.variance_explained',
      entityType: 'cashier_shift',
      entityId: shift.id,
      before: { varianceNote: shift.varianceNote },
      after: { varianceNote: note },
    });
  });
  return shiftItem(deps.tenantDb, await loadShift(deps.tenantDb, shiftId));
}

export async function signOffShift(
  deps: ShiftDeps,
  tenant: TenantContext,
  shiftId: string,
  note: string | null,
) {
  await deps.tenantDb.$transaction(async (tx) => {
    await lockShift(tx, shiftId);
    const shift = await loadShift(tx, shiftId);
    if (shift.userId === tenant.userId) {
      throw new AppError('FORBIDDEN', 'A supervisor other than the cashier signs off');
    }
    if (shift.status !== 'CLOSING') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This shift is not waiting for sign-off', {
        status: shift.status,
      });
    }
    if (!shift.varianceNote) {
      throw new AppError('STATE_TRANSITION_INVALID', 'The cashier has not given a reason yet', {
        status: shift.status,
      });
    }
    await tx.cashierShift.update({
      where: { id: shift.id },
      data: { status: 'CLOSED', signedOffById: tenant.userId },
    });
    await recordAudit(tx, {
      action: 'shift.signed_off',
      entityType: 'cashier_shift',
      entityId: shift.id,
      before: { status: 'CLOSING' },
      after: { status: 'CLOSED' },
      reason: note ?? undefined,
    });
  });
  return shiftItem(deps.tenantDb, await loadShift(deps.tenantDb, shiftId));
}

export async function listShifts(deps: ShiftDeps, query: z.output<typeof ShiftQuery>) {
  const shifts = await deps.tenantDb.cashierShift.findMany({
    where: { status: query.status, outletId: null },
    include: SHIFT,
    orderBy: { openedAt: query.status === 'CLOSED' ? 'desc' : 'asc' },
    take: 200,
  });
  return { data: await Promise.all(shifts.map((s) => shiftItem(deps.tenantDb, s))) };
}

// ── Handovers (M4-12) ────────────────────────────────────────────────────────────────────

export async function createHandover(
  deps: ShiftDeps,
  tenant: TenantContext,
  body: { toUserId: string | null; amountMinor: string },
) {
  await deps.tenantDb.$transaction(async (tx) => {
    const mine = await openShiftOf(tx, tenant.userId);
    if (!mine) throw new AppError('SHIFT_NOT_OPEN', 'Open a shift first');
    await lockShift(tx, mine.id);
    const locked = await loadShift(tx, mine.id);
    if (locked.status !== 'OPEN') throw new AppError('SHIFT_NOT_OPEN', 'Open a shift first');
    if (body.toUserId !== null) {
      const theirs = body.toUserId === tenant.userId ? null : await openShiftOf(tx, body.toUserId);
      if (!theirs) {
        const message = 'Hand over to a colleague with an open shift, or to the safe';
        throw new AppError('VALIDATION_ERROR', message, {
          issues: [{ path: 'body.toUserId', code: 'custom', message }],
        });
      }
    }
    const now = deps.clock();
    const currency = await baseCurrency(tx, tenant.propertyId);
    await tx.cashierShift.update({
      where: { id: mine.id },
      data: {
        handovers: {
          create: {
            toUserId: body.toUserId,
            amountMinor: BigInt(body.amountMinor),
            currency,
            at: now,
            // The safe has no one to confirm: it is confirmed as it is made.
            confirmedAt: body.toUserId === null ? now : null,
          },
        },
      },
    });
    await recordAudit(tx, {
      action: 'shift.cash_handed_over',
      entityType: 'cashier_shift',
      entityId: mine.id,
      after: { toUserId: body.toUserId, amountMinor: body.amountMinor, currency },
    });
  });
  return currentShift(deps, tenant);
}

export async function confirmHandover(deps: ShiftDeps, tenant: TenantContext, handoverId: string) {
  await deps.tenantDb.$transaction(async (tx) => {
    const from = await tx.cashierShift.findFirst({
      where: { handovers: { some: { id: handoverId } } },
      include: SHIFT,
    });
    const handover = from?.handovers.find((h) => h.id === handoverId);
    if (!from || !handover || handover.toUserId !== tenant.userId) {
      throw new AppError('NOT_FOUND', 'Handover not found');
    }
    if (handover.confirmedAt) {
      throw new AppError('STATE_TRANSITION_INVALID', 'This handover is already confirmed');
    }
    const mine = await openShiftOf(tx, tenant.userId);
    if (!mine) throw new AppError('SHIFT_NOT_OPEN', 'Open a shift to receive cash');
    await lockShift(tx, mine.id);
    await tx.cashierShift.update({
      where: { id: from.id },
      data: {
        handovers: {
          update: { where: { id: handoverId }, data: { confirmedAt: deps.clock() } },
        },
      },
    });
    await recordAudit(tx, {
      action: 'shift.cash_received',
      entityType: 'cashier_shift',
      entityId: mine.id,
      after: { handoverId, fromShiftId: from.id, amountMinor: String(handover.amountMinor) },
    });
  });
  return currentShift(deps, tenant);
}
