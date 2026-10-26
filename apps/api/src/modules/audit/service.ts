import type { AuditEventsQuery } from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { TenantContext } from '../../core/tenancy.ts';

// Audit log (PRD M1-11, S27; T-014). Reads only: events are written by `recordAudit` in
// the transaction of each change. Keyset pages on the id, newest first.

export interface AuditDeps {
  tenantDb: TenantDb;
}

const encodeCursor = (id: bigint) => Buffer.from(id.toString()).toString('base64url');
function decodeCursor(cursor: string | undefined): bigint | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString();
  return /^\d{1,19}$/.test(raw) ? BigInt(raw) : null;
}

export async function listAuditEvents(
  deps: AuditDeps,
  tenant: TenantContext,
  query: z.output<typeof AuditEventsQuery>,
) {
  const before = decodeCursor(query.cursor);
  const and: Prisma.AuditEventWhereInput[] = [
    // This property's events and the organisation-level ones.
    { OR: [{ propertyId: tenant.propertyId }, { propertyId: null }] },
  ];
  if (before !== null) and.push({ id: { lt: before } });
  if (query.actorUserId) and.push({ actorUserId: query.actorUserId });
  if (query.entityType) and.push({ entityType: query.entityType });
  if (query.entityId) and.push({ entityId: query.entityId });
  if (query.action) {
    and.push({ OR: [{ action: query.action }, { action: { startsWith: `${query.action}.` } }] });
  }
  if (query.from) and.push({ occurredAt: { gte: new Date(query.from) } });
  if (query.to) and.push({ occurredAt: { lt: new Date(query.to) } });
  const rows = await deps.tenantDb.auditEvent.findMany({
    where: { AND: and },
    include: { actor: { select: { id: true, name: true } } },
    orderBy: { id: 'desc' },
    take: query.limit + 1,
  });
  const pageRows = rows.slice(0, query.limit);
  const last = pageRows.at(-1);
  return {
    data: pageRows.map((e) => ({
      id: e.id.toString(),
      occurredAt: e.occurredAt.toISOString(),
      actorType: e.actorType as 'USER' | 'SYSTEM' | 'SUPPORT',
      actor: e.actor,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      propertyId: e.propertyId,
      before: e.before,
      after: e.after,
      reason: e.reason,
      approvalRequestId: e.approvalRequestId,
      requestId: e.requestId,
      ip: e.ip,
      userAgent: e.userAgent,
    })),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
  };
}
