import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { MAX_FOLIO_WINDOWS } from './folios.ts';
import { AmountMinor, Instant, Uuid } from './primitives.ts';

// E-invoicing (PRD M4-24 "As finance, I submit invoices to the tax authority's e-invoicing
// platform through an accredited provider and print the returned reference and QR code";
// Strategy §7.6; T-160). An invoice is a folio window once the folio is no longer open (the
// invoice the desk prints). Finance sends it; the worker passes it to the provider and keeps the
// invoice reference number (IRN) and QR data it returns, which the printed invoice then carries.
// No provider is chosen yet: the provider is `off` in production until one is.

const ADDED = 'Not in tab 4: designed in T-160 (PRD M4-24).';

export const EinvoiceSettings = z
  .object({
    /** Invoices of this property go to the tax authority. */
    enabled: z.boolean(),
    /** An accredited provider is set up on the platform. */
    providerReady: z.boolean(),
    /** The hotel's tax ID (TIN) from the property's tax registration; required to switch on. */
    sellerTin: z.string().nullable(),
    /** Invoices with charges posted since then can be sent. */
    enabledAt: Instant.nullable(),
  })
  .meta({ id: 'EinvoiceSettings' });

export const EINVOICE_STATUSES = ['NOT_SENT', 'QUEUED', 'ACCEPTED', 'REJECTED', 'FAILED'] as const;
export type EinvoiceStatus = (typeof EINVOICE_STATUSES)[number];

export const EinvoiceItem = z
  .object({
    folioId: Uuid,
    folioNumber: z.string(),
    windowNumber: z.number().int(),
    invoiceNumber: z.string(),
    billTo: z.string(),
    /** The buyer's tax ID, for a company with one. */
    buyerTin: z.string().nullable(),
    totalMinor: AmountMinor,
    currency: z.string(),
    status: z.enum(EINVOICE_STATUSES),
    irn: z.string().nullable(),
    /** Why the provider refused it, when REJECTED. */
    reasons: z.array(z.string()),
    /** Tries so far; a FAILED invoice never reached the provider. */
    attempts: z.number().int(),
    submittedAt: Instant.nullable(),
    submittedBy: z.string().nullable(),
    acceptedAt: Instant.nullable(),
  })
  .meta({ id: 'EinvoiceItem' });

const MANAGE = {
  tags: ['E-invoicing'],
  propertyScoped: true as const,
  permission: 'einvoice.submit',
};

export const getEinvoiceSettings = defineRoute({
  ...MANAGE,
  operationId: 'getEinvoiceSettings',
  method: 'get',
  path: '/einvoicing/settings',
  summary: 'Whether invoices go to the tax authority, and what switching on needs',
  description: ADDED,
  response: EinvoiceSettings,
});

export const updateEinvoiceSettings = defineRoute({
  ...MANAGE,
  permission: 'tax.manage',
  operationId: 'updateEinvoiceSettings',
  method: 'put',
  path: '/einvoicing/settings',
  summary: 'Switch e-invoicing on or off',
  description: `${ADDED} Switching on needs the hotel's TIN and a provider on the platform (409 otherwise); invoices with charges posted from then on can be sent.`,
  body: z.object({ enabled: z.boolean() }),
  response: EinvoiceSettings,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const EinvoiceList = z
  .object({
    data: z.array(EinvoiceItem),
    counts: z.record(z.enum(EINVOICE_STATUSES), z.number().int()),
  })
  .meta({ id: 'EinvoiceList' });

export const listEinvoices = defineRoute({
  ...MANAGE,
  operationId: 'listEinvoices',
  method: 'get',
  path: '/einvoices',
  summary: 'Invoices to send, waiting, accepted, rejected or failed; newest first, at most 200',
  description: `${ADDED} NOT_SENT: windows of folios no longer open, with charges posted since e-invoicing was switched on, not sent yet.`,
  query: z.object({ status: z.enum(EINVOICE_STATUSES).optional() }),
  response: EinvoiceList,
});

export const submitEinvoice = defineRoute({
  ...MANAGE,
  operationId: 'submitEinvoice',
  method: 'post',
  path: '/folios/{folioId}/windows/{windowNumber}/einvoice',
  summary: 'Send an invoice to the tax authority (it is queued; the worker sends it)',
  description: `${ADDED} Again after a rejection or failure, with the invoice as it is now. 409 while open, empty, queued or accepted, or with e-invoicing off.`,
  idempotent: true,
  params: z.object({
    folioId: Uuid,
    windowNumber: z.coerce.number().int().min(1).max(MAX_FOLIO_WINDOWS),
  }),
  body: z.object({}),
  response: EinvoiceItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const EINVOICE_ROUTES = {
  getEinvoiceSettings,
  updateEinvoiceSettings,
  listEinvoices,
  submitEinvoice,
} as const;
