import { defineJob } from './jobs.ts';

// Hourly cleanup (tab 2 scheduled jobs: "session cleanup"; T-021). Removes rows that no
// longer do anything: ended sessions, used or expired links, old rate-limit windows, expired
// idempotency keys and published outbox events. Audit events are never removed.

const DAY = 24 * 60 * 60_000;

/** How long each kind of row is kept after it stops mattering. */
export const RETENTION = {
  /** Revoked or expired sessions: kept a month for "where am I signed in" and support. */
  sessionsMs: 30 * DAY,
  /** Used or expired email, reset and invitation-style links. */
  authTokensMs: 7 * DAY,
  /** Rate-limit windows are a minute long; a day covers any investigation. */
  rateLimitMs: DAY,
  /** Published outbox events; handlers have long finished (pg-boss keeps its own job history). */
  domainEventsMs: 30 * DAY,
} as const;

export const cleanupJob = defineJob({
  name: 'cleanup',
  schedule: { cron: '17 * * * *' },
  options: { retryLimit: 2, retryDelay: 60 },
  async run(_data, { db, clock, logger }) {
    const now = clock().getTime();
    const before = (ms: number) => new Date(now - ms);
    // Child sessions (PIN users on a device) go with their device session (ON DELETE CASCADE).
    const sessions = await db.session.deleteMany({
      where: {
        OR: [
          { revokedAt: { lt: before(RETENTION.sessionsMs) } },
          { expiresAt: { lt: before(RETENTION.sessionsMs) } },
        ],
      },
    });
    const authTokens = await db.authToken.deleteMany({
      where: {
        OR: [
          { usedAt: { lt: before(RETENTION.authTokensMs) } },
          { expiresAt: { lt: before(RETENTION.authTokensMs) } },
        ],
      },
    });
    const rateLimitHits = await db.rateLimitHit.deleteMany({
      where: { windowStart: { lt: before(RETENTION.rateLimitMs) } },
    });
    const idempotencyKeys = await db.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date(now) } },
    });
    const domainEvents = await db.domainEvent.deleteMany({
      where: { publishedAt: { lt: before(RETENTION.domainEventsMs) } },
    });
    logger.info(
      {
        deleted: {
          sessions: sessions.count,
          authTokens: authTokens.count,
          rateLimitHits: rateLimitHits.count,
          idempotencyKeys: idempotencyKeys.count,
          domainEvents: domainEvents.count,
        },
      },
      'Cleanup done',
    );
  },
});
