import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';

// Room types, rooms and out-of-order/out-of-service blocks (tab 4 row "Rooms"; PRD M2-01–
// M2-03; S24; T-031). Lists are open to everyone at the property (front desk and
// housekeeping read them); changes need roomtype.manage, room.manage or room.block.

export const HK_STATUSES = [
  'DIRTY',
  'CLEANING',
  'CLEAN',
  'INSPECTED',
  'OUT_OF_ORDER',
  'OUT_OF_SERVICE',
] as const;
export const BLOCK_KINDS = ['OUT_OF_ORDER', 'OUT_OF_SERVICE'] as const;

/** Longest single block; a longer closure is several blocks or a deactivated room. */
export const MAX_BLOCK_DAYS = 366;

const Text = (max: number) => z.string().trim().min(1).max(max);
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();
/** Short labels (amenities, features), each once. */
const Labels = z
  .array(Text(60))
  .max(40)
  .refine((l) => new Set(l.map((x) => x.toLowerCase())).size === l.length, 'Each one once');

// ── Room types ─────────────────────────────────────────────────────────────────────────

export const RoomTypeItem = z
  .object({
    id: Uuid,
    code: z.string(),
    name: z.string(),
    baseOccupancy: z.number().int(),
    maxOccupancy: z.number().int(),
    description: z.string().nullable(),
    amenities: z.array(z.string()),
    /** Files of kind RoomType; download links come from GET /files/{id}/download-url. */
    photoFileIds: z.array(Uuid),
    sortOrder: z.number().int(),
    active: z.boolean(),
    /** Active rooms of this type. */
    roomCount: z.number().int(),
  })
  .meta({ id: 'RoomType' });

const RoomTypeCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,10}$/, 'Two to ten letters, digits or dashes, e.g. DLX');
const Occupancy = z.number().int().min(1).max(20);

const RoomTypeFields = z.object({
  code: RoomTypeCode,
  name: Text(80),
  baseOccupancy: Occupancy,
  maxOccupancy: Occupancy,
  description: OptionalText(1000),
  amenities: Labels,
  photoFileIds: z
    .array(Uuid)
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, 'Each photo once'),
  sortOrder: z.number().int().min(0).max(999),
});

const occupancyOrder = (t: { baseOccupancy?: number; maxOccupancy?: number }) =>
  t.baseOccupancy === undefined ||
  t.maxOccupancy === undefined ||
  t.baseOccupancy <= t.maxOccupancy;
const occupancyIssue = {
  message: 'Maximum occupancy must be at least the base occupancy',
  path: ['maxOccupancy'],
};

export const RoomTypeBody = RoomTypeFields.extend({
  baseOccupancy: Occupancy.default(2),
  maxOccupancy: Occupancy.default(2),
  description: OptionalText(1000).default(null),
  amenities: Labels.default([]),
  photoFileIds: RoomTypeFields.shape.photoFileIds.default([]),
  sortOrder: z.number().int().min(0).max(999).default(0),
}).refine(occupancyOrder, occupancyIssue);

/** Built from the fields without defaults (`.partial()` keeps defaults). */
export const RoomTypePatchBody = RoomTypeFields.extend({ active: z.boolean() })
  .partial()
  .refine(occupancyOrder, occupancyIssue);

export const listRoomTypes = defineRoute({
  operationId: 'listRoomTypes',
  method: 'get',
  path: '/room-types',
  summary: 'Room types of the property, active and inactive',
  tags: ['Rooms'],
  propertyScoped: true,
  response: z.object({ data: z.array(RoomTypeItem) }),
});

export const createRoomType = defineRoute({
  operationId: 'createRoomType',
  method: 'post',
  path: '/room-types',
  summary: 'Add a room type',
  tags: ['Rooms'],
  propertyScoped: true,
  permission: 'roomtype.manage',
  body: RoomTypeBody,
  status: 201,
  response: RoomTypeItem,
});

