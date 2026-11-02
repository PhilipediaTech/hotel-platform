import { z } from 'zod';
import { MANUAL_PAY_METHODS } from '../setup.ts';
import { defineRoute } from './contract.ts';
import { MAX_FOLIO_WINDOWS } from './folios.ts';
import { AmountMinor, PdfDocument, Uuid } from './primitives.ts';

// Manual payments and folio documents (PRD M4-08 and the receipt/invoice/proforma story, M4
// rules 1, 4, 5 and the acceptance "a cashier without an open shift cannot record a cash
// payment"; tab 4 rows "Payments" and "Folios" and the POST /payments example; S11; T-062).
// A payment is taken at the desk on the cashier's open shift, onto a folio window, and is
// append-only. A reference (POS slip, transfer) is used once per property and method (open
// issue 19). Receipts, invoices and proformas are PDFs. Foreign currency comes with T-065,
// refunds with T-072, payment links and webhooks later.

const PositiveMinor = AmountMinor.refine(
  (v) => !v.startsWith('-') && v !== '0',
  'Must be more than zero',
);

export const PaymentBody = z
  .object({
    /** A payment on a folio window… */
    folioId: Uuid.optional(),
    windowNumber: z.number().int().min(1).max(MAX_FOLIO_WINDOWS).default(1),
    /** …or an advance deposit on a booking before arrival (M4-13; T-063). */
    reservationId: Uuid.optional(),
    /** One the property switched on in setup. */
    method: z.enum(MANUAL_PAY_METHODS),
    amountMinor: PositiveMinor,
    /** Base currency by default; a foreign one uses the business date's exchange rate (T-065). */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    /** POS slip, transfer or voucher number; required except for cash. */
    externalRef: z.string().trim().min(1).max(100).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .refine((b) => (b.folioId === undefined) !== (b.reservationId === undefined), {
    message: 'Pay onto a folio or a booking (deposit)',
    path: ['folioId'],
  })
  .refine((b) => b.method === 'CASH' || b.externalRef !== null, {
    message: 'Give the reference (POS slip, transfer or voucher number)',
    path: ['externalRef'],
  });

export const capturePayment = defineRoute({
  operationId: 'capturePayment',
  method: 'post',
  path: '/payments',
  summary: 'Take a payment at the desk onto a folio window, or a deposit on a booking',
  description:
    'Recorded on the caller’s open shift (409 SHIFT_NOT_OPEN without one, M4 rule 4) and the business date. With `reservationId` it is an advance deposit (M4-13): it goes into the booking’s deposit ledger and moves to the folio at check-in; `balanceMinor` is then the deposit held. Bookings that are cancelled, no-show or checked out take no deposits (409 STATE_TRANSITION_INVALID). A reference is used once per property and method (409 PAYMENT_DUPLICATE). Append-only: corrections are refunds (T-072).',
  tags: ['Payments'],
  propertyScoped: true,
  permission: 'payment.capture',
  idempotent: true,
  body: PaymentBody,
  status: 201,
  response: z
    .object({
      paymentId: Uuid,
      shiftId: Uuid,
      /** The payment's value in the base currency (the rate applied for a foreign one). */
      baseAmountMinor: AmountMinor,
      balanceMinor: AmountMinor,
    })
    .meta({ id: 'PaymentCaptured' }),
  errors: [
    'SHIFT_NOT_OPEN',
    'PAYMENT_DUPLICATE',
    'BUSINESS_DAY_CLOSED',
    'STATE_TRANSITION_INVALID',
  ],
});

const FolioParams = z.object({ folioId: Uuid });

export const getFolioInvoice = defineRoute({
  operationId: 'getFolioInvoice',
  method: 'get',
  path: '/folios/{folioId}/invoice.pdf',
  summary: 'The folio’s invoice (PDF): charges with their taxes, payments and balance',
  description: 'One window, or the whole folio when `window` is left out.',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.invoice',
  produces: 'application/pdf',
  params: FolioParams,
  query: z.object({ window: z.coerce.number().int().min(1).max(MAX_FOLIO_WINDOWS).optional() }),
  response: PdfDocument,
});

export const getFolioReceipt = defineRoute({
  operationId: 'getFolioReceipt',
  method: 'get',
  path: '/folios/{folioId}/receipt.pdf',
  summary: 'A receipt (PDF) for one payment on the folio',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.invoice',
  produces: 'application/pdf',
  params: FolioParams,
  query: z.object({ paymentId: Uuid }),
  response: PdfDocument,
});

export const getProforma = defineRoute({
  operationId: 'getProforma',
  method: 'get',
  path: '/reservations/{reservationId}/proforma.pdf',
  summary: 'A proforma invoice (PDF) for a booking: its stays’ nights and taxes, before arrival',
  description:
    'From the stays’ quotes, so the amounts are what the guest was quoted. Cancelled and no-show stays are left out.',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.invoice',
  produces: 'application/pdf',
  params: z.object({ reservationId: Uuid }),
  response: PdfDocument,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const getDepositReceipt = defineRoute({
  operationId: 'getDepositReceipt',
  method: 'get',
  path: '/reservations/{reservationId}/receipt.pdf',
  summary: 'A receipt (PDF) for a deposit paid on a booking',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.invoice',
  produces: 'application/pdf',
  params: z.object({ reservationId: Uuid }),
  query: z.object({ paymentId: Uuid }),
  response: PdfDocument,
});

export const RefundBody = z.object({
  /** In the payment's currency; at most what is left of it. */
  amountMinor: PositiveMinor,
  /** Back the way it came by default; another desk method when that can't be done. */
  method: z.enum(MANUAL_PAY_METHODS).optional(),
  /** Transfer or POS reversal reference; not needed for cash. */
  externalRef: z.string().trim().min(1).max(100).nullable().default(null),
  reason: z.string().trim().min(1).max(500),
});

export const refundPayment = defineRoute({
  operationId: 'refundPayment',
  method: 'post',
  path: '/payments/{paymentId}/refund',
  summary: 'Refund a payment, with a reason and approval',
  description:
    'A refund is a negative payment pointing at the original, on the refunder’s open shift (409 SHIFT_NOT_OPEN), never more than is left of it. Every refund goes through the payment.refund approval policy (202 until a manager approves; managers within their limit refund directly). A folio refund needs the folio open; a deposit refund takes the money out of the booking’s deposit ledger. A foreign refund on a folio uses the business date’s rate; the difference from the original rate posts to the FX revenue code (M4 rule 6).',
  tags: ['Payments'],
  propertyScoped: true,
  permission: 'payment.refund',
  idempotent: true,
  approval: true,
  params: z.object({ paymentId: Uuid }),
  body: RefundBody,
  status: 201,
  response: z
    .object({
      refundId: Uuid,
      shiftId: Uuid,
      /** Negative: what left the hotel, in the base currency. */
      baseAmountMinor: AmountMinor,
      /** The folio's balance, or the deposit held, after the refund. */
      balanceMinor: AmountMinor,
    })
    .meta({ id: 'RefundResult' }),
  errors: [
    'SHIFT_NOT_OPEN',
    'PAYMENT_DUPLICATE',
    'BUSINESS_DAY_CLOSED',
    'STATE_TRANSITION_INVALID',
  ],
});

export const PAYMENT_ROUTES = {
  capturePayment,
  getFolioInvoice,
  getFolioReceipt,
  getProforma,
  getDepositReceipt,
  refundPayment,
} as const;
