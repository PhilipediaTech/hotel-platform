import { z } from 'zod';

// Guest registration at check-in (PRD M3-08, M3 rules 2 and 6; T-051). A property chooses
// which fields it must collect; only those are stored (data minimisation, NDPA). ID details
// (type, number, expiry, scan) are encrypted at rest and purged after the retention period.

export const REGISTRATION_FIELDS = [
  'nationality',
  'address',
  'purpose',
  'idType',
  'idNumber',
  'idExpiry',
] as const;

export type RegistrationField = (typeof REGISTRATION_FIELDS)[number];

/** Fields that are ID data (M3 rule 6): kept encrypted in `id_documents` and purged. */
export const ID_FIELDS = ['idType', 'idNumber', 'idExpiry'] as const satisfies RegistrationField[];

export const ID_TYPES = [
  'PASSPORT',
  'NATIONAL_ID',
  'DRIVERS_LICENCE',
  'VOTERS_CARD',
  'OTHER',
] as const;

export const STAY_PURPOSES = ['BUSINESS', 'LEISURE', 'CONFERENCE', 'FAMILY', 'OTHER'] as const;

/** M3 rule 6: 12 months unless the property sets another period. */
export const DEFAULT_ID_RETENTION_MONTHS = 12;

export const RegistrationSettings = z
  .object({
    /** What the desk must collect at check-in; nothing else is stored. */
    requiredFields: z
      .array(z.enum(REGISTRATION_FIELDS))
      .refine((f) => new Set(f).size === f.length, 'Each field once'),
    /** ID details are deleted this many months after check-in. */
    idRetentionMonths: z.number().int().min(1).max(120),
  })
  .meta({ id: 'RegistrationSettings' });

/** Until a property chooses: the tab 4 check-in example's fields. */
export const DEFAULT_REGISTRATION: z.output<typeof RegistrationSettings> = {
  requiredFields: ['nationality', 'purpose', 'idType', 'idNumber'],
  idRetentionMonths: DEFAULT_ID_RETENTION_MONTHS,
};

/** Shows the last four characters of an ID number, e.g. "•••• 4567". */
export function maskIdNumber(value: string): string {
  return value.length <= 4 ? '••••' : `•••• ${value.slice(-4)}`;
}
