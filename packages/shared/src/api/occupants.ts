import { z } from 'zod';
import { Phone } from './auth.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, Uuid } from './primitives.ts';

// Extra people on a stay (PRD M14-02, M14-03; T-056). The front desk adds an adult or child
// to a booked or checked-in stay within the room type's maximum occupancy. The nightly charge
// is the desk's to set: the rate plan suggests one for each person above the room type's base
// occupancy, and the desk may change it (zero is allowed) with a note saying why. Night audit
// posts each person's charge with the room night, under the room code and its taxes.

export const OCCUPANT_KINDS = ['ADULT', 'CHILD'] as const;
export type OccupantKind = (typeof OCCUPANT_KINDS)[number];

const Name = z.string().trim().min(1).max(80);
const NonNegative = AmountMinor.refine((v) => !v.startsWith('-'), 'Must not be negative');
const Note = z.string().trim().max(500);

export const OccupantItem = z
  .object({
    id: Uuid,
    stayId: Uuid,
    firstName: z.string(),
    lastName: z.string(),
    kind: z.enum(OCCUPANT_KINDS),
    phone: z.string().nullable(),
    nightlyChargeMinor: AmountMinor,
    chargeNote: z.string().nullable(),
    addedBy: z.string().nullable(),
    addedAt: Instant,
    removedAt: Instant.nullable(),
    /** Send as `If-Match: "<version>"` when changing the charge or removing the person. */
    version: z.number().int(),
  })
  .meta({ id: 'StayOccupant' });

export const StayOccupants = z
  .object({
    stayId: Uuid,
    status: z.string(),
    isDayUse: z.boolean(),
    adults: z.number().int(),
    children: z.number().int(),
    baseOccupancy: z.number().int(),
    maxOccupancy: z.number().int(),
    /** What the plan suggests per night for the next adult or child (0 within base occupancy). */
    suggested: z.object({ ADULT: AmountMinor, CHILD: AmountMinor }),
    /** The stay's version after the change (check-in and check-out send it as `If-Match`). */
    stayVersion: z.number().int(),
    /** Present and removed people, newest first. */
    data: z.array(OccupantItem),
  })
  .meta({ id: 'StayOccupants' });

const StayParams = z.object({ stayId: Uuid });
const OccupantParams = z.object({ stayId: Uuid, occupantId: Uuid });

export const OccupantBody = z.object({
  firstName: Name,
  lastName: Name,
  kind: z.enum(OCCUPANT_KINDS),
  phone: Phone.nullable().default(null),
  /** Left out: the plan's suggestion. */
  nightlyChargeMinor: NonNegative.optional(),
  /** Needed when the charge is not the suggestion. */
  chargeNote: Note.nullable().default(null),
});

export const OccupantChargeBody = z.object({
  nightlyChargeMinor: NonNegative,
  chargeNote: Note.nullable().default(null),
});

export const listOccupants = defineRoute({
  operationId: 'listOccupants',
  method: 'get',
  path: '/stays/{stayId}/occupants',
  summary: 'The people added to a stay, its occupancy limits and the suggested charges',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'frontdesk.read',
  params: StayParams,
  response: StayOccupants,
});

export const addOccupant = defineRoute({
  operationId: 'addOccupant',
  method: 'post',
  path: '/stays/{stayId}/occupants',
  summary: 'Add an adult or child to a booked or checked-in stay',
  description:
    '422 OCCUPANCY_EXCEEDED when the room type would hold more than its maximum. The nightly charge defaults to the plan’s suggestion; any other amount (zero included) needs `chargeNote`. Charges start with the next night night audit posts.',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'reservation.modify',
  idempotent: true,
  params: StayParams,
  body: OccupantBody,
  status: 201,
  response: StayOccupants,
  errors: ['OCCUPANCY_EXCEEDED', 'STATE_TRANSITION_INVALID'],
});

export const changeOccupantCharge = defineRoute({
  operationId: 'changeOccupantCharge',
  method: 'patch',
  path: '/stays/{stayId}/occupants/{occupantId}',
  summary: 'Change what an added person pays per night, from the next night posted',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'reservation.modify',
  ifMatch: true,
  params: OccupantParams,
  body: OccupantChargeBody,
  response: StayOccupants,
  errors: ['VERSION_CONFLICT', 'STATE_TRANSITION_INVALID'],
});

export const removeOccupant = defineRoute({
  operationId: 'removeOccupant',
  method: 'post',
  path: '/stays/{stayId}/occupants/{occupantId}/remove',
  summary: 'Take an added person off the stay (nights already posted stay posted)',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'reservation.modify',
  idempotent: true,
  ifMatch: true,
  params: OccupantParams,
  body: z.object({}),
  response: StayOccupants,
  errors: ['VERSION_CONFLICT', 'STATE_TRANSITION_INVALID'],
});

export const OCCUPANT_ROUTES = {
  listOccupants,
  addOccupant,
  changeOccupantCharge,
  removeOccupant,
} as const;
