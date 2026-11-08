import { z } from 'zod';
import {
  PAYSTACK_SIGNATURE_HEADER,
  parsePaystackEvent,
  paystackSignatureOk,
} from './paystack-events.ts';
import {
  PaymentProviderError,
  type Charge,
  type ChargeStatus,
  type PaymentProvider,
} from './payments.ts';

// Paystack behind the PaymentProvider interface (ADR-021). Transaction Initialize opens a
// hosted checkout under our reference; Verify Transaction reads the charge back. Amounts go in
// the currency's subunit (kobo for NGN), which is our minor unit. The secret key is sent only
// to api.paystack.co; error bodies are never passed on (they can echo request data).
// Webhooks are signed with the secret key (T-071). A dedicated virtual account is made for a
// Paystack customer (Create Customer, then Create Dedicated Account); test keys get Paystack's
// test bank. The feature must be enabled on the Paystack business.

const API = 'https://api.paystack.co';

const Initialized = z.object({
  status: z.literal(true),
  data: z.object({ authorization_url: z.url(), reference: z.string() }),
});

const Customer = z.object({
  status: z.literal(true),
  data: z.object({ customer_code: z.string() }),
});

const Dedicated = z.object({
  status: z.literal(true),
  data: z.object({
    account_number: z.string(),
    account_name: z.string(),
    bank: z.object({ name: z.string() }),
  }),
});

const Verified = z.object({
  status: z.literal(true),
  data: z.object({
    reference: z.string(),
    status: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    paid_at: z.string().nullable().optional(),
    channel: z.string().nullable().optional(),
  }),
});

/** Paystack's transaction status → ours. Anything not final yet is pending. */
export function chargeStatusOf(status: string): ChargeStatus {
  if (status === 'success') return 'SUCCEEDED';
  if (status === 'failed' || status === 'reversed') return 'FAILED';
  return 'PENDING';
}

export function createPaystackProvider(options: {
  secretKey: string;
  /** Signs webhooks; Paystack uses the secret key. */
  webhookKey?: string;
  fetch?: typeof fetch;
}): PaymentProvider {
  const webhookKey = options.webhookKey ?? options.secretKey;
  const call = async (path: string, init: RequestInit = {}) => {
    let res: Response;
    try {
      res = await (options.fetch ?? fetch)(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${options.secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaymentProviderError('Paystack could not be reached');
    }
    if (!res.ok) {
      throw new PaymentProviderError(`Paystack refused the request (${res.status})`, res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new PaymentProviderError('Paystack answered with something unreadable', res.status);
    }
  };

  return {
    name: 'PAYSTACK',
    async createCheckout(request) {
      const body = await call('/transaction/initialize', {
        method: 'POST',
        body: JSON.stringify({
          email: request.email,
          amount: request.amountMinor.toString(),
          currency: request.currency,
          reference: request.reference,
          ...(request.callbackUrl ? { callback_url: request.callbackUrl } : {}),
          metadata: request.metadata,
        }),
      });
      const parsed = Initialized.safeParse(body);
      if (!parsed.success || parsed.data.data.reference !== request.reference) {
        throw new PaymentProviderError('Paystack did not open a checkout');
      }
      return { reference: request.reference, checkoutUrl: parsed.data.data.authorization_url };
    },
    async refund(reference, amountMinor) {
      await call('/refund', {
        method: 'POST',
        body: JSON.stringify({ transaction: reference, amount: amountMinor.toString() }),
      });
    },
    async verify(reference) {
      const body = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
      const parsed = Verified.safeParse(body);
      if (!parsed.success || parsed.data.data.reference !== reference) {
        throw new PaymentProviderError('Paystack answered with something unreadable');
      }
      const d = parsed.data.data;
      const status = chargeStatusOf(d.status);
      const charge: Charge = {
        reference,
        status,
        amountMinor: BigInt(d.amount),
        currency: d.currency.toUpperCase(),
        paidAt: status === 'SUCCEEDED' && d.paid_at ? new Date(d.paid_at) : null,
        channel: d.channel ?? null,
      };
      return charge;
    },
    readWebhook(raw, headers) {
      const signature = headers[PAYSTACK_SIGNATURE_HEADER];
      if (
        !paystackSignatureOk(raw, typeof signature === 'string' ? signature : undefined, webhookKey)
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
    async createVirtualAccount(owner) {
      const customer = Customer.safeParse(
        await call('/customer', {
          method: 'POST',
          body: JSON.stringify({
            email: owner.email,
            first_name: owner.firstName,
            last_name: owner.lastName,
            phone: owner.phone,
          }),
        }),
      );
      if (!customer.success) throw new PaymentProviderError('Paystack did not create the customer');
      const account = Dedicated.safeParse(
        await call('/dedicated_account', {
          method: 'POST',
          body: JSON.stringify({
            customer: customer.data.data.customer_code,
            preferred_bank: options.secretKey.startsWith('sk_test_') ? 'test-bank' : 'wema-bank',
          }),
        }),
      );
      if (!account.success) {
        throw new PaymentProviderError('Paystack did not issue a virtual account');
      }
      return {
        accountNumber: account.data.data.account_number,
        bankName: account.data.data.bank.name,
        accountName: account.data.data.account_name,
      };
    },
  };
}
