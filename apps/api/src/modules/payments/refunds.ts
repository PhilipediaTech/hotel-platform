import { microsToRate, toBaseMinor, type RefundBody } from '@hotel/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import {
  performOrRequest,
  type ApprovalActionHandler,
  type ExecuteContext,
} from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import { postingDate } from '../../core/business-day.ts';
import { pgErrorInfo, raisedBy } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { folioBalances } from '../folios/service.ts';
import { systemCodeId } from '../folios/system-codes.ts';
import { rateFor } from '../fx/service.ts';
import { depositHeld, lockReservation } from './deposits.ts';
import type { PaymentDeps } from './service.ts';

// Refunds (PRD M4 "as finance, I refund a payment (original method where possible) with
// reason and approval"; M1 rule 2 "any refund" needs approval; tab 4 POST
// /payments/{id}/refund; T-072). A refund is a negative payment pointing at the original
// (append-only, M4 rule 1), on the refunder's open shift (M4 rule 4), never more than is left
// of it. A folio refund needs the folio open. A deposit refund takes its base value out of the
// booking's deposit ledger (REFUNDED). A foreign refund on a folio uses the business date's
// rate; the difference from the original rate posts to the FX revenue code so the folio sees
// the money at the value it came in at (M4 rule 6).

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = Tx | TenantDb;

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

const RefundStored = z.object({
  paymentId: z.string(),
  amountMinor: z.string(),
  method: z.string(),
  externalRef: z.string().nullable(),
  reason: z.string(),
  /** Base value of the refund at the original rate, for the approval threshold. */
  baseAmountMinor: z.string(),
});
type RefundPayload = z.output<typeof RefundStored>;

/** The payment, what is left of it, and its base value per unit of its own currency. */
async function refundable(db: Client, paymentId: string) {
  const original = await db.payment.findUnique({
    where: { id: paymentId },
    include: { refundedBy: { select: { amountMinor: true } }, folio: true, reservation: true },
  });
  if (!original) throw new AppError('NOT_FOUND', 'Payment not found');
  if (original.refundsPaymentId) {
    throw new AppError('STATE_TRANSITION_INVALID', 'A refund is not refunded', {
      reason: 'IS_REFUND',
    });
  }
  // The schedule counts this money as paid: until the event is inspected and its final bill
  // is known, nothing can be said to be owed back (M9-08).
  const held = await db.eventDeposit.findFirst({
    where: { paymentId },
    include: { contract: { include: { booking: true } } },
  });
  const settling =
    held?.contract.booking.inspectedAt || held?.contract.booking.status === 'CANCELLED';
  if (held && !settling) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'Event money can be refunded once the event has been inspected or cancelled',
      { reason: 'EVENT_MONEY' },
    );
  }
  const left = original.amountMinor + original.refundedBy.reduce((s, r) => s + r.amountMinor, 0n);
  return { original, left };
}

/** Base value of `amount` of the payment's currency at the payment's own rate. */
const atOriginalRate = (p: { rateMicros: bigint | null }, amount: bigint) =>
  p.rateMicros === null ? amount : toBaseMinor(amount, p.rateMicros);

