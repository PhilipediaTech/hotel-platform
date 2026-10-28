import type { PgBoss } from 'pg-boss';
import type { Pool, PoolClient } from 'pg';
import type { Prisma } from '../generated/prisma/client.ts';
import { currentTenant } from './tenancy.ts';

// Outbox (tab 2 "Audit, outbox and jobs", ADR-012; T-021). A module that causes a side effect
// in another module (send a WhatsApp message, run a leakage rule, update the housekeeping
// list) records a domain event in the transaction of its change. The worker's publisher then
// turns each new event into one pg-boss job per subscribed handler, in one transaction with
// marking the event published, so no event is lost or published twice. Handlers run with
// pg-boss retries: delivery is at least once, so every handler must tolerate a repeat.

export interface EventInput {
  /** `resource.past_tense`, e.g. `reservation.created` (CHECK in the database). */
  type: string;
  payload: Record<string, unknown>;
  /** Defaults to the tenant's organisation. */
  organisationId?: string;
  /** Defaults to the tenant's property; `null` for an organisation-level event. */
  propertyId?: string | null;
}

/** Anything with a `domainEvent.create`: the plain client, a transaction, the tenant client. */
export interface OutboxClient {
  domainEvent: {
    create(args: { data: Prisma.DomainEventUncheckedCreateInput }): PromiseLike<unknown>;
  };
}

/** Records a domain event through `client` (use the transaction of the change). */
export async function recordEvent(client: OutboxClient, input: EventInput): Promise<void> {
  const tenant = currentTenant();
  const organisationId = input.organisationId ?? tenant?.organisationId;
  if (!organisationId)
    throw new Error(`Event ${input.type}: no organisation (pass organisationId)`);
  await client.domainEvent.create({
    data: {
      organisationId,
      propertyId: input.propertyId === undefined ? (tenant?.propertyId ?? null) : input.propertyId,
      type: input.type,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });
}

/** An event as handlers receive it. */
export interface DomainEventRecord {
  id: string;
  organisationId: string;
  propertyId: string | null;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

/** A side effect of one or more event types; runs as its own pg-boss queue `event.<name>`. */
export interface EventHandler {
  /** kebab-case, unique: becomes the queue name. */
  name: string;
  events: readonly string[];
  handle(event: DomainEventRecord): Promise<void>;
}

export const handlerQueue = (handler: Pick<EventHandler, 'name'>) => `event.${handler.name}`;

/** pg-boss runs its INSERT on our connection, inside our transaction. */
const onConnection = (client: PoolClient) => ({
  executeSql: async (text: string, values?: unknown[]) => client.query(text, values),
});

/**
 * Publishes up to `limit` unpublished events, oldest first. Returns how many it published.
 * Safe to run from several workers at once (rows are claimed with SKIP LOCKED).
 */
export async function publishPending(
  pool: Pool,
  boss: PgBoss,
  handlers: readonly EventHandler[],
  limit = 100,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; type: string }>(
      `SELECT id::text, type FROM domain_events WHERE published_at IS NULL
       ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const event of rows) {
      for (const handler of handlers.filter((h) => h.events.includes(event.type))) {
        await boss.send(handlerQueue(handler), { eventId: event.id }, { db: onConnection(client) });
      }
    }
    if (rows.length > 0) {
      await client.query(
        'UPDATE domain_events SET published_at = now() WHERE id = ANY($1::bigint[])',
        [rows.map((r) => r.id)],
      );
    }
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
