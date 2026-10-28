import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import type { Prisma } from '../generated/prisma/client.ts';
import { getAuth } from './auth.ts';
import { getRequestId } from './request-id.ts';
import { currentTenant } from './tenancy.ts';

// Audit writer (spec tab 2 "Audit, outbox and jobs": an `audit_events` row written in the
// same transaction as the change — actor, action, entity, before, after, reason, approval,
// IP, device). Callers pass the transaction they are already writing with, so the event
// commits or rolls back with the change. The table is append-only (database trigger).

export type ActorType = 'USER' | 'SYSTEM' | 'SUPPORT';

interface RequestFacts {
  requestId: string;
  ip: string | undefined;
  userAgent: string | undefined;
  /** The signed-in user when the request arrived (sign-in itself passes its actor). */
  userId: string | undefined;
}

const requestFacts = new AsyncLocalStorage<RequestFacts>();

/** Middleware after step 5 (session load): the request's facts for audit events. */
export function auditContext(): RequestHandler {
  return (req, _res, next) => {
    requestFacts.run(
      {
        requestId: getRequestId(req),
        ip: req.ip,
        userAgent: req.get('user-agent')?.slice(0, 300),
        userId: getAuth(req)?.user.id,
      },
      next,
    );
  };
}

export interface AuditInput {
  /** resource.verb, e.g. `role.updated`. */
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | undefined;
  approvalRequestId?: string | undefined;
  /** Defaults to the tenant's organisation. */
  organisationId?: string;
  /** Defaults to the tenant's property; `null` records an organisation-level event. */
  propertyId?: string | null;
  /**
   * Defaults to the tenant context's user (the requester when an approved action runs), else
   * the request's signed-in user, else SYSTEM.
   */
  actorUserId?: string | null;
  actorType?: ActorType;
}

/** Anything with an `auditEvent.create`: the plain client, a transaction, the tenant client. */
export interface AuditClient {
  auditEvent: {
    create(args: { data: Prisma.AuditEventUncheckedCreateInput }): PromiseLike<unknown>;
  };
}

/** Keys never stored in before/after, at any depth (`hasPin` is fine, `pin`/`pinHash` not). */
const SECRET_KEY = /password|secret|token|otp|hash$|enc$|^pin$|^code$/i;

/** JSON-safe copy without secrets: dates as ISO, bigints as strings, bytes dropped. */
export function auditValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) {
    return value.map((v) => auditValue(v) ?? null);
  }
  if (typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, v] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      const clean = auditValue(v);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return value;
}

/** Writes one audit event through `client` (use the transaction of the change). */
export async function recordAudit(client: AuditClient, input: AuditInput): Promise<void> {
  const facts = requestFacts.getStore();
  const tenant = currentTenant();
  const organisationId = input.organisationId ?? tenant?.organisationId;
  if (!organisationId)
    throw new Error(`Audit ${input.action}: no organisation (pass organisationId)`);
  const actorUserId =
    input.actorUserId === undefined ? (tenant?.userId ?? facts?.userId ?? null) : input.actorUserId;
  const before = auditValue(input.before);
  const after = auditValue(input.after);
  await client.auditEvent.create({
    data: {
      organisationId,
      propertyId: input.propertyId === undefined ? (tenant?.propertyId ?? null) : input.propertyId,
      actorUserId,
      actorType: input.actorType ?? (actorUserId ? 'USER' : 'SYSTEM'),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      reason: input.reason ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
      requestId: facts?.requestId ?? null,
      ip: facts?.ip ?? null,
      userAgent: facts?.userAgent ?? null,
    },
  });
}

/** Organisations a user belongs to (active memberships). */
async function organisationsOf(
  client: { membership: { findMany(args: object): PromiseLike<{ organisationId: string }[]> } },
  userId: string,
): Promise<string[]> {
  const rows = await client.membership.findMany({
    where: { userId, active: true },
    select: { organisationId: true },
  });
  return [...new Set(rows.map((r) => r.organisationId))];
}

/**
 * A security event about a user (sign-in, lockout, password or MFA change): recorded once
 * in every organisation the user belongs to, so each owner sees it. Organisation-level.
 */
export async function recordUserEvent(
  client: AuditClient & {
    membership: { findMany(args: object): PromiseLike<{ organisationId: string }[]> };
  },
  userId: string,
  input: Omit<AuditInput, 'organisationId' | 'propertyId' | 'entityType' | 'entityId'> & {
    entityType?: string;
    entityId?: string;
  },
): Promise<void> {
  for (const organisationId of await organisationsOf(client, userId)) {
    await recordAudit(client, {
      entityType: 'user',
      entityId: userId,
      actorUserId: userId,
      ...input,
      organisationId,
      propertyId: null,
    });
  }
}
