import {
  API_ROUTES,
  isErrorCode,
  type ApiRoutes,
  type ErrorCode,
  type RouteContract,
  type RouteInput,
  type RouteResponse,
} from '@hotel/shared';

/**
 * Typed client for the staff API, driven by the route contracts in @hotel/shared:
 * `api.call('getFolio', { params: { folioId } })` is checked against the contract and
 * resolves to the contract's response type.
 *
 * Responses are not re-parsed: the server already sends them through the response schema.
 */

/** A non-2xx answer from the API (or an unreadable one). `status` drives Query retries. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

export interface CallOptions {
  /** Reuse the same key when the user retries a write; generated if omitted. */
  idempotencyKey?: string;
  /** `ETag` from the last read, for versioned PATCHes. */
  ifMatch?: string;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** Default `/api/v1` (proxied to the API by Vite in development). */
  baseUrl?: string;
  /** Current property for `X-Property-Id`; property-scoped calls fail without one. */
  propertyId?: () => string | null;
  fetch?: typeof fetch;
}

type CallArgs<R extends RouteContract> =
  // Routes without required input can be called with no second argument.
  Record<string, never> extends RouteInput<R>
    ? [input?: RouteInput<R>, options?: CallOptions]
    : [input: RouteInput<R>, options?: CallOptions];

type RouteTable = Record<string, RouteContract>;

export interface ApiClient<Routes extends RouteTable = ApiRoutes> {
  call<K extends keyof Routes & string>(
    operationId: K,
    ...args: CallArgs<Routes[K]>
  ): Promise<RouteResponse<Routes[K]>>;
  /** A `produces` route (a PDF): the file, to open or save. */
  download<K extends keyof Routes & string>(
    operationId: K,
    ...args: CallArgs<Routes[K]>
  ): Promise<Blob>;
}

/** URL values must be scalars; an object here is a caller bug, not "[object Object]". */
function scalar(value: unknown, name: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new Error(`"${name}" must be a string, number or boolean in the URL`);
}

export function buildPath(path: string, params: Record<string, unknown> = {}): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing path parameter "${name}" for ${path}`);
    }
    return encodeURIComponent(scalar(value, name));
  });
}

export function buildQuery(query: Record<string, unknown> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? (value as unknown[]) : [value]) {
      search.append(key, scalar(item, key));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = (body as { error?: Record<string, unknown> } | undefined)?.error;
  if (error && isErrorCode(error['code'])) {
    return new ApiError(
      response.status,
      error['code'],
      typeof error['message'] === 'string' ? error['message'] : response.statusText,
      typeof error['requestId'] === 'string' ? error['requestId'] : undefined,
      error['details'] as Record<string, unknown> | undefined,
    );
  }
  // Not our envelope (a proxy or gateway page): keep the status so retries still work.
  return new ApiError(
    response.status,
    response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'INTERNAL' : 'NOT_FOUND',
    `Unexpected ${response.status} response from the server.`,
  );
}

/** `routes` defaults to the whole API; tests pass their own table. */
export function createApiClient<Routes extends RouteTable = ApiRoutes>(
  options: ApiClientOptions = {},
  routes: Routes = API_ROUTES as unknown as Routes,
): ApiClient<Routes> {
  const baseUrl = (options.baseUrl ?? '/api/v1').replace(/\/$/, '');
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function request(
    route: RouteContract,
    input: { params?: unknown; query?: unknown; body?: unknown } = {},
    callOptions: CallOptions = {},
  ): Promise<unknown> {
    const url =
      baseUrl +
      buildPath(route.path, input.params as Record<string, unknown> | undefined) +
      buildQuery(input.query as Record<string, unknown> | undefined);

    const headers = new Headers({ Accept: route.produces ?? 'application/json' });
    if (route.body) headers.set('Content-Type', 'application/json');
    if (route.propertyScoped) {
      const propertyId = options.propertyId?.();
      if (!propertyId) throw new Error(`${route.operationId} needs a current property.`);
      headers.set('X-Property-Id', propertyId);
    }
    if (route.idempotent) {
      headers.set('Idempotency-Key', callOptions.idempotencyKey ?? crypto.randomUUID());
    }
    if (route.ifMatch) {
      if (!callOptions.ifMatch) throw new Error(`${route.operationId} needs an ifMatch ETag.`);
      headers.set('If-Match', callOptions.ifMatch);
    }

    const init: RequestInit = {
      method: route.method.toUpperCase(),
      headers,
      credentials: 'include', // session cookie `sid`
    };
    if (route.body) init.body = JSON.stringify(input.body);
    if (callOptions.signal) init.signal = callOptions.signal;

    // Network failures reject with TypeError, which Query retries (no `status`).
    const response = await doFetch(url, init);
    if (!response.ok) throw await toApiError(response);
    if (response.status === 204) return undefined;
    if (route.produces) return response.blob();
    // 202 ApprovalPending is a success the caller checks for (tab 4, "Approvals").
    return response.json();
  }

  return {
    call(operationId, ...args) {
      const route = routes[operationId];
      if (!route) throw new Error(`Unknown operation ${operationId}`);
      const [input, callOptions] = args as [
        { params?: unknown; query?: unknown; body?: unknown } | undefined,
        CallOptions | undefined,
      ];
      return request(route, input, callOptions) as never;
    },
    download(operationId, ...args) {
      const route = routes[operationId];
      if (!route?.produces) throw new Error(`${operationId} does not produce a file`);
      const [input, callOptions] = args as [
        { params?: unknown; query?: unknown; body?: unknown } | undefined,
        CallOptions | undefined,
      ];
      return request(route, input, callOptions) as Promise<Blob>;
    },
  };
}

let currentPropertyId: string | null = null;

/** The property `X-Property-Id` carries on property-scoped calls; set by the session. */
export function setApiPropertyId(propertyId: string | null): void {
  currentPropertyId = propertyId;
}

/** The app's client: same-origin `/api/v1`, or `VITE_API_BASE_URL` when set. */
export const api: ApiClient = createApiClient({
  baseUrl: (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? '/api/v1',
  propertyId: () => currentPropertyId,
});
