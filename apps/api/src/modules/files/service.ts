import { randomUUID } from 'node:crypto';
import {
  FILE_DOWNLOAD_URL_TTL_SECONDS,
  FILE_UPLOAD_URL_TTL_SECONDS,
  fileKind,
  fileReadPermission,
  type FileContentType,
  type FileEntityType,
} from '@hotel/shared';
import type { Logger } from 'pino';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { matchesContentType, type FileScanner } from '../../core/file-scan.ts';
import { fileStorageKey, incomingKey, type FileStore } from '../../core/files.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { TenantContext } from '../../core/tenancy.ts';

// Files (tab 2 "Files"; T-023): upload links, the scan, download links for clean files.

export interface FileDeps {
  tenantDb: TenantDb;
  store: FileStore;
  clock: Clock;
}

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

export async function createUploadUrl(
  deps: FileDeps,
  tenant: TenantContext,
  input: { entityType: FileEntityType; contentType: FileContentType; sizeBytes: number },
) {
  const kind = fileKind(input.entityType);
  if (!kind) throw invalid('entityType', 'Unknown file kind');
  if (!tenant.permissions.has(kind.permission)) {
    throw new AppError('FORBIDDEN', 'You do not have permission to upload this file.', {
      permission: kind.permission,
    });
  }
  if (!kind.contentTypes.includes(input.contentType)) {
    throw invalid('contentType', `Accepted types: ${kind.contentTypes.join(', ')}`);
  }
  if (input.sizeBytes > kind.maxBytes) {
    throw invalid('sizeBytes', `The file is larger than ${kind.maxBytes / 1024 / 1024} MB`);
  }

  const id = randomUUID();
  const storageKey = fileStorageKey(tenant.organisationId, tenant.propertyId, id);
  // The tenant client sets the organisation and property.
  await deps.tenantDb.fileObject.create({
    data: {
      id,
      storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      entityType: kind.entityType,
      retentionClass: kind.retentionClass,
      uploadedById: tenant.userId,
      createdAt: deps.clock(),
    } as never,
  });
  const link = await deps.store.presignUpload({
    key: incomingKey(storageKey),
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    expiresInSeconds: FILE_UPLOAD_URL_TTL_SECONDS,
  });
  return {
    fileId: id,
    method: 'PUT' as const,
    url: link.url,
    headers: link.headers,
    expiresAt: link.expiresAt.toISOString(),
  };
}

export async function getDownloadUrl(deps: FileDeps, tenant: TenantContext, fileId: string) {
  const file = await deps.tenantDb.fileObject.findUnique({ where: { id: fileId } });
  if (!file) throw new AppError('NOT_FOUND', 'File not found.');
  const kind = file.entityType ? fileKind(file.entityType) : undefined;
  const permission = kind ? fileReadPermission(kind) : null;
  if (!kind || (permission !== null && !tenant.permissions.has(permission))) {
    throw new AppError('FORBIDDEN', 'You do not have permission to open this file.', {
      ...(permission ? { permission } : {}),
    });
  }
  if (file.scan !== 'CLEAN') {
    throw new AppError(
      'FILE_NOT_READY',
      file.scan === 'PENDING'
        ? 'The file is still being checked. Try again in a minute.'
        : 'The file was blocked by the security check.',
      { scan: file.scan },
    );
  }
  const link = await deps.store.presignDownload({
    key: file.storageKey,
    contentType: file.contentType,
    expiresInSeconds: FILE_DOWNLOAD_URL_TTL_SECONDS,
  });
  return {
    url: link.url,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    expiresAt: link.expiresAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------
// Scan (worker). Runs outside any tenant, on the base client.

export interface ScanDeps {
  db: Db;
  store: FileStore;
  scanner: FileScanner;
  clock: Clock;
  logger: Logger;
}

/** A file whose upload link expired this long ago without an upload is given up on. */
export const ABANDON_AFTER_MS = (FILE_UPLOAD_URL_TTL_SECONDS + 5 * 60) * 1000;

export type BlockReason = 'SIZE_MISMATCH' | 'TYPE_MISMATCH' | 'MALWARE';

export interface ScanSummary {
  clean: number;
  blocked: number;
  abandoned: number;
  waiting: number;
}

/**
 * Scans uploaded files that are still PENDING, oldest first. Each file is claimed with a row
 * lock (SKIP LOCKED), so two workers never scan the same file.
 */
export async function scanPendingFiles(deps: ScanDeps, limit = 50): Promise<ScanSummary> {
  const summary: ScanSummary = { clean: 0, blocked: 0, abandoned: 0, waiting: 0 };
  const pending = await deps.db.fileObject.findMany({
    where: { scan: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
    take: limit,
  });
  for (const { id } of pending) {
    summary[await scanFile(deps, id)] += 1;
  }
  return summary;
}

type Verdict = { body: Buffer } | { reason: BlockReason; signature?: string };

async function inspect(
  store: FileStore,
  scanner: FileScanner,
  key: string,
  storedBytes: number,
  file: { sizeBytes: number; contentType: string },
): Promise<Verdict> {
  if (storedBytes !== file.sizeBytes) return { reason: 'SIZE_MISMATCH' };
  const body = await store.read(key);
  if (body.length !== file.sizeBytes) return { reason: 'SIZE_MISMATCH' };
  if (!matchesContentType(body, file.contentType)) return { reason: 'TYPE_MISMATCH' };
  const result = await scanner.scan(body);
  if (result.infected) {
    return { reason: 'MALWARE', ...(result.signature ? { signature: result.signature } : {}) };
  }
  return { body };
}

async function scanFile(deps: ScanDeps, id: string): Promise<keyof ScanSummary> {
  const { db, store, scanner, clock, logger } = deps;
  return db.$transaction(
    async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM files WHERE id = ${id}::uuid AND scan = 'PENDING' FOR UPDATE SKIP LOCKED`;
      if (claimed.length === 0) return 'waiting';
      const file = await tx.fileObject.findUniqueOrThrow({ where: { id } });
      const upload = incomingKey(file.storageKey);

      const object = await store.head(upload);
      if (!object) {
        if (clock().getTime() - file.createdAt.getTime() < ABANDON_AFTER_MS) return 'waiting';
        await tx.fileObject.delete({ where: { id } });
        logger.info({ fileId: id }, 'File never uploaded; removed');
        return 'abandoned';
      }

      const verdict = await inspect(store, scanner, upload, object.sizeBytes, file);
      if ('body' in verdict) {
        // Only the bytes that were scanned are ever served.
        await store.put(file.storageKey, verdict.body, file.contentType);
        await tx.fileObject.update({ where: { id }, data: { scan: 'CLEAN' } });
        await store.delete(upload);
        return 'clean';
      }

      const { reason, signature } = verdict;
      await tx.fileObject.update({ where: { id }, data: { scan: 'INFECTED' } });
      await recordAudit(tx, {
        organisationId: file.organisationId,
        propertyId: file.propertyId,
        actorType: 'SYSTEM',
        actorUserId: null,
        action: 'file.blocked',
        entityType: 'file',
        entityId: id,
        before: { scan: 'PENDING' },
        after: { scan: 'INFECTED', reason, ...(signature ? { signature } : {}) },
        reason,
      });
      await store.delete(upload);
      logger.warn({ fileId: id, reason, signature }, 'File blocked by the scan');
      return 'blocked';
    },
    { timeout: 60_000 },
  );
}
