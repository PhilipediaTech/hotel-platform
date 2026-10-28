import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { IsoDate, Uuid } from './primitives.ts';

// Room-type inventory (tab 2 "Inventory and concurrency"; PRD M2 rules 1–2, M2-09; T-040):
// how many rooms of each type are left per date, and the overbooking limit. Not in tab 4: the
// rate screen shows it, and GM set overbooking limits (M2-09) here.

/** Days ahead the inventory is kept for (today included); a daily job extends it. */
export const INVENTORY_DAYS = 400;
/** Most rooms a hotel may sell above capacity, per type and date. */
export const MAX_OVERBOOK_LIMIT = 50;
const MAX_READ_DAYS = 62;

export const InventoryDay = z
  .object({
    roomTypeId: Uuid,
    date: IsoDate,
    /** Active rooms of the type (out of service still counts). */
    capacity: z.number().int(),
    outOfOrder: z.number().int(),
    /** Confirmed and checked-in stays (reservations, T-042). */
    sold: z.number().int(),
    /** Unexpired tentative holds and group blocks. */
    held: z.number().int(),
    overbookLimit: z.number().int(),
    /** Sellable: capacity − out of order − sold − held + overbooking limit (M2 rule 1). */
    available: z.number().int(),
  })
  .meta({ id: 'InventoryDay' });

export const getInventory = defineRoute({
  operationId: 'getInventory',
  method: 'get',
  path: '/inventory',
  summary: 'Rooms left per room type and date',
  description: `\`to\` is included; at most ${MAX_READ_DAYS} days.`,
  tags: ['Availability'],
  propertyScoped: true,
  permission: 'availability.read',
  query: z.object({ from: IsoDate, to: IsoDate }),
  response: z.object({ days: z.array(InventoryDay) }),
});

export const OverbookingBody = z
  .object({
    roomTypeIds: z
      .array(Uuid)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, 'Each once'),
    /** From today on. */
    from: IsoDate,
    /** Included; within the inventory horizon. */
    to: IsoDate,
    limit: z.number().int().min(0).max(MAX_OVERBOOK_LIMIT),
  })
  .refine((b) => b.to >= b.from, { message: 'End on or after the start', path: ['to'] });

export const setOverbooking = defineRoute({
  operationId: 'setOverbooking',
  method: 'put',
  path: '/inventory/overbooking',
  summary: 'Set how many rooms may be sold above capacity (default 0)',
  description:
    'Lowering the limit below what is already sold answers 409 STATE_TRANSITION_INVALID with the dates.',
  tags: ['Availability'],
  propertyScoped: true,
  permission: 'rate.overbook',
  body: OverbookingBody,
  response: z.object({ changedDays: z.number().int() }),
  errors: ['STATE_TRANSITION_INVALID'],
});

export const INVENTORY_ROUTES = { getInventory, setOverbooking } as const;
export { MAX_READ_DAYS as MAX_INVENTORY_READ_DAYS };
