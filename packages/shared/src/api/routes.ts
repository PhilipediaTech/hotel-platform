import { z } from 'zod';
import { defineRoute } from './contract.ts';

// The API surface, one entry per endpoint in spec tab 4. Modules add their routes here as
// they are built; `npm run openapi` regenerates apps/api/openapi.json from this list.

export const getOpenApiDocument = defineRoute({
  operationId: 'getOpenApiDocument',
  method: 'get',
  path: '/openapi.json',
  summary: 'This API description (OpenAPI 3.1)',
  tags: ['Meta'],
  auth: 'none',
  response: z.record(z.string(), z.unknown()).meta({ description: 'OpenAPI 3.1 document' }),
});

export const API_ROUTES = {
  getOpenApiDocument,
} as const;

export type ApiRoutes = typeof API_ROUTES;
export type OperationId = keyof ApiRoutes;
