import {
  FILE_DOWNLOAD_URL_TTL_SECONDS,
  keptUntil,
  staffDocumentRetentionOf,
  type StaffDocumentBody,
  type StaffDocumentItem,
  type StaffDocumentRetention,
  type StaffDocumentType,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { FileStore } from '../../core/files.ts';
import { defineJob } from '../../core/jobs.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { propertyToday } from '../availability/inventory.ts';

// Staff documents (PRD M7-09 "contract, guarantor form, ID ... with restricted access and
// retention"; T-140). Tab 3 names staff_documents without columns: designed here.
// - staff.docs only. A document is uploaded as a StaffDocument file (which the generic file
//   link refuses), then filed on the record; opening it goes through its own route, audited.
// - Retention runs from the person's last day: each type is kept for its months (property
//   settings, staffDocuments.retention), then the daily worker deletes the row, the file row
//   and the stored object, with an audit entry. Rejoining (no last day) keeps everything.

export interface StaffDocumentDeps {
  tenantDb: TenantDb;
  store: FileStore;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const FILE_MAX_AGE_MS = 15 * 60_000;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
  });

const DOC_INCLUDE = {
  file: { select: { contentType: true, sizeBytes: true, scan: true, storageKey: true } },
  uploadedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.StaffDocumentInclude;
type DocRow = Prisma.StaffDocumentGetPayload<{ include: typeof DOC_INCLUDE }>;

function docItem(
  d: DocRow,
  endDate: Date | null,
  retention: StaffDocumentRetention,
): z.input<typeof StaffDocumentItem> {
  const type = d.type as StaffDocumentType;
  return {
    id: d.id,
    type,
    title: d.title,
    notes: d.notes,
    contentType: d.file.contentType,
    sizeBytes: d.file.sizeBytes,
    scan: d.file.scan,
    uploadedBy: d.uploadedBy,
    createdAt: iso(d.createdAt),
    keptUntil: endDate ? keptUntil(day(endDate), retention[type]) : null,
  };
}

async function retentionOf(db: Client, propertyId: string) {
  const property = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  const settings = (property.settings ?? {}) as Record<string, unknown>;
  const docs = (settings['staffDocuments'] ?? {}) as Record<string, unknown>;
  return { retention: staffDocumentRetentionOf(docs['retention']), settings };
}

async function staffOf(db: Client, staffId: string) {
  const s = await db.staffProfile.findFirst({ where: { id: staffId } });
  if (!s) throw new AppError('NOT_FOUND', 'Staff member not found.');
  return s;
}

async function docOf(db: Client, staffId: string, documentId: string) {
  const d = await db.staffDocument.findFirst({
    where: { id: documentId, staffId },
    include: DOC_INCLUDE,
  });
  if (!d) throw new AppError('NOT_FOUND', 'Document not found.');
  return d;
}

export async function listStaffDocuments(
  deps: StaffDocumentDeps,
  tenant: TenantContext,
  staffId: string,
) {
  const s = await staffOf(deps.tenantDb, staffId);
  const [{ retention }, rows] = await Promise.all([
    retentionOf(deps.tenantDb, tenant.propertyId),
    deps.tenantDb.staffDocument.findMany({
      where: { staffId },
      include: DOC_INCLUDE,
      orderBy: [{ type: 'asc' }, { createdAt: 'desc' }],
    }),
  ]);
  return { data: rows.map((d) => docItem(d, s.endDate, retention)), retention };
}

export async function addStaffDocument(
  deps: StaffDocumentDeps,
  tenant: TenantContext,
  staffId: string,
  body: z.output<typeof StaffDocumentBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const s = await staffOf(tx, staffId);
    const file = await tx.fileObject.findUnique({ where: { id: body.fileId } });
    const fresh =
      file !== null && deps.clock().getTime() - file.createdAt.getTime() <= FILE_MAX_AGE_MS;
    if (
      !file ||
      file.entityType !== 'StaffDocument' ||
      file.uploadedById !== tenant.userId ||
      file.entityId !== null ||
      !fresh
    ) {
      throw invalid('body.fileId', 'Upload the document again and file it straight away');
    }
    const d = await tx.staffDocument.create({
      data: {
        staffId: s.id,
        type: body.type,
        title: body.title,
        notes: body.notes,
        fileId: file.id,
        uploadedById: tenant.userId,
      } as unknown as Prisma.StaffDocumentUncheckedCreateInput, // tenant IDs come from the client
      include: DOC_INCLUDE,
    });
    await tx.fileObject.update({ where: { id: file.id }, data: { entityId: d.id } });
    await recordAudit(tx, {
      action: 'staff_document.added',
      entityType: 'staff_profile',
      entityId: s.id,
      after: { documentId: d.id, type: body.type, title: body.title },
    });
    const { retention } = await retentionOf(tx, tenant.propertyId);
    return docItem(d, s.endDate, retention);
  });
}

