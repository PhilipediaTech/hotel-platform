import { readFileSync } from 'node:fs';
import { EXAMPLE_ROUTES } from '@hotel/shared/testing';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../../test/helpers.ts';
import { OPENAPI_FILE, renderOpenApi } from '../../scripts/openapi.ts';
import { buildOpenApiDocument, type OpenApiDocument } from './openapi.ts';

const doc = buildOpenApiDocument(Object.values(EXAMPLE_ROUTES));
type Operation = Record<string, unknown> & {
  parameters?: { name: string; in: string; required?: boolean }[];
  responses: Record<string, { description: string; content?: unknown }>;
};
const op = (path: string, method: string) =>
  (doc.paths?.[path] as Record<string, Operation> | undefined)?.[method] as Operation;

/** Every `$ref` in the document points at a component that exists. */
function danglingRefs(document: OpenApiDocument): string[] {
  const missing: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') {
          const [, , section, name] = value.split('/');
          const components = document.components as Record<string, Record<string, unknown>>;
          if (!section || !name || !components[section]?.[name]) missing.push(value);
        } else walk(value);
      }
    }
  };
  walk(document);
  return missing;
}

describe('buildOpenApiDocument', () => {
  it('produces OpenAPI 3.1 for /api/v1 with a session cookie scheme', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers).toEqual([{ url: '/api/v1' }]);
    expect(doc.components?.securitySchemes?.['session']).toMatchObject({
      in: 'cookie',
      name: 'sid',
    });
  });

  it('declares path, query and header parameters', () => {
    const charge = op('/folios/{folioId}/charges', 'post');
    expect(charge.parameters?.map((p) => [p.in, p.name, p.required])).toEqual([
      ['path', 'folioId', true],
      ['header', 'X-Property-Id', true],
      ['header', 'Idempotency-Key', true],
    ]);
    const list = op('/reservations', 'get');
    expect(list.parameters?.filter((p) => p.in === 'query').map((p) => p.name)).toEqual([
      'limit',
      'cursor',
      'status',
      'arrivalFrom',
    ]);
    expect(op('/example-rooms/{roomId}', 'patch').parameters?.map((p) => p.name)).toContain(
      'If-Match',
    );
  });

  it('groups error codes by HTTP status, all using the error envelope', () => {
    const responses = op('/folios/{folioId}/charges', 'post').responses;
    expect(Object.keys(responses)).toEqual([
      '201',
      '202',
      '400',
      '401',
      '403',
      '404',
      '409',
      '422',
      '429',
      '500',
    ]);
    expect(responses['409']?.description).toBe(
      'Conflict: `IDEMPOTENCY_KEY_REUSED`, `BUSINESS_DAY_CLOSED`, `SHIFT_NOT_OPEN`',
    );
    expect(responses['401']?.content).toEqual({
      'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
    });
    expect(responses['202']?.content).toEqual({
      'application/json': { schema: { $ref: '#/components/schemas/ApprovalPending' } },
    });
  });

  it('records permission, idempotency and session security on the operation', () => {
    const charge = op('/folios/{folioId}/charges', 'post');
    expect(charge['x-permission']).toBe('folio.post');
    expect(charge['x-idempotent']).toBe(true);
    expect(charge['security']).toEqual([{ session: [] }]);
  });

  it('describes a 204 without content', () => {
    expect(op('/notes/{noteId}', 'delete').responses['204']).toEqual({ description: 'No content' });
  });

  it('turns schemas with a meta id into shared components', () => {
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(
      expect.arrayContaining(['ErrorEnvelope', 'ApprovalPending', 'Money', 'AmountMinor', 'Uuid']),
    );
    expect(danglingRefs(doc)).toEqual([]);
  });

  it('rejects duplicate operation ids', () => {
    const { getFolio } = EXAMPLE_ROUTES;
    expect(() => buildOpenApiDocument([getFolio, { ...getFolio, path: '/other' }])).toThrow(
      'Duplicate operationId getFolio',
    );
  });
});

describe('the API document', () => {
  it('is served at /api/v1/openapi.json without a session', async () => {
    const res = await request(buildTestApp().app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(renderOpenApi()));
  });

  it('matches the committed apps/api/openapi.json (run `npm run openapi` after contract changes)', () => {
    expect(readFileSync(OPENAPI_FILE, 'utf8')).toBe(renderOpenApi());
  });

  it('has no dangling references', () => {
    expect(danglingRefs(buildOpenApiDocument())).toEqual([]);
  });
});
