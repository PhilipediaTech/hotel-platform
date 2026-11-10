import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { EventBookingItem } from './events.ts';
import { AmountMinor, Instant, Uuid } from './primitives.ts';

// Cancelling an event (T-121b). The spec has no cancellation story; Philip set the rule on
// 2026-11-10: no cancelling within 24 hours of the event; cancelled within 24 hours of booking,
// 30% of the deposit is kept; later than that, 50%. Kept here, in one place, so the contract,
// the screen and the server all state the same rule.

export const EVENT_CANCELLATION = {
  /** No cancelling once the event is this close: it goes ahead and is invoiced as agreed. */
  noticeHours: 24,
  /** Cancelling within this long of booking keeps the smaller share of the deposit. */
  earlyHours: 24,
  earlyKeepBps: 3000,
  laterKeepBps: 5000,
} as const;

/** The rule in words, for the contract and the screen. */
export function eventCancellationTerms(): string {
  const c = EVENT_CANCELLATION;
  return [
    'Cancellation:',
    `- Cancelled within ${c.earlyHours} hours of booking: ${c.earlyKeepBps / 100}% of the deposit paid is kept.`,
    `- Cancelled after that: ${c.laterKeepBps / 100}% of the deposit paid is kept.`,
    `- Within ${c.noticeHours} hours of the event it can no longer be cancelled, and is invoiced as agreed.`,
    'Any tax due on the amount kept is added to it. Everything else paid is refunded.',
  ].join('\n');
}

export const EventCancellationView = z
  .object({
    allowed: z.boolean(),
    /** Why it cannot be cancelled. */
    reason: z.enum(['TOO_CLOSE', 'NOTHING_TO_CANCEL', 'NOT_CANCELLABLE']).nullable(),
    /** When it counts as booked: confirmed, or for a paid hold, the contract issued. */
    bookedAt: Instant.nullable(),
    keepBps: z.number().int(),
    depositPaidMinor: AmountMinor,
    /** Before any tax on it. */
    feeMinor: AmountMinor,
    receivedMinor: AmountMinor,
  })
  .meta({ id: 'EventCancellation' });

export const EventCancelBody = z.object({ reason: z.string().trim().min(1).max(500) });

const COMMON = {
  tags: ['Events'],
  propertyScoped: true as const,
  module: 'events' as const,
};
const Params = z.object({ bookingId: Uuid });

export const getEventCancellation = defineRoute({
  ...COMMON,
  permission: 'event.enquiry',
  operationId: 'getEventCancellation',
  method: 'get',
  path: '/event-bookings/{bookingId}/cancellation',
  summary: 'Whether a booking can be cancelled now, and what the client would lose',
  params: Params,
  response: EventCancellationView,
});

export const cancelEvent = defineRoute({
  ...COMMON,
  permission: 'event.confirm',
  operationId: 'cancelEvent',
  method: 'post',
  path: '/event-bookings/{bookingId}/cancel',
  summary: 'Cancel a confirmed or paid booking under the cancellation rule',
  description:
    'Gives the space back, posts the cancellation fee to the event’s bill and voids the contract. What is left is refunded from the bill, then the event is closed. Refused within 24 hours of the event.',
  idempotent: true,
  params: Params,
  body: EventCancelBody,
  response: EventBookingItem,
  errors: ['STATE_TRANSITION_INVALID', 'BUSINESS_DAY_CLOSED'],
});

export const EVENT_CANCELLATION_ROUTES = { getEventCancellation, cancelEvent } as const;
