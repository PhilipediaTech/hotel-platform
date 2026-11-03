import { z } from 'zod';
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

const API = 'https://api.paystack.co';

const Initialized = z.object({
  status: z.literal(true),
  data: z.object({ authorization_url: z.url(), reference: z.string() }),
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
  fetch?: typeof fetch;
}): PaymentProvider {
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
  };
}
