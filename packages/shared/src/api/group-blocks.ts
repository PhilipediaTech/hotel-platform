import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { RESERVATION_STATUSES } from '../reservations.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';

// Group blocks and allotments (PRD M3-17 "group blocks with rooming list, pick-up and release
// date", group.manage; M2-12 "allotments with release days", allotment.manage; M2 rule 1
// "allocated … group blocks not released"; T-123). A block holds rooms of some types on each of
// its nights, out of what can be sold. A reservation made against it takes from what it holds
// first. A group gives back what is left on its release date; an allotment gives back each night
// a set number of days before that night.

export const GROUP_BLOCK_KINDS = ['GROUP', 'ALLOTMENT'] as const;
export const GROUP_BLOCK_STATUSES = ['ACTIVE', 'RELEASED', 'CANCELLED'] as const;

/** Longest block, in nights. */
export const GROUP_BLOCK_MAX_NIGHTS = 120;

const Name = z.string().trim().min(1).max(120);

export const GroupBlockNightItem = z
  .object({
    roomTypeId: Uuid,
    date: IsoDate,
    /** Rooms agreed for the night. */
    rooms: z.number().int(),
    /** Booked against the block. */
    pickedUp: z.number().int(),
    /** Still held for the block; 0 once released. */
    remaining: z.number().int(),
    released: z.boolean(),
  })
  .meta({ id: 'GroupBlockNight' });

export const RoomingEntryItem = z
  .object({
    reservationId: Uuid,
    confirmationNo: z.string(),
    stayId: Uuid,
    guestName: z.string(),
    roomTypeId: Uuid,
    roomNumber: z.string().nullable(),
    arrival: IsoDate,
    departure: IsoDate,
    status: z.enum(RESERVATION_STATUSES),
  })
  .meta({ id: 'RoomingEntry' });

export const GroupBlockItem = z
  .object({
    id: Uuid,
    kind: z.enum(GROUP_BLOCK_KINDS),
    code: z.string(),
    name: z.string(),
    status: z.enum(GROUP_BLOCK_STATUSES),
    company: z.object({ id: Uuid, name: z.string() }).nullable(),
    ratePlan: z.object({ id: Uuid, code: z.string(), name: z.string() }),
    arrival: IsoDate,
    /** The day the last guests leave; nights run up to the day before. */
    departure: IsoDate,
    /** A group's cut-off: what is not picked up is given back on this day. */
    releaseDate: IsoDate.nullable(),
    /** An allotment gives back each night this many days before it. */
    releaseDays: z.number().int().nullable(),
    notes: z.string().nullable(),
    roomTypes: z.array(
      z.object({ id: Uuid, name: z.string(), rooms: z.number().int(), pickedUp: z.number().int() }),
    ),
    createdAt: Instant,
  })
  .meta({ id: 'GroupBlock' });

export const GroupBlockDetail = GroupBlockItem.extend({
  nights: z.array(GroupBlockNightItem),
  rooming: z.array(RoomingEntryItem),
}).meta({ id: 'GroupBlockDetail' });

const BlockFields = {
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/, 'Letters, numbers and dashes only'),
  name: Name,
  companyId: Uuid.nullable().default(null),
  ratePlanId: Uuid,
  notes: z.string().trim().max(2000).nullable().default(null),
  /** Rooms of each type held every night of the block. */
  rooms: z
    .array(z.object({ roomTypeId: Uuid, count: z.number().int().min(0).max(500) }))
    .min(1)
    .max(30)
    .refine((r) => new Set(r.map((x) => x.roomTypeId)).size === r.length, 'One line per room type'),
};

export const GroupBlockBody = z
  .object({
    ...BlockFields,
    arrival: IsoDate,
    departure: IsoDate,
    releaseDate: IsoDate.nullable().default(null),
    releaseDays: z.number().int().min(0).max(365).nullable().default(null),
  })
  .refine((b) => b.departure > b.arrival, {
    path: ['departure'],
    message: 'The block ends after it starts',
  });

/** What can change after a block is made: its name, rate, rooms and release. */
export const GroupBlockUpdateBody = z.object({
  ...BlockFields,
  releaseDate: IsoDate.nullable().default(null),
  releaseDays: z.number().int().min(0).max(365).nullable().default(null),
});

