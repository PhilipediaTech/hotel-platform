import {
  MAX_WEBHOOK_ENDPOINTS,
  PARTNER_EVENT_TYPES,
  PARTNER_EVENTS,
  TEST_EVENT_TYPE,
  type ApiKeyCreate,
  type ApiKeyItem,
  type PartnerEventType,
  type WebhookDeliveryItem,
  type WebhookEndpointItem,
} from '@hotel/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { newApiKey } from '../../core/api-keys.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import type { Config } from '../../core/config.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { defineJob } from '../../core/jobs.ts';
import { decryptSecret, encryptSecret } from '../../core/mfa.ts';
import type { DomainEventRecord, EventHandler } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { newToken } from '../../core/tokens.ts';
import {
  webhookSignature,
  webhookUrlProblem,
  WebhookUnreachableError,
  type WebhookSender,
} from '../../core/webhook-sender.ts';

// Integrations (T-166; Versions V2 "Partner API and webhooks"). Keys for the partner API, and
// webhook endpoints the hotel's events are sent to. An outbox handler turns each event an
// endpoint takes into a delivery and sends it at once; a job every minute sends what is due
// again: after 1, 5, 15, 60, 240 and 720 minutes, then the delivery has FAILED and the hotel can
// send it again. Delivery is at least once (the event ID in the body lets a receiver skip a
// repeat). Each try is signed afresh with the endpoint's secret.

export type WebhookConfig = Pick<Config, 'idKey' | 'nodeEnv'>;

export interface IntegrationDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
  config: Pick<Config, 'sessionSecret' | 'idKey' | 'nodeEnv'>;
  webhooks: WebhookSender;
}

/** Minutes before the next try after one that failed; then FAILED. */
export const RETRY_MINUTES = [1, 5, 15, 60, 240, 720];
/** A try in progress holds its delivery this long, so two workers never send it together. */
const LEASE_MS = 5 * 60_000;
const SECRET_PREFIX = 'whsec_';
const STATS_DAYS = 7;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

// ── API keys ────────────────────────────────────────────────────────────────────────────

type KeyRow = Prisma.ApiKeyGetPayload<{ include: { createdBy: { select: { name: true } } } }>;

const keyItem = (k: KeyRow): z.input<typeof ApiKeyItem> => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  scopes: k.scopes as z.input<typeof ApiKeyItem>['scopes'],
  createdAt: iso(k.createdAt),
  createdBy: k.createdBy.name,
  lastUsedAt: k.lastUsedAt ? iso(k.lastUsedAt) : null,
  revokedAt: k.revokedAt ? iso(k.revokedAt) : null,
});

const withCreator = { createdBy: { select: { name: true } } } as const;

