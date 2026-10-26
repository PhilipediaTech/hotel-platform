import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { ERROR_HTTP_STATUS, type ErrorEnvelope } from '../errors.ts';
import { routeErrorCodes } from './contract.ts';
import {
  AmountMinor,
  ErrorEnvelopeSchema,
  Instant,
  IsoDate,
  MAX_PAGE_LIMIT,
  PageQuery,
} from './primitives.ts';
import { API_ROUTES } from './routes.ts';
import { EXAMPLE_ROUTES } from './testing.ts';

describe('wire primitives (tab 4 conventions)', () => {
  it.each(['0', '4500000', '-125', '999999999999999999'])('accepts amount %s', (v) => {
    expect(AmountMinor.safeParse(v).success).toBe(true);
  });

  it.each([4500000, '45.00', '007', '1e6', '', '-0x1', '1234567890123456789'])(
    'rejects amount %s',
    (v) => {
      expect(AmountMinor.safeParse(v).success).toBe(false);
    },
  );

  it('takes dates as YYYY-MM-DD and instants as UTC only', () => {
    expect(IsoDate.safeParse('2026-11-12').success).toBe(true);
    expect(IsoDate.safeParse('12/11/2026').success).toBe(false);
    expect(Instant.safeParse('2026-11-12T09:30:00Z').success).toBe(true);
    expect(Instant.safeParse('2026-11-12T10:30:00+01:00').success).toBe(false);
  });

  it('coerces and bounds page queries', () => {
    expect(PageQuery.parse({})).toEqual({ limit: 50 });
    expect(PageQuery.parse({ limit: '20', cursor: 'abc' })).toEqual({ limit: 20, cursor: 'abc' });
    expect(PageQuery.safeParse({ limit: String(MAX_PAGE_LIMIT + 1) }).success).toBe(false);
    expect(PageQuery.safeParse({ limit: '0' }).success).toBe(false);
  });
});

describe('ErrorEnvelopeSchema', () => {
  it('lists exactly the error codes the API can return', () => {
    expect(ErrorEnvelopeSchema.shape.error.shape.code.options).toEqual(
      Object.keys(ERROR_HTTP_STATUS),
    );
  });

  it('matches the ErrorEnvelope type the API sends', () => {
    expectTypeOf<z.output<typeof ErrorEnvelopeSchema>>().toEqualTypeOf<ErrorEnvelope>();
  });
});

describe('routeErrorCodes', () => {
  it('derives errors from the route flags and adds its own', () => {
    expect(routeErrorCodes(EXAMPLE_ROUTES.postCharge)).toEqual([
      'VALIDATION_ERROR',
      'UNAUTHENTICATED',
      'SESSION_EXPIRED',
      'MFA_REQUIRED',
      'FORBIDDEN',
      'MODULE_DISABLED',
      'NOT_FOUND',
      'IDEMPOTENCY_KEY_REUSED',
      'APPROVAL_EXPIRED',
      'BUSINESS_DAY_CLOSED',
      'SHIFT_NOT_OPEN',
      'RATE_LIMITED',
      'INTERNAL',
    ]);
  });

  it('gives a public route without input only rate limit and internal errors', () => {
    expect(routeErrorCodes(API_ROUTES.getOpenApiDocument)).toEqual(['RATE_LIMITED', 'INTERNAL']);
  });

  it('adds VERSION_CONFLICT for If-Match routes', () => {
    expect(routeErrorCodes(EXAMPLE_ROUTES.renameRoom)).toContain('VERSION_CONFLICT');
  });
});

describe('API_ROUTES', () => {
  it('is keyed by each route operationId', () => {
    for (const [key, route] of Object.entries(API_ROUTES)) expect(route.operationId).toBe(key);
  });

  it('uses relative OpenAPI-style paths', () => {
    for (const route of Object.values(API_ROUTES)) {
      expect(route.path).toMatch(/^\/[\w\-./{}]*$/);
      expect(route.path).not.toMatch(/^\/api\//);
      expect(route.path).not.toContain(':');
    }
  });
});

describe('role edit body', () => {
  it('leaves out what the caller leaves out (no defaults on PATCH)', async () => {
    const { RolePatchBody } = await import('./access.ts');
    expect(RolePatchBody.parse({ name: 'Bar' })).toEqual({ name: 'Bar' });
  });
});
