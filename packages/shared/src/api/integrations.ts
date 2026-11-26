import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { ApiScope, PartnerEventType, TEST_EVENT_TYPE } from './partner-api.ts';
import { Instant, Uuid } from './primitives.ts';

// Integrations settings (T-166): the hotel's partner API keys and webhook endpoints. A key or a
// signing secret is shown once, when it is made, and never again (only its HMAC, or the secret
// encrypted, is kept). Each delivery is signed: `X-Webhook-Signature: v1=<hex>`, the
// HMAC-SHA256 with the endpoint's secret of `<X-Webhook-Timestamp>.<body>`.

const ADDED = 'Not in tab 4: designed in T-166 (Versions V2, partner API and webhooks).';
const PERMISSION = 'integration.manage';

export const ApiKeyItem = z
  .object({
    id: Uuid,
    name: z.string(),
    /** The key's first characters, to tell keys apart. */
    prefix: z.string(),
    scopes: z.array(ApiScope),
    createdAt: Instant,
    createdBy: z.string(),
    lastUsedAt: Instant.nullable(),
    revokedAt: Instant.nullable(),
  })
  .meta({ id: 'ApiKeyItem' });

export const listApiKeys = defineRoute({
  operationId: 'listApiKeys',
  method: 'get',
  path: '/api-keys',
  summary: 'The property’s partner API keys, newest first',
  description: ADDED,
  tags: ['Integrations'],
  propertyScoped: true,
  permission: PERMISSION,
  response: z.object({ data: z.array(ApiKeyItem) }),
});

export const ApiKeyCreate = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(ApiScope).min(1),
});

export const createApiKey = defineRoute({
  operationId: 'createApiKey',
  method: 'post',
  path: '/api-keys',
  summary: 'Make a key for an outside system: the key is in this answer only',
  description: ADDED,
  tags: ['Integrations'],
  propertyScoped: true,
  permission: PERMISSION,
  body: ApiKeyCreate,
  status: 201,
  response: z.object({ key: ApiKeyItem, token: z.string() }),
});

export const revokeApiKey = defineRoute({
  operationId: 'revokeApiKey',
  method: 'post',
  path: '/api-keys/{apiKeyId}/revoke',
  summary: 'Stop a key working, at once and for good',
  description: ADDED,
  tags: ['Integrations'],
  propertyScoped: true,
  permission: PERMISSION,
  params: z.object({ apiKeyId: Uuid }),
  response: ApiKeyItem,
});

export const WebhookEndpointItem = z
  .object({
    id: Uuid,
    url: z.string(),
    description: z.string().nullable(),
    events: z.array(PartnerEventType),
    active: z.boolean(),
    createdAt: Instant,
    createdBy: z.string(),
    /** The last 7 days. */
    delivered: z.number().int(),
    failed: z.number().int(),
    pending: z.number().int(),
  })
  .meta({ id: 'WebhookEndpointItem' });

export const MAX_WEBHOOK_ENDPOINTS = 10;

export const listWebhookEndpoints = defineRoute({
  operationId: 'listWebhookEndpoints',
  method: 'get',
  path: '/webhook-endpoints',
  summary: 'Where the property’s events are sent',
  description: ADDED,
  tags: ['Integrations'],
  propertyScoped: true,
  permission: PERMISSION,
  response: z.object({ data: z.array(WebhookEndpointItem) }),
});

const WebhookUrl = z.url({ protocol: /^https?$/ }).max(500);

export const createWebhookEndpoint = defineRoute({
  operationId: 'createWebhookEndpoint',
  method: 'post',
  path: '/webhook-endpoints',
  summary: 'Send events to a URL: the signing secret is in this answer only',
  description: `${ADDED} https only in production, and never a private or local address. At most ${MAX_WEBHOOK_ENDPOINTS} per property.`,
  tags: ['Integrations'],
  propertyScoped: true,
  permission: PERMISSION,
  body: z.object({
    url: WebhookUrl,
    description: z.string().trim().max(200).optional(),
    events: z.array(PartnerEventType).min(1),
  }),
  status: 201,
  response: z.object({ endpoint: WebhookEndpointItem, secret: z.string() }),
  errors: ['VALIDATION_ERROR'],
});

export const updateWebhookEndpoint = defineRoute({
  operationId: 'updateWebhookEndpoint',
  method: 'patch',
  path: '/webhook-endpoints/{endpointId}',
  summary: 'Change an endpoint’s URL or events, or pause it',
  description: ADDED,
  tags: ['Integrations'],
  propertyScoped: true,
  permission: PERMISSION,
  params: z.object({ endpointId: Uuid }),
  body: z.object({
    url: WebhookUrl.optional(),
    description: z.string().trim().max(200).nullable().optional(),
    events: z.array(PartnerEventType).min(1).optional(),
    active: z.boolean().optional(),
  }),
  response: WebhookEndpointItem,
});

export const WEBHOOK_DELIVERY_STATUSES = ['PENDING', 'DELIVERED', 'FAILED'] as const;

export const WebhookDeliveryItem = z
  .object({
    id: Uuid,
    endpointId: Uuid,
    url: z.string(),
    eventType: z.union([PartnerEventType, z.literal(TEST_EVENT_TYPE)]),
    status: z.enum(WEBHOOK_DELIVERY_STATUSES),
    attempts: z.number().int(),
    nextAttemptAt: Instant.nullable(),
    lastStatusCode: z.number().int().nullable(),
    lastError: z.string().nullable(),
    createdAt: Instant,
    deliveredAt: Instant.nullable(),
  })
  .meta({ id: 'WebhookDeliveryItem' });

export const testWebhookEndpoint = defineRoute({
  operationId: 'testWebhookEndpoint',
  method: 'post',
  path: '/webhook-endpoints/{endpointId}/test',
  summary: 'Send a signed test event now, and say how it went',
  description: ADDED,
  tags: ['Integrations'],
  propertyScoped: true,
  permission: PERMISSION,
  params: z.object({ endpointId: Uuid }),
  response: WebhookDeliveryItem,
});

export const listWebhookDeliveries = defineRoute({
  operationId: 'listWebhookDeliveries',
  method: 'get',
  path: '/webhook-deliveries',
  summary: 'The latest 100 deliveries, newest first',
  description: ADDED,
  tags: ['Integrations'],
  propertyScoped: true,
  permission: PERMISSION,
  query: z.object({
    endpointId: Uuid.optional(),
    status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
  }),
  response: z.object({ data: z.array(WebhookDeliveryItem) }),
});

export const retryWebhookDelivery = defineRoute({
  operationId: 'retryWebhookDelivery',
  method: 'post',
  path: '/webhook-deliveries/{deliveryId}/retry',
  summary: 'Send a failed delivery again now (then on the usual retry plan)',
  description: ADDED,
  tags: ['Integrations'],
  propertyScoped: true,
  permission: PERMISSION,
  params: z.object({ deliveryId: Uuid }),
  response: WebhookDeliveryItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const INTEGRATION_ROUTES = {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  listWebhookEndpoints,
  createWebhookEndpoint,
  updateWebhookEndpoint,
  testWebhookEndpoint,
  listWebhookDeliveries,
  retryWebhookDelivery,
} as const;