export const updateRoomType = defineRoute({
  operationId: 'updateRoomType',
  method: 'patch',
  path: '/room-types/{roomTypeId}',
  summary: 'Change a room type, or deactivate it once it has no active rooms',
  tags: ['Rooms'],
  propertyScoped: true,
  permission: 'roomtype.manage',
  params: z.object({ roomTypeId: Uuid }),
  body: RoomTypePatchBody,
  response: RoomTypeItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

// ── Rooms ──────────────────────────────────────────────────────────────────────────────

export const RoomBlockItem = z
  .object({
    id: Uuid,
    roomId: Uuid,
    kind: z.enum(BLOCK_KINDS),
    startDate: IsoDate,
    /** Exclusive: the first day the room is back. */
    endDate: IsoDate,
    reason: z.string(),
    createdBy: z.object({ id: Uuid, name: z.string() }),
    createdAt: Instant,
    releasedAt: Instant.nullable(),
  })
  .meta({ id: 'RoomBlock' });

export const RoomItem = z
  .object({
    id: Uuid,
    number: z.string(),
    roomTypeId: Uuid,
    floor: z.string().nullable(),
    building: z.string().nullable(),
    features: z.array(z.string()),
    connectingRoomId: Uuid.nullable(),
    hkStatus: z.enum(HK_STATUSES),
    /** Printed on the room's QR sticker; staff scan it to report a fault (T-082). */
    qrToken: z.string(),
    active: z.boolean(),
    /** Send as `If-Match: "<version>"` when changing the room. */
    version: z.number().int(),
    /** Blocks not released that end after today (current and future). */
    blocks: z.array(RoomBlockItem),
  })
  .meta({ id: 'Room' });

const RoomNumber = z
  .string()
  .trim()
  .min(1)
  .max(10)
  .regex(/^[A-Za-z0-9-]+$/, 'Letters, digits and dashes, e.g. 101 or B-12');

const RoomFields = z.object({
  number: RoomNumber,
  roomTypeId: Uuid,
  floor: OptionalText(20),
  building: OptionalText(60),
  features: Labels,
  /** The room on the other side of the connecting door; set on both rooms. */
  connectingRoomId: Uuid.nullable(),
});

export const RoomBody = RoomFields.extend({
  floor: OptionalText(20).default(null),
  building: OptionalText(60).default(null),
  features: Labels.default([]),
  connectingRoomId: Uuid.nullable().default(null),
});

export const RoomPatchBody = RoomFields.extend({ active: z.boolean() }).partial();

export const listRooms = defineRoute({
  operationId: 'listRooms',
  method: 'get',
  path: '/rooms',
  summary: 'Rooms of the property with their current and future blocks',
  tags: ['Rooms'],
  propertyScoped: true,
  response: z.object({ data: z.array(RoomItem) }),
});

export const createRoom = defineRoute({
  operationId: 'createRoom',
  method: 'post',
  path: '/rooms',
  summary: 'Add a room',
  tags: ['Rooms'],
  propertyScoped: true,
  permission: 'room.manage',
  body: RoomBody,
  status: 201,
  response: RoomItem,
});

export const updateRoom = defineRoute({
  operationId: 'updateRoom',
  method: 'patch',
  path: '/rooms/{roomId}',
  summary: 'Change a room: number, type, floor, features, connecting room, active',
  tags: ['Rooms'],
  propertyScoped: true,
  permission: 'room.manage',
  ifMatch: true,
  params: z.object({ roomId: Uuid }),
  body: RoomPatchBody,
  response: RoomItem,
});

/** Statuses staff set by hand; out of order/service come from blocks (M2 rule 2). */
export const SETTABLE_HK_STATUSES = ['DIRTY', 'CLEANING', 'CLEAN', 'INSPECTED'] as const;

export const setHkStatus = defineRoute({
  operationId: 'setHkStatus',
  method: 'patch',
  path: '/rooms/{roomId}/hk-status',
  summary: 'Set a room’s housekeeping status',
  description:
    'hk.work or hk.inspect for dirty, cleaning and clean; hk.inspect for inspected. A room under an out-of-order or out-of-service block keeps that status until the block ends (409 STATE_TRANSITION_INVALID). The housekeeping board arrives with T-080.',
  tags: ['Rooms'],
  propertyScoped: true,
  ifMatch: true,
  params: z.object({ roomId: Uuid }),
  body: z.object({ hkStatus: z.enum(SETTABLE_HK_STATUSES) }),
  response: RoomItem,
  errors: ['STATE_TRANSITION_INVALID', 'VERSION_CONFLICT'],
});

// ── Blocks ─────────────────────────────────────────────────────────────────────────────

export const RoomBlockBody = z
  .object({
    roomId: Uuid,
    kind: z.enum(BLOCK_KINDS),
    /** From today (property date) onwards. */
    startDate: IsoDate,
    /** Exclusive: the first day the room is back. */
    endDate: IsoDate,
    reason: Text(500),
  })
  .refine((b) => b.endDate > b.startDate, {
    message: 'The room must be back after it is blocked',
    path: ['endDate'],
  });

export const createRoomBlock = defineRoute({
  operationId: 'createRoomBlock',
  method: 'post',
  path: '/room-blocks',
  summary: 'Put a room out of order or out of service for a date range',
  description:
    'Out of order removes the room from availability; out of service keeps it counted but not assignable (PRD M2 rule 2). A block starting today sets the housekeeping status at once.',
  tags: ['Rooms'],
  propertyScoped: true,
  permission: 'room.block',
  body: RoomBlockBody,
  status: 201,
  response: RoomBlockItem,
  errors: ['BOOKING_CONFLICT'],
});

export const releaseRoomBlock = defineRoute({
  operationId: 'releaseRoomBlock',
  method: 'post',
  path: '/room-blocks/{blockId}/release',
  summary: 'End a block early or cancel a future one',
  tags: ['Rooms'],
  propertyScoped: true,
  permission: 'room.block',
  params: z.object({ blockId: Uuid }),
  response: RoomBlockItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const ROOM_ROUTES = {
  listRoomTypes,
  createRoomType,
  updateRoomType,
  listRooms,
  createRoom,
  updateRoom,
  setHkStatus,
  createRoomBlock,
  releaseRoomBlock,
} as const;
