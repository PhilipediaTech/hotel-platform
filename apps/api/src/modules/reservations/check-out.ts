import { addDays, daysBetween, type CheckOutBody, type CheckOutPreview } from '@hotel/shared';
import type { z } from 'zod';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { applyDeparture } from './extend.ts';
import { dayUseOf, getReservation, type ReservationDeps } from './service.ts';

// Check-out (PRD M3 story "I check a guest out after the folio balance is zero…", M3 rules 3
// and 4, M3 acceptance FOLIO_BALANCE_OUTSTANDING, housekeeping rule 2; tab 4 POST
// /stays/{id}/check-out; S12; T-064). Every window of the guest's folio must be at zero
// (transfer to a company account comes with the city ledger, write-off with its approval);
// open tasks and complaints would warn, unreturned keys do now, and nothing else blocks. The
// folio is settled, the room set to dirty. An overnight guest leaving early has the stay
// shortened to the business date in the same transaction (M3-12; at least one night, so a
// guest leaving on the arrival day keeps that night), which releases the later nights; a
// day-use stay frees its room from now on. Sending the bill by email or WhatsApp waits for
// notifications (T-024); the desk prints it.

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = Tx | TenantDb;
type Blocker = z.input<typeof CheckOutPreview>['blockers'][number];

const day = (d: Date) => d.toISOString().slice(0, 10);

/** When an overnight stay ends if the guest leaves on `date`: never after the booked
 * departure, never before one night. */
function leavesOn(stay: { isDayUse: boolean; arrival: Date; departure: Date }, date: string) {
  const booked = day(stay.departure);
  if (stay.isDayUse || date >= booked) return booked;
  const oneNight = addDays(day(stay.arrival), 1);
  return date > oneNight ? date : oneNight;
}

/** Balance of each window of a folio: its lines minus its payments. */
async function windowBalances(db: Client, folioId: string) {
  const [windows, lines, payments] = await Promise.all([
    db.folio.findUniqueOrThrow({
      where: { id: folioId },
      include: {
        windows: { orderBy: { number: 'asc' }, include: { payerGuest: true, company: true } },
      },
    }),
    db.folioLine.groupBy({ by: ['windowId'], where: { folioId }, _sum: { amountMinor: true } }),
    db.payment.groupBy({ by: ['windowId'], where: { folioId }, _sum: { baseAmountMinor: true } }),
  ]);
  const charged = new Map(lines.map((l) => [l.windowId, l._sum.amountMinor ?? 0n]));
  const paid = new Map(payments.map((p) => [p.windowId, p._sum.baseAmountMinor ?? 0n]));
  return {
    folio: windows,
    windows: windows.windows.map((w) => ({
      number: w.number,
      payerName: w.company
        ? w.company.name
        : w.payerGuest
          ? `${w.payerGuest.firstName} ${w.payerGuest.lastName}`.trim()
          : windows.name,
      balanceMinor: (charged.get(w.id) ?? 0n) - (paid.get(w.id) ?? 0n),
    })),
  };
}

async function blockersOf(db: Client, stay: { status: string; folioId: string | null }) {
  const blockers: Blocker[] = [];
  if (stay.status !== 'CHECKED_IN') blockers.push('NOT_CHECKED_IN');
  const balances = stay.folioId ? await windowBalances(db, stay.folioId) : null;
  if (balances?.windows.some((w) => w.balanceMinor !== 0n)) {
    blockers.push('FOLIO_BALANCE_OUTSTANDING');
  }
  return { blockers, balances };
}

export async function getCheckOut(
  deps: ReservationDeps,
  tenant: TenantContext,
  stayId: string,
): Promise<z.input<typeof CheckOutPreview>> {
  const db = deps.tenantDb;
  const stay = await db.stay.findUnique({
    where: { id: stayId },
    include: { guest: true, room: true },
  });
  if (!stay) throw new AppError('NOT_FOUND', 'Stay not found');
  const date = await businessDate(db, tenant.propertyId, deps.clock);
  const { blockers, balances } = await blockersOf(db, stay);
  const keys = await db.keyIssue.aggregate({
    where: { stayId: stay.id, returnedAt: null },
    _sum: { count: true },
  });
  const out = keys._sum.count ?? 0;
  const leaves = leavesOn(stay, date);
  const early = daysBetween(leaves, day(stay.departure));
  return {
    stayId: stay.id,
    status: stay.status,
    guestName: `${stay.guest.firstName} ${stay.guest.lastName}`.trim(),
    roomNumber: stay.room?.number ?? null,
    arrival: day(stay.arrival),
    departure: day(stay.departure),
    dayUse: dayUseOf(stay),
    businessDate: date,
    leavesOn: leaves,
    folio: balances
      ? {
          id: balances.folio.id,
          number: balances.folio.number,
          balanceMinor: balances.windows.reduce((s, w) => s + w.balanceMinor, 0n).toString(),
          windows: balances.windows.map((w) => ({
            ...w,
            balanceMinor: w.balanceMinor.toString(),
          })),
        }
      : null,
    warnings: [
      ...(out > 0 ? [{ code: 'KEYS_NOT_RETURNED' as const, count: out }] : []),
      ...(early > 0 ? [{ code: 'EARLY_DEPARTURE' as const, count: early }] : []),
    ],
    blockers,
    version: stay.version,
  };
}

