import { z } from 'zod';
import { ID_TYPES } from '../registration.ts';
import { defineRoute } from './contract.ts';
import { IsoDate, Uuid } from './primitives.ts';

// ID scan at check-in (PRD M14-14 "As front desk, I photograph a guest's ID and the
// registration card fields fill in for me to check", reservation.checkin; T-150). The photo
// is the ID document already uploaded for the check-in (file kind IdDocument). The AI reads
// it and answers the fields it can see; nothing is saved by the scan: the desk checks and
// corrects the fields, then checks the guest in as usual. Each scan counts against the plan's
// monthly AI allowance (Strategy: Professional and Group).

export const IdScanResult = z
  .object({
    /** What fills the registration card: null where the ID does not show it clearly. */
    fields: z.object({
      nationality: z.string().nullable(),
      idType: z.enum(ID_TYPES).nullable(),
      idNumber: z.string().nullable(),
      idExpiry: IsoDate.nullable(),
      address: z.string().nullable(),
    }),
    /** For the desk to compare with the booking: not saved. */
    nameOnId: z.object({ firstName: z.string(), lastName: z.string() }).nullable(),
    /** The name on the ID matches the stay's guest (null when no name could be read). */
    nameMatchesGuest: z.boolean().nullable(),
    /** The ID's expiry date is before today (null when no expiry could be read). */
    expired: z.boolean().nullable(),
    /** False when nothing at all could be read: ask for a clearer photo. */
    readable: z.boolean(),
  })
  .meta({ id: 'IdScanResult' });

export const scanIdDocument = defineRoute({
  operationId: 'scanIdDocument',
  method: 'post',
  path: '/stays/{stayId}/id-scan',
  summary: 'Read the guest’s ID photo and suggest the registration fields (M14-14)',
  description:
    'Not in tab 4: designed in T-150. `fileId` is the uploaded ID photo (IdDocument, JPEG, PNG or WebP). Nothing is saved: the answer only fills the check-in form for the desk to check. Counts against the monthly AI allowance (403 ALLOWANCE_USED_UP); 503 AI_UNAVAILABLE when the AI cannot answer.',
  tags: ['Reservations'],
  propertyScoped: true,
  permission: 'reservation.checkin',
  params: z.object({ stayId: Uuid }),
  body: z.object({ fileId: Uuid }),
  response: IdScanResult,
  errors: ['ALLOWANCE_USED_UP', 'AI_UNAVAILABLE'],
});

export const ID_SCAN_ROUTES = { scanIdDocument } as const;
