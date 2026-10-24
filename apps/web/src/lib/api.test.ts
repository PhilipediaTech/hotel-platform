import { EXAMPLE_ROUTES } from '@hotel/shared/testing';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { shouldRetry } from '../app/query-client.ts';
import { ApiError, buildPath, buildQuery, createApiClient } from './api.ts';

const FOLIO_ID = '3f2b8a4e-7d9a-4b1c-8d3e-4f5a6b7c8d9e';
const PROPERTY_ID = '0d0d0d0d-0000-4000-8000-000000000002';
const NGN = (amountMinor: string) => ({ amountMinor, currency: 'NGN' });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(
  response: Response = jsonResponse(200, {}),
  propertyId: string | null = PROPERTY_ID,
) {
  const fetch = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(response));
  const client = createApiClient(
    { baseUrl: 'https://api.example.test/api/v1/', propertyId: () => propertyId, fetch },
    EXAMPLE_ROUTES,
  );
  const sent = () => {
    const [url, init] = fetch.mock.calls[0] ?? [];
    return { url, init, headers: new Headers(init?.headers) };
  };
  return { client, fetch, sent };
}

describe('buildPath / buildQuery', () => {
  it('fills and encodes path parameters', () => {
    expect(buildPath('/rooms/{roomId}', { roomId: 'a b/c' })).toBe('/rooms/a%20b%2Fc');
    expect(() => buildPath('/rooms/{roomId}', {})).toThrow('Missing path parameter "roomId"');
  });

  it('skips empty values and repeats arrays', () => {
    expect(buildQuery({ limit: 20, cursor: undefined, status: ['A', 'B'] })).toBe(
      '?limit=20&status=A&status=B',
    );
    expect(buildQuery({})).toBe('');
    expect(() => buildQuery({ filter: { a: 1 } })).toThrow('"filter" must be a string');
  });
});

describe('createApiClient: requests', () => {
  it('builds a GET with path, property header and session cookie', async () => {
    const folio = { id: FOLIO_ID, number: 'F-1001', balance: NGN('4500000') };
    const { client, sent } = setup(jsonResponse(200, folio));
    const result = await client.call('getFolio', { params: { folioId: FOLIO_ID } });
    expect(result).toEqual(folio);
    expectTypeOf(result.balance.amountMinor).toBeString();
    const { url, init, headers } = sent();
    expect(url).toBe(`https://api.example.test/api/v1/folios/${FOLIO_ID}`);
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('include');
    expect(init?.body).toBeUndefined();
    expect(headers.get('X-Property-Id')).toBe(PROPERTY_ID);
    expect(headers.get('Idempotency-Key')).toBeNull();
  });

  it('sends query parameters', async () => {
    const { client, sent } = setup(jsonResponse(200, { data: [], nextCursor: null }));
    await client.call('listReservations', { query: { limit: 20, status: 'CONFIRMED' } });
    expect(sent().url).toBe(
      'https://api.example.test/api/v1/reservations?limit=20&status=CONFIRMED',
    );
  });

  it('sends a JSON body with a generated idempotency key, or the caller’s key', async () => {
    const body = { amount: NGN('250000'), description: 'Laundry' };
    const first = setup(jsonResponse(201, { id: FOLIO_ID, amount: body.amount }));
    await first.client.call('postCharge', { params: { folioId: FOLIO_ID }, body });
    expect(first.sent().init?.method).toBe('POST');
    expect(JSON.parse(first.sent().init?.body as string)).toEqual(body);
    expect(first.sent().headers.get('Content-Type')).toBe('application/json');
    expect(first.sent().headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);

    const retry = setup(jsonResponse(201, { id: FOLIO_ID, amount: body.amount }));
    await retry.client.call(
      'postCharge',
      { params: { folioId: FOLIO_ID }, body },
      { idempotencyKey: 'same-key-as-before' },
    );
    expect(retry.sent().headers.get('Idempotency-Key')).toBe('same-key-as-before');
  });

  it('sends If-Match, and refuses a versioned PATCH without it', async () => {
    const { client, sent, fetch } = setup(jsonResponse(200, { id: FOLIO_ID, name: 'Deluxe 101' }));
    const input = { params: { roomId: FOLIO_ID }, body: { name: 'Deluxe 101' } };
    await expect(client.call('renameRoom', input)).rejects.toThrow('needs an ifMatch ETag');
    expect(fetch).not.toHaveBeenCalled();
    await client.call('renameRoom', input, { ifMatch: '"3"' });
    expect(sent().headers.get('If-Match')).toBe('"3"');
  });

  it('refuses a property-scoped call when no property is selected', async () => {
    const { client, fetch } = setup(jsonResponse(200, {}), null);
    await expect(client.call('getFolio', { params: { folioId: FOLIO_ID } })).rejects.toThrow(
      'getFolio needs a current property',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves a 204 to undefined', async () => {
    const { client } = setup(new Response(null, { status: 204 }));
    await expect(
      client.call('deleteNote', { params: { noteId: FOLIO_ID } }),
    ).resolves.toBeUndefined();
  });
});

describe('createApiClient: errors', () => {
  it('turns the error envelope into an ApiError the UI can branch on', async () => {
    const { client } = setup(
      jsonResponse(409, {
        error: {
          code: 'BUSINESS_DAY_CLOSED',
          message: 'The business day 12 Nov 2026 is closed.',
          requestId: 'req_abc',
          details: { businessDate: '2026-11-12' },
        },
      }),
    );
    const error = await client
      .call('postCharge', {
        params: { folioId: FOLIO_ID },
        body: { amount: NGN('1'), description: 'x' },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'BUSINESS_DAY_CLOSED',
      requestId: 'req_abc',
      details: { businessDate: '2026-11-12' },
    });
    expect(shouldRetry(0, error)).toBe(false);
  });

  it('keeps the status of a non-envelope gateway error, so Query retries it', async () => {
    const { client } = setup(new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = await client
      .call('getFolio', { params: { folioId: FOLIO_ID } })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: 'INTERNAL' });
    expect(shouldRetry(0, error)).toBe(true);
  });

  it('lets network failures through as-is (retried by Query)', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    const client = createApiClient({ propertyId: () => PROPERTY_ID, fetch }, EXAMPLE_ROUTES);
    const error = await client
      .call('getFolio', { params: { folioId: FOLIO_ID } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(shouldRetry(0, error)).toBe(true);
  });
});

describe('the app client', () => {
  it('fetches the API description from same-origin /api/v1', async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { openapi: '3.1.0' })));
    const client = createApiClient({ fetch });
    await expect(client.call('getOpenApiDocument')).resolves.toEqual({ openapi: '3.1.0' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/openapi.json',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

// Type-level checks (run by tsc, not at runtime).
if (import.meta.env['TYPECHECK_ONLY']) {
  const { client } = setup();
  // @ts-expect-error — params are required for getFolio
  void client.call('getFolio');
  // @ts-expect-error — folioId must be a string
  void client.call('getFolio', { params: { folioId: 1 } });
  // @ts-expect-error — unknown operation
  void client.call('noSuchRoute');
  const badBody = { amount: { amountMinor: 1, currency: 'NGN' }, description: '' };
  // @ts-expect-error — amountMinor is a string on the wire
  void client.call('postCharge', { params: { folioId: '' }, body: badBody });
}
