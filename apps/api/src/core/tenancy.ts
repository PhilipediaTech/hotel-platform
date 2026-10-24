import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, RequestHandler } from 'express';
import { getAuth } from './auth.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';

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
  if (memberships.length === 0) return null;
  const roles = new Map(memberships.map((m) => [m.role.id, m.role]));
  return {
    userId,
    organisationId: property.organisationId,
    propertyId: property.id,
    roles: [...roles.values()].map((r) => ({ id: r.id, name: r.name, requiresMfa: r.requiresMfa })),
    permissions: new Set([...roles.values()].flatMap((r) => r.permissions)),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Middleware step 7: `X-Property-Id` → membership check → tenant context for the rest of the
 * request. Another tenant's property (or one that doesn't exist) answers 404, never 403, so
 * guessed IDs reveal nothing (PRD M1 acceptance). Requests without the header, or not signed
 * in, pass through: routes that need a property say so in their contract.
 */
export function tenancyContext({ db }: { db: Db }): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('X-Property-Id');
    const auth = getAuth(req);
    // Malformed headers are reported by the route's validation; anonymous and MFA-pending
    // requests are refused by the route before tenancy matters.
    if (!header || !UUID.test(header) || !auth?.session.mfaPassed) {
      next();
      return;
    }
    const tenant = await resolveTenant(db, auth.user.id, header);
    if (!tenant) throw new AppError('NOT_FOUND', 'Property not found.');
    markTenant(req, tenant);
    storage.run(tenant, next);
  };
}
