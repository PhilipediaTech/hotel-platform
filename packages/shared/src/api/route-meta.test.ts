import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { routeMetaSource } from './route-meta-source.ts';
import { ROUTE_META } from './route-meta.ts';
import { API_ROUTES } from './routes.ts';

// route-meta.ts is what the web client reads at runtime (T-091b); it must match the
// contracts exactly, or a call would go to the wrong path or miss a header.

describe('ROUTE_META', () => {
  it('is generated from API_ROUTES as they are now (run npm run routes:meta)', () => {
    const file = readFileSync(new URL('./route-meta.ts', import.meta.url), 'utf8');
    expect(file).toBe(routeMetaSource(API_ROUTES));
  });

  it('has every route with its method, path and flags', () => {
    expect(Object.keys(ROUTE_META)).toEqual(Object.keys(API_ROUTES));
    expect(ROUTE_META['sendTestMessage']).toEqual({
      operationId: 'sendTestMessage',
      method: 'post',
      path: '/message-templates/test',
      body: true,
      propertyScoped: true,
      idempotent: true,
    });
  });
});
