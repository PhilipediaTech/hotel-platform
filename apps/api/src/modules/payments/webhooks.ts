import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate, postingDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { raisedBy, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { PaymentEvent, PaymentProvider } from '../../core/payments.ts';
import { parsePaystackEvent } from '../../core/paystack-events.ts';
import { numberParam, raiseAlert, ruleSettings, type RuleSettings } from '../leakage/engine.ts';
import { settleIntent, systemShift } from './intents.ts';

// Payment webhooks (tab 4 POST /webhooks/payments/{provider}; M4 rules 4–7 and the AC
// "replaying the same webhook 5 times creates exactly one payment"; T-071). Receiving: check
// the signature on the raw body (401 and nothing stored otherwise), store the raw event once
// per provider event ID (a replay answers 200 and changes nothing), answer at once. A job
// then records each event: a paid payment link settles its intent (T-070); a transfer to a
// virtual account pays its owner — a folio, or a guest's in-house folio or next booking —
// on the system shift; money no owner can take goes to the unmatched-transfer queue. Every
// write is keyed by (provider, reference), so processing an event twice records nothing new.

type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

export interface WebhookDeps {
  db: Db;
  clock: Clock;
  provider: PaymentProvider;
  logger?: Logger;
}

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
/** An event still failing after this long is given up on (its error stays for support). */
const RETRY_HOURS = 24;

/** Receives one webhook call (the route). Answers once it is safely stored. */
export async function receiveWebhook(
  deps: WebhookDeps,
  providerName: string,
  raw: Buffer | undefined,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ received: true }> {
  if (providerName.toUpperCase() !== deps.provider.name) {
    throw new AppError('NOT_FOUND', 'No such payment provider');
  }
  const reading = raw ? deps.provider.readWebhook(raw, headers) : { signatureOk: false as const };
  if (!reading.signatureOk) {
    throw new AppError('UNAUTHENTICATED', 'The webhook signature does not match');
  }
  // A signed body we can't read is kept (by its hash) for support, and not processed.
  const eventId =
    reading.event?.id ??
    `unreadable:${createHash('sha256')
      .update(raw ?? '')
      .digest('hex')}`;
  const now = deps.clock();
  await deps.db.webhookEvent.createMany({
    data: [
      {
        provider: deps.provider.name,
        eventId,
        signatureOk: true,
        payload: reading.payload ?? {},
        receivedAt: now,
        ...(reading.event ? {} : { processedAt: now, error: 'Not an event we read' }),
      },
    ],
    skipDuplicates: true,
  });
  return { received: true };
}

/** The job: records what each stored event pays; answers how many were processed. */
export async function processWebhookEvents(deps: WebhookDeps): Promise<number> {
  const pending = await deps.db.webhookEvent.findMany({
    where: { provider: deps.provider.name, processedAt: null },
    orderBy: { id: 'asc' },
    take: 100,
  });
  let done = 0;
  for (const row of pending) {
    const now = deps.clock();
    try {
      const event = parsePaystackEvent(row.payload);
      if (event) await processEvent(deps, event);
      await deps.db.webhookEvent.update({
        where: { id: row.id },
        data: { processedAt: now, error: null },
      });
      done += 1;
    } catch (err) {
      // Tried again on the next run (day being audited, database busy…), for a day.
      const message = err instanceof AppError ? `${err.code}: ${err.message}` : 'Unexpected error';
      const giveUp = now.getTime() - row.receivedAt.getTime() > RETRY_HOURS * 3_600_000;
      await deps.db.webhookEvent.update({
        where: { id: row.id },
        data: { error: message, ...(giveUp ? { processedAt: now } : {}) },
      });
      deps.logger?.warn({ webhookEventId: row.id.toString(), message }, 'Webhook not processed');
    }
  }
  return done;
}

async function processEvent(deps: WebhookDeps, event: PaymentEvent): Promise<void> {
  if (event.type !== 'CHARGE_SUCCEEDED') return;
  const provider = deps.provider.name;
  // A payment link of ours.
  if (event.reference) {
    const intent = await deps.db.paymentIntent.findFirst({
      where: { provider, providerRef: event.reference },
    });
    if (intent) {
      await settleIntent(deps, intent.id, {
        reference: event.reference,
        status: 'SUCCEEDED',
        amountMinor: event.amountMinor,
        currency: event.currency,
        paidAt: event.paidAt,
        channel: event.channel,
      });
      return;
    }
  }
  // A transfer to one of our virtual accounts.
  if (event.accountNumber) {
    const account = await deps.db.virtualAccount.findUnique({
      where: { provider_accountNumber: { provider, accountNumber: event.accountNumber } },
    });
    if (account) {
      await payToAccount(deps, account, event);
      return;
    }
  }
  // Anything else on the provider account is not ours to record.
}

type Account = Prisma.VirtualAccountGetPayload<object>;
type Charged = Extract<PaymentEvent, { type: 'CHARGE_SUCCEEDED' }>;
type Target =
  { kind: 'folio'; folioId: string; windowId: string } | { kind: 'deposit'; reservationId: string };

/** Where money sent to an account goes, or null when no owner can take it now. */
async function targetOf(tx: Tx, account: Account): Promise<Target | null> {
  if (!account.active) return null;
  const folioTarget = async (folioId: string): Promise<Target | null> => {
    const folio = await tx.folio.findUnique({ where: { id: folioId }, include: { windows: true } });
    const window = folio?.windows.find((w) => w.number === 1);
    if (!folio || folio.status !== 'OPEN' || !window) return null;
    return { kind: 'folio', folioId: folio.id, windowId: window.id };
  };
  if (account.ownerType === 'FOLIO') return folioTarget(account.ownerId);
  if (account.ownerType === 'GUEST') {
    // In house: their folio. Else exactly one booking still to arrive: its deposit.
    const stays = await tx.stay.findMany({
      where: { propertyId: account.propertyId, guestId: account.ownerId, status: 'CHECKED_IN' },
    });
    if (stays.length === 1 && stays[0]?.folioId) return folioTarget(stays[0].folioId);
    if (stays.length > 1) return null;
    const bookings = await tx.reservation.findMany({
      where: {
        propertyId: account.propertyId,
        bookerGuestId: account.ownerId,
        status: { in: ['TENTATIVE', 'CONFIRMED'] },
      },
      select: { id: true },
    });
    return bookings.length === 1 && bookings[0]
      ? { kind: 'deposit', reservationId: bookings[0].id }
      : null;
  }
  // Company and event accounts come with the city ledger and events.
  return null;
}

/** Records a transfer as a payment (system shift, M4 rule 4); one per reference. */
export async function recordTransfer(
  tx: Tx,
  args: {
    propertyId: string;
    provider: string;
    reference: string;
    amountMinor: bigint;
    note: string;
    target: Target;
    now: Date;
    clock: Clock;
    /** Who matched it by hand; null for the webhook. */
    userId: string | null;
  },
): Promise<string> {
  const property = await tx.property.findUniqueOrThrow({ where: { id: args.propertyId } });
  const date = await postingDate(tx, args.propertyId, args.clock);
  const shiftId = await systemShift(tx, args.propertyId, args.now);
  const payment = await tx.payment.create({
    data: {
      propertyId: args.propertyId,
      ...(args.target.kind === 'folio'
        ? { folioId: args.target.folioId, windowId: args.target.windowId }
        : { reservationId: args.target.reservationId }),
      method: 'VIRTUAL_ACCOUNT',
      amountMinor: args.amountMinor,
      currency: property.baseCurrency,
      baseAmountMinor: args.amountMinor,
      provider: args.provider,
      externalRef: args.reference,
      businessDate: dbDate(date),
      shiftId,
      receivedById: args.userId,
      note: args.note,
      createdAt: args.now,
    },
  });
  if (args.target.kind === 'deposit') {
    await tx.depositLedgerEntry.create({
      data: {
        propertyId: args.propertyId,
        reservationId: args.target.reservationId,
        paymentId: payment.id,
        kind: 'RECEIVED',
        amountMinor: args.amountMinor,
        businessDate: dbDate(date),
      },
    });
  }
  const where = { organisationId: property.organisationId, propertyId: args.propertyId };
  const facts = {
    ...(args.target.kind === 'folio'
      ? { folioId: args.target.folioId, window: 1 }
      : { reservationId: args.target.reservationId, deposit: true }),
    method: 'VIRTUAL_ACCOUNT',
    amountMinor: args.amountMinor.toString(),
    currency: property.baseCurrency,
    provider: args.provider,
    externalRef: args.reference,
    shiftId,
  };
  await recordAudit(tx, {
    ...where,
    action: args.target.kind === 'folio' ? 'payment.captured' : 'deposit.received',
    entityType: 'payment',
    entityId: payment.id,
    actorType: args.userId ? 'USER' : 'SYSTEM',
    actorUserId: args.userId,
    after: facts,
  });
  await recordEvent(tx, {
    ...where,
    type: 'payment.captured',
    payload: { paymentId: payment.id, ...facts },
  });
  return payment.id;
}

async function payToAccount(deps: WebhookDeps, account: Account, event: Charged) {
  const reference = event.reference ?? event.id;
  const now = deps.clock();
  try {
    await deps.db.$transaction(async (tx) => {
      // Already recorded (as a payment or in the queue): nothing to do.
      const [paid, queued] = await Promise.all([
        tx.payment.findFirst({ where: { provider: account.provider, externalRef: reference } }),
        tx.unmatchedTransfer.findFirst({
          where: { provider: account.provider, externalRef: reference },
        }),
      ]);
      if (paid || queued) return;
      const property = await tx.property.findUniqueOrThrow({ where: { id: account.propertyId } });
      const target = event.currency === property.baseCurrency ? await targetOf(tx, account) : null;
      if (!target) {
        await tx.unmatchedTransfer.create({
          data: {
            propertyId: account.propertyId,
            provider: account.provider,
            externalRef: reference,
            amountMinor: event.amountMinor,
            senderName: event.senderName,
            receivedAt: event.paidAt ?? now,
          },
        });
        await recordAudit(tx, {
          organisationId: property.organisationId,
          propertyId: account.propertyId,
          action: 'payment.transfer_unmatched',
          entityType: 'virtual_account',
          entityId: account.id,
          actorType: 'SYSTEM',
          actorUserId: null,
          after: {
            reference,
            amountMinor: event.amountMinor.toString(),
            currency: event.currency,
            ownerType: account.ownerType,
          },
        });
        return;
      }
      await recordTransfer(tx, {
        propertyId: account.propertyId,
        provider: account.provider,
        reference,
        amountMinor: event.amountMinor,
        note: event.senderName
          ? `Transfer from ${event.senderName} to ${account.accountNumber}`
          : `Transfer to ${account.accountNumber}`,
        target,
        now,
        clock: deps.clock,
        userId: null,
      });
    });
  } catch (err) {
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
}

const HOUR_MS = 3_600_000;
/** Manual transfers older than the longest setting plus a week were looked at already. */
const MANUAL_LOOKBACK_MS = (720 + 168) * HOUR_MS;

/**
 * Core rule "unmatched transfer" (M4 rule 7; M6 leakage rules; T-071, T-090), checked hourly.
 * One alert per transfer still waiting in the queue after the rule's hours (default 24), and,
 * as Philip decided on 2026-11-10 (spec issue 20), one per bank transfer typed in at the desk
 * (provider MANUAL) that many hours after it was recorded: no provider confirmed it, and bank
 * matching is V1.1, so the owner checks it against the bank. Answers how many were raised.
 */
export async function unmatchedTransferAlerts(db: Db, clock: Clock): Promise<number> {
  const now = clock().getTime();
  const settings = new Map<string, Promise<RuleSettings>>();
  const settingsOf = (propertyId: string) => {
    let s = settings.get(propertyId);
    if (!s) {
      s = ruleSettings(db, propertyId, 'UNMATCHED_TRANSFER');
      settings.set(propertyId, s);
    }
    return s;
  };
  const due = async (propertyId: string, at: Date) => {
    const s = await settingsOf(propertyId);
    return s.enabled && at.getTime() <= now - numberParam(s, 'hours') * HOUR_MS;
  };

  const waiting = await db.unmatchedTransfer.findMany({
    where: { matchedPaymentId: null, receivedAt: { lte: new Date(now - HOUR_MS) } },
    include: { property: { select: { organisationId: true } } },
  });
  const manual = await db.payment.findMany({
    where: {
      method: 'BANK_TRANSFER',
      provider: 'MANUAL',
      amountMinor: { gt: 0 },
      matchedTransfer: null,
      createdAt: { lte: new Date(now - HOUR_MS), gte: new Date(now - MANUAL_LOOKBACK_MS) },
    },
    include: {
      property: { select: { organisationId: true } },
      folio: { select: { number: true } },
    },
  });
  const keys = [
    ...waiting.map((t) => `UNMATCHED_TRANSFER:${t.id}`),
    ...manual.map((p) => `UNMATCHED_TRANSFER:payment:${p.id}`),
  ];
  const raisedBefore = new Set(
    (
      await db.leakageAlert.findMany({
        where: { dedupeKey: { in: keys } },
        select: { propertyId: true, dedupeKey: true },
      })
    ).map((a) => `${a.propertyId} ${a.dedupeKey}`),
  );

  let raised = 0;
  for (const t of waiting) {
    const dedupeKey = `UNMATCHED_TRANSFER:${t.id}`;
    if (raisedBefore.has(`${t.propertyId} ${dedupeKey}`)) continue;
    if (!(await due(t.propertyId, t.receivedAt))) continue;
    const date = await businessDate(db, t.propertyId, clock);
    const id = await db.$transaction((tx) =>
      raiseAlert(tx, {
        propertyId: t.propertyId,
        organisationId: t.property.organisationId,
        ruleCode: 'UNMATCHED_TRANSFER',
        businessDate: date,
        severity: 'HIGH',
        entityType: 'unmatched_transfer',
        entityId: t.id,
        evidence: {
          source: 'QUEUE',
          reference: t.externalRef,
          amountMinor: t.amountMinor.toString(),
          senderName: t.senderName,
          receivedAt: t.receivedAt.toISOString(),
        },
        dedupeKey,
        event: { transferId: t.id },
      }),
    );
    if (id) raised += 1;
  }
  for (const p of manual) {
    const dedupeKey = `UNMATCHED_TRANSFER:payment:${p.id}`;
    if (raisedBefore.has(`${p.propertyId} ${dedupeKey}`)) continue;
    if (!(await due(p.propertyId, p.createdAt))) continue;
    const date = await businessDate(db, p.propertyId, clock);
    const id = await db.$transaction((tx) =>
      raiseAlert(tx, {
        propertyId: p.propertyId,
        organisationId: p.property.organisationId,
        ruleCode: 'UNMATCHED_TRANSFER',
        businessDate: date,
        severity: 'NORMAL',
        entityType: 'payment',
        entityId: p.id,
        subjectUserId: p.receivedById,
        evidence: {
          source: 'MANUAL',
          reference: p.externalRef,
          amountMinor: p.amountMinor.toString(),
          currency: p.currency,
          folioId: p.folioId,
          folio: p.folio?.number ?? null,
          reservationId: p.reservationId,
          recordedAt: p.createdAt.toISOString(),
        },
        dedupeKey,
        event: { paymentId: p.id },
      }),
    );
    if (id) raised += 1;
  }
  return raised;
}
