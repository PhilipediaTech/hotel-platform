import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';

// Lost and found (PRD M5-13 "As a manager, I record lost-and-found items with custody and
// handover", lostfound.manage; lost_found_items is listed for V1.1 in tab 3 without columns;
// no tab 4 row; S17 "lost item"; T-133). An item is logged where it was found (a room links it
// to the stay most likely to own it), then held in a storage place by a custodian. Every
// custody change is on its trail. It ends either returned to its owner (name, contact and how
// they were identified) or, once kept long enough, disposed of. Valuables are kept longer and
// are never discarded or donated.

export const LOST_STATUSES = ['HELD', 'RETURNED', 'DISPOSED'] as const;
export type LostStatus = (typeof LOST_STATUSES)[number];
export const DISPOSALS = ['DISCARDED', 'DONATED', 'POLICE', 'OTHER'] as const;
export type Disposal = (typeof DISPOSALS)[number];
/** Ways a valuable may leave without its owner. */
export const VALUABLE_DISPOSALS: readonly Disposal[] = ['POLICE', 'OTHER'];
export const LOST_EVENT_KINDS = ['LOGGED', 'CUSTODY', 'RETURNED', 'DISPOSED', 'NOTE'] as const;
/** Offered when logging an item; any other category can be typed. */
export const LOST_CATEGORIES = [
  'Phone',
  'Electronics',
  'Charger',
  'Clothing',
  'Shoes',
  'Bag',
  'Jewellery',
  'Watch',
  'Documents',
  'Cash',
  'Glasses',
  'Toiletries',
  'Other',
] as const;
/** Days an item is kept before it may be disposed of. */
export const KEEP_DAYS = 90;
export const KEEP_DAYS_VALUABLE = 180;

const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
const Optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();
const Person = z.object({ id: Uuid, name: z.string() });

export const LostItem = z
  .object({
    id: Uuid,
    /** LF-<number> on the tag. */
    number: z.number().int(),
    description: z.string(),
    category: z.string(),
    valuable: z.boolean(),
    foundAt: Instant,
    foundWhere: z.string().nullable(),
    room: z.object({ id: Uuid, number: z.string() }).nullable(),
    /** The guest of the room when it was found. */
    owner: z
      .object({
        stayId: Uuid,
        guestName: z.string(),
        phone: z.string().nullable(),
        checkedOutAt: Instant.nullable(),
      })
      .nullable(),
    foundBy: Person,
    storageLocation: z.string(),
    custodian: Person,
    status: z.enum(LOST_STATUSES),
    keepUntil: IsoDate,
    /** Held past its keep-until date: it may be disposed of. */
    canDispose: z.boolean(),
    returnedToName: z.string().nullable(),
    disposal: z.enum(DISPOSALS).nullable(),
    closedAt: Instant.nullable(),
  })
  .meta({ id: 'LostItem' });

export const LostItemDetail = LostItem.extend({
  returnedToPhone: z.string().nullable(),
  returnedIdNote: z.string().nullable(),
  closedBy: Person.nullable(),
  /** The custody trail, oldest first. */
  events: z.array(
    z.object({
      kind: z.enum(LOST_EVENT_KINDS),
      note: z.string().nullable(),
      storageLocation: z.string().nullable(),
      custodian: Person.nullable(),
      by: Person,
      at: Instant,
    }),
  ),
}).meta({ id: 'LostItemDetail' });

export const LostItemBody = z.object({
  description: Text(3, 200),
  category: Text(2, 40),
  valuable: z.boolean().default(false),
  /** When it was found; now when left out. */
  foundAt: Instant.optional(),
  roomId: Uuid.nullable().default(null),
  /** Where, when not a room (lobby, pool, restaurant…). */
  foundWhere: Optional(120).default(null),
  storageLocation: Text(2, 120),
  /** Who holds it; the person logging it when left out. */
  custodianId: Uuid.nullable().default(null),
  note: Optional(500).default(null),
});

export const CustodyBody = z.object({
  storageLocation: Text(2, 120),
  custodianId: Uuid,
  note: Optional(500).default(null),
});

export const ReturnBody = z.object({
  toName: Text(2, 120),
  toPhone: Optional(40).default(null),
  /** How they were identified, e.g. "Passport ending 4567" or "Booking LAG-24117". */
  idNote: Text(3, 200),
  note: Optional(500).default(null),
});

export const DisposeBody = z.object({
  disposal: z.enum(DISPOSALS),
  /** What was done and who took it. */
  note: Text(3, 500),
});

const COMMON = {
  tags: ['Lost and found'],
  propertyScoped: true as const,
  permission: 'lostfound.manage',
};
const ItemParams = z.object({ itemId: Uuid });
const ADDED = 'Added (T-133): tab 4 has no lost-and-found routes.';

export const listLostItems = defineRoute({
  ...COMMON,
  operationId: 'listLostItems',
  method: 'get',
  path: '/lost-found',
  summary: 'Lost-and-found items (M5-13)',
  description: `${ADDED} Held items by default, newest first.`,
  query: z.object({
    status: z.enum(LOST_STATUSES).optional(),
    q: z.string().trim().max(80).optional(),
  }),
  response: z.object({
    data: z.array(LostItem),
    categories: z.array(z.string()),
    /** People who can hold items (lostfound.manage). */
    custodians: z.array(Person),
    /** Rooms to log an item in. */
    rooms: z.array(z.object({ id: Uuid, number: z.string() })),
  }),
});

export const createLostItem = defineRoute({
  ...COMMON,
  operationId: 'createLostItem',
  method: 'post',
  path: '/lost-found',
  summary: 'Log a found item (M5-13)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: LostItemBody,
  response: LostItemDetail,
});

export const getLostItem = defineRoute({
  ...COMMON,
  operationId: 'getLostItem',
  method: 'get',
  path: '/lost-found/{itemId}',
  summary: 'A found item with its custody trail (M5-13)',
  description: ADDED,
  params: ItemParams,
  response: LostItemDetail,
});

export const moveLostItem = defineRoute({
  ...COMMON,
  operationId: 'moveLostItem',
  method: 'post',
  path: '/lost-found/{itemId}/custody',
  summary: 'Hand a found item to another custodian or storage place (M5-13)',
  description: ADDED,
  idempotent: true,
  params: ItemParams,
  body: CustodyBody,
  response: LostItemDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const returnLostItem = defineRoute({
  ...COMMON,
  operationId: 'returnLostItem',
  method: 'post',
  path: '/lost-found/{itemId}/return',
  summary: 'Hand a found item back to its owner (M5-13)',
  description: ADDED,
  idempotent: true,
  params: ItemParams,
  body: ReturnBody,
  response: LostItemDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const disposeLostItem = defineRoute({
  ...COMMON,
  operationId: 'disposeLostItem',
  method: 'post',
  path: '/lost-found/{itemId}/dispose',
  summary: 'Dispose of an unclaimed item after its keep-until date (M5-13)',
  description: `${ADDED} Valuables go to the police or are handled otherwise, never discarded or donated.`,
  idempotent: true,
  params: ItemParams,
  body: DisposeBody,
  response: LostItemDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const LOST_FOUND_ROUTES = {
  listLostItems,
  createLostItem,
  getLostItem,
  moveLostItem,
  returnLostItem,
  disposeLostItem,
} as const;
