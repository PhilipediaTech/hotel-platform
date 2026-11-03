import { z } from 'zod';
import { MAX_FOLIO_WINDOWS } from './folios.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, Uuid } from './primitives.ts';

// Online payments: payment links (PRD M4-07 "online card", M4-08 "I send a payment link …
// to a guest by WhatsApp or email"; tab 4 POST /payment-intents ●; ADR-021 Paystack; T-070).
// A link asks for an amount on a folio window, or as a booking's deposit, in the base
// currency; the guest pays on the provider's hosted page. The paid charge becomes a CARD_ONLINE
// payment on the property's system shift (M4 rule 4) when it is checked: by the cashier, by a
// job every 5 minutes, and with T-071 by the provider's webhook. Sending is by email for now
// (WhatsApp comes with T-024).

export const INTENT_STATUSES = ['CREATED', 'SUCCEEDED', 'FAILED', 'EXPIRED'] as const;
/** A link can be paid for this long; a later payment is still recorded if it comes. */
export const PAYMENT_LINK_HOURS = 72;

const PositiveMinor = AmountMinor.refine(
  (v) => !v.startsWith('-') && v !== '0',
  'Must be more than zero',
);

export const PaymentIntentBody = z
  .object({
    /** A link for a folio window… */
    folioId: Uuid.optional(),
    windowNumber: z.number().int().min(1).max(MAX_FOLIO_WINDOWS).default(1),
    /** …or for a booking's deposit before arrival. */
    reservationId: Uuid.optional(),
    amountMinor: PositiveMinor,
    /** The guest's email: the provider sends its receipt there. */
    email: z.email().max(254),
    /** Email the link to the guest now (otherwise copy it). */
    send: z.boolean().default(false),
  })
  .refine((b) => (b.folioId === undefined) !== (b.reservationId === undefined), {
    message: 'Ask for payment on a folio or a booking (deposit)',
    path: ['folioId'],
  });

export const PaymentIntentItem = z
  .object({
    id: Uuid,
    folioId: Uuid.nullable(),
    windowNumber: z.int().nullable(),
    reservationId: Uuid.nullable(),
    provider: z.string(),
    /** Our reference at the provider (and on the payment it becomes). */
    reference: z.string(),
    amountMinor: AmountMinor,
    currency: z.string(),
    status: z.enum(INTENT_STATUSES),
    /** The payment link. */
    checkoutUrl: z.url(),
    sentTo: z.string().nullable(),
    requestedBy: z.string().nullable(),
    paymentId: Uuid.nullable(),
    paidAt: Instant.nullable(),
    expiresAt: Instant,
    createdAt: Instant,
  })
  .meta({ id: 'PaymentIntent' });

export const PaymentIntentQuery = z
  .object({ folioId: Uuid.optional(), reservationId: Uuid.optional() })
  .refine((q) => (q.folioId === undefined) !== (q.reservationId === undefined), {
    message: 'Name a folio or a booking',
    path: ['folioId'],
  });

export const createPaymentIntent = defineRoute({
  operationId: 'createPaymentIntent',
  method: 'post',
  path: '/payment-intents',
  summary: 'Create a payment link for a folio window or a booking deposit',
  description:
    'Opens a hosted checkout at the payment provider and answers its link; with `send` the ' +
    'link is emailed to the guest. 502 PAYMENT_PROVIDER_UNAVAILABLE when the provider fails.',
  tags: ['Payments'],
  propertyScoped: true,
  permission: 'payment.request',
  idempotent: true,
  status: 201,
  body: PaymentIntentBody,
  response: PaymentIntentItem,
  errors: ['PAYMENT_PROVIDER_UNAVAILABLE'],
});

export const listPaymentIntents = defineRoute({
  operationId: 'listPaymentIntents',
  method: 'get',
  path: '/payment-intents',
  summary: 'Payment links of a folio or a booking, newest first',
  description: 'Added beyond tab 4 (T-070): the desk sees what it asked for and what was paid.',
  tags: ['Payments'],
  propertyScoped: true,
  permission: 'payment.request',
  query: PaymentIntentQuery,
  response: z.object({ data: z.array(PaymentIntentItem) }),
});

export const checkPaymentIntent = defineRoute({
  operationId: 'checkPaymentIntent',
  method: 'post',
  path: '/payment-intents/{paymentIntentId}/check',
  summary: 'Ask the provider whether a payment link was paid; record the payment if so',
  description:
    'Added beyond tab 4 (T-070), until webhooks (T-071). Safe to repeat: a link is recorded ' +
    'as a payment once.',
  tags: ['Payments'],
  propertyScoped: true,
  permission: 'payment.request',
  idempotent: true,
  params: z.object({ paymentIntentId: Uuid }),
  response: PaymentIntentItem,
  errors: ['PAYMENT_PROVIDER_UNAVAILABLE', 'AUDIT_IN_PROGRESS'],
});

export const PAYMENT_INTENT_ROUTES = {
  createPaymentIntent,
  listPaymentIntents,
  checkPaymentIntent,
} as const;
