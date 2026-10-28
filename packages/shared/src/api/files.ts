import { z } from 'zod';
import { FILE_CONTENT_TYPES, FILE_ENTITY_TYPES } from '../files.ts';
import { defineRoute } from './contract.ts';
import { Instant, Uuid } from './primitives.ts';

// Files (tab 4 row "Files"; tab 2 "Files"; T-023). The browser uploads straight to storage
// with the returned link; the worker scans the file, and only clean files get download
// links. Permissions depend on the file kind (FILE_KINDS), so the service checks them.

export const createFileUploadUrl = defineRoute({
  operationId: 'createFileUploadUrl',
  method: 'post',
  path: '/files/upload-url',
  summary: 'Reserve a file and get a short-lived link to upload it to',
  description:
    'Send the file with `method` to `url`, with exactly the returned `headers`. The file can be downloaded once the scan marks it clean.',
  tags: ['Files'],
  propertyScoped: true,
  body: z.object({
    /** The kind of record the file belongs to; decides permission, types and size. */
    entityType: z.enum(FILE_ENTITY_TYPES),
    contentType: z.enum(FILE_CONTENT_TYPES),
    sizeBytes: z.number().int().min(1),
  }),
  status: 201,
  response: z.object({
    fileId: Uuid,
    method: z.literal('PUT'),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    expiresAt: Instant,
  }),
});

export const getFileDownloadUrl = defineRoute({
  operationId: 'getFileDownloadUrl',
  method: 'get',
  path: '/files/{fileId}/download-url',
  summary: 'A link to download a clean file, valid for 5 minutes',
  tags: ['Files'],
  propertyScoped: true,
  params: z.object({ fileId: Uuid }),
  response: z.object({
    url: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    expiresAt: Instant,
  }),
  errors: ['FILE_NOT_READY'],
});

export const FILE_ROUTES = { createFileUploadUrl, getFileDownloadUrl } as const;