export const RoomingListBody = z.object({
  rooms: z
    .array(
      z.object({
        firstName: Name,
        lastName: Name,
        roomTypeId: Uuid,
        adults: z.number().int().min(1).max(20).default(1),
        phone: z.string().trim().max(30).nullable().default(null),
        email: z.email().max(254).nullable().default(null),
      }),
    )
    .min(1)
    .max(100),
});

export const RoomingListResult = z
  .object({
    booked: z.array(z.object({ line: z.number().int(), confirmationNo: z.string() })),
    failed: z.array(z.object({ line: z.number().int(), message: z.string() })),
    block: GroupBlockDetail,
  })
  .meta({ id: 'RoomingListResult' });

function routesFor(kind: 'GROUP' | 'ALLOTMENT') {
  const group = kind === 'GROUP';
  const base = group ? '/group-blocks' : '/allotments';
  const noun = group ? 'GroupBlock' : 'Allotment';
  const common = {
    tags: ['Groups'],
    propertyScoped: true as const,
    permission: group ? 'group.manage' : 'allotment.manage',
  };
  const params = z.object({ blockId: Uuid });
  return {
    list: defineRoute({
      ...common,
      operationId: `list${noun}s`,
      method: 'get',
      path: base,
      summary: group
        ? 'Group blocks with their pick-up (M3-17)'
        : 'Allotments with their pick-up (M2-12)',
      query: z.object({ status: z.enum(GROUP_BLOCK_STATUSES).optional() }),
      response: z.object({ data: z.array(GroupBlockItem) }),
    }),
    create: defineRoute({
      ...common,
      operationId: `create${noun}`,
      method: 'post',
      path: base,
      summary: group
        ? 'Hold rooms for a group, to be given back on its release date (M3-17)'
        : 'Hold rooms for a company or agent, each night given back some days before (M2-12)',
      description:
        '409 BOOKING_CONFLICT naming the nights when there are not enough rooms to hold.',
      idempotent: true,
      status: 201,
      body: GroupBlockBody,
      response: GroupBlockDetail,
      errors: ['BOOKING_CONFLICT'],
    }),
    get: defineRoute({
      ...common,
      operationId: `get${noun}`,
      method: 'get',
      path: `${base}/{blockId}`,
      summary: 'Nights, pick-up and rooming list',
      params,
      response: GroupBlockDetail,
    }),
    update: defineRoute({
      ...common,
      operationId: `update${noun}`,
      method: 'put',
      path: `${base}/{blockId}`,
      summary: 'Change the rooms held, the rate or the release',
      description:
        'Rooms can be added while there are rooms to sell, and taken away down to what is picked up.',
      params,
      body: GroupBlockUpdateBody,
      response: GroupBlockDetail,
      errors: ['BOOKING_CONFLICT', 'STATE_TRANSITION_INVALID'],
    }),
    release: defineRoute({
      ...common,
      operationId: `release${noun}`,
      method: 'post',
      path: `${base}/{blockId}/release`,
      summary: 'Give back every room not picked up now, or cancel the block',
      params,
      body: z.object({ cancel: z.boolean().default(false) }),
      response: GroupBlockDetail,
      errors: ['STATE_TRANSITION_INVALID'],
    }),
    rooming: defineRoute({
      ...common,
      operationId: `book${noun}RoomingList`,
      method: 'post',
      path: `${base}/{blockId}/rooming-list`,
      summary: 'Book a reservation for each name on the rooming list, from the block',
      description: 'Each line is booked on its own; the lines that could not be booked say why.',
      params,
      body: RoomingListBody,
      response: RoomingListResult,
      errors: ['STATE_TRANSITION_INVALID'],
    }),
  };
}

const G = routesFor('GROUP');
const A = routesFor('ALLOTMENT');

export const listGroupBlocks = G.list;
export const createGroupBlock = G.create;
export const getGroupBlock = G.get;
export const updateGroupBlock = G.update;
export const releaseGroupBlock = G.release;
export const bookGroupBlockRoomingList = G.rooming;
export const listAllotments = A.list;
export const createAllotment = A.create;
export const getAllotment = A.get;
export const updateAllotment = A.update;
export const releaseAllotment = A.release;
export const bookAllotmentRoomingList = A.rooming;

export const GROUP_BLOCK_ROUTES = {
  listGroupBlocks,
  createGroupBlock,
  getGroupBlock,
  updateGroupBlock,
  releaseGroupBlock,
  bookGroupBlockRoomingList,
  listAllotments,
  createAllotment,
  getAllotment,
  updateAllotment,
  releaseAllotment,
  bookAllotmentRoomingList,
} as const;
