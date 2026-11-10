import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { EventBookingItem } from './events.ts';
import { AmountMinor, Instant, Uuid } from './primitives.ts';

// Cancelling an event (T-121b, T-121c). The spec has no cancellation story; Philip set the
// default rule on 2026-11-10: no cancelling within 24 hours of the event; cancelled within 24
// hours of booking, 30% of the deposit is kept; later than that, 50%. Each hotel can change the
// numbers (T-121c); every contract keeps the rule it was issued under, so a later change never
// alters what a client signed.

/** The default rule, for hotels that have not set their own. */
export const EVENT_CANCELLATION = {
  /** No cancelling once the event is this close: it goes ahead and is invoiced as agreed. */
  noticeHours: 24,
  /** Cancelling within this long of booking keeps the smaller share of the deposit. */
  earlyHours: 24,
  earlyKeepBps: 3000,
  laterKeepBps: 5000,
} as const;

const Hours = z
  .number()
  .int()
  .min(0)
  .max(24 * 60);
const Bps = z.number().int().min(0).max(10_000);

export const EventCancellationRule = z
  .object({
    /** No cancelling once the event is this close. */
    noticeHours: Hours,
    /** Cancelling within this long of booking keeps `earlyKeepBps` of the deposit paid. */
    earlyHours: Hours,
    earlyKeepBps: Bps,
    laterKeepBps: Bps,
  })
  .meta({ id: 'EventCancellationRule' });
export type EventCancellationRule = z.infer<typeof EventCancellationRule>;

/** A stored rule, or the default when there is none (or it no longer reads). */
export function cancellationRuleOf(stored: unknown): EventCancellationRule {
  const parsed = EventCancellationRule.safeParse(stored);
  return parsed.success ? parsed.data : { ...EVENT_CANCELLATION };
}

/** The rule in words, for the contract and the screen. */
export function eventCancellationTerms(rule: EventCancellationRule = EVENT_CANCELLATION): string {
  const c = rule;
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
    /** The rule that applies: the contract's own, or the hotel's for a booking without one. */
    rule: EventCancellationRule,
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

export const EventSettingsView = z
  .object({ cancellation: EventCancellationRule, isDefault: z.boolean() })
  .meta({ id: 'EventSettings' });

export const getEventSettings = defineRoute({
  ...COMMON,
  permission: 'event.enquiry',
  operationId: 'getEventSettings',
  method: 'get',
  path: '/event-settings',
  summary: 'The hotel’s event cancellation rule',
  response: EventSettingsView,
});

export const updateEventSettings = defineRoute({
  ...COMMON,
  permission: 'space.manage',
  operationId: 'updateEventSettings',
  method: 'put',
  path: '/event-settings',
  summary: 'Set the hotel’s event cancellation rule',
  description:
    'Applies to contracts issued from now on; each contract keeps the rule printed on it.',
  body: z.object({ cancellation: EventCancellationRule }),
  response: EventSettingsView,
});

export const EVENT_CANCELLATION_ROUTES = {
  getEventCancellation,
  cancelEvent,
  getEventSettings,
  updateEventSettings,
} as const;
