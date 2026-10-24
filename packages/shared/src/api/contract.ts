import type { z } from 'zod';
import type { ErrorCode } from '../errors.ts';

// An API route defined once as data. The API mounts it (validation in, schema-shaped
// output), the OpenAPI document is generated from it, and the web client is typed by it.

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Request part schemas are objects so each field maps to one named parameter. */
type ObjectSchema = z.ZodObject;

export interface RouteContract<
  Params extends ObjectSchema | undefined = ObjectSchema | undefined,
  Query extends ObjectSchema | undefined = ObjectSchema | undefined,
  Body extends z.ZodType | undefined = z.ZodType | undefined,
  Response extends z.ZodType = z.ZodType,
> {
  /** Stable camelCase name; the client calls routes by it. */
  operationId: string;
  method: HttpMethod;
  /** Relative to `/api/v1`, OpenAPI style: `/folios/{folioId}/charges`. */
  path: string;
  summary: string;
  description?: string;
  tags: readonly string[];
  /** `session` = needs the `sid` cookie (default); `none` = public. */
  auth?: 'session' | 'none';
  /** Reachable before MFA is passed (only the routes that get a user through MFA). */
  allowPendingMfa?: boolean;
  /** Sends `X-Property-Id`; the server checks membership (tab 4, "Property scope"). */
  propertyScoped?: boolean;
  /** Permission code the caller must hold (PRD codes are canonical, spec issue 22). */
  permission?: string;
  /** ● in tab 4: requires `Idempotency-Key`. */
  idempotent?: boolean;
  /** PATCH of a versioned resource: requires `If-Match` (tab 4, "Concurrency"). */
  ifMatch?: boolean;
  /** May answer 202 `ApprovalPending` instead of performing the action. */
  approval?: boolean;
  params?: Params;
  query?: Query;
  body?: Body;
  /** Success status; 204 means no body (use `z.void()` as `response`). */
  status?: 200 | 201 | 202 | 204;
  response: Response;
  /** Domain errors this route can return, beyond the ones implied by the flags above. */
  errors?: readonly ErrorCode[];
}

/** Identity function that keeps the literal types of a route definition. */
export function defineRoute<
  Params extends ObjectSchema | undefined = undefined,
  Query extends ObjectSchema | undefined = undefined,
  Body extends z.ZodType | undefined = undefined,
  Response extends z.ZodType = z.ZodType,
>(
  route: RouteContract<Params, Query, Body, Response>,
): RouteContract<Params, Query, Body, Response> {
  return route;
}

// Optional properties read as `Schema | undefined`, so strip `undefined` before testing
// whether a route defines a part; `[X] extends [never]` avoids distributing over unions.
type Part<S> = Exclude<S, undefined>;
type Defines<S> = [Part<S>] extends [never] ? false : true;
type SchemaInput<S> = Part<S> extends z.ZodType ? z.input<Part<S>> : never;
type SchemaOutput<S> = Part<S> extends z.ZodType ? z.output<Part<S>> : never;

/** What a caller passes: only the parts the route defines. */
export type RouteInput<R extends RouteContract> = (Defines<R['params']> extends true
  ? { params: SchemaInput<R['params']> }
  : { params?: never }) &
  (Defines<R['query']> extends true ? { query?: SchemaInput<R['query']> } : { query?: never }) &
  (Defines<R['body']> extends true
    ? // A body schema with a default may be left out.
      undefined extends SchemaInput<R['body']>
      ? { body?: SchemaInput<R['body']> }
      : { body: SchemaInput<R['body']> }
    : { body?: never });

/** What a handler receives after validation (defaults applied, coercions done). */
export interface ParsedRouteInput<R extends RouteContract> {
  params: Defines<R['params']> extends true ? SchemaOutput<R['params']> : Record<string, never>;
  query: Defines<R['query']> extends true ? SchemaOutput<R['query']> : Record<string, never>;
  body: Defines<R['body']> extends true ? SchemaOutput<R['body']> : undefined;
}

/** What goes over the wire on success (see the no-transforms rule in primitives.ts). */
export type RouteResponse<R extends RouteContract> = z.output<R['response']>;

/**
 * Every error code a route can return: the ones its flags imply (validation, auth,
 * permission, tenancy, idempotency, concurrency, approvals) plus its own.
 */
export function routeErrorCodes(route: RouteContract): ErrorCode[] {
  const codes = new Set<ErrorCode>();
  if (route.params || route.query || route.body || route.idempotent || route.ifMatch) {
    codes.add('VALIDATION_ERROR');
  }
  if (route.auth !== 'none') {
    codes.add('UNAUTHENTICATED').add('SESSION_EXPIRED').add('MFA_REQUIRED');
  }
  if (route.permission || route.propertyScoped) codes.add('FORBIDDEN');
  if (route.propertyScoped) codes.add('MODULE_DISABLED');
  if (route.params) codes.add('NOT_FOUND');
  if (route.idempotent) codes.add('IDEMPOTENCY_KEY_REUSED');
  if (route.ifMatch) codes.add('VERSION_CONFLICT');
  if (route.approval) codes.add('APPROVAL_EXPIRED');
  for (const code of route.errors ?? []) codes.add(code);
  codes.add('RATE_LIMITED').add('INTERNAL');
  return [...codes];
}
