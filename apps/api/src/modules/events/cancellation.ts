import {
  cancellationRuleOf,
  EventCancellationRule,
  type EventCancelBody,
  type EventCancellationView,
} from '@hotel/shared';
import type { z } from 'zod';
import { recordAudit } from '../../core/audit.ts';
import { raisedBy } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { postChargeLines } from '../folios/service.ts';
import { LIVE_CONTRACT } from './allocation.ts';
import { lockBooking, REVENUE_CODE } from './sales.ts';
import { BOOKING_INCLUDE, bookingOf, type EventDeps } from './service.ts';

// Cancelling an event (T-121b, T-121c). The rule is the contract's own, or for a booking
// confirmed without one, the hotel's current rule (default EVENT_CANCELLATION).
// The share kept is of the deposit actually paid, so the fee with its tax never exceeds what
// the client has paid. Cancelling posts that fee to the event's bill; the rest is refunded
// through the normal refund screen (with its approval), and then the event is closed.

type TenantTx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type View = z.input<typeof EventCancellationView>;

const HOUR = 3_600_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The hotel's rule for contracts issued now. */
export async function hotelRule(db: TenantDb | TenantTx, propertyId: string) {
  const property = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  const settings = (property.settings ?? {}) as Record<string, unknown>;
  return cancellationRuleOf(settings['eventCancellation']);
}

export async function getSettings(deps: EventDeps, tenant: TenantContext) {
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
  });
  const settings = (property.settings ?? {}) as Record<string, unknown>;
  return {
    cancellation: cancellationRuleOf(settings['eventCancellation']),
    isDefault: !EventCancellationRule.safeParse(settings['eventCancellation']).success,
  };
}

