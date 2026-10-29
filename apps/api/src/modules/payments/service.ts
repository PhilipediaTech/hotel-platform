import type { PaymentBody } from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, raisedBy, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { enabledMethods, folioBalances } from '../folios/service.ts';
import { depositHeld, lockReservation, receiveDeposit } from './deposits.ts';

// Manual payments (PRD M4-08, M4 rules 1, 4, 5; tab 4 POST /payments; T-062). A payment is
// taken at the desk onto a folio window, on the cashier's open shift (SHIFT_NOT_OPEN
// otherwise) and the business date. Desk payments have provider MANUAL; a reference is used
// once per property and method (open issue 19, PAYMENT_DUPLICATE). Rows are never changed
// (trigger); refunds are their own negative rows (T-072). A payment on a booking before
// arrival is an advance deposit (M4-13, T-063): it goes into the booking's deposit ledger.

export interface PaymentDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

const METHOD_NAMES: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  POS_TERMINAL: 'POS terminal',
  MOBILE_MONEY: 'Mobile money',
  VOUCHER: 'Voucher',
};

/** Where a payment goes: a folio window, or a booking's deposit ledger (M4-13). */
type Target =
  | { kind: 'folio'; folioId: string; windowId: string; windowNumber: number }
  | { kind: 'deposit'; reservationId: string };

/** Checks the folio or booking the payment is for; answers the target and its currency. */
async function targetOf(tx: Tx, body: z.output<typeof PaymentBody>) {
  if (body.folioId) {
    const folio = await tx.folio.findUnique({
      where: { id: body.folioId },
      include: { windows: true, property: true },
    });
    if (!folio) throw new AppError('NOT_FOUND', 'Folio not found');
    if (folio.status !== 'OPEN') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This folio is not open', {
        status: folio.status,
      });
    }
    const window = folio.windows.find((w) => w.number === body.windowNumber);
    if (!window) throw invalid('body.windowNumber', 'This folio has no such window');
    const target: Target = {
      kind: 'folio',
      folioId: folio.id,
      windowId: window.id,
      windowNumber: window.number,
    };
    return { target, property: folio.property, currency: folio.currency };
  }
  const reservation = await tx.reservation.findUnique({
    where: { id: body.reservationId ?? '' },
    include: { property: true },
  });
  if (!reservation) throw new AppError('NOT_FOUND', 'Reservation not found');
  if (reservation.status !== 'TENTATIVE' && reservation.status !== 'CONFIRMED') {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      reservation.status === 'CHECKED_IN'
        ? 'The guest is in: take the payment on the folio'
        : 'Only a booking still to arrive takes a deposit',
      { status: reservation.status },
    );
  }
  await lockReservation(tx, reservation.id);
  const target: Target = { kind: 'deposit', reservationId: reservation.id };
  return { target, property: reservation.property, currency: reservation.property.baseCurrency };
}

export async function capturePayment(
  deps: PaymentDeps,
  tenant: TenantContext,
  body: z.output<typeof PaymentBody>,
) {
  let result: { paymentId: string; shiftId: string; target: Target };
  try {
    result = await deps.tenantDb.$transaction(async (tx) => {
      const { target, property, currency: base } = await targetOf(tx, body);
      const currency = body.currency ?? base;
      if (currency !== base) {
        throw invalid('body.currency', `Payments are taken in ${base} for now`);
      }
      if (!enabledMethods(property.settings).includes(body.method)) {
        throw invalid(
          'body.method',
          `${METHOD_NAMES[body.method] ?? body.method} is not switched on for this hotel (setup, payment methods)`,
        );
      }

      // M4 rule 4: on the cashier's open shift. Locked so a close can't slip in between.
      const open = await tx.cashierShift.findFirst({
        where: { userId: tenant.userId, status: 'OPEN', outletId: null },
      });
      if (open)
        await tx.$queryRaw`SELECT id FROM cashier_shifts WHERE id = ${open.id}::uuid FOR UPDATE`;
      const shift = open ? await tx.cashierShift.findUnique({ where: { id: open.id } }) : null;
      if (!shift || shift.status !== 'OPEN') {
        throw new AppError('SHIFT_NOT_OPEN', 'Open a cashier shift before taking payments');
      }

      const date = await businessDate(tx, property.id, deps.clock);
      const amount = BigInt(body.amountMinor);
      const payment = await tx.payment.create({
        data: {
          ...(target.kind === 'folio'
            ? { folioId: target.folioId, windowId: target.windowId }
            : { reservationId: target.reservationId }),
          method: body.method,
          amountMinor: amount,
          currency,
          baseAmountMinor: amount,
          provider: 'MANUAL',
          externalRef: body.externalRef,
          businessDate: dbDate(date),
          shiftId: shift.id,
          receivedById: tenant.userId,
          note: body.note,
          createdAt: deps.clock(),
        } as unknown as Prisma.PaymentUncheckedCreateInput, // tenant IDs come from the client
      });
      if (target.kind === 'deposit') {
        await receiveDeposit(tx, {
          reservationId: target.reservationId,
          paymentId: payment.id,
          amountMinor: amount,
          businessDate: date,
        });
      }
      const facts = {
        ...(target.kind === 'folio'
          ? { folioId: target.folioId, window: target.windowNumber }
          : { reservationId: target.reservationId, deposit: true }),
        method: body.method,
        amountMinor: body.amountMinor,
        currency,
        externalRef: body.externalRef,
        shiftId: shift.id,
      };
      await recordAudit(tx, {
        action: target.kind === 'folio' ? 'payment.captured' : 'deposit.received',
        entityType: 'payment',
        entityId: payment.id,
        after: facts,
        reason: body.note ?? undefined,
      });
      await recordEvent(tx, {
        type: 'payment.captured',
        payload: { paymentId: payment.id, ...facts },
      });
      return { paymentId: payment.id, shiftId: shift.id, target };
    });
  } catch (err) {
    if (pgErrorInfo(err)?.constraint === 'payments_manual_ref_key') {
      throw new AppError(
        'PAYMENT_DUPLICATE',
        'This reference has already been used for a payment',
        {
          method: body.method,
          externalRef: body.externalRef,
        },
      );
    }
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
  const { target } = result;
  const balance =
    target.kind === 'folio'
      ? ((await folioBalances(deps.tenantDb, [target.folioId])).get(target.folioId) ?? 0n)
      : await depositHeld(deps.tenantDb, target.reservationId);
  return {
    paymentId: result.paymentId,
    shiftId: result.shiftId,
    balanceMinor: balance.toString(),
  };
}
