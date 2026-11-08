import { PAYMENT_LINK_HOURS, type PaymentIntentBody, type PaymentIntentItem } from '@hotel/shared';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { postingDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, raisedBy, type Db } from '../../core/db.ts';
import type { EmailProvider } from '../../core/email.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import {
  newPaymentReference,
  PaymentProviderError,
  type Charge,
  type PaymentProvider,
} from '../../core/payments.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { houseRights } from '../folios/service.ts';
import { afterOnlinePayment } from '../bookingengine/after-payment.ts';
import { money } from './documents.ts';

// Payment links (PRD M4-07 online card, M4-08; tab 4 POST /payment-intents ●; ADR-021; T-070).
// A link is a hosted checkout at the provider under our reference, for a folio window or a
// booking's deposit, in the base currency. When the provider says the charge succeeded, it is
// recorded once (the intent row is locked; payments are unique per provider and reference) as
// a CARD_ONLINE payment on the property's system shift (M4 rule 4: provider money is not in a
// cashier's drawer) on the open business day. A booking whose guest has checked in since is
// paid on their folio instead. Checked by the cashier, by a job every 5 minutes, and from T-071
// by the webhook (which calls `settleIntent` too).

export interface IntentDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
  provider: PaymentProvider;
  email: EmailProvider;
  logger?: Logger;
}

type Intent = Prisma.PaymentIntentGetPayload<{ include: { requestedBy: true } }>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });
/** Checked by the job for a week after they were made, paid or not. */
const WATCH_DAYS = 7;

function unavailable(err: unknown): never {
  if (err instanceof PaymentProviderError) {
    throw new AppError(
      'PAYMENT_PROVIDER_UNAVAILABLE',
      'The payment provider could not be reached; try again in a minute',
    );
  }
  throw err;
}

export function intentItem(i: Intent): z.input<typeof PaymentIntentItem> {
  return {
    id: i.id,
    folioId: i.folioId,
    windowNumber: i.windowNumber,
    reservationId: i.reservationId,
    provider: i.provider,
    reference: i.providerRef,
    amountMinor: i.amountMinor.toString(),
    currency: i.currency,
    status: i.status as z.input<typeof PaymentIntentItem>['status'],
    checkoutUrl: i.checkoutUrl,
    sentTo: i.sentTo,
    requestedBy: i.requestedBy?.name ?? null,
    paymentId: i.paymentId,
    paidAt: i.paidAt ? iso(i.paidAt) : null,
    expiresAt: iso(i.expiresAt),
    createdAt: iso(i.createdAt),
  };
}

async function loadIntent(db: TenantDb, id: string) {
  const intent = await db.paymentIntent.findUnique({
    where: { id },
    include: { requestedBy: true },
  });
  if (!intent) throw new AppError('NOT_FOUND', 'Payment link not found');
  return intent;
}

export async function createPaymentIntent(
  deps: IntentDeps,
  tenant: TenantContext,
  body: z.output<typeof PaymentIntentBody>,
  options: { callbackUrl: string | null } = { callbackUrl: null },
) {
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
  });
  // What the link pays, and what the guest reads it is for.
  let purpose: string;
  if (body.folioId) {
    const folio = await deps.tenantDb.folio.findUnique({
      where: { id: body.folioId },
      include: { windows: true },
    });
    if (!folio) throw new AppError('NOT_FOUND', 'Folio not found');
    if (folio.status !== 'OPEN') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This folio is not open', {
        status: folio.status,
      });
    }
    houseRights(folio, tenant);
    if (!folio.windows.some((w) => w.number === body.windowNumber)) {
      throw invalid('body.windowNumber', 'This folio has no such window');
    }
    purpose = `your bill ${folio.number}`;
  } else {
    const reservation = await deps.tenantDb.reservation.findUnique({
      where: { id: body.reservationId ?? '' },
    });
    if (!reservation) throw new AppError('NOT_FOUND', 'Reservation not found');
    if (reservation.status !== 'TENTATIVE' && reservation.status !== 'CONFIRMED') {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'Only a booking still to arrive takes a deposit link',
        { status: reservation.status },
      );
    }
    purpose = `a deposit on booking ${reservation.confirmationNo}`;
  }

  const reference = newPaymentReference();
  const amount = BigInt(body.amountMinor);
  const session = await deps.provider
    .createCheckout({
      reference,
      amountMinor: amount,
      currency: property.baseCurrency,
      email: body.email,
      callbackUrl: options.callbackUrl,
      metadata: { hotel: property.name, for: purpose },
    })
    .catch(unavailable);
  const now = deps.clock();
  const expiresAt = new Date(now.getTime() + PAYMENT_LINK_HOURS * 3_600_000);

  const intent = await deps.tenantDb.$transaction(async (tx) => {
    const created = await tx.paymentIntent.create({
      data: {
        ...(body.folioId
          ? { folioId: body.folioId, windowNumber: body.windowNumber }
          : { reservationId: body.reservationId }),
        provider: deps.provider.name,
        providerRef: reference,
        amountMinor: amount,
        currency: property.baseCurrency,
        idempotencyKey: randomUUID(),
        checkoutUrl: session.checkoutUrl,
        requestedById: tenant.userId,
        sentTo: body.send ? body.email : null,
        expiresAt,
        createdAt: now,
      } as unknown as Prisma.PaymentIntentUncheckedCreateInput, // tenant IDs come from the client
    });
    await recordAudit(tx, {
      action: 'payment.link_created',
      entityType: 'payment_intent',
      entityId: created.id,
      after: {
        reference,
        amountMinor: body.amountMinor,
        currency: property.baseCurrency,
        folioId: body.folioId ?? null,
        windowNumber: body.folioId ? body.windowNumber : null,
        reservationId: body.reservationId ?? null,
        sentTo: body.send ? body.email : null,
      },
    });
    return created;
  });

  if (body.send) {
    const amountText = money(amount, property.baseCurrency);
    await deps.email.send({
      to: body.email,
      subject: `Payment request from ${property.name}: ${amountText}`,
      text: [
        `${property.name} asks you to pay ${amountText} for ${purpose}.`,
        '',
        `Pay securely here: ${session.checkoutUrl}`,
        '',
        `The link works for ${PAYMENT_LINK_HOURS} hours. If you have already paid, ignore this message.`,
      ].join('\n'),
      tag: 'payment-request',
    });
  }
  return intentItem(await loadIntent(deps.tenantDb, intent.id));
}

