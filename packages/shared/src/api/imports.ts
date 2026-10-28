import { z } from 'zod';
import { IMPORT_KINDS } from '../imports.ts';
import { defineRoute } from './contract.ts';
import { Instant, Uuid } from './primitives.ts';

// Spreadsheet imports (tab 4 row "Imports"; PRD M1-03; S03; T-034): upload a file (T-023,
// kind ImportJob), check it (nothing is written), read the report, then apply it. Rooms with
// their room types, and rates, so far.

const IMPORT = 'import.run';

export const ImportErrorItem = z
  .object({
    /** Spreadsheet row (header = 1); null for the whole file. */
    row: z.number().int().nullable(),
    column: z.string().nullable(),
    message: z.string(),
  })
  .meta({ id: 'ImportError' });

export const ImportReport = z
  .object({
    /** Data rows read (blank rows skipped). */
    total: z.number().int(),
    errorCount: z.number().int(),
    /** The first 200 errors; errorCount is complete. */
    errors: z.array(ImportErrorItem),
    /** What applying does (or did), e.g. roomsNew, roomsUpdated, rateLines. */
    summary: z.record(z.string(), z.number().int()),
    /** The first 20 rows as read. */
    preview: z.array(
      z.record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
      ),
    ),
    /** After applying: days of rates that changed, rooms written. */
    applied: z.record(z.string(), z.number().int()).nullable(),
  })
  .meta({ id: 'ImportReport' });

export const ImportJobItem = z
  .object({
    id: Uuid,
    kind: z.enum(IMPORT_KINDS),
    /** VALIDATED: no errors, ready to apply. FAILED: fix the file and upload it again. */
    status: z.enum(['VALIDATED', 'FAILED', 'APPLIED']),
    fileId: Uuid,
    createdAt: Instant,
    createdBy: z.object({ id: Uuid, name: z.string() }),
    report: ImportReport,
  })
  .meta({ id: 'ImportJob' });

export const ImportBody = z.object({
  kind: z.enum(IMPORT_KINDS),
  /** An uploaded file of kind ImportJob (CSV or XLSX). */
  fileId: Uuid,
});

export const validateImport = defineRoute({
  operationId: 'validateImport',
  method: 'post',
  path: '/imports',
  summary: 'Check an uploaded spreadsheet; nothing is written until it is applied',
  description:
    'Answers 409 FILE_NOT_READY while the file is still being scanned. Every invalid row is listed; a file with errors cannot be applied.',
  tags: ['Imports'],
  propertyScoped: true,
  permission: IMPORT,
  body: ImportBody,
  status: 201,
  response: ImportJobItem,
  errors: ['FILE_NOT_READY'],
});

const ImportParams = z.object({ importId: Uuid });

export const getImport = defineRoute({
  operationId: 'getImport',
  method: 'get',
  path: '/imports/{importId}',
  summary: 'An import and its report',
  tags: ['Imports'],
  propertyScoped: true,
  permission: IMPORT,
  params: ImportParams,
  response: ImportJobItem,
});

export const applyImport = defineRoute({
  operationId: 'applyImport',
  method: 'post',
  path: '/imports/{importId}/apply',
  summary: 'Write a checked import (all rows or none)',
  description:
    'Answers 409 STATE_TRANSITION_INVALID when the import had errors, was already applied, or no longer fits what is in the property (details.errors).',
  tags: ['Imports'],
  propertyScoped: true,
  permission: IMPORT,
  params: ImportParams,
  response: ImportJobItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const IMPORT_ROUTES = { validateImport, getImport, applyImport } as const;
