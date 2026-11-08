import type { Logger } from 'pino';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { PaymentProvider } from '../../core/payments.ts';
import { runAsTenant, type TenantContext } from '../../core/tenancy.ts';
import { createTenantDb } from '../../core/tenant-db.ts';
import { queueMessage } from '../notifications/delivery.ts';
import { reinstateReservation, updateReservation } from '../reservations/service.ts';

// What happens once a booking-page payment lands (PRD M11 rules; T-112): the hold is confirmed.
// If the hold ran out first, the booking stands again when a room is left; otherwise the
// money goes back on its own and the guest is told. Only bookings made on the booking page.

export interface AfterPaymentDeps {
  db: Db;
  clock: Clock;
  provider: PaymentProvider;
  logger?: Logger;
}

/** The booking page acts for nobody: audit shows SYSTEM, and no user is named on rows. */
export function guestTenant(property: { id: string; organisationId: string }): TenantContext {
  return {
    userId: null as unknown as string,
    organisationId: property.organisationId,
    propertyId: property.id,
    roles: [],
    permissions: new Set(),
  };
}

const short = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);

function money(minor: bigint, currency: string) {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(
    Number(minor) / 100,
  );
}

async function loadBooking(db: Db, reservationId: string) {
  return db.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: {
      booker: true,
      property: true,
      stays: { include: { roomType: true, quote: true } },
    },
  });
}
type Booking = Awaited<ReturnType<typeof loadBooking>>;

/** Tells the guest a booking is confirmed, by email and WhatsApp; once per booking. */
export async function queueConfirmation(db: Db, booking: Booking): Promise<void> {
  const [stay] = booking.stays;
  if (!stay) return;
  const vars = {
    guest_name: `${booking.booker.firstName} ${booking.booker.lastName}`,
    property_name: booking.property.name,
    confirmation_no: booking.confirmationNo,
    arrival: short(stay.arrival),
    departure: short(stay.departure),
    room_type: stay.roomType.name,
    total: money(
      booking.stays.reduce((sum, s) => sum + s.quote.totalMinor, 0n),
      booking.property.baseCurrency,
    ),
  };
  const ref = `booking_confirmed:${booking.id}`;
  const common = {
    organisationId: booking.organisationId,
    propertyId: booking.propertyId,
    templateCode: 'BOOKING_CONFIRMED',
    vars,
    ref,
  };
  if (booking.booker.email) {
    await queueMessage(db, { ...common, channel: 'EMAIL', recipient: booking.booker.email });
  }
  if (booking.booker.phone) {
    await queueMessage(db, { ...common, channel: 'WHATSAPP', recipient: booking.booker.phone });
  }
}

/** Sends the money back and records it: the room it was for has gone. */
async function refundLatePayment(
  deps: AfterPaymentDeps,
  booking: Booking,
  intent: { id: string; paymentId: string | null; providerRef: string; amountMinor: bigint },
): Promise<void> {
  if (!intent.paymentId) return;
  const paymentId = intent.paymentId;
  await deps.provider.refund(intent.providerRef, intent.amountMinor);
  const now = deps.clock();
  await deps.db.$transaction(async (tx) => {
    const original = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const row = await tx.payment.create({
      data: {
        propertyId: original.propertyId,
        reservationId: original.reservationId,
        method: original.method,
        amountMinor: -original.amountMinor,
        currency: original.currency,
        baseAmountMinor: -original.baseAmountMinor,
        provider: original.provider,
        externalRef: `${intent.providerRef}-REFUND`,
        businessDate: original.businessDate,
        shiftId: original.shiftId,
        refundsPaymentId: original.id,
        note: 'Refunded automatically: the hold ran out and no room was left',
        createdAt: now,
      },
    });
    await tx.depositLedgerEntry.create({
      data: {
        propertyId: original.propertyId,
        reservationId: booking.id,
        paymentId: row.id,
        kind: 'REFUNDED',
        amountMinor: -original.amountMinor,
        businessDate: original.businessDate,
      },
    });
    await recordAudit(tx, {
      organisationId: booking.organisationId,
      propertyId: booking.propertyId,
      actorType: 'SYSTEM',
      actorUserId: null,
      action: 'payment.refunded',
      entityType: 'payment',
      entityId: row.id,
      reason: 'The hold ran out and no room was left',
      after: { refundsPaymentId: original.id, amountMinor: original.amountMinor.toString() },
    });
    if (booking.booker.email) {
      await queueMessage(tx, {
        organisationId: booking.organisationId,
        propertyId: booking.propertyId,
        channel: 'EMAIL',
        templateCode: 'BOOKING_REFUNDED',
        recipient: booking.booker.email,
        ref: `booking_refunded:${booking.id}`,
        vars: {
          guest_name: `${booking.booker.firstName} ${booking.booker.lastName}`,
          property_name: booking.property.name,
          confirmation_no: booking.confirmationNo,
          amount: money(original.amountMinor, original.currency),
        },
      });
    }
  });
}

/** Called once, when a link's payment is first recorded. Other payments are left alone. */
export async function afterOnlinePayment(deps: AfterPaymentDeps, intentId: string): Promise<void> {
  const intent = await deps.db.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
  if (!intent.reservationId) return;
  const link = await deps.db.guestLink.findFirst({
    where: { reservationId: intent.reservationId },
  });
  if (!link) return;
  const reservationId = intent.reservationId;
  const booking = await loadBooking(deps.db, reservationId);
  const rdeps = { db: deps.db, tenantDb: createTenantDb(deps.db), clock: deps.clock };
  const tenant = guestTenant(booking.property);

  if (booking.status === 'TENTATIVE') {
    await runAsTenant(tenant, () =>
      updateReservation(rdeps, tenant, reservationId, `"${booking.version}"`, { confirm: true }),
    );
    await queueConfirmation(deps.db, booking);
    return;
  }
  if (booking.status !== 'CANCELLED' || booking.cancelReason !== 'HOLD_EXPIRED') return;
  try {
    await runAsTenant(tenant, () => reinstateReservation(rdeps, tenant, reservationId));
    await queueConfirmation(deps.db, booking);
  } catch (err) {
    const noRoom = err instanceof AppError && err.code === 'BOOKING_CONFLICT';
    const dateGone =
      err instanceof AppError &&
      err.code === 'STATE_TRANSITION_INVALID' &&
      (err.details as { reason?: string } | undefined)?.reason === 'ARRIVAL_PASSED';
    if (!noRoom && !dateGone) throw err;
    await refundLatePayment(deps, booking, intent);
  }
}
