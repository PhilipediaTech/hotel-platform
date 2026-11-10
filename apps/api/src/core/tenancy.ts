import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, RequestHandler } from 'express';
import { recordAudit } from './audit.ts';
import { getAuth } from './auth.ts';
import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { isPlatformAdmin } from './platform-admin.ts';
import { SUPPORT_PERMISSIONS, SUPPORT_ROLE_NAME } from './support.ts';

// Tenancy context (spec tab 2, request lifecycle step 7 and "Tenancy"): the property a
// request acts on, checked against the user's memberships, kept in AsyncLocalStorage so
// repositories and the tenant Prisma extension can scope every query without being handed
// client-supplied IDs.

export interface TenantRole {
  id: string;
  name: string;
  requiresMfa: boolean;
}

export interface TenantContext {
  userId: string;
  organisationId: string;
  propertyId: string;
  /** Roles that apply here: this property's plus the organisation-wide ones. */
  roles: readonly TenantRole[];
  permissions: ReadonlySet<string>;
  /** Modules the platform switched off for this group (T-100: MODULE_DISABLED). */
  disabledModules?: ReadonlySet<string>;
  /** The group is suspended for non-payment: reads only (M13-06; T-124). */
  suspended?: boolean;
  /** Set when a platform admin reads the group through a support session (T-100). */
  support?: { sessionId: string };
}

const storage = new AsyncLocalStorage<TenantContext>();
const byRequest = new WeakMap<Request, TenantContext>();

/** The tenant of the current async call chain, if any. */
export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}

/** Programming error, not a client error: a tenant query ran outside any tenant context. */
export class TenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenancyError';
  }
}

export function requireTenant(): TenantContext {
  const tenant = storage.getStore();
  if (!tenant)
    throw new TenancyError(
      'No tenant context: run inside a property-scoped request or runAsTenant()',
    );
  return tenant;
}

/**
 * Runs `fn` as `tenant` (jobs, scripts and tests; requests get it from middleware step 7).
 * The result is awaited inside the context: Prisma queries are lazy and only run when
 * awaited, so a query returned un-awaited would otherwise run outside it (and throw).
 */
export function runAsTenant<T>(tenant: TenantContext, fn: () => T | PromiseLike<T>): Promise<T> {
  return storage.run(tenant, async () => await fn());
}

/** The tenant resolved for this request, or null (no `X-Property-Id`, or not signed in). */
export function tenantOf(req: Request): TenantContext | null {
  return byRequest.get(req) ?? null;
}

/** Records the tenant on a request. Used by the middleware, and by tests of routes. */
export function markTenant(req: Request, tenant: TenantContext): void {
  byRequest.set(req, tenant);
}

/**
 * What `userId` may do in `propertyId`, or null when they may not see it at all: unknown or
 * archived property, or no active membership (property-level, or organisation-wide in the
 * property's organisation).
 */
export async function resolveTenant(
  db: Db,
  userId: string,
  propertyId: string,
  /** Platform staff: an open support session also gives access (T-100). */
  support?: { now: Date },
): Promise<TenantContext | null> {
  const property = await db.property.findUnique({
    where: { id: propertyId },
    select: { id: true, organisationId: true, status: true },
  });
  if (!property || property.status === 'ARCHIVED') return null;
  const memberships = await db.membership.findMany({
    where: {
      userId,
      active: true,
      organisationId: property.organisationId,
      OR: [{ propertyId: property.id }, { propertyId: null }],
    },
    include: { role: true },
  });
  const disabledModules = new Set(
    (
      await db.featureFlag.findMany({
        where: { organisationId: property.organisationId, enabled: false },
        select: { module: true },
      })
    ).map((f) => f.module),
  );
  const suspended =
    (
      await db.subscription.findUnique({
        where: { organisationId: property.organisationId },
        select: { status: true },
      })
    )?.status === 'SUSPENDED';
  if (memberships.length === 0) {
    // M13-02: platform staff reach a group only through an open support session.
    if (!support) return null;
    const session = await db.supportSession.findFirst({
      where: {
        organisationId: property.organisationId,
        adminUserId: userId,
        endedAt: null,
        expiresAt: { gt: support.now },
      },
      select: { id: true },
    });
    if (!session) return null;
    return {
      userId,
      organisationId: property.organisationId,
      propertyId: property.id,
      roles: [{ id: session.id, name: SUPPORT_ROLE_NAME, requiresMfa: true }],
      permissions: new Set(SUPPORT_PERMISSIONS),
      disabledModules,
      suspended,
      support: { sessionId: session.id },
    };
  }
  const roles = new Map(memberships.map((m) => [m.role.id, m.role]));
  return {
    userId,
    organisationId: property.organisationId,
    propertyId: property.id,
    roles: [...roles.values()].map((r) => ({ id: r.id, name: r.name, requiresMfa: r.requiresMfa })),
    permissions: new Set([...roles.values()].flatMap((r) => r.permissions)),
    disabledModules,
    suspended,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Middleware step 7: `X-Property-Id` → membership check → tenant context for the rest of the
 * request. Another tenant's property (or one that doesn't exist) answers 404, never 403, so
 * guessed IDs reveal nothing (PRD M1 acceptance). Requests without the header, or not signed
 * in, pass through: routes that need a property say so in their contract.
 */
export function tenancyContext({
  db,
  clock,
  config,
}: {
  db: Db;
  clock: Clock;
  config: Pick<Config, 'platformAdminEmails'>;
}): RequestHandler {
  return async (req, res, next) => {
    const header = req.get('X-Property-Id');
    const auth = getAuth(req);
    // Malformed headers are reported by the route's validation; anonymous and MFA-pending
    // requests are refused by the route before tenancy matters.
    if (!header || !UUID.test(header) || !auth?.session.mfaPassed) {
      next();
      return;
    }
    const tenant = await resolveTenant(
      db,
      auth.user.id,
      header,
      isPlatformAdmin(config, auth.user) ? { now: clock() } : undefined,
    );
    if (!tenant) throw new AppError('NOT_FOUND', 'Property not found.');
    if (tenant.support) {
      // M13-02: a support session only reads, and every record opened is audited.
      if (req.method !== 'GET') {
        throw new AppError('FORBIDDEN', 'A support session is read-only.', { support: true });
      }
      res.on('finish', () => {
        if (res.statusCode >= 300) return;
        void recordAudit(db, {
          organisationId: tenant.organisationId,
          propertyId: tenant.propertyId,
          actorUserId: tenant.userId,
          actorType: 'SUPPORT',
          action: 'support.viewed',
          entityType: 'request',
          entityId: req.path.slice(0, 200),
          after: { sessionId: tenant.support?.sessionId, query: req.query },
        }).catch(() => undefined);
      });
    }
    markTenant(req, tenant);
    storage.run(tenant, next);
  };
}
