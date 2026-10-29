import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type ResponseConfig,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import {
  API_ROUTES,
  ApprovalPending,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  routeErrorCodes,
  type ErrorCode,
  type RouteContract,
} from '@hotel/shared';
import { z } from 'zod';

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

const SESSION_SCHEME = 'session';

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No content',
  400: 'Bad request',
  401: 'Not signed in',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  422: 'Business rule violated',
  429: 'Too many requests',
  500: 'Internal error',
};

const json = (schema: z.ZodType) => ({ 'application/json': { schema } });

function requestHeaders(route: RouteContract): z.ZodObject | undefined {
  const shape: Record<string, z.ZodType> = {};
  if (route.propertyScoped) {
    shape['X-Property-Id'] = z.uuid().meta({ description: 'Property the call acts on.' });
  }
  if (route.idempotent) {
    shape['Idempotency-Key'] = z.uuid().meta({
      description:
        'Reuse the same key when retrying; a different body with a used key is rejected.',
    });
  }
  if (route.ifMatch) {
    shape['If-Match'] = z.string().meta({ description: 'The `ETag` from the last read.' });
  }
  return Object.keys(shape).length > 0 ? z.object(shape) : undefined;
}

/** One response per HTTP status, listing the error codes that share it. */
function errorResponses(codes: ErrorCode[]): Record<number, ResponseConfig> {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_HTTP_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus.entries()]
      .sort(([a], [b]) => a - b)
      .map(([status, list]) => [
        status,
        {
          description: `${STATUS_TEXT[status] ?? 'Error'}: ${list.map((c) => `\`${c}\``).join(', ')}`,
          content: json(ErrorEnvelopeSchema),
        },
      ]),
  );
}

function toRouteConfig(route: RouteContract): RouteConfig {
  const status = route.status ?? 200;
  const responses: Record<number, ResponseConfig> = {
    [status]:
      status === 204
        ? { description: STATUS_TEXT[204] ?? '' }
        : route.produces
          ? {
              description: STATUS_TEXT[status] ?? '',
              content: { [route.produces]: { schema: { type: 'string', format: 'binary' } } },
            }
          : { description: STATUS_TEXT[status] ?? '', content: json(route.response) },
    ...errorResponses(routeErrorCodes(route)),
  };
  if (route.approval) {
    responses[202] = {
      description: 'Over the caller’s limit: an approval request was created instead.',
      content: json(ApprovalPending),
    };
  }

  const headers = requestHeaders(route);
  const config: RouteConfig = {
    method: route.method,
    path: route.path,
    operationId: route.operationId,
    summary: route.summary,
    tags: [...route.tags],
    security: route.auth === 'none' ? [] : [{ [SESSION_SCHEME]: [] }],
    request: {
      ...(route.params && { params: route.params }),
      ...(route.query && { query: route.query }),
      ...(headers && { headers }),
      ...(route.body && { body: { required: true, content: json(route.body) } }),
    },
    responses,
  };
  if (route.description) config.description = route.description;
  if (route.permission) config['x-permission'] = route.permission;
  if (route.idempotent) config['x-idempotent'] = true;
  return config;
}

/** Builds the OpenAPI 3.1 document from route contracts (default: every route in the API). */
export function buildOpenApiDocument(
  routes: readonly RouteContract[] = Object.values(API_ROUTES),
): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', SESSION_SCHEME, {
    type: 'apiKey',
    in: 'cookie',
    name: 'sid',
    description: 'Session cookie set by sign-in (httpOnly, Secure, SameSite=Lax).',
  });
  // Schemas carrying `.meta({ id })` (ErrorEnvelope, Money…) become components when used.

  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.operationId)) {
      throw new Error(`Duplicate operationId ${route.operationId}`);
    }
    seen.add(route.operationId);
    registry.registerPath(toRouteConfig(route));
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Hotel Platform API',
      version: '1',
      description:
        'Staff app API. Money is a string of minor units with a currency; dates are `YYYY-MM-DD`; instants are ISO 8601 UTC. Errors use the `ErrorEnvelope`.',
    },
    servers: [{ url: '/api/v1' }],
  });
}

let cached: OpenApiDocument | undefined;

/** The document for the routes in `API_ROUTES`, built once per process. */
export function openApiDocument(): OpenApiDocument {
  cached ??= buildOpenApiDocument();
  return cached;
}
