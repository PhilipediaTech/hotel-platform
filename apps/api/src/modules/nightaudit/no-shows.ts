import { feeFor, inventoryFieldOf, type FeeRule } from '@hotel/shared';
import type { ExecuteContext } from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { recordEvent } from '../../core/outbox.ts';
import { releaseInventory } from '../availability/inventory.ts';
import { openFolio, postChargeLines, routedWindow } from '../folios/service.ts';
import { systemCodeId } from '../folios/system-codes.ts';
import { lockReservation } from '../payments/deposits.ts';
import { releaseAllocations } from '../reservations/rooms.ts';

// No-shows (night audit step 6; PRD M3 "as a night auditor, I mark unarrived guaranteed
// bookings as no-show and post the fee", M3 rule "no-show is only possible after night audit
// of the arrival date; non-guaranteed no-shows release inventory without fee"; T-073b). A
// confirmed stay that has not arrived by the audited date becomes NO_SHOW and gives its rooms
// back; a guaranteed one is charged its plan's no-show fee on a folio of its own, where any
// advance deposit is applied as at check-in. Manual no-shows, reinstating and deposit
// forfeits are T-074.

type Ctx = ExecuteContext & { now: Date };

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Marks one stay a no-show; answers the fee posted (0 when none), or null if it arrived. */
export async function markNoShow(
  ctx: Ctx,
  args: { stayId: string; businessDate: string; clock: Clock },
): Promise<bigint | null> {
  const { tx, now } = ctx;
  const found = await tx.stay.findUniqueOrThrow({ where: { id: args.stayId } });
  await lockReservation(tx, found.reservationId);
  const stay = await tx.stay.findUniqueOrThrow({
    where: { id: args.stayId },
    include: {
      reservation: { include: { stays: { select: { id: true, status: true } } } },
      ratePlan: { include: { cancellationPolicy: true } },
      nights: { orderBy: { date: 'asc' } },
    },
  });
  // Arrived, cancelled or already handled since the run listed it.
  if (stay.status !== 'CONFIRMED' || day(stay.arrival) > args.businessDate) return null;

  if (!stay.isDayUse) {
    const field = inventoryFieldOf(stay.status);
    if (field) {
      await releaseInventory(tx, {
        propertyId: stay.propertyId,
        roomTypeId: stay.roomTypeId,
        arrival: day(stay.arrival),
        departure: day(stay.departure),
        field,
      });
    }
  }
  await releaseAllocations(tx, [stay.id]);
  await tx.stay.update({
    where: { id: stay.id },
    data: { status: 'NO_SHOW', roomId: null, version: { increment: 1 } },
  });
  const reservation = stay.reservation;
  const stillLive = reservation.stays.some(
    (s) => s.id !== stay.id && ['CONFIRMED', 'TENTATIVE', 'CHECKED_IN'].includes(s.status),
  );
  await tx.reservation.update({
    where: { id: reservation.id },
    data: {
      ...(stillLive ? {} : { status: 'NO_SHOW' }),
      version: { increment: 1 },
      history: {
        create: {
          stayId: stay.id,
          fromStatus: 'CONFIRMED',
          toStatus: 'NO_SHOW',
          reason: 'Night audit',
          byUserId: ctx.tenant.userId,
          at: now,
        },
      },
    },
  });

  // Only a guaranteed booking owes the fee (M3 rule).
  let feeMinor = 0n;
  let folioId: string | null = null;
  if (reservation.guarantee !== 'NONE') {
    const rule = stay.ratePlan.cancellationPolicy.noShowFee as unknown as Omit<
      FeeRule,
      'daysBefore'
    >;
    feeMinor = feeFor(
      rule,
      stay.nights.map((n) => n.amountMinor),
    );
    if (feeMinor > 0n) {
      folioId = await openFolio(tx, stay, args.clock, args.businessDate);
      const folio = await tx.folio.findUniqueOrThrow({
        where: { id: folioId },
        include: { windows: true, routingRules: true },
      });
      const code = await tx.revenueCode.findUniqueOrThrow({
        where: { id: await systemCodeId(tx, 'NOSHOW') },
      });
      await postChargeLines(ctx, {
        folio,
        windowId: routedWindow(folio, code) ?? '',
        code,
        description: `No-show fee, arrival ${day(stay.arrival)}`,
        quantity: 1,
        unitAmountMinor: feeMinor,
        note: null,
        sourceType: 'NO_SHOW',
        sourceId: stay.id,
        businessDate: args.businessDate,
      });
    }
  }
  await recordAudit(tx, {
    action: 'reservation.no_show',
    entityType: 'reservation',
    entityId: reservation.id,
    reason: 'Night audit',
    before: { stayId: stay.id, status: 'CONFIRMED' },
    after: { stayId: stay.id, status: 'NO_SHOW', feeMinor: feeMinor.toString(), folioId },
  });
  await recordEvent(tx, {
    type: 'reservation.no_show',
    payload: { reservationId: reservation.id, stayId: stay.id, feeMinor: feeMinor.toString() },
  });
  return feeMinor;
}
