import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PaymentEvent } from './payments.ts';

// Paystack webhooks (ADR-021; T-071): every event is signed with HMAC-SHA512 of the raw body,
// keyed by the secret key, in `x-paystack-signature` (hex). The fake provider signs the same
// way with its own key, so `npm run simulate:webhook` exercises the real path. A transfer to a
// dedicated virtual account arrives as `charge.success` on the `dedicated_nuban` channel, with
// the receiving account number on its authorization (or metadata).

export const PAYSTACK_SIGNATURE_HEADER = 'x-paystack-signature';

export function signPaystack(raw: Buffer | string, key: string): string {
  return createHmac('sha512', key).update(raw).digest('hex');
}

/** True when `signature` is the body's HMAC under `key` (constant-time). */
export function paystackSignatureOk(raw: Buffer, signature: string | undefined, key: string) {
  if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const expected = Buffer.from(signPaystack(raw, key), 'hex');
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const Event = z.object({
  event: z.string(),
  data: z
    .object({
      id: z.union([z.number(), z.string()]),
      reference: z.string().nullable().optional(),
      status: z.string().optional(),
      amount: z.number().int().optional(),
      currency: z.string().optional(),
      paid_at: z.string().nullable().optional(),
      channel: z.string().nullable().optional(),
      authorization: z
        .object({
          receiver_bank_account_number: z.string().nullable().optional(),
          sender_name: z.string().nullable().optional(),
        })
        .partial()
        .nullable()
        .optional(),
      metadata: z
        .union([
          z.object({ receiver_account_number: z.string().nullable().optional() }).loose(),
          z.string(),
        ])
        .nullable()
        .optional(),
    })
    .loose(),
});

/**
 * What a signed Paystack event says, or null when it is not one we read. The event ID is
 * the event type and the transaction ID: Paystack sends no event ID of its own, and a retry
 * of the same event repeats both.
 */
export function parsePaystackEvent(body: unknown): PaymentEvent | null {
  const parsed = Event.safeParse(body);
  if (!parsed.success) return null;
  const { event, data } = parsed.data;
  const id = `${event}:${String(data.id)}`;
  if (event !== 'charge.success' || data.status !== 'success') {
    return { id, type: 'OTHER', reference: data.reference ?? null };
  }
  const meta = typeof data.metadata === 'object' && data.metadata ? data.metadata : null;
  return {
    id,
    type: 'CHARGE_SUCCEEDED',
    reference: data.reference ?? null,
    amountMinor: BigInt(data.amount ?? 0),
    currency: (data.currency ?? 'NGN').toUpperCase(),
    paidAt: data.paid_at ? new Date(data.paid_at) : null,
    channel: data.channel ?? null,
    accountNumber:
      data.authorization?.receiver_bank_account_number ?? meta?.receiver_account_number ?? null,
    senderName: data.authorization?.sender_name ?? null,
  };
}
