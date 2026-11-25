import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, Uuid } from './primitives.ts';

// Kitchen display (PRD M8-06 "As kitchen staff, I see tickets on a kitchen display and bump
// them when done", pos.kitchen; tab 5 S44 /kitchen "Ticket queue, bump"; tab 3
// kitchen_tickets; T-156). A ticket is what one order sends one station at a time: the
// cashier sends the items, or settling the order sends what is left. The display shows the
// station's tickets oldest first; the cook bumps each when done, and can recall one bumped
// by mistake. A voided item stays on its ticket, struck through.

export const KitchenTicketItem = z
  .object({
    id: Uuid,
    orderId: Uuid,
    /** The order's number and table or tab. */
    orderNumber: z.string(),
    label: z.string(),
    /** 1, 2, … : the order's rounds. */
    number: z.number().int(),
    station: z.string(),
    sentAt: Instant,
    sentBy: z.string(),
    bumpedAt: Instant.nullable(),
    bumpedBy: z.string().nullable(),
    /** The order was cancelled after sending: nothing to make. */
    cancelled: z.boolean(),
    lines: z.array(
      z.object({
        id: Uuid,
        name: z.string(),
        quantity: z.number().int(),
        note: z.string().nullable(),
        /** Voided after it was sent: not to make. */
        voided: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'KitchenTicket' });

export const KitchenBoard = z
  .object({
    /** Outlets with at least one station, and their stations. */
    outlets: z.array(z.object({ id: Uuid, name: z.string(), stations: z.array(z.string()) })),
    /** The tickets waiting, oldest first. */
    waiting: z.array(KitchenTicketItem),
    /** The last tickets bumped today, newest first (to recall one). */
    bumped: z.array(KitchenTicketItem),
  })
  .meta({ id: 'KitchenBoard' });

const KITCHEN = {
  tags: ['Kitchen'],
  propertyScoped: true as const,
  permission: 'pos.kitchen',
};
const ADDED = 'Not in tab 4 (tab 5 S44 names the screen): designed in T-156.';

export const getKitchenBoard = defineRoute({
  ...KITCHEN,
  operationId: 'getKitchenBoard',
  method: 'get',
  path: '/kitchen/tickets',
  summary: 'A station’s tickets: waiting, oldest first, and the last ones bumped',
  description: `${ADDED} Without an outlet and station, the first outlet's first station.`,
  query: z.object({
    outletId: Uuid.optional(),
    station: z.string().trim().min(1).max(30).optional(),
  }),
  response: KitchenBoard,
});

const TicketParams = z.object({ ticketId: Uuid });

export const bumpKitchenTicket = defineRoute({
  ...KITCHEN,
  operationId: 'bumpKitchenTicket',
  method: 'post',
  path: '/kitchen/tickets/{ticketId}/bump',
  summary: 'Done: take the ticket off the display',
  description: `${ADDED} Bumping a bumped ticket changes nothing.`,
  params: TicketParams,
  response: KitchenTicketItem,
});

export const recallKitchenTicket = defineRoute({
  ...KITCHEN,
  operationId: 'recallKitchenTicket',
  method: 'post',
  path: '/kitchen/tickets/{ticketId}/recall',
  summary: 'Put a bumped ticket back on the display',
  description: `${ADDED} Recalling a waiting ticket changes nothing.`,
  params: TicketParams,
  response: KitchenTicketItem,
});

export const KITCHEN_ROUTES = { getKitchenBoard, bumpKitchenTicket, recallKitchenTicket } as const;