export async function listPaymentIntents(
  deps: IntentDeps,
  query: { folioId?: string | undefined; reservationId?: string | undefined },
) {
  const rows = await deps.tenantDb.paymentIntent.findMany({
    where: query.folioId
      ? { folioId: query.folioId }
      : { reservationId: query.reservationId ?? '' },
    include: { requestedBy: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return { data: rows.map(intentItem) };
}

/** The cashier asks now (tab 4 beyond: POST /payment-intents/{id}/check). */
export async function checkPaymentIntent(deps: IntentDeps, id: string) {
  // Through the tenant client first: another property's link is not found.
  const intent = await loadIntent(deps.tenantDb, id);
  await settleIntent(deps, intent.id);
  return intentItem(await loadIntent(deps.tenantDb, intent.id));
}

/** The property's system shift for provider money (M4 rule 4), opened on first use. */
export async function systemShift(
  tx: Parameters<Parameters<Db['$transaction']>[0]>[0],
  propertyId: string,
  now: Date,
) {
  const open = await tx.cashierShift.findFirst({
    where: { propertyId, userId: null, outletId: null, status: 'OPEN' },
  });
  if (open) return open.id;
  await tx.$executeRaw`
    INSERT INTO cashier_shifts (id, property_id, status, float_minor, opened_at)
    VALUES (${randomUUID()}::uuid, ${propertyId}::uuid, 'OPEN', 0, ${now})
    ON CONFLICT DO NOTHING`;
  const shift = await tx.cashierShift.findFirstOrThrow({
    where: { propertyId, userId: null, outletId: null, status: 'OPEN' },
  });
  return shift.id;
}

/**
 * Asks the provider about one link and records what it says: a payment (once), FAILED, or
 * EXPIRED once past its time unpaid. Base client: called for any property by the job (and the
 * webhook); the request path checks the tenant first. Answers the link's status.
 */
export async function settleIntent(
  deps: Pick<IntentDeps, 'db' | 'clock' | 'provider' | 'logger'>,
  intentId: string,
  /** The charge as a signed webhook told it (T-071): no need to ask the provider again. */
  known?: Charge,
): Promise<string> {
  const { db } = deps;
  const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
  if (intent.status === 'SUCCEEDED') return intent.status;
  let charge: Charge;
  try {
    charge = known ?? (await deps.provider.verify(intent.providerRef));
  } catch (err) {
    unavailable(err);
  }
  const now = deps.clock();
  if (charge.status === 'PENDING') {
    if (intent.status === 'CREATED' && intent.expiresAt <= now) {
      await db.paymentIntent.updateMany({
        where: { id: intent.id, status: 'CREATED' },
        data: { status: 'EXPIRED' },
      });
      return 'EXPIRED';
    }
    return intent.status;
  }
  if (charge.status === 'FAILED') {
    await db.paymentIntent.updateMany({
      where: { id: intent.id, status: { in: ['CREATED', 'EXPIRED'] } },
      data: { status: 'FAILED' },
    });
    return 'FAILED';
  }
  if (charge.amountMinor !== intent.amountMinor || charge.currency !== intent.currency) {
    // Never a different amount from a hosted checkout; recorded for finance to look at.
    throw new Error(
      `Charge ${intent.providerRef} paid ${charge.currency} ${charge.amountMinor}, not ${intent.currency} ${intent.amountMinor}`,
    );
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payment_intents WHERE id = ${intent.id}::uuid FOR UPDATE`;
      const fresh = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
      if (fresh.status === 'SUCCEEDED') return;
      const property = await tx.property.findUniqueOrThrow({ where: { id: intent.propertyId } });
      const date = await postingDate(tx, intent.propertyId, deps.clock);

      // Where the money goes: the folio window asked for; or the booking's deposit, unless
      // the guest has checked in since (then their folio).
      let folioId = intent.folioId;
      let windowNumber = intent.windowNumber;
      if (!folioId && intent.reservationId) {
        await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${intent.reservationId}::uuid FOR UPDATE`;
        const stay = await tx.stay.findFirst({
          where: { reservationId: intent.reservationId, folioId: { not: null } },
          orderBy: { checkedInAt: 'asc' },
        });
        if (stay?.folioId) {
          folioId = stay.folioId;
          windowNumber = 1;
        }
      }
      const window = folioId
        ? await tx.folioWindow.findFirstOrThrow({ where: { folioId, number: windowNumber ?? 1 } })
        : null;
      const shiftId = await systemShift(tx, intent.propertyId, now);
      const payment = await tx.payment.create({
        data: {
          propertyId: intent.propertyId,
          ...(folioId && window
            ? { folioId, windowId: window.id }
            : { reservationId: intent.reservationId }),
          method: 'CARD_ONLINE',
          amountMinor: intent.amountMinor,
          currency: intent.currency,
          baseAmountMinor: intent.amountMinor,
          provider: intent.provider,
          externalRef: intent.providerRef,
          businessDate: dbDate(date),
          shiftId,
          receivedById: null,
          note: charge.channel ? `Paid online (${charge.channel})` : 'Paid online',
          createdAt: now,
        },
      });
      if (!folioId && intent.reservationId) {
        await tx.depositLedgerEntry.create({
          data: {
            propertyId: intent.propertyId,
            reservationId: intent.reservationId,
            paymentId: payment.id,
            kind: 'RECEIVED',
            amountMinor: intent.amountMinor,
            businessDate: dbDate(date),
          },
        });
      }
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'SUCCEEDED', paymentId: payment.id, paidAt: charge.paidAt ?? now },
      });
      const where = { organisationId: property.organisationId, propertyId: intent.propertyId };
      const facts = {
        ...(folioId
          ? { folioId, window: windowNumber }
          : { reservationId: intent.reservationId, deposit: true }),
        method: 'CARD_ONLINE',
        amountMinor: intent.amountMinor.toString(),
        currency: intent.currency,
        provider: intent.provider,
        externalRef: intent.providerRef,
        shiftId,
        paymentIntentId: intent.id,
      };
      await recordAudit(tx, {
        ...where,
        action: folioId ? 'payment.captured' : 'deposit.received',
        entityType: 'payment',
        entityId: payment.id,
        actorType: 'SYSTEM',
        actorUserId: null,
        after: facts,
      });
      await recordEvent(tx, {
        ...where,
        type: 'payment.captured',
        payload: { paymentId: payment.id, ...facts },
      });
    });
  } catch (err) {
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
  // A booking-page payment confirms its booking (T-112). The money is safely recorded by now;
  // a problem here is for the logs and must not make the provider send the payment again.
  await afterOnlinePayment(deps, intent.id).catch((err: unknown) => {
    deps.logger?.error(
      { err: pgErrorInfo(err) ?? String(err), intentId: intent.id },
      'After-payment step failed',
    );
  });
  return 'SUCCEEDED';
}

/** The job: links still open (or expired this week) are asked about; answers how many paid. */
export async function checkOpenIntents(
  deps: Pick<IntentDeps, 'db' | 'clock' | 'provider'> & { logger?: Logger },
): Promise<number> {
  const since = new Date(deps.clock().getTime() - WATCH_DAYS * 86_400_000);
  const open = await deps.db.paymentIntent.findMany({
    where: {
      provider: deps.provider.name,
      status: { in: ['CREATED', 'EXPIRED'] },
      createdAt: { gte: since },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  let paid = 0;
  for (const { id } of open) {
    try {
      if ((await settleIntent(deps, id)) === 'SUCCEEDED') paid += 1;
    } catch (err) {
      // The next run tries again (provider down, day being audited…).
      deps.logger?.warn(
        { intentId: id, code: err instanceof AppError ? err.code : 'ERROR' },
        'Payment link not checked',
      );
    }
  }
  return paid;
}
