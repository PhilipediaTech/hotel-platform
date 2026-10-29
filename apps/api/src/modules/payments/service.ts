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

// Manual payments (PRD M4-08, M4 rules 1, 4, 5; tab 4 POST /payments; T-062). A payment is
// taken at the desk onto a folio window, on the cashier's open shift (SHIFT_NOT_OPEN
// otherwise) and the business date. Desk payments have provider MANUAL; a reference is used
// once per property and method (open issue 19, PAYMENT_DUPLICATE). Rows are never changed
// (trigger); refunds are their own negative rows (T-072).

export interface PaymentDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

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

export async function capturePayment(
  deps: PaymentDeps,
  tenant: TenantContext,
  body: z.output<typeof PaymentBody>,
) {
  let result: { paymentId: string; shiftId: string; folioId: string };
  try {
    result = await deps.tenantDb.$transaction(async (tx) => {
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
      const currency = body.currency ?? folio.currency;
      if (currency !== folio.currency) {
        throw invalid('body.currency', `Payments are taken in ${folio.currency} for now`);
      }
      if (!enabledMethods(folio.property.settings).includes(body.method)) {
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

      const date = await businessDate(tx, folio.propertyId, deps.clock);
      const amount = BigInt(body.amountMinor);
      const payment = await tx.payment.create({
        data: {
          folioId: folio.id,
          windowId: window.id,
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
      const facts = {
        folioId: folio.id,
        window: window.number,
        method: body.method,
        amountMinor: body.amountMinor,
        currency,
        externalRef: body.externalRef,
        shiftId: shift.id,
      };
      await recordAudit(tx, {
        action: 'payment.captured',
        entityType: 'payment',
        entityId: payment.id,
        after: facts,
        reason: body.note ?? undefined,
      });
      await recordEvent(tx, {
        type: 'payment.captured',
        payload: { paymentId: payment.id, ...facts },
      });
      return { paymentId: payment.id, shiftId: shift.id, folioId: folio.id };
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
  const balances = await folioBalances(deps.tenantDb, [result.folioId]);
  return {
    paymentId: result.paymentId,
    shiftId: result.shiftId,
    balanceMinor: (balances.get(result.folioId) ?? 0n).toString(),
  };
}
