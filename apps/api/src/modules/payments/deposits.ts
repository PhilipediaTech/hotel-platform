import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { postingDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { systemCodeId } from '../folios/system-codes.ts';

// Advance deposits (PRD M4-13; tab 3 `deposit_ledger_entries`; T-063). A deposit taken before
// arrival is a payment on the booking (no folio yet) and a RECEIVED entry in its ledger: a
// liability, not revenue. When the booking's first folio opens (check-in), whatever the
// ledger holds moves to it: an APPLIED entry takes it out of the ledger and a DEPOSIT_APPLY
// line (negative) credits the folio's window 1. The ledger's sum is what the hotel holds.

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = Tx | TenantDb;

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

/** Serialises deposit changes on a booking (a deposit taken while the guest checks in). */
export async function lockReservation(tx: Tx, reservationId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${reservationId}::uuid FOR UPDATE`;
}

/** What the booking's deposit ledger holds. */
export async function depositHeld(db: Client, reservationId: string): Promise<bigint> {
  const sum = await db.depositLedgerEntry.aggregate({
    where: { reservationId },
    _sum: { amountMinor: true },
  });
  return sum._sum.amountMinor ?? 0n;
}

/** Records a deposit payment in the booking's ledger (call under `lockReservation`). */
export async function receiveDeposit(
  tx: Tx,
  args: { reservationId: string; paymentId: string; amountMinor: bigint; businessDate: string },
): Promise<void> {
  await tx.depositLedgerEntry.create({
    data: {
      reservationId: args.reservationId,
      paymentId: args.paymentId,
      kind: 'RECEIVED',
      amountMinor: args.amountMinor,
      businessDate: dbDate(args.businessDate),
    } as unknown as Prisma.DepositLedgerEntryUncheckedCreateInput, // tenant IDs come from the client
  });
}

/**
 * Moves what the booking's deposit ledger holds onto a newly opened folio (M4-13). Nothing to
 * do when it holds nothing. Returns the amount applied.
 */
export async function applyDeposit(
  tx: Tx,
  folio: { id: string; propertyId: string; currency: string; reservationId: string | null },
  windowId: string,
  userId: string | null,
  clock: Clock,
): Promise<bigint> {
  if (!folio.reservationId) return 0n;
  await lockReservation(tx, folio.reservationId);
  const held = await depositHeld(tx, folio.reservationId);
  if (held <= 0n) return 0n;
  const date = await postingDate(tx, folio.propertyId, clock);
  const entry = await tx.depositLedgerEntry.create({
    data: {
      reservationId: folio.reservationId,
      kind: 'APPLIED',
      amountMinor: -held,
      businessDate: dbDate(date),
    } as unknown as Prisma.DepositLedgerEntryUncheckedCreateInput, // tenant IDs come from the client
  });
  const line = await tx.folioLine.create({
    data: {
      propertyId: folio.propertyId,
      folioId: folio.id,
      windowId,
      businessDate: dbDate(date),
      postedAt: clock(),
      kind: 'DEPOSIT_APPLY',
      revenueCodeId: await systemCodeId(tx, 'DEPOSIT'),
      description: 'Advance deposit applied',
      quantity: 1,
      unitAmountMinor: -held,
      amountMinor: -held,
      currency: folio.currency,
      sourceType: 'DEPOSIT',
      sourceId: entry.id,
      postedById: userId,
    },
  });
  await recordAudit(tx, {
    action: 'deposit.applied',
    entityType: 'reservation',
    entityId: folio.reservationId,
    after: { folioId: folio.id, folioLineId: line.id, amountMinor: held.toString() },
  });
  return held;
}

/** Bookings among `reservationIds` whose deposits received cover what is due. */
export async function depositsCovered(db: Client, due: Map<string, bigint>): Promise<Set<string>> {
  const ids = [...due.keys()];
  if (ids.length === 0) return new Set();
  const received = await db.depositLedgerEntry.groupBy({
    by: ['reservationId'],
    where: { reservationId: { in: ids }, kind: 'RECEIVED' },
    _sum: { amountMinor: true },
  });
  const got = new Map(received.map((r) => [r.reservationId, r._sum.amountMinor ?? 0n]));
  return new Set(ids.filter((id) => (got.get(id) ?? 0n) >= (due.get(id) ?? 0n)));
}
