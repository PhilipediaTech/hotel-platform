import { randomBytes, randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import {
  PAYSTACK_SIGNATURE_HEADER,
  parsePaystackEvent,
  paystackSignatureOk,
} from './paystack-events.ts';

// PaymentProvider interface (spec tab 2, "Integrations"; ADR-021: Paystack). A hosted checkout
// is opened for an amount under our own reference; the guest pays on the provider's page (the
// payment link); the charge is then looked up by that reference.
// Webhooks and virtual accounts arrive with T-071. The fake is used in tests and local
// development (PAYMENT_PROVIDER=fake).

export interface CheckoutRequest {
  /** Ours, unique: the provider keeps it and answers by it. */
  reference: string;
  amountMinor: bigint;
  currency: string;
  /** The payer's email (Paystack needs one for its receipt). */
  email: string;
  /** Where the provider sends the guest after paying; its own page when null. */
  callbackUrl: string | null;
  /** Shown in the provider's dashboard: hotel, folio or booking. */
  metadata: Record<string, string>;
}

export interface CheckoutSession {
  reference: string;
  /** The hosted page: the payment link the guest opens. */
  checkoutUrl: string;
}

export type ChargeStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface Charge {
  reference: string;
  status: ChargeStatus;
  /** What was paid (when SUCCEEDED), in minor units of `currency`. */
  amountMinor: bigint;
  currency: string;
  paidAt: Date | null;
  /** How the guest paid at the provider (card, bank, transfer, USSD…), for the note. */
  channel: string | null;
}

/** A signed webhook event, as far as payments care (T-071). */
export type PaymentEvent =
  | { id: string; type: 'OTHER'; reference: string | null }
  | {
      /** Unique per provider: a replay carries the same one. */
      id: string;
      type: 'CHARGE_SUCCEEDED';
      reference: string | null;
      amountMinor: bigint;
      currency: string;
      paidAt: Date | null;
      channel: string | null;
      /** The virtual account the money was sent to, for bank transfers to one. */
      accountNumber: string | null;
      senderName: string | null;
    };

/** What a webhook request turned out to be. */
export type WebhookReading =
  { signatureOk: false } | { signatureOk: true; payload: unknown; event: PaymentEvent | null };

export interface VirtualAccountOwner {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
}

export interface IssuedAccount {
  accountNumber: string;
  bankName: string;
  accountName: string;
}

export interface PaymentProvider {
  /** Stored on payments and intents: `PAYSTACK`, `FAKE`. */
  readonly name: string;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  /** The charge for a reference; PENDING while the guest has not paid. */
  verify(reference: string): Promise<Charge>;
  /** Checks a webhook's signature on its raw body and reads it (T-071). */
  readWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookReading;
  /** A bank account number of the owner's own: transfers to it arrive as webhooks (T-071). */
  createVirtualAccount(owner: VirtualAccountOwner): Promise<IssuedAccount>;
}

/** The provider could not be reached or refused the call; never shows its raw answer. */
export class PaymentProviderError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'PaymentProviderError';
    this.status = status;
  }
}

/** A reference for a new charge: unguessable, short enough for a bank statement. */
export function newPaymentReference(): string {
  return `HP-${randomBytes(9).toString('base64url')}`;
}

/** The fake signs its webhooks like Paystack, with this public development key. */
export const FAKE_WEBHOOK_KEY = 'fake-provider-webhook-key';

export interface FakePaymentProvider extends PaymentProvider {
  readonly sessions: Map<string, CheckoutRequest & { status: ChargeStatus; paidAt: Date | null }>;
  /** The guest pays (or fails) on the fake checkout page. */
  complete(reference: string, outcome?: 'SUCCEEDED' | 'FAILED', paidAt?: Date): void;
}

/**
 * Keeps checkouts in memory. Its checkout page is the API's development route
 * (`GET /api/v1/dev/fake-pay/{reference}`), which marks the charge paid; never in production.
 */
export function createFakePaymentProvider(options: {
  checkoutBase: string;
  logger?: Logger;
}): FakePaymentProvider {
  const sessions: FakePaymentProvider['sessions'] = new Map();

  return {
    name: 'FAKE',
    sessions,
    createCheckout(request) {
      sessions.set(request.reference, { ...request, status: 'PENDING', paidAt: null });
      const checkoutUrl = `${options.checkoutBase}/${encodeURIComponent(request.reference)}`;
      options.logger?.info(
        { reference: request.reference, amountMinor: request.amountMinor.toString(), checkoutUrl },
        'Payment link (fake provider): open it to pay',
      );
      return Promise.resolve({ reference: request.reference, checkoutUrl });
    },
    verify(reference) {
      const s = sessions.get(reference);
      if (!s) return Promise.reject(new PaymentProviderError('No such charge', 404));
      return Promise.resolve({
        reference,
        status: s.status,
        amountMinor: s.amountMinor,
        currency: s.currency,
        paidAt: s.paidAt,
        channel: s.status === 'SUCCEEDED' ? 'card' : null,
      });
    },
    readWebhook(raw, headers) {
      const signature = headers[PAYSTACK_SIGNATURE_HEADER];
      if (
        !paystackSignatureOk(
          raw,
          typeof signature === 'string' ? signature : undefined,
          FAKE_WEBHOOK_KEY,
        )
      ) {
        return { signatureOk: false };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return { signatureOk: true, payload: null, event: null };
      }
      return { signatureOk: true, payload, event: parsePaystackEvent(payload) };
    },
    createVirtualAccount(owner) {
      const account = {
        // Ten digits like a NUBAN, starting 99 so it is plainly not a real bank's.
        accountNumber: `99${String(randomInt(0, 100_000_000)).padStart(8, '0')}`,
        bankName: 'Fake Bank',
        accountName: `HOTEL/${owner.lastName} ${owner.firstName}`.toUpperCase(),
      };
      options.logger?.info(account, 'Virtual account (fake provider)');
      return Promise.resolve(account);
    },
    complete(reference, outcome = 'SUCCEEDED', paidAt = new Date()) {
      const s = sessions.get(reference);
      if (!s) throw new PaymentProviderError('No such charge', 404);
      s.status = outcome;
      s.paidAt = outcome === 'SUCCEEDED' ? paidAt : null;
    },
  };
}
