import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';

// Staff documents (PRD M7-09 "As HR, I store staff documents (contract, guarantor form, ID)
// with restricted access and retention", staff.docs; tab 3 staff_documents; S36; T-140).
// - Only holders of staff.docs list, add, open or remove them. A document opens only through
//   its own route (never the generic file link), and every look is audited.
// - Retention starts when the person leaves: each type is kept that many months after their
//   last day, then a daily worker deletes the document and its file. Someone brought back
//   keeps everything.

export const STAFF_DOCUMENT_TYPES = [
  'CONTRACT',
  'GUARANTOR',
  'ID',
  'CERTIFICATE',
  'OTHER',
] as const;
export type StaffDocumentType = (typeof STAFF_DOCUMENT_TYPES)[number];

const Months = z.number().int().min(1).max(240);

export const StaffDocumentRetention = z
  .object({
    CONTRACT: Months,
    GUARANTOR: Months,
    ID: Months,
    CERTIFICATE: Months,
    OTHER: Months,
  })
  .meta({ id: 'StaffDocumentRetention' });
export type StaffDocumentRetention = z.output<typeof StaffDocumentRetention>;

/** Months kept after the last day, by type, unless the property sets its own. */
export const DEFAULT_STAFF_DOCUMENT_RETENTION: StaffDocumentRetention = {
  CONTRACT: 72,
  GUARANTOR: 72,
  ID: 12,
  CERTIFICATE: 24,
  OTHER: 24,
};

export function staffDocumentRetentionOf(stored: unknown): StaffDocumentRetention {
  const parsed = StaffDocumentRetention.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_STAFF_DOCUMENT_RETENTION;
}

/** The last date a document is kept, for someone who left on `endDate`. */
export function keptUntil(endDate: string, months: number): string {
  const [y, m, d] = endDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
  target.setUTCDate(Math.min(d, last.getUTCDate()));
  return target.toISOString().slice(0, 10);
}

export const StaffDocumentItem = z
  .object({
    id: Uuid,
    type: z.enum(STAFF_DOCUMENT_TYPES),
    title: z.string(),
    notes: z.string().nullable(),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    /** The scan must pass before it opens. */
    scan: z.enum(['PENDING', 'CLEAN', 'INFECTED']),
    uploadedBy: z.object({ id: Uuid, name: z.string() }),
    createdAt: Instant,
    /** Set once they have left: the document is deleted after this date. */
    keptUntil: IsoDate.nullable(),
  })
  .meta({ id: 'StaffDocument' });

export const StaffDocumentBody = z
  .object({
    type: z.enum(STAFF_DOCUMENT_TYPES),
    title: z.string().trim().min(1).max(120),
    /** Uploaded first as a StaffDocument file by the same person. */
    fileId: Uuid,
    notes: z
      .string()
      .trim()
      .max(500)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .default(null),
  })
  .meta({ id: 'StaffDocumentBody' });

const ADDED = 'Tab 3 names staff_documents; the routes are designed in T-140.';
const DOCS = { tags: ['Staff'], propertyScoped: true as const, permission: 'staff.docs' };
const StaffParams = z.object({ staffId: Uuid });
const DocParams = z.object({ staffId: Uuid, documentId: Uuid });

export const listStaffDocuments = defineRoute({
  ...DOCS,
  operationId: 'listStaffDocuments',
  method: 'get',
  path: '/staff/{staffId}/documents',
  summary: "A staff member's documents (M7-09)",
  description: ADDED,
  params: StaffParams,
  response: z.object({ data: z.array(StaffDocumentItem), retention: StaffDocumentRetention }),
});

export const addStaffDocument = defineRoute({
  ...DOCS,
  operationId: 'addStaffDocument',
  method: 'post',
  path: '/staff/{staffId}/documents',
  summary: 'File an uploaded document on a staff record (M7-09)',
  description: ADDED,
  idempotent: true,
  status: 201,
  params: StaffParams,
  body: StaffDocumentBody,
  response: StaffDocumentItem,
});

export const getStaffDocumentLink = defineRoute({
  ...DOCS,
  operationId: 'getStaffDocumentLink',
  method: 'get',
  path: '/staff/{staffId}/documents/{documentId}/download-url',
  summary: 'A 5-minute link to open the document; each look is audited (M7-09)',
  description: ADDED,
  params: DocParams,
  response: z.object({ url: z.string(), contentType: z.string(), expiresAt: Instant }),
  errors: ['FILE_NOT_READY'],
});

export const removeStaffDocument = defineRoute({
  ...DOCS,
  operationId: 'removeStaffDocument',
  method: 'delete',
  path: '/staff/{staffId}/documents/{documentId}',
  summary: 'Delete a document and its file (M7-09)',
  description: `${ADDED} Audited with what was deleted.`,
  params: DocParams,
  response: z.object({ removed: z.literal(true) }),
});

export const getStaffDocumentSettings = defineRoute({
  ...DOCS,
  operationId: 'getStaffDocumentSettings',
  method: 'get',
  path: '/staff-documents/settings',
  summary: 'How long each type of document is kept after someone leaves (M7-09)',
  description: ADDED,
  response: z.object({ retention: StaffDocumentRetention }),
});

export const updateStaffDocumentSettings = defineRoute({
  ...DOCS,
  operationId: 'updateStaffDocumentSettings',
  method: 'put',
  path: '/staff-documents/settings',
  summary: 'Change how long each type of document is kept after someone leaves (M7-09)',
  description: ADDED,
  body: z.object({ retention: StaffDocumentRetention }),
  response: z.object({ retention: StaffDocumentRetention }),
});

export const STAFF_DOCUMENT_ROUTES = {
  listStaffDocuments,
  addStaffDocument,
  getStaffDocumentLink,
  removeStaffDocument,
  getStaffDocumentSettings,
  updateStaffDocumentSettings,
} as const;
