import { recordAudit } from '../../core/audit.ts';
import type { Db } from '../../core/db.ts';

// Event money (PRD M9-05, M9 rules and AC: "an instalment paid to the event virtual account
// allocates to the next due instalment"; T-120). Kept apart from the rest of the events module
// because the payments module calls it. A payment lands on the event's folio as a credit, so it
// is never revenue; event_deposits records which part of the schedule it paid.

type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

export const LIVE_CONTRACT = ['ISSUED', 'SIGNED'] as const;

/**
 * Applies a payment on an event's folio to the schedule, oldest due first: what is left after
 * one entry goes on to the next, and what is left after the whole schedule is held as paid
 * over. Does nothing for any other folio. Money on a hold keeps the space until the event.
 */
export async function allocateEventPayment(
  tx: Tx,
  args: {
    propertyId: string;
    folioId: string;
    paymentId: string;
    amountMinor: bigint;
    now: Date;
    userId: string | null;
  },
): Promise<void> {
  const found = await tx.eventContract.findFirst({
    where: {
      propertyId: args.propertyId,
      folioId: args.folioId,
      status: { in: [...LIVE_CONTRACT] },
    },
    select: { id: true },
  });
  if (!found) return;
  // Two payments at once must not both see the same instalment as unpaid.
  await tx.$queryRaw`SELECT id FROM event_contracts WHERE id = ${found.id}::uuid FOR UPDATE`;
  const contract = await tx.eventContract.findUniqueOrThrow({
    where: { id: found.id },
    include: {
      booking: { include: { property: { select: { organisationId: true } } } },
      schedule: { orderBy: { sequence: 'asc' } },
    },
  });

  let left = args.amountMinor;
  const applied: { scheduleId: string | null; kind: string; amountMinor: string }[] = [];
  for (const entry of contract.schedule) {
    if (left === 0n) break;
    const room = entry.amountMinor - entry.paidMinor;
    if (room <= 0n) continue;
    const take = left < room ? left : room;
    await tx.eventPaymentSchedule.update({
      where: { id: entry.id },
      data: { paidMinor: entry.paidMinor + take },
    });
    await tx.eventDeposit.create({
      data: {
        propertyId: args.propertyId,
        contractId: contract.id,
        scheduleId: entry.id,
        paymentId: args.paymentId,
        kind: entry.kind,
        amountMinor: take,
        createdAt: args.now,
      },
    });
    applied.push({ scheduleId: entry.id, kind: entry.kind, amountMinor: take.toString() });
    left -= take;
  }
  if (left > 0n) {
    await tx.eventDeposit.create({
      data: {
        propertyId: args.propertyId,
        contractId: contract.id,
        scheduleId: null,
        paymentId: args.paymentId,
        kind: 'UNALLOCATED',
        amountMinor: left,
        createdAt: args.now,
      },
    });
    applied.push({ scheduleId: null, kind: 'UNALLOCATED', amountMinor: left.toString() });
  }

  const b = contract.booking;
  const keepsSpace =
    b.status === 'HOLD' && (b.holdExpiresAt?.getTime() ?? 0) < b.startsAt.getTime();
  if (keepsSpace) {
    await tx.eventBooking.update({
      where: { id: b.id },
      data: { holdExpiresAt: b.startsAt, version: { increment: 1 } },
    });
  }
  await recordAudit(tx, {
    organisationId: b.property.organisationId,
    propertyId: args.propertyId,
    action: 'event_payment.allocated',
    entityType: 'event_contract',
    entityId: contract.id,
    actorType: args.userId ? 'USER' : 'SYSTEM',
    actorUserId: args.userId,
    after: {
      paymentId: args.paymentId,
      applied,
      ...(keepsSpace ? { holdKeptUntil: b.startsAt.toISOString() } : {}),
    },
  });
}

/** Whether any money has been received against the booking's contracts. */
export async function bookingHasMoney(tx: Tx, bookingId: string): Promise<boolean> {
  return (await tx.eventDeposit.count({ where: { contract: { bookingId } } })) > 0;
}

/**
 * A hold ended before any money came in: its contract is dead, its account takes no more (a
 * late transfer goes to the unmatched queue), and its empty folio is closed.
 */
export async function voidUnpaidContract(tx: Tx, bookingId: string): Promise<void> {
  const live = await tx.eventContract.findFirst({
    where: { bookingId, status: { in: [...LIVE_CONTRACT] } },
  });
  if (!live || (await bookingHasMoney(tx, bookingId))) return;
  await tx.eventContract.update({
    where: { id: live.id },
    data: { status: 'VOID', version: { increment: 1 } },
  });
  await tx.virtualAccount.updateMany({
    where: { propertyId: live.propertyId, ownerType: 'EVENT', ownerId: bookingId },
    data: { active: false },
  });
  await tx.folio.update({ where: { id: live.folioId }, data: { status: 'CLOSED' } });
}
