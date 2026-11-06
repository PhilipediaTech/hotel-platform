import { z } from 'zod';
import { MAX_FOLIO_WINDOWS } from './folios.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, Uuid } from './primitives.ts';

// Webhooks, virtual accounts and the unmatched-transfer queue (PRD M4-08 "virtual-account
// details", M4 rules 4–7 and the AC "replaying the same webhook 5 times creates exactly one
// payment"; tab 4 rows "Payments" and "Webhooks" and the POST /webhooks/payments/{provider}
// notes; ADR-021 Paystack; T-071). The provider calls the webhook; it is verified, stored and
// answered at once, and a job records what it pays: a payment link (T-070), a transfer to a
// virtual account, or, when no owner can take the money, an unmatched transfer that finance
// matches by hand within 24 hours.

export const VIRTUAL_ACCOUNT_OWNERS = ['FOLIO', 'GUEST'] as const;

export const paymentWebhook = defineRoute({
  operationId: 'paymentWebhook',
  method: 'post',
  path: '/webhooks/payments/{provider}',
  summary: 'Payment provider webhook',
  description:
    'Signed by the provider (Paystack: `x-paystack-signature`, HMAC-SHA512 of the raw body). ' +
    'A bad signature answers 401 and stores nothing; an event already received answers 200.',
  tags: ['Webhooks'],
  auth: 'none',
  params: z.object({ provider: z.string().regex(/^[a-z]+$/) }),
  body: z.record(z.string(), z.unknown()),
  response: z.object({ received: z.literal(true) }),
});

export const VirtualAccountBody = z.object({
  /** A guest folio's own account, or one for a guest (their in-house folio or next booking). */
  ownerType: z.enum(VIRTUAL_ACCOUNT_OWNERS),
  ownerId: Uuid,
  /** The guest's email and phone: the provider needs both for the account holder. */
  email: z.email().max(254),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ]{7,20}$/, 'Enter a phone number'),
  /** Email the account details to the guest. */
  send: z.boolean().default(false),
});

export const VirtualAccountItem = z
  .object({
    id: Uuid,
    provider: z.string(),
    ownerType: z.string(),
    ownerId: Uuid,
    accountNumber: z.string(),
    bankName: z.string(),
    accountName: z.string(),
    active: z.boolean(),
  })
  .meta({ id: 'VirtualAccount' });

export const createVirtualAccount = defineRoute({
  operationId: 'createVirtualAccount',
  method: 'post',
  path: '/virtual-accounts',
  summary: 'Issue a virtual bank account for a folio or a guest',
  description:
    'One active account per owner: asking again answers the one it has. Transfers to it are ' +
    'recorded as payments by the webhook.',
  tags: ['Payments'],
  propertyScoped: true,
  permission: 'payment.request',
  idempotent: true,
  status: 201,
  body: VirtualAccountBody,
  response: VirtualAccountItem,
  errors: ['PAYMENT_PROVIDER_UNAVAILABLE'],
});

export const listVirtualAccounts = defineRoute({
  operationId: 'listVirtualAccounts',
  method: 'get',
  path: '/virtual-accounts',
  summary: 'The virtual accounts of a folio or a guest',
  description: 'Added beyond tab 4 (T-071).',
  tags: ['Payments'],
  propertyScoped: true,
  permission: 'payment.request',
  query: z.object({ ownerType: z.enum(VIRTUAL_ACCOUNT_OWNERS), ownerId: Uuid }),
  response: z.object({ data: z.array(VirtualAccountItem) }),
});

export const UnmatchedTransferItem = z
  .object({
    id: Uuid,
    provider: z.string(),
    reference: z.string(),
    amountMinor: AmountMinor,
    senderName: z.string().nullable(),
    receivedAt: Instant,
    /** Over 24 hours unmatched (the Leakage Guard has raised an alert). */
    overdue: z.boolean(),
    matchedPaymentId: Uuid.nullable(),
  })
  .meta({ id: 'UnmatchedTransfer' });

export const listUnmatchedTransfers = defineRoute({
  operationId: 'listUnmatchedTransfers',
  method: 'get',
  path: '/unmatched-transfers',
  summary: 'Transfers no owner could take: still to match first, then matched',
  tags: ['Payments'],
  propertyScoped: true,
  permission: 'payment.capture',
  query: z.object({ matched: z.enum(['true', 'false']).optional() }),
  response: z.object({ data: z.array(UnmatchedTransferItem) }),
});

export const MatchBody = z
  .object({
    folioId: Uuid.optional(),
    windowNumber: z.number().int().min(1).max(MAX_FOLIO_WINDOWS).default(1),
    reservationId: Uuid.optional(),
    note: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .refine((b) => (b.folioId === undefined) !== (b.reservationId === undefined), {
    message: 'Match it to a folio or a booking (deposit)',
    path: ['folioId'],
  });

export const matchUnmatchedTransfer = defineRoute({
  operationId: 'matchUnmatchedTransfer',
  method: 'post',
  path: '/unmatched-transfers/{unmatchedTransferId}/match',
  summary: 'Record an unmatched transfer as a payment on a folio or a booking',
  tags: ['Payments'],
  propertyScoped: true,
  permission: 'payment.capture',
  idempotent: true,
  params: z.object({ unmatchedTransferId: Uuid }),
  body: MatchBody,
  response: UnmatchedTransferItem,
  errors: ['AUDIT_IN_PROGRESS'],
});

export const VIRTUAL_ACCOUNT_ROUTES = {
  paymentWebhook,
  createVirtualAccount,
  listVirtualAccounts,
  listUnmatchedTransfers,
  matchUnmatchedTransfer,
} as const;
