import type { ParsedRouteInput, RouteContract } from '@hotel/shared';
import type { Request, Response, Router } from 'express';
import type { z } from 'zod';
import { getAuth, requireAuth, type AuthContext } from './auth.ts';
import { AppError } from './errors.ts';
import { withIdempotency } from './idempotency.ts';
import { tenantOf, type TenantContext } from './tenancy.ts';

export interface RouteContext {
  req: Request;
  res: Response;
  /** Always set on `auth: 'session'` routes (default); may be null on public ones. */
  auth: AuthContext | null;
  /** Always set on `propertyScoped` routes (middleware step 7). */
  tenant: TenantContext | null;
}

/** Returns the response body before schema parsing (the schema strips unknown fields). */
export type RouteHandler<R extends RouteContract> = (
  input: ParsedRouteInput<R>,
  ctx: RouteContext,
) => z.input<R['response']> | Promise<z.input<R['response']>>;

/** `/folios/{folioId}` → `/folios/:folioId` */
export function toExpressPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

type Issue = { path: string; code: string; message: string };

function parsePart(
  location: string,
  schema: z.ZodType | undefined,
  value: unknown,
  issues: Issue[],
): unknown {
  if (!schema) return location === 'body' ? undefined : {};
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    issues.push({
      path: [location, ...issue.path.map(String)].join('.'),
      code: issue.code,
      message: issue.message,
    });
  }
  return undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function checkHeaders(route: RouteContract, req: Request, issues: Issue[]): void {
  const require = (name: string, valid: (v: string) => boolean, message: string) => {
    const value = req.get(name);
    if (value === undefined || !valid(value)) {
      issues.push({ path: `headers.${name}`, code: 'invalid_header', message });
    }
  };
  if (route.propertyScoped) {
    require('X-Property-Id', (v) => UUID.test(v), 'X-Property-Id must be a property UUID.');
  }
  if (route.idempotent) {
    require('Idempotency-Key', (v) => UUID.test(v), 'Idempotency-Key must be a UUID.');
  }
  if (route.ifMatch) {
    require('If-Match', (v) => v.length > 0, 'If-Match must carry the ETag from the last read.');
  }
}

/**
 * Mounts a route contract on a router: validates headers, params, query and body (all
 * problems reported together as VALIDATION_ERROR with `details.issues[].path` such as
 * `query.limit`), runs the handler, and sends its result parsed through the response schema
 * so fields the contract doesn't list never leave the server.
 */
export function mountRoute<R extends RouteContract>(
  router: Router,
  route: R,
  handler: RouteHandler<R>,
): void {
  // Permissions are checked against the property's roles; organisation-level checks arrive
  // with the routes that need them (T-013).
  if (route.permission && !route.propertyScoped) {
    throw new Error(`${route.operationId}: a permission needs a propertyScoped route`);
  }
  // Keys belong to the signed-in user (T-020).
  if (route.idempotent && route.auth === 'none') {
    throw new Error(`${route.operationId}: idempotent routes need a signed-in user`);
  }
  router[route.method](toExpressPath(route.path), async (req: Request, res: Response) => {
    // Sign-in first, so anonymous callers learn nothing from validation messages.
    const auth =
      route.auth === 'none'
        ? getAuth(req)
        : requireAuth(req, { allowPendingMfa: route.allowPendingMfa ?? false });
    const issues: Issue[] = [];
    checkHeaders(route, req, issues);
    const params = parsePart('params', route.params, req.params, issues);
    const query = parsePart('query', route.query, req.query, issues);
    const body = parsePart('body', route.body, req.body, issues);
    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', 'Request validation failed.', { issues });
    }

    // Middleware step 7 has already answered 404 for a property the user can't see.
    const tenant = tenantOf(req);
    if (route.propertyScoped && !tenant) {
      throw new AppError('NOT_FOUND', 'Property not found.');
    }
    if (route.permission && !tenant?.permissions.has(route.permission)) {
      throw new AppError('FORBIDDEN', 'Your role does not allow this.', {
        permission: route.permission,
      });
    }

    const run = async (): Promise<{ status: number; body: unknown }> => {
      const result = await handler({ params, query, body } as ParsedRouteInput<R>, {
        req,
        res,
        auth,
        tenant,
      });
      const status = route.status ?? 200;
      if (status === 204) return { status, body: undefined };
      const parsed = route.response.safeParse(result);
      if (!parsed.success) {
        // A server bug, not a client error: surfaces as 500 INTERNAL and is logged.
        throw new Error(
          `Response for ${route.operationId} does not match its contract: ${parsed.error.message}`,
        );
      }
      return { status, body: parsed.data };
    };
    const { status, body: out } =
      route.idempotent && auth ? await withIdempotency(req, res, auth.user.id, run) : await run();
    if (status === 204) {
      res.status(204).end();
      return;
    }
    res.status(status).json(out);
  });
}
