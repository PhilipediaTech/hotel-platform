import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { EventBookingItem } from './events.ts';
import { AmountMinor, Instant, IsoDate, PdfDocument, Uuid } from './primitives.ts';

// Events and spaces, second part (PRD M9-04–M9-06, M9 AC; tab 3 event_quotes,
// event_quote_versions, event_contracts, event_payment_schedules, event_deposits; tab 4
// /event-bookings/{id}/quotes, /contract, /confirm; T-120): the versioned quote, the contract
// with its payment schedule on the event's own virtual account, and confirming the booking.

export const EVENT_LINE_KINDS = ['SPACE', 'PACKAGE', 'CATERING', 'EQUIPMENT', 'EXTRA'] as const;
export const EVENT_SCHEDULE_KINDS = ['DEPOSIT', 'INSTALMENT', 'DAMAGE_DEPOSIT'] as const;
export const EVENT_SCHEDULE_STATUSES = ['DUE', 'OVERDUE', 'PART_PAID', 'PAID'] as const;
export const EVENT_CONTRACT_STATUSES = ['ISSUED', 'SIGNED', 'SUPERSEDED', 'VOID'] as const;
/** What still stands between a hold and a confirmed booking (M9-06). */
export const EVENT_CONFIRM_MISSING = ['NO_CONTRACT', 'NOT_SIGNED', 'DEPOSIT_NOT_PAID'] as const;

const PositiveMinor = AmountMinor.refine((v) => BigInt(v) > 0n, 'Must be more than nothing');
const NonNegativeMinor = AmountMinor.refine((v) => !v.startsWith('-'), 'Must not be negative');

export const EventQuoteLineItem = z
  .object({
    kind: z.enum(EVENT_LINE_KINDS),
    description: z.string(),
    quantity: z.number().int(),
    unitMinor: AmountMinor,
    amountMinor: AmountMinor,
    revenueCode: z.string(),
    taxMinor: AmountMinor,
    totalMinor: AmountMinor,
    /** Added by the system to reach the space's minimum hire. */
    minimumHire: z.boolean(),
  })
  .meta({ id: 'EventQuoteLine' });

export const EventQuoteVersionItem = z
  .object({
    id: Uuid,
    version: z.number().int(),
    lines: z.array(EventQuoteLineItem),
    netMinor: AmountMinor,
    taxMinor: AmountMinor,
    totalMinor: AmountMinor,
    notes: z.string().nullable(),
    createdAt: Instant,
  })
  .meta({ id: 'EventQuoteVersion' });

export const EventQuoteView = z
  .object({
    currentVersion: z.number().int(),
    /** Newest first. */
    versions: z.array(EventQuoteVersionItem),
    /** The space's prices that apply on the day of the event. */
    rates: z.array(
      z.object({ id: Uuid, name: z.string(), unit: z.string(), amountMinor: AmountMinor }),
    ),
    minimumHireMinor: AmountMinor,
    expectedGuests: z.number().int(),
  })
  .meta({ id: 'EventQuote' });

export const EventQuoteBody = z.object({
  lines: z
    .array(
      z.object({
        kind: z.enum(EVENT_LINE_KINDS),
        description: z.string().trim().min(1).max(200),
        quantity: z.number().int().min(1).max(100_000),
        unitMinor: NonNegativeMinor,
      }),
    )
    .min(1, 'Add at least one line')
    .max(100),
  notes: z.string().trim().max(4000).nullable().default(null),
});

export const EventScheduleItem = z
  .object({
    id: Uuid,
    sequence: z.number().int(),
    kind: z.enum(EVENT_SCHEDULE_KINDS),
    dueDate: IsoDate,
    amountMinor: AmountMinor,
    paidMinor: AmountMinor,
    status: z.enum(EVENT_SCHEDULE_STATUSES),
  })
  .meta({ id: 'EventScheduleEntry' });

export const EventContractItem = z
  .object({
    id: Uuid,
    number: z.string(),
    status: z.enum(EVENT_CONTRACT_STATUSES),
    quoteVersion: z.number().int(),
    clientName: z.string(),
    clientEmail: z.string(),
    clientPhone: z.string(),
    terms: z.string(),
    totalMinor: AmountMinor,
    damageDepositMinor: AmountMinor,
    issuedAt: Instant,
    signedByName: z.string().nullable(),
    signedOn: IsoDate.nullable(),
    folio: z.object({ id: Uuid, number: z.string() }),
    account: z
      .object({ bankName: z.string(), accountNumber: z.string(), accountName: z.string() })
      .nullable(),
    schedule: z.array(EventScheduleItem),
    /** Money received beyond the whole schedule, held until the event is closed. */
    overpaidMinor: AmountMinor,
  })
  .meta({ id: 'EventContract' });

