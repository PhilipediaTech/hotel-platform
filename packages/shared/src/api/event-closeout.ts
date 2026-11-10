import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { EVENT_LINE_KINDS } from './event-sales.ts';
import { EventBookingItem } from './events.ts';
import { AmountMinor, Instant, PdfDocument, Uuid } from './primitives.ts';

// Events and spaces, third part (PRD M9-07, M9-08, M9 rule "damage deposits are a liability,
// never revenue, until settled"; tab 3 event_briefs; tab 4 /event-bookings/{id}/close; T-121):
// the brief for each department, the inspection and final invoice, and closing the event.

/** What still stands between an inspected event and closing it (M9-08). */
export const EVENT_CLOSE_BLOCKERS = [
  'EVENT_NOT_OVER',
  'NOT_INSPECTED',
  'BALANCE_DUE',
  'CREDIT_TO_RETURN',
] as const;

const NonNegativeMinor = AmountMinor.refine((v) => !v.startsWith('-'), 'Must not be negative');

export const EventBriefView = z
  .object({
    sections: z.array(
      z.object({
        department: z.object({ id: Uuid, code: z.string(), name: z.string() }),
        instructions: z.string(),
        version: z.number().int(),
        updatedAt: Instant.nullable(),
      }),
    ),
  })
  .meta({ id: 'EventBrief' });

export const EventBriefBody = z.object({
  /** Leaving a department's instructions empty removes it from the brief. */
  sections: z
    .array(z.object({ departmentId: Uuid, instructions: z.string().trim().max(8000) }))
    .max(50),
});

export const EventCloseOutView = z
  .object({
    status: EventBookingItem.shape.status,
    inspection: z
      .object({
        at: Instant,
        notes: z.string(),
        damageDescription: z.string().nullable(),
        /** What the damage cost the client, with any tax on it. */
        damageTotalMinor: AmountMinor,
      })
      .nullable(),
    folio: z
      .object({
        id: Uuid,
        number: z.string(),
        status: z.string(),
        /** Above zero the client owes the hotel; below zero the hotel owes the client. */
        balanceMinor: AmountMinor,
      })
      .nullable(),
    damageDepositHeldMinor: AmountMinor,
    /** The part of the damage deposit that goes to the damage; the rest is the client's. */
    damageDepositRetainedMinor: AmountMinor,
    blockers: z.array(z.enum(EVENT_CLOSE_BLOCKERS)),
    closedAt: Instant.nullable(),
  })
  .meta({ id: 'EventCloseOut' });

export const EventInspectionBody = z
  .object({
    notes: z.string().trim().min(1).max(4000),
    damageMinor: NonNegativeMinor.default('0'),
    damageDescription: z.string().trim().max(200).nullable().default(null),
    /** Anything agreed on the day that was not on the quote. */
    extras: z
      .array(
        z.object({
          kind: z.enum(EVENT_LINE_KINDS),
          description: z.string().trim().min(1).max(200),
          quantity: z.number().int().min(1).max(100_000),
          unitMinor: NonNegativeMinor,
        }),
      )
      .max(50)
      .default([]),
  })
  .refine((b) => BigInt(b.damageMinor) === 0n || (b.damageDescription ?? '').length > 0, {
    path: ['damageDescription'],
    message: 'Say what was damaged',
  });

const COMMON = {
  tags: ['Events'],
  propertyScoped: true as const,
  module: 'events' as const,
};
const Params = z.object({ bookingId: Uuid });

export const getEventBrief = defineRoute({
  ...COMMON,
  permission: 'event.enquiry',
  operationId: 'getEventBrief',
  method: 'get',
  path: '/event-bookings/{bookingId}/brief',
  summary: 'The event brief: what each department has to do (M9-07)',
  params: Params,
  response: EventBriefView,
});

export const saveEventBrief = defineRoute({
  ...COMMON,
  permission: 'event.brief',
  operationId: 'saveEventBrief',
  method: 'put',
  path: '/event-bookings/{bookingId}/brief',
  summary: 'Write the brief for each department of a confirmed booking (M9-07)',
  params: Params,
  body: EventBriefBody,
  response: EventBriefView,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const getEventBriefPdf = defineRoute({
  ...COMMON,
  permission: 'event.enquiry',
  operationId: 'getEventBriefPdf',
  method: 'get',
  path: '/event-bookings/{bookingId}/brief.pdf',
  summary: 'The banquet event order (PDF), whole or for one department',
  produces: 'application/pdf',
  params: Params,
  query: z.object({ departmentId: Uuid.optional() }),
  response: PdfDocument,
});

export const getEventCloseOut = defineRoute({
  ...COMMON,
  permission: 'event.enquiry',
  operationId: 'getEventCloseOut',
  method: 'get',
  path: '/event-bookings/{bookingId}/close-out',
  summary: 'The inspection, the event’s bill, and what closing it still needs',
  params: Params,
  response: EventCloseOutView,
});

export const inspectEvent = defineRoute({
  ...COMMON,
  permission: 'event.close',
  operationId: 'inspectEvent',
  method: 'post',
  path: '/event-bookings/{bookingId}/inspection',
  summary: 'Record the inspection and post the final charges to the event’s bill (M9-08)',
  description:
    'Posts the contracted quote, anything added on the day, and any damage. Damage is what turns part of the damage deposit into revenue; the rest stays the client’s.',
  idempotent: true,
  status: 201,
  params: Params,
  body: EventInspectionBody,
  response: EventCloseOutView,
  errors: ['STATE_TRANSITION_INVALID', 'BUSINESS_DAY_CLOSED'],
});

export const getEventInvoicePdf = defineRoute({
  ...COMMON,
  permission: 'event.close',
  operationId: 'getEventInvoicePdf',
  method: 'get',
  path: '/event-bookings/{bookingId}/invoice.pdf',
  summary: 'The event’s final invoice (PDF) (M9-08)',
  produces: 'application/pdf',
  params: Params,
  response: PdfDocument,
});

export const closeEvent = defineRoute({
  ...COMMON,
  permission: 'event.close',
  operationId: 'closeEvent',
  method: 'post',
  path: '/event-bookings/{bookingId}/close',
  summary: 'Close an inspected event whose bill has reached zero (M9-08)',
  description:
    '409 with `blockers` while the client owes money or is owed it: take the payment or refund it on the event’s bill first.',
  idempotent: true,
  params: Params,
  body: z.object({}),
  response: EventBookingItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const EVENT_CLOSEOUT_ROUTES = {
  getEventBrief,
  saveEventBrief,
  getEventBriefPdf,
  getEventCloseOut,
  inspectEvent,
  getEventInvoicePdf,
  closeEvent,
} as const;