export async function updateSettings(
  deps: EventDeps,
  tenant: TenantContext,
  rule: EventCancellationRule,
) {
  await deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM properties WHERE id = ${tenant.propertyId}::uuid FOR UPDATE`;
    const property = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
    const settings = (property.settings ?? {}) as Record<string, unknown>;
    await tx.property.update({
      where: { id: tenant.propertyId },
      data: { settings: { ...settings, eventCancellation: rule } as never },
    });
    await recordAudit(tx, {
      action: 'event_settings.updated',
      entityType: 'property',
      entityId: tenant.propertyId,
      before: { eventCancellation: cancellationRuleOf(settings['eventCancellation']) },
      after: { eventCancellation: rule },
    });
  });
  return getSettings(deps, tenant);
}

async function assess(db: TenantDb | TenantTx, bookingId: string, now: Date) {
  const booking = await db.eventBooking.findFirst({ where: { id: bookingId } });
  if (!booking) throw new AppError('NOT_FOUND', 'Booking not found');
  const contract = await db.eventContract.findFirst({
    where: { bookingId, status: { in: [...LIVE_CONTRACT] } },
    include: { schedule: true, deposits: true },
  });
  const received = (contract?.deposits ?? []).reduce((sum, d) => sum + d.amountMinor, 0n);
  const depositPaid = (contract?.schedule ?? [])
    .filter((s) => s.kind === 'DEPOSIT')
    .reduce((sum, s) => sum + s.paidMinor, 0n);
  const rule = contract
    ? cancellationRuleOf(contract.cancellationRule)
    : await hotelRule(db, booking.propertyId);
  const bookedAt = booking.confirmedAt ?? contract?.issuedAt ?? null;
  const early = bookedAt !== null && now.getTime() - bookedAt.getTime() < rule.earlyHours * HOUR;
  const keepBps = early ? rule.earlyKeepBps : rule.laterKeepBps;

  let reason: View['reason'] = null;
  const live = booking.status === 'CONFIRMED' && !booking.inspectedAt;
  if (booking.status === 'HOLD') {
    // An unpaid hold is simply released.
    if (received === 0n) reason = 'NOTHING_TO_CANCEL';
  } else if (!live) {
    reason = 'NOT_CANCELLABLE';
  }
  if (!reason && booking.startsAt.getTime() - now.getTime() < rule.noticeHours * HOUR) {
    reason = 'TOO_CLOSE';
  }
  const fee = (depositPaid * BigInt(keepBps)) / 10_000n;
  return { booking, contract, rule, reason, bookedAt, keepBps, depositPaid, fee, received };
}

export async function getCancellation(deps: EventDeps, bookingId: string): Promise<View> {
  const a = await assess(deps.tenantDb, bookingId, deps.clock());
  return {
    allowed: a.reason === null,
    reason: a.reason,
    bookedAt: a.bookedAt ? iso(a.bookedAt) : null,
    keepBps: a.keepBps,
    depositPaidMinor: a.depositPaid.toString(),
    feeMinor: a.fee.toString(),
    receivedMinor: a.received.toString(),
    rule: a.rule,
  };
}

const message = (reason: NonNullable<View['reason']>, rule: EventCancellationRule) =>
  reason === 'TOO_CLOSE'
    ? `Within ${rule.noticeHours} hours of the event it can no longer be cancelled`
    : MESSAGES[reason];

const MESSAGES: Record<Exclude<NonNullable<View['reason']>, 'TOO_CLOSE'>, string> = {
  NOTHING_TO_CANCEL: 'Nothing has been paid on this hold: release it instead',
  NOT_CANCELLABLE: 'Only a confirmed or paid booking that has not taken place can be cancelled',
};

export async function cancelBooking(
  deps: EventDeps,
  tenant: TenantContext,
  bookingId: string,
  body: z.output<typeof EventCancelBody>,
) {
  const now = deps.clock();
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      await lockBooking(tx, bookingId);
      const a = await assess(tx, bookingId, now);
      if (a.reason) {
        throw new AppError('STATE_TRANSITION_INVALID', message(a.reason, a.rule), {
          reason: a.reason,
        });
      }
      const folioId = a.contract?.folioId ?? null;
      if (a.fee > 0n && a.contract && folioId) {
        const folio = await tx.folio.findFirst({
          where: { id: folioId },
          include: { windows: true },
        });
        const windowId = folio?.windows.find((w) => w.number === 1)?.id;
        const code = await tx.revenueCode.findFirst({ where: { code: REVENUE_CODE.EXTRA } });
        if (folio?.status !== 'OPEN' || !windowId || !code) {
          throw new AppError('STATE_TRANSITION_INVALID', 'The event’s bill is not open');
        }
        await postChargeLines(
          { tx, tenant, approvalRequestId: null, now },
          {
            folio,
            windowId,
            code,
            description: `Cancellation: ${a.keepBps / 100}% of the deposit`,
            quantity: 1,
            unitAmountMinor: a.fee,
            note: body.reason,
            sourceType: 'EVENT',
            sourceId: bookingId,
          },
        );
      }
      if (a.contract) {
        await tx.eventContract.update({
          where: { id: a.contract.id },
          data: { status: 'VOID', version: { increment: 1 } },
        });
      }
      await tx.virtualAccount.updateMany({
        where: { ownerType: 'EVENT', ownerId: bookingId },
        data: { active: false },
      });
      await tx.eventBooking.update({
        where: { id: bookingId },
        data: {
          status: 'CANCELLED',
          holdExpiresAt: null,
          cancelledAt: now,
          cancelReason: body.reason,
          cancellationFeeMinor: a.fee,
          folioId,
          version: { increment: 1 },
        },
      });
      if (a.booking.enquiryId) {
        await tx.eventEnquiry.updateMany({
          where: { id: a.booking.enquiryId, status: { in: ['OPEN', 'WON'] } },
          data: { status: 'LOST', lostReason: `Cancelled: ${body.reason}`, updatedAt: now },
        });
      }
      await recordAudit(tx, {
        action: 'event_booking.cancelled',
        entityType: 'event_booking',
        entityId: bookingId,
        reason: body.reason,
        before: { status: a.booking.status },
        after: {
          status: 'CANCELLED',
          keepBps: a.keepBps,
          depositPaidMinor: a.depositPaid.toString(),
          feeMinor: a.fee.toString(),
        },
      });
      const row = await tx.eventBooking.findUniqueOrThrow({
        where: { id: bookingId },
        include: BOOKING_INCLUDE,
      });
      return bookingOf(row);
    });
  } catch (err) {
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
}