export async function checkOut(
  deps: ReservationDeps,
  tenant: TenantContext,
  stayId: string,
  ifMatch: string,
  body: z.output<typeof CheckOutBody>,
) {
  const now = deps.clock();
  const reservationId = await deps.tenantDb.$transaction(async (tx) => {
    // Locked: two check-outs, or a payment landing while the balance is checked.
    await tx.$queryRaw`SELECT id FROM stays WHERE id = ${stayId}::uuid FOR UPDATE`;
    const stay = await tx.stay.findUnique({ where: { id: stayId } });
    if (!stay) throw new AppError('NOT_FOUND', 'Stay not found');
    if (Number(/^(?:W\/)?"?(\d+)"?$/.exec(ifMatch.trim())?.[1] ?? -1) !== stay.version) {
      throw new AppError('VERSION_CONFLICT', 'Someone changed this stay; reload and try again', {
        version: stay.version,
      });
    }
    if (stay.status !== 'CHECKED_IN' || !stay.roomId) {
      throw new AppError('STATE_TRANSITION_INVALID', 'Only a checked-in guest is checked out', {
        from: stay.status,
        to: 'CHECKED_OUT',
      });
    }
    if (stay.folioId) {
      await tx.$queryRaw`SELECT id FROM folios WHERE id = ${stay.folioId}::uuid FOR UPDATE`;
    }
    const date = await businessDate(tx, stay.propertyId, deps.clock);
    const { blockers, balances } = await blockersOf(tx, stay);
    if (blockers.includes('FOLIO_BALANCE_OUTSTANDING') && balances) {
      throw new AppError('FOLIO_BALANCE_OUTSTANDING', 'Settle the bill before checking out', {
        folioId: balances.folio.id,
        windows: balances.windows
          .filter((w) => w.balanceMinor !== 0n)
          .map((w) => ({ number: w.number, balanceMinor: w.balanceMinor.toString() })),
      });
    }

    // An early departure: the stay ends now and its later nights go back (M3-12).
    const leaves = leavesOn(stay, date);
    let version = stay.version;
    if (leaves < day(stay.departure)) {
      await applyDeparture(tx, {
        propertyId: stay.propertyId,
        stayId: stay.id,
        version: null,
        to: leaves,
        added: [],
        reason: 'Early departure at check-out',
        now,
      });
      version += 1;
    }
    if (stay.isDayUse) {
      // A day-use room is free from now on (or was never used, when it ends before its start).
      const allocations = await tx.roomAllocation.findMany({
        where: { stayId: stay.id, active: true },
      });
      for (const a of allocations) {
        if (a.startsAt && a.startsAt < now) {
          if (a.endsAt && a.endsAt > now) {
            await tx.roomAllocation.update({ where: { id: a.id }, data: { endsAt: now } });
          }
        } else {
          await tx.roomAllocation.update({ where: { id: a.id }, data: { active: false } });
        }
      }
    }
    // Housekeeping rule 2: check-out (and a day-use end) sets the room to dirty.
    await tx.room.update({
      where: { id: stay.roomId },
      data: { hkStatus: 'DIRTY', hkStatusAt: now, version: { increment: 1 } },
    });
    if (body.keysReturned) {
      await tx.keyIssue.updateMany({
        where: { stayId: stay.id, returnedAt: null },
        data: { returnedAt: now },
      });
    }
    if (balances && balances.folio.status === 'OPEN') {
      await tx.folio.update({
        where: { id: balances.folio.id },
        data: { status: 'SETTLED', version: { increment: 1 } },
      });
    }
    const claimed = await tx.stay.updateMany({
      where: { id: stay.id, version },
      data: { status: 'CHECKED_OUT', checkedOutAt: now, version: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      throw new AppError('VERSION_CONFLICT', 'Someone changed this stay; reload and try again');
    }
    // The reservation is checked out once none of its guests is still in or to come.
    const left = await tx.stay.count({
      where: {
        reservationId: stay.reservationId,
        status: { notIn: ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] },
      },
    });
    await tx.reservation.update({
      where: { id: stay.reservationId },
      data: {
        ...(left === 0 ? { status: 'CHECKED_OUT' as const } : {}),
        version: { increment: 1 },
        history: {
          create: {
            stayId: stay.id,
            fromStatus: 'CHECKED_IN',
            toStatus: 'CHECKED_OUT',
            byUserId: tenant.userId,
            at: now,
          },
        },
      },
    });
    await recordAudit(tx, {
      action: 'stay.checked_out',
      entityType: 'stay',
      entityId: stay.id,
      before: { status: 'CHECKED_IN' },
      after: {
        status: 'CHECKED_OUT',
        roomId: stay.roomId,
        keysReturned: body.keysReturned,
        folioId: stay.folioId,
      },
    });
    await recordEvent(tx, {
      type: 'stay.checked_out',
      payload: { stayId: stay.id, reservationId: stay.reservationId, roomId: stay.roomId },
    });
    return stay.reservationId;
  });
  return getReservation(deps, reservationId);
}