export const EventContractView = z
  .object({
    contract: EventContractItem.nullable(),
    missing: z.array(z.enum(EVENT_CONFIRM_MISSING)),
    /** Set when the contract was just issued with `send`. */
    emailed: z.boolean().optional(),
  })
  .meta({ id: 'EventContractView' });

export const EventContractBody = z.object({
  clientName: z.string().trim().min(1).max(120),
  clientEmail: z.email().max(254),
  /** The provider needs an email and a phone for the account holder. */
  clientPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ]{7,20}$/, 'Enter a phone number'),
  terms: z.string().trim().min(1).max(20_000),
  schedule: z
    .array(
      z.object({
        kind: z.enum(EVENT_SCHEDULE_KINDS),
        dueDate: IsoDate,
        amountMinor: PositiveMinor,
      }),
    )
    .min(1)
    .max(24),
  /** Email the contract, schedule and bank details to the client. */
  send: z.boolean().default(false),
});

export const EventContractSignBody = z.object({
  signedByName: z.string().trim().min(1).max(120),
  signedOn: IsoDate,
});

export const EventConfirmBody = z
  .object({
    /** Ask to confirm although the contract or deposit rule is not met. */
    override: z.boolean().default(false),
    reason: z.string().trim().max(500).default(''),
  })
  .refine((b) => !b.override || b.reason.length > 0, {
    path: ['reason'],
    message: 'Say why this booking should be confirmed anyway',
  });

const COMMON = {
  tags: ['Events'],
  propertyScoped: true as const,
  module: 'events' as const,
};
const Params = z.object({ bookingId: Uuid });

export const getEventQuotes = defineRoute({
  ...COMMON,
  permission: 'event.enquiry',
  operationId: 'getEventQuotes',
  method: 'get',
  path: '/event-bookings/{bookingId}/quotes',
  summary: 'The quote’s versions, with the prices that apply that day (M9-04)',
  params: Params,
  response: EventQuoteView,
});

export const createEventQuoteVersion = defineRoute({
  ...COMMON,
  permission: 'event.quote',
  operationId: 'createEventQuoteVersion',
  method: 'post',
  path: '/event-bookings/{bookingId}/quotes',
  summary: 'Save a new version of the quote (M9-04)',
  description:
    'Earlier versions are kept as they were. A contract not yet signed or paid on is withdrawn, since it no longer matches; one signed or paid on stops the quote changing.',
  idempotent: true,
  status: 201,
  params: Params,
  body: EventQuoteBody,
  response: EventQuoteView,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const getEventContract = defineRoute({
  ...COMMON,
  permission: 'event.enquiry',
  operationId: 'getEventContract',
  method: 'get',
  path: '/event-bookings/{bookingId}/contract',
  summary: 'The contract, its payment schedule, and what confirming still needs',
  params: Params,
  response: EventContractView,
});

export const getEventContractPdf = defineRoute({
  ...COMMON,
  permission: 'event.enquiry',
  operationId: 'getEventContractPdf',
  method: 'get',
  path: '/event-bookings/{bookingId}/contract.pdf',
  summary: 'The contract (PDF) to send or sign',
  produces: 'application/pdf',
  params: Params,
  response: PdfDocument,
});

export const issueEventContract = defineRoute({
  ...COMMON,
  permission: 'event.contract',
  operationId: 'issueEventContract',
  method: 'post',
  path: '/event-bookings/{bookingId}/contract',
  summary: 'Issue the contract and payment schedule on a dedicated virtual account (M9-05)',
  description:
    'The deposit and instalments add up to the current quote; a damage deposit is extra and refundable. Issuing again replaces a contract not yet signed or paid on.',
  idempotent: true,
  status: 201,
  params: Params,
  body: EventContractBody,
  response: EventContractView,
  errors: ['STATE_TRANSITION_INVALID', 'PAYMENT_PROVIDER_UNAVAILABLE'],
});

export const signEventContract = defineRoute({
  ...COMMON,
  permission: 'event.contract',
  operationId: 'signEventContract',
  method: 'post',
  path: '/event-bookings/{bookingId}/contract/sign',
  summary: 'Record that the client has signed the contract',
  params: Params,
  body: EventContractSignBody,
  response: EventContractView,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const confirmEventBooking = defineRoute({
  ...COMMON,
  permission: 'event.confirm',
  operationId: 'confirmEventBooking',
  method: 'post',
  path: '/event-bookings/{bookingId}/confirm',
  summary: 'Confirm the booking when the contract and deposit rules are met (M9-06)',
  description:
    '409 with `missing` when the contract is not signed or the deposit not paid in full. With `override` and a reason the answer is 202 and a manager approves, unless the caller is one of the approvers.',
  idempotent: true,
  approval: true,
  params: Params,
  body: EventConfirmBody,
  response: EventBookingItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const EVENT_SALES_ROUTES = {
  getEventQuotes,
  createEventQuoteVersion,
  getEventContract,
  getEventContractPdf,
  issueEventContract,
  signEventContract,
  confirmEventBooking,
} as const;