export async function listApiKeys(deps: IntegrationDeps) {
  const keys = await deps.tenantDb.apiKey.findMany({
    include: withCreator,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  return { data: keys.map(keyItem) };
}

export async function createApiKey(
  deps: IntegrationDeps,
  tenant: TenantContext,
  body: z.output<typeof ApiKeyCreate>,
) {
  const { token, tokenHash, prefix } = newApiKey(deps.config);
  const scopes = [...new Set(body.scopes)];
  const key = await deps.tenantDb.$transaction(async (tx) => {
    const row = await tx.apiKey.create({
      data: {
        propertyId: tenant.propertyId,
        name: body.name,
        prefix,
        tokenHash,
        scopes,
        createdById: tenant.userId,
        createdAt: deps.clock(),
      },
      include: withCreator,
    });
    await recordAudit(tx, {
      action: 'api_key.created',
      entityType: 'api_key',
      entityId: row.id,
      after: { name: row.name, prefix, scopes },
    });
    return row;
  });
  return { key: keyItem(key), token };
}

export async function revokeApiKey(deps: IntegrationDeps, tenant: TenantContext, id: string) {
  return deps.tenantDb.$transaction(async (tx) => {
    const key = await tx.apiKey.findFirst({ where: { id }, include: withCreator });
    if (!key) throw new AppError('NOT_FOUND', 'API key not found.');
    if (key.revokedAt) return keyItem(key);
    const row = await tx.apiKey.update({
      where: { id },
      data: { revokedAt: deps.clock(), revokedById: tenant.userId },
      include: withCreator,
    });
    await recordAudit(tx, {
      action: 'api_key.revoked',
      entityType: 'api_key',
      entityId: id,
      before: { name: key.name, prefix: key.prefix },
    });
    return keyItem(row);
  });
}

// ── Webhook endpoints ───────────────────────────────────────────────────────────────────

type EndpointRow = Prisma.WebhookEndpointGetPayload<{
  include: { createdBy: { select: { name: true } } };
}>;
type Stats = Map<string, { delivered: number; failed: number; pending: number }>;

const endpointItem = (e: EndpointRow, stats: Stats): z.input<typeof WebhookEndpointItem> => ({
  id: e.id,
  url: e.url,
  description: e.description,
  events: e.events as PartnerEventType[],
  active: e.active,
  createdAt: iso(e.createdAt),
  createdBy: e.createdBy.name,
  ...(stats.get(e.id) ?? { delivered: 0, failed: 0, pending: 0 }),
});

async function statsOf(deps: IntegrationDeps, endpointIds: string[]): Promise<Stats> {
  const since = new Date(deps.clock().getTime() - STATS_DAYS * 86_400_000);
  const rows = await deps.tenantDb.webhookDelivery.groupBy({
    by: ['endpointId', 'status'],
    where: { endpointId: { in: endpointIds }, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const out: Stats = new Map();
  for (const r of rows) {
    const s = out.get(r.endpointId) ?? { delivered: 0, failed: 0, pending: 0 };
    if (r.status === 'DELIVERED') s.delivered += r._count._all;
    else if (r.status === 'FAILED') s.failed += r._count._all;
    else s.pending += r._count._all;
    out.set(r.endpointId, s);
  }
  return out;
}

const onlyKnown = (events: readonly string[]) =>
  PARTNER_EVENT_TYPES.filter((t) => events.includes(t));

function checkUrl(deps: IntegrationDeps, url: string) {
  const problem = webhookUrlProblem(url, deps.config.nodeEnv === 'production');
  if (problem) throw invalid('body.url', problem);
}

export async function listWebhookEndpoints(deps: IntegrationDeps) {
  const rows = await deps.tenantDb.webhookEndpoint.findMany({
    include: withCreator,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const stats = await statsOf(
    deps,
    rows.map((r) => r.id),
  );
  return { data: rows.map((r) => endpointItem(r, stats)) };
}

export async function createWebhookEndpoint(
  deps: IntegrationDeps,
  tenant: TenantContext,
  body: { url: string; description?: string | undefined; events: string[] },
) {
  checkUrl(deps, body.url);
  const secret = `${SECRET_PREFIX}${newToken()}`;
  const row = await deps.tenantDb.$transaction(async (tx) => {
    if ((await tx.webhookEndpoint.count()) >= MAX_WEBHOOK_ENDPOINTS) {
      throw invalid('body.url', `A property can send to at most ${MAX_WEBHOOK_ENDPOINTS} URLs`);
    }
    const created = await tx.webhookEndpoint.create({
      data: {
        propertyId: tenant.propertyId,
        url: body.url,
        description: body.description || null,
        events: onlyKnown(body.events),
        secretEnc: encryptSecret(deps.config.idKey, secret),
        createdById: tenant.userId,
        createdAt: deps.clock(),
      },
      include: withCreator,
    });
    await recordAudit(tx, {
      action: 'webhook_endpoint.created',
      entityType: 'webhook_endpoint',
      entityId: created.id,
      after: { url: created.url, events: created.events },
    });
    return created;
  });
  return { endpoint: endpointItem(row, new Map()), secret };
}

export async function updateWebhookEndpoint(
  deps: IntegrationDeps,
  id: string,
  body: {
    url?: string | undefined;
    description?: string | null | undefined;
    events?: string[] | undefined;
    active?: boolean | undefined;
  },
) {
  if (body.url !== undefined) checkUrl(deps, body.url);
  const row = await deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.webhookEndpoint.findFirst({ where: { id } });
    if (!before) throw new AppError('NOT_FOUND', 'Webhook endpoint not found.');
    const after = await tx.webhookEndpoint.update({
      where: { id },
      data: {
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        ...(body.events ? { events: onlyKnown(body.events) } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
      include: withCreator,
    });
    await recordAudit(tx, {
      action: 'webhook_endpoint.updated',
      entityType: 'webhook_endpoint',
      entityId: id,
      before: { url: before.url, events: before.events, active: before.active },
      after: { url: after.url, events: after.events, active: after.active },
    });
    return after;
  });
  return endpointItem(row, await statsOf(deps, [id]));
}

// ── Deliveries ──────────────────────────────────────────────────────────────────────────

type DeliveryRow = Prisma.WebhookDeliveryGetPayload<{
  include: { endpoint: { select: { url: true } } };
}>;

const deliveryItem = (d: DeliveryRow): z.input<typeof WebhookDeliveryItem> => ({
  id: d.id,
  endpointId: d.endpointId,
  url: d.endpoint.url,
  eventType: d.eventType as z.input<typeof WebhookDeliveryItem>['eventType'],
  status: d.status as z.input<typeof WebhookDeliveryItem>['status'],
  attempts: d.attempts,
  nextAttemptAt: d.status === 'PENDING' && d.nextAttemptAt ? iso(d.nextAttemptAt) : null,
  lastStatusCode: d.lastStatusCode,
  lastError: d.lastError,
  createdAt: iso(d.createdAt),
  deliveredAt: d.deliveredAt ? iso(d.deliveredAt) : null,
});

const withUrl = { endpoint: { select: { url: true } } } as const;

export async function listWebhookDeliveries(
  deps: IntegrationDeps,
  query: { endpointId?: string | undefined; status?: string | undefined },
) {
  const rows = await deps.tenantDb.webhookDelivery.findMany({
    where: {
      ...(query.endpointId ? { endpointId: query.endpointId } : {}),
      ...(query.status ? { status: query.status } : {}),
    },
    include: withUrl,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  return { data: rows.map(deliveryItem) };
}

async function deliveryNow(deps: IntegrationDeps, id: string) {
  await sendDue(deps.db, deps.clock, deps.webhooks, deps.config, { ids: [id] });
  return deliveryItem(
    await deps.tenantDb.webhookDelivery.findFirstOrThrow({ where: { id }, include: withUrl }),
  );
}

export async function testWebhookEndpoint(
  deps: IntegrationDeps,
  tenant: TenantContext,
  id: string,
) {
  const endpoint = await deps.tenantDb.webhookEndpoint.findFirst({ where: { id } });
  if (!endpoint) throw new AppError('NOT_FOUND', 'Webhook endpoint not found.');
  const now = deps.clock();
  const delivery = await deps.tenantDb.webhookDelivery.create({
    data: {
      propertyId: tenant.propertyId,
      endpointId: id,
      eventId: null,
      eventType: TEST_EVENT_TYPE,
      body: JSON.stringify({
        id: `evt_test_${randomUUID()}`,
        type: TEST_EVENT_TYPE,
        createdAt: iso(now),
        propertyId: tenant.propertyId,
        data: { message: 'A test from the hotel: your endpoint is set up.' },
      }),
      nextAttemptAt: now,
      createdAt: now,
    },
  });
  return deliveryNow(deps, delivery.id);
}

export async function retryWebhookDelivery(deps: IntegrationDeps, id: string) {
  const row = await deps.tenantDb.webhookDelivery.findFirst({ where: { id } });
  if (!row) throw new AppError('NOT_FOUND', 'Delivery not found.');
  if (row.status !== 'FAILED') {
    throw new AppError('STATE_TRANSITION_INVALID', 'Only a failed delivery can be sent again.', {
      status: row.status,
    });
  }
  await deps.tenantDb.webhookDelivery.updateMany({
    where: { id, status: 'FAILED' },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: deps.clock(), lastError: null },
  });
  return deliveryNow(deps, id);
}

/** The JSON sent for an event: its ID, type, time, property and the passed-on payload fields. */
export function eventBody(event: DomainEventRecord & { type: PartnerEventType }): string {
  const data: Record<string, unknown> = {};
  for (const field of PARTNER_EVENTS[event.type]) {
    if (field in event.payload) data[field] = event.payload[field];
  }
  return JSON.stringify({
    id: `evt_${event.id}`,
    type: event.type,
    createdAt: iso(event.occurredAt),
    propertyId: event.propertyId,
    data,
  });
}

const isPartnerEvent = (type: string): type is PartnerEventType =>
  (PARTNER_EVENT_TYPES as readonly string[]).includes(type);

/** An event → one delivery per live endpoint of its property that takes it (once each). */
export async function fanOut(db: Db, clock: Clock, event: DomainEventRecord): Promise<string[]> {
  if (!event.propertyId || !isPartnerEvent(event.type)) return [];
  const endpoints = await db.webhookEndpoint.findMany({
    where: { propertyId: event.propertyId, active: true, events: { has: event.type } },
    select: { id: true },
  });
  if (endpoints.length === 0) return [];
  const now = clock();
  const body = eventBody({ ...event, type: event.type });
  const created = await db.webhookDelivery.createManyAndReturn({
    data: endpoints.map((e) => ({
      propertyId: event.propertyId ?? '',
      endpointId: e.id,
      eventId: BigInt(event.id),
      eventType: event.type,
      body,
      nextAttemptAt: now,
      createdAt: now,
    })),
    // A repeat of the event (the outbox is at least once) adds nothing.
    skipDuplicates: true,
    select: { id: true },
  });
  return created.map((d) => d.id);
}

type Outcome =
  { kind: 'DELIVERED'; status: number } | { kind: 'RETRY'; status: number | null; error: string };

/**
 * Sends what is due (or the deliveries named), each once: a 2xx answer delivers it; anything
 * else waits for the next try, or FAILED after the last. Answers how many it tried.
 */
export async function sendDue(
  db: Db,
  clock: Clock,
  sender: WebhookSender,
  config: WebhookConfig,
  options: {
    ids?: string[];
    batch?: number;
    logger?: { warn: (o: object, m: string) => void };
  } = {},
): Promise<number> {
  const now = clock();
  const due = await db.webhookDelivery.findMany({
    where: {
      status: 'PENDING',
      nextAttemptAt: { lte: now },
      // A paused endpoint keeps its deliveries until it is switched back on; a test is sent.
      ...(options.ids ? { id: { in: options.ids } } : { endpoint: { active: true } }),
    },
    include: { endpoint: { select: { url: true, secretEnc: true } } },
    orderBy: { nextAttemptAt: 'asc' },
    take: options.batch ?? 50,
  });
  let tried = 0;
  for (const row of due) {
    // Claim it: another worker (or the request that made it) may be on the same row.
    const claimed = await db.webhookDelivery.updateMany({
      where: { id: row.id, status: 'PENDING', nextAttemptAt: row.nextAttemptAt },
      data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count !== 1) continue;
    tried += 1;
    const timestamp = String(Math.floor(clock().getTime() / 1000));
    let outcome: Outcome;
    try {
      const secret = decryptSecret(config.idKey, row.endpoint.secretEnc);
      const { status } = await sender.send({
        url: row.endpoint.url,
        body: row.body,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'HotelPlatform-Webhooks/1',
          'X-Webhook-Id': row.id,
          'X-Webhook-Event': row.eventType,
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Signature': webhookSignature(secret, timestamp, row.body),
        },
      });
      outcome =
        status >= 200 && status < 300
          ? { kind: 'DELIVERED', status }
          : { kind: 'RETRY', status, error: `The endpoint answered ${status}` };
    } catch (err) {
      if (!(err instanceof WebhookUnreachableError)) {
        options.logger?.warn({ err: pgErrorInfo(err), id: row.id }, 'Webhook send failed');
      }
      outcome = {
        kind: 'RETRY',
        status: null,
        error: err instanceof WebhookUnreachableError ? err.message : 'Sending failed',
      };
    }
    const at = clock();
    const attempts = row.attempts + 1;
    await db.webhookDelivery.update({
      where: { id: row.id },
      data:
        outcome.kind === 'DELIVERED'
          ? {
              status: 'DELIVERED',
              attempts,
              nextAttemptAt: null,
              deliveredAt: at,
              lastStatusCode: outcome.status,
              lastError: null,
            }
          : {
              attempts,
              lastStatusCode: outcome.status,
              lastError: outcome.error.slice(0, 300),
              ...(row.attempts >= RETRY_MINUTES.length
                ? { status: 'FAILED', nextAttemptAt: null }
                : {
                    nextAttemptAt: new Date(
                      at.getTime() + (RETRY_MINUTES[row.attempts] ?? 60) * 60_000,
                    ),
                  }),
            },
    });
  }
  return tried;
}

/** Each partner event → deliveries to the endpoints that take it, sent at once (T-166). */
export function partnerWebhookHandler(deps: {
  db: Db;
  clock: Clock;
  sender: WebhookSender;
  config: WebhookConfig;
  logger: { warn: (o: object, m: string) => void };
}): EventHandler {
  return {
    name: 'partner-webhooks',
    events: PARTNER_EVENT_TYPES,
    async handle(event) {
      const ids = await fanOut(deps.db, deps.clock, event);
      if (ids.length > 0) {
        await sendDue(deps.db, deps.clock, deps.sender, deps.config, { ids, logger: deps.logger });
      }
    },
  };
}

/** Every minute: the deliveries whose next try is due. */
export const webhookDeliveryJob = (deps: { sender: WebhookSender; config: WebhookConfig }) =>
  defineJob({
    name: 'webhook-delivery',
    schedule: { cron: '* * * * *' },
    options: { expireInSeconds: 5 * 60, retryLimit: 0 },
    run: async (_data, ctx) => {
      const n = await sendDue(ctx.db, ctx.clock, deps.sender, deps.config, {
        logger: ctx.logger,
      });
      if (n > 0) ctx.logger.info({ count: n }, 'Webhooks sent');
    },
  });
