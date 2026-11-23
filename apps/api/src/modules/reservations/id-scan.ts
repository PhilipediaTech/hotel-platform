import { ID_SCAN_ROUTES, ID_TYPES, localDate, type IdScanResult } from '@hotel/shared';
import express, { type Router } from 'express';
import { z } from 'zod';
import { AiUnavailableError, type AiImage, type AiProvider } from '../../core/ai.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { FileStore } from '../../core/files.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { aiAllowanceUsedUp, countAiUse } from '../../core/usage.ts';

// ID scan at check-in (PRD M14-14; M14 rules: AI answers only from the hotel's own data and
// never changes data without a person's confirmation; T-150). The desk's uploaded ID photo
// goes to the AI provider with fixed instructions; its answer is checked field by field and
// only fills the form. Nothing here is saved but the audit of the scan (which fields were
// found, never their values) and the month's AI count. The photo itself is the IdDocument the
// check-in keeps and purges under M3 rule 6.

export interface IdScanDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
  ai: AiProvider;
  files: Pick<FileStore, 'read'>;
}

const SYSTEM = `You read identity documents (passports, national ID cards, driver's licences, voter's cards) photographed at a hotel front desk, so the desk does not have to type the guest's details.
Answer with one JSON object and nothing else, with these keys:
- "documentType": one of "PASSPORT", "NATIONAL_ID", "DRIVERS_LICENCE", "VOTERS_CARD", "OTHER"
- "documentNumber": the document's number exactly as printed
- "expiryDate": the expiry date as YYYY-MM-DD
- "nationality": the holder's nationality as a two-letter ISO 3166-1 code (for example NG)
- "firstName" and "lastName": the holder's given names and surname as printed
- "address": the holder's address, only if the document shows one
Use null for anything that is not clearly readable. Never guess or complete a value.
If the picture is not an identity document, answer {}.`;

const IMAGE_TYPES = new Set<AiImage['mediaType']>(['image/jpeg', 'image/png', 'image/webp']);

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .catch(null);

/** What the model answered, checked loosely: anything malformed becomes null. */
const Answer = z.object({
  documentType: z.enum(ID_TYPES).nullable().catch(null),
  documentNumber: text(40),
  expiryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)))
    .nullable()
    .catch(null),
  nationality: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .catch(null),
  firstName: text(80),
  lastName: text(80),
  address: text(300),
});

/** The first {...} in the answer, parsed; null when there is none. */
function json(answer: string): unknown {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(answer.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

const letters = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\p{L}\s]/gu, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/** Same surname, and the booked first name among the ID's given names (or the other way). */
export function sameName(
  id: { firstName: string; lastName: string },
  guest: { firstName: string; lastName: string },
): boolean {
  const idLast = letters(id.lastName).join(' ');
  const guestLast = letters(guest.lastName).join(' ');
  if (!idLast || idLast !== guestLast) return false;
  const idFirst = letters(id.firstName);
  const guestFirst = letters(guest.firstName);
  return guestFirst.some((n) => idFirst.includes(n)) || idFirst.some((n) => guestFirst.includes(n));
}

export async function scanIdDocument(
  deps: IdScanDeps,
  tenant: TenantContext,
  stayId: string,
  body: { fileId: string },
): Promise<z.input<typeof IdScanResult>> {
  const stay = await deps.tenantDb.stay.findFirst({
    where: { id: stayId },
    include: { guest: { select: { firstName: true, lastName: true } } },
  });
  if (!stay) throw new AppError('NOT_FOUND', 'Stay not found');
  const file = await deps.tenantDb.fileObject.findFirst({
    where: { id: body.fileId, entityType: 'IdDocument', scan: { not: 'INFECTED' } },
  });
  if (!file) {
    throw new AppError('VALIDATION_ERROR', 'Upload the ID photo first', {
      issues: [{ path: 'body.fileId', code: 'custom', message: 'Upload the ID photo first' }],
    });
  }
  if (!IMAGE_TYPES.has(file.contentType as AiImage['mediaType'])) {
    throw new AppError('VALIDATION_ERROR', 'Scan a photo of the ID (JPEG, PNG or WebP)', {
      issues: [{ path: 'body.fileId', code: 'custom', message: 'A photo, not a PDF' }],
    });
  }
  if (await aiAllowanceUsedUp(deps.db, tenant.organisationId, deps.clock())) {
    throw new AppError(
      'ALLOWANCE_USED_UP',
      'This month’s AI allowance is used up: type the ID details in. Scans work again next month.',
    );
  }
  let answer: string;
  try {
    const bytes = await deps.files.read(file.storageKey);
    const result = await deps.ai.generate({
      system: SYSTEM,
      user: 'Read this identity document.',
      images: [
        { mediaType: file.contentType as AiImage['mediaType'], data: bytes.toString('base64') },
      ],
      effort: 'low',
    });
    await countAiUse(deps.db, {
      organisationId: tenant.organisationId,
      metric: 'AI_ID_SCAN',
      at: deps.clock(),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    answer = result.text;
  } catch (err) {
    if (err instanceof AiUnavailableError) {
      throw new AppError(
        'AI_UNAVAILABLE',
        'The ID could not be read right now: type the details in.',
      );
    }
    throw err;
  }

  const parsed = Answer.safeParse(json(answer) ?? {});
  const a = parsed.success
    ? parsed.data
    : {
        documentType: null,
        documentNumber: null,
        expiryDate: null,
        nationality: null,
        firstName: null,
        lastName: null,
        address: null,
      };
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
    select: { timeZone: true },
  });
  const today = localDate(deps.clock(), property.timeZone);
  const nameOnId =
    a.firstName && a.lastName ? { firstName: a.firstName, lastName: a.lastName } : null;
  const idNumber = a.documentNumber && a.documentNumber.length >= 3 ? a.documentNumber : null;
  const out = {
    fields: {
      nationality: a.nationality,
      idType: a.documentType,
      idNumber,
      idExpiry: a.expiryDate,
      address: a.address,
    },
    nameOnId,
    nameMatchesGuest: nameOnId ? sameName(nameOnId, stay.guest) : null,
    expired: a.expiryDate ? a.expiryDate < today : null,
    readable: Object.values(a).some((v) => v !== null),
  };
  await recordAudit(deps.tenantDb, {
    action: 'stay.id_scanned',
    entityType: 'stay',
    entityId: stay.id,
    // Which fields were read, never what they say: ID data stays out of the audit log.
    after: {
      fileId: file.id,
      found: Object.entries(out.fields)
        .filter(([, v]) => v !== null)
        .map(([k]) => k),
      nameMatchesGuest: out.nameMatchesGuest,
      expired: out.expired,
    },
  });
  return out;
}

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

export function idScanRoutes(deps: IdScanDeps): Router {
  const router = express.Router();
  mountRoute(router, ID_SCAN_ROUTES.scanIdDocument, ({ params, body }, { tenant }) =>
    scanIdDocument(deps, tenantFrom(tenant), params.stayId, body),
  );
  return router;
}