/** A short link to the document, after the scan passed; each look is on the audit log. */
export async function getStaffDocumentLink(
  deps: StaffDocumentDeps,
  staffId: string,
  documentId: string,
) {
  const d = await docOf(deps.tenantDb, staffId, documentId);
  if (d.file.scan !== 'CLEAN') {
    throw new AppError(
      'FILE_NOT_READY',
      d.file.scan === 'PENDING'
        ? 'The document is still being checked. Try again in a minute.'
        : 'The document was blocked by the security check.',
      { scan: d.file.scan },
    );
  }
  await recordAudit(deps.tenantDb, {
    action: 'staff_document.viewed',
    entityType: 'staff_profile',
    entityId: staffId,
    after: { documentId: d.id, type: d.type, title: d.title },
  });
  const link = await deps.store.presignDownload({
    key: d.file.storageKey,
    contentType: d.file.contentType,
    expiresInSeconds: FILE_DOWNLOAD_URL_TTL_SECONDS,
  });
  return { url: link.url, contentType: d.file.contentType, expiresAt: iso(link.expiresAt) };
}

export async function removeStaffDocument(
  deps: StaffDocumentDeps,
  staffId: string,
  documentId: string,
) {
  const key = await deps.tenantDb.$transaction(async (tx) => {
    const d = await docOf(tx, staffId, documentId);
    await tx.staffDocument.delete({ where: { id: d.id } });
    await tx.fileObject.delete({ where: { id: d.fileId } });
    await recordAudit(tx, {
      action: 'staff_document.removed',
      entityType: 'staff_profile',
      entityId: staffId,
      before: { documentId: d.id, type: d.type, title: d.title, createdAt: iso(d.createdAt) },
    });
    return d.file.storageKey;
  });
  // After the commit: a failure here leaves only an orphan object, never a broken record.
  await deps.store.delete(key);
  return { removed: true as const };
}

export async function getStaffDocumentSettings(deps: StaffDocumentDeps, tenant: TenantContext) {
  const { retention } = await retentionOf(deps.tenantDb, tenant.propertyId);
  return { retention };
}

export async function updateStaffDocumentSettings(
  deps: StaffDocumentDeps,
  tenant: TenantContext,
  retention: StaffDocumentRetention,
) {
  await deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM properties WHERE id = ${tenant.propertyId}::uuid FOR UPDATE`;
    const { retention: before, settings } = await retentionOf(tx, tenant.propertyId);
    const docs = (settings['staffDocuments'] ?? {}) as Record<string, unknown>;
    await tx.property.update({
      where: { id: tenant.propertyId },
      data: { settings: { ...settings, staffDocuments: { ...docs, retention } } as never },
    });
    await recordAudit(tx, {
      action: 'staff_document_settings.updated',
      entityType: 'property',
      entityId: tenant.propertyId,
      before: { retention: before },
      after: { retention },
    });
  });
  return { retention };
}

// ── Retention (daily) ──────────────────────────────────────────────────────────────────

/** Deletes documents kept past their retention; returns how many (exported for tests). */
export async function purgeStaffDocuments(db: Db, store: FileStore, clock: Clock): Promise<number> {
  const docs = await db.staffDocument.findMany({
    where: { staff: { status: 'LEFT', endDate: { not: null } } },
    include: {
      file: { select: { storageKey: true } },
      staff: { select: { endDate: true, propertyId: true } },
    },
  });
  const byProperty = new Map<
    string,
    { today: string; retention: StaffDocumentRetention; organisationId: string }
  >();
  let purged = 0;
  for (const d of docs) {
    const propertyId = d.staff.propertyId;
    let rules = byProperty.get(propertyId);
    if (!rules) {
      const property = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
      const settings = (property.settings ?? {}) as Record<string, unknown>;
      const own = (settings['staffDocuments'] ?? {}) as Record<string, unknown>;
      rules = {
        today: await propertyToday(db, propertyId, clock),
        retention: staffDocumentRetentionOf(own['retention']),
        organisationId: property.organisationId,
      };
      byProperty.set(propertyId, rules);
    }
    if (!d.staff.endDate) continue;
    const until = keptUntil(day(d.staff.endDate), rules.retention[d.type as StaffDocumentType]);
    if (until >= rules.today) continue;
    await db.$transaction(async (tx) => {
      await tx.staffDocument.delete({ where: { id: d.id } });
      await tx.fileObject.delete({ where: { id: d.fileId } });
      await recordAudit(tx, {
        organisationId: rules.organisationId,
        propertyId,
        actorUserId: null,
        action: 'staff_document.purged',
        entityType: 'staff_profile',
        entityId: d.staffId,
        before: { documentId: d.id, type: d.type, title: d.title, keptUntil: until },
      });
    });
    await store.delete(d.file.storageKey);
    purged += 1;
  }
  return purged;
}

export function staffDocumentPurgeJob(deps: { store: FileStore }) {
  return defineJob({
    name: 'staff-document-purge',
    // Daily at 02:45 UTC, after the ID document purge.
    schedule: { cron: '45 2 * * *' },
    async run(_data, { db, clock, logger }) {
      const purged = await purgeStaffDocuments(db, deps.store, clock);
      if (purged > 0) logger.info({ purged }, 'Staff documents past retention deleted');
    },
  });
}
