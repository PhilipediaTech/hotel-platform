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
    folioId: Uuid,
    windowNumber: z.number().int().min(1).max(MAX_FOLIO_WINDOWS).default(1),
    /** One the property switched on in setup. */
    method: z.enum(MANUAL_PAY_METHODS),
    amountMinor: PositiveMinor,
    /** The property's base currency; other currencies come with T-065. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    /** POS slip, transfer or voucher number; required except for cash. */
    externalRef: z.string().trim().min(1).max(100).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .refine((b) => b.method === 'CASH' || b.externalRef !== null, {
    message: 'Give the reference (POS slip, transfer or voucher number)',
    path: ['externalRef'],
  });

export const capturePayment = defineRoute({
  operationId: 'capturePayment',
  method: 'post',
  path: '/payments',
  summary: 'Take a payment at the desk onto a folio window',
  description:
    'Recorded on the caller’s open shift (409 SHIFT_NOT_OPEN without one, M4 rule 4) and the business date. A reference is used once per property and method (409 PAYMENT_DUPLICATE). Append-only: corrections are refunds (T-072).',
  tags: ['Payments'],
  propertyScoped: true,
  permission: 'payment.capture',
  idempotent: true,
  body: PaymentBody,
  status: 201,
  response: z
    .object({ paymentId: Uuid, shiftId: Uuid, balanceMinor: AmountMinor })
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

export const PAYMENT_ROUTES = {
  capturePayment,
  getFolioInvoice,
  getFolioReceipt,
  getProforma,
} as const;
