import type { ExecuteContext } from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { openFolio, postChargeLines, routedWindow } from '../folios/service.ts';
import { systemCodeId, type SystemCode } from '../folios/system-codes.ts';

// Booking fees (PRD M3 "cancellation fees apply per policy", the no-show story and rule;
// T-073b, T-074). A cancellation or no-show fee is a charge on the stay's own guest folio,
// opened for it if it has none; opening it moves the booking's advance deposit onto it as at
// check-in, so a deposit pays the fee and any rest is a credit refunded from the folio
// (T-072). Fees post to the system codes CANCEL and NOSHOW (group FEE, no tax until Philip
// sets the tax stack). Reinstating a booking reverses its fees. A late check-out fee (LATE,
// T-055) goes the same way.

type Ctx = ExecuteContext & { now: Date };

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

/** The source types of booking fees, on their lines. */
export const FEE_SOURCES = {
  CANCEL: 'CANCELLATION',
  NOSHOW: 'NO_SHOW',
  LATE: 'LATE_CHECK_OUT',
} as const;

/** Posts a fee for a stay; answers the folio it went on. */
export async function postBookingFee(
  ctx: Ctx,
  args: {
    stay: {
      id: string;
      propertyId: string;
      reservationId: string;
      guestId: string;
      folioId: string | null;
    };
    code: Extract<SystemCode, 'CANCEL' | 'NOSHOW' | 'LATE'>;
    amountMinor: bigint;
    description: string;
    businessDate: string;
    clock: Clock;
  },
): Promise<string> {
  const { tx } = ctx;
  const folioId = await openFolio(tx, args.stay, args.clock, args.businessDate);
  const folio = await tx.folio.findUniqueOrThrow({
    where: { id: folioId },
    include: { windows: true, routingRules: true },
  });
  const code = await tx.revenueCode.findUniqueOrThrow({
    where: { id: await systemCodeId(tx, args.code) },
  });
  await postChargeLines(ctx, {
    folio,
    windowId: routedWindow(folio, code) ?? '',
    code,
    description: args.description,
    quantity: 1,
    unitAmountMinor: args.amountMinor,
    note: null,
    sourceType: FEE_SOURCES[args.code],
    sourceId: args.stay.id,
    businessDate: args.businessDate,
  });
  return folioId;
}

/** Reverses the booking fees of these stays not reversed yet; answers how many. */
export async function reverseBookingFees(
  ctx: Ctx,
  args: { stayIds: string[]; reason: string; businessDate: string },
): Promise<number> {
  const { tx } = ctx;
  const fees = await tx.folioLine.findMany({
    where: {
      kind: 'CHARGE',
      // Booking fees only: a late check-out fee stays when a booking is reinstated.
      sourceType: { in: [FEE_SOURCES.CANCEL, FEE_SOURCES.NOSHOW] },
      sourceId: { in: args.stayIds },
      reversedBy: { is: null },
    },
  });
  for (const fee of fees) {
    const reversal = await tx.folioLine.create({
      data: {
        propertyId: fee.propertyId,
        folioId: fee.folioId,
        windowId: fee.windowId,
        businessDate: dbDate(args.businessDate),
        postedAt: ctx.now,
        kind: 'REVERSAL',
        revenueCodeId: fee.revenueCodeId,
        description: `Reversal: ${fee.description}`,
        quantity: fee.quantity,
        unitAmountMinor: -fee.unitAmountMinor,
        amountMinor: -fee.amountMinor,
        currency: fee.currency,
        reversesLineId: fee.id,
        postedById: ctx.tenant.userId,
        reason: args.reason,
      },
    });
    await recordAudit(tx, {
      action: 'folio.line_reversed',
      entityType: 'folio',
      entityId: fee.folioId,
      reason: args.reason,
      before: { lineId: fee.id, amountMinor: fee.amountMinor.toString() },
      after: { reversalLineIds: [reversal.id] },
    });
  }
  return fees.length;
}