async function refund(ctx: ExecuteContext & { now: Date }, p: RefundPayload): Promise<string> {
  const { tx, tenant } = ctx;
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${p.paymentId}::uuid FOR UPDATE`;
  const { original, left } = await refundable(tx, p.paymentId);
  const amount = BigInt(p.amountMinor);
  if (amount > left) {
    throw invalid(
      'body.amountMinor',
      left > 0n ? 'More than is left of the payment' : 'Already refunded',
    );
  }
  if (original.folio && original.folio.status !== 'OPEN') {
    throw new AppError('STATE_TRANSITION_INVALID', 'This folio is no longer open', {
      status: original.folio.status,
    });
  }
  const shift = await tx.cashierShift.findFirst({
    where: { userId: tenant.userId, status: 'OPEN', outletId: null },
  });
  if (shift)
    await tx.$queryRaw`SELECT id FROM cashier_shifts WHERE id = ${shift.id}::uuid FOR UPDATE`;
  const open = shift ? await tx.cashierShift.findUnique({ where: { id: shift.id } }) : null;
  if (!open || open.status !== 'OPEN') {
    throw new AppError('SHIFT_NOT_OPEN', 'Open a cashier shift before refunding');
  }
  const date = await postingDate(tx, original.propertyId, () => ctx.now);

  // What the refund is worth in the base currency.
  const valueThen = atOriginalRate(original, amount);
  let rateMicros = original.rateMicros;
  let baseOut = valueThen;
  if (original.rateMicros !== null && original.folioId) {
    // A folio refund in a foreign currency pays out at today's rate (M4 rule 6).
    const today = await rateFor(tx, original.currency, date);
    rateMicros = today?.rateMicros ?? original.rateMicros;
    baseOut = toBaseMinor(amount, rateMicros);
  }
  if (original.reservationId && !original.folioId) {
    await lockReservation(tx, original.reservationId);
    const held = await depositHeld(tx, original.reservationId);
    if (valueThen > held) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'The deposit has already moved to the guest bill: refund from the folio',
        { reason: 'DEPOSIT_APPLIED', heldMinor: held.toString() },
      );
    }
  }

  const row = await tx.payment.create({
    data: {
      folioId: original.folioId,
      windowId: original.windowId,
      reservationId: original.reservationId,
      method: p.method,
      amountMinor: -amount,
      currency: original.currency,
      rateMicros,
      baseAmountMinor: -baseOut,
      provider: 'MANUAL',
      externalRef: p.externalRef,
      businessDate: dbDate(date),
      shiftId: open.id,
      receivedById: tenant.userId,
      refundsPaymentId: original.id,
      approvalRequestId: ctx.approvalRequestId,
      note: p.reason,
      createdAt: ctx.now,
    } as unknown as Prisma.PaymentUncheckedCreateInput, // tenant IDs come from the client
  });

  if (original.reservationId && !original.folioId) {
    await tx.depositLedgerEntry.create({
      data: {
        reservationId: original.reservationId,
        paymentId: row.id,
        kind: 'REFUNDED',
        amountMinor: -valueThen,
        businessDate: dbDate(date),
      } as unknown as Prisma.DepositLedgerEntryUncheckedCreateInput, // tenant IDs come from the client
    });
  }

  // The rate moved: the folio keeps the money at the value it came in at; the difference is
  // the hotel's exchange gain (positive line) or loss (negative).
  const difference = valueThen - baseOut;
  if (difference !== 0n && original.folioId && original.windowId) {
    await tx.folioLine.create({
      data: {
        propertyId: original.propertyId,
        folioId: original.folioId,
        windowId: original.windowId,
        businessDate: dbDate(date),
        postedAt: ctx.now,
        kind: 'CHARGE',
        revenueCodeId: await systemCodeId(tx, 'FX'),
        description: `Exchange difference on refund of ${original.currency} ${(Number(amount) / 100).toFixed(2)} at ${microsToRate(rateMicros ?? 0n)}`,
        quantity: 1,
        unitAmountMinor: difference,
        amountMinor: difference,
        currency: original.folio?.currency ?? 'NGN',
        sourceType: 'FX',
        sourceId: row.id,
        postedById: tenant.userId,
        shiftId: open.id,
        approvalRequestId: ctx.approvalRequestId,
        reason: p.reason,
      },
    });
  }

  const facts = {
    refundsPaymentId: original.id,
    amountMinor: p.amountMinor,
    currency: original.currency,
    method: p.method,
    baseAmountMinor: (-baseOut).toString(),
    ...(difference !== 0n ? { fxDifferenceMinor: difference.toString() } : {}),
  };
  await recordAudit(tx, {
    action: 'payment.refunded',
    entityType: 'payment',
    entityId: row.id,
    reason: p.reason,
    approvalRequestId: ctx.approvalRequestId ?? undefined,
    after: facts,
  });
  await recordEvent(tx, { type: 'payment.refunded', payload: { refundId: row.id, ...facts } });
  return row.id;
}

export function refundHandler(deps: PaymentDeps): ApprovalActionHandler<RefundPayload> {
  return {
    action: 'payment.refund',
    payload: RefundStored,
    measure: (p) => ({ amountMinor: BigInt(p.baseAmountMinor) }),
    execute: (ctx, p) => refund({ ...ctx, now: deps.clock() }, p),
  };
}

export async function refundPayment(
  deps: PaymentDeps,
  tenant: TenantContext,
  paymentId: string,
  body: z.output<typeof RefundBody>,
) {
  // Checked before any approval request, so a manager is never asked for the impossible.
  const { original, left } = await refundable(deps.tenantDb, paymentId);
  const amount = BigInt(body.amountMinor);
  if (amount > left) {
    throw invalid(
      'body.amountMinor',
      left > 0n ? 'More than is left of the payment' : 'Already refunded',
    );
  }
  const method = body.method ?? original.method;
  if (method !== 'CASH' && body.externalRef === null && method !== original.method) {
    throw invalid(
      'body.externalRef',
      'Give the reference of the refund (transfer or POS reversal)',
    );
  }
  let result;
  try {
    result = await performOrRequest(
      { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
      tenant,
      refundHandler(deps),
      {
        paymentId,
        amountMinor: body.amountMinor,
        method,
        externalRef: body.externalRef,
        reason: body.reason,
        baseAmountMinor: atOriginalRate(original, amount).toString(),
      },
      body.reason,
    );
  } catch (err) {
    if (pgErrorInfo(err)?.constraint === 'payments_manual_ref_key') {
      throw new AppError(
        'PAYMENT_DUPLICATE',
        'This reference has already been used for a payment',
        {
          method,
          externalRef: body.externalRef,
        },
      );
    }
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
  if (!('resultRef' in result)) return result;
  const row = await deps.tenantDb.payment.findUniqueOrThrow({ where: { id: result.resultRef } });
  const balance = row.folioId
    ? ((await folioBalances(deps.tenantDb, [row.folioId])).get(row.folioId) ?? 0n)
    : await depositHeld(deps.tenantDb, row.reservationId ?? '');
  return {
    refundId: row.id,
    shiftId: row.shiftId,
    baseAmountMinor: row.baseAmountMinor.toString(),
    balanceMinor: balance.toString(),
  };
}
