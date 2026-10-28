import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDatabaseUrl, testDb } from '../../test/db.ts';
import { makeTenant, makeUser } from '../../test/factories.ts';
import { TEST_CONFIG } from '../../test/helpers.ts';
import { workerJobs } from '../jobs.ts';
import { createFakeFileScanner } from './file-scan.ts';
import { createLocalFileStore } from './files.ts';
import { createSession } from './auth.ts';
import { cleanupJob, RETENTION } from './cleanup.ts';
import { startWorker, type RunningWorker } from './jobs.ts';
import { publishPending, recordEvent, type DomainEventRecord } from './outbox.ts';
import { runAsTenant } from './tenancy.ts';

// Outbox and jobs (tab 2 "Audit, outbox and jobs"; T-021) against a real pg-boss.

const db = testDb();
const logger = pino({ level: 'silent' });
const clock = () => new Date();

const seen: Record<string, DomainEventRecord[]> = { notify: [], tally: [], flaky: [] };
let flakyFailures = 0;

const HANDLERS = [
  {
    name: 'test-notify',
    events: ['booking.created', 'booking.cancelled'],
    handle: (e: DomainEventRecord) => {
      seen['notify']?.push(e);
      return Promise.resolve();
    },
  },
  {
    name: 'test-tally',
    events: ['booking.created'],
    handle: (e: DomainEventRecord) => {
      seen['tally']?.push(e);
      return Promise.resolve();
    },
  },
  {
    name: 'test-flaky',
    events: ['payment.received'],
    handle: (e: DomainEventRecord) => {
      if (flakyFailures > 0) {
        flakyFailures -= 1;
        return Promise.reject(new Error('provider timeout'));
      }
      seen['flaky']?.push(e);
      return Promise.resolve();
    },
  },
];

let worker: RunningWorker;

/** Waits for a handler; on timeout the error lists the queue's jobs (CI shows only the error). */
async function handled(name: string, count: number, timeout: number) {
  try {
    await expect.poll(() => seen[name]?.length, { timeout }).toBe(count);
  } catch (err) {
    const jobs = await worker.boss.findJobs(`event.test-${name}`);
    const states = jobs.map(
      (j) =>
        `${j.state}/r${j.retryCount}${j.output ? ` ${JSON.stringify(j.output).slice(0, 120)}` : ''}`,
    );
    throw new Error(`${String(err)}; jobs: ${states.join(', ')}`, { cause: err });
  }
}
let pool: pg.Pool;

beforeAll(async () => {
  worker = await startWorker({
    databaseUrl: testDatabaseUrl(),
    db,
    clock,
    logger,
    jobs: workerJobs({
      files: createLocalFileStore({ dir: TEST_CONFIG.localFilesDir, secret: 'test', clock }),
      scanner: createFakeFileScanner(),
    }),
    handlers: HANDLERS,
    // Tests publish by hand.
    publishIntervalMs: 3_600_000,
  });
  for (const h of HANDLERS) await worker.boss.deleteAllJobs(`event.${h.name}`);
  pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 4 });
}, 60_000);

afterAll(async () => {
  await worker.stop();
  await pool.end();
});

beforeEach(async () => {
  await resetDb(db);
  for (const list of Object.values(seen)) list.length = 0;
  flakyFailures = 0;
});

async function tenant() {
  const { organisation, property } = await makeTenant(db);
  const user = await makeUser(db);
  return {
    organisation,
    property,
    as: {
      userId: user.id,
      organisationId: organisation.id,
      propertyId: property.id,
      roles: [],
      permissions: new Set<string>(),
    },
  };
}

describe('recordEvent', () => {
  it('writes in the transaction of the change, with the tenant’s organisation and property', async () => {
    const t = await tenant();
    await expect(
      runAsTenant(t.as, () =>
        db.$transaction(async (tx) => {
          await recordEvent(tx, { type: 'booking.created', payload: { bookingId: 'b1' } });
          throw new Error('change failed');
        }),
      ),
    ).rejects.toThrow('change failed');
    expect(await db.domainEvent.count()).toBe(0);

    await runAsTenant(t.as, () =>
      db.$transaction((tx) =>
        recordEvent(tx, { type: 'booking.created', payload: { bookingId: 'b1' } }),
      ),
    );
    expect(await db.domainEvent.findFirstOrThrow()).toMatchObject({
      organisationId: t.organisation.id,
      propertyId: t.property.id,
      type: 'booking.created',
      payload: { bookingId: 'b1' },
      publishedAt: null,
    });
  });

  it('refuses a type that is not resource.past_tense', async () => {
    const t = await tenant();
    await expect(
      recordEvent(db, { type: 'BookingCreated', payload: {}, organisationId: t.organisation.id }),
    ).rejects.toThrow();
  });
});

describe('outbox publisher and handlers', () => {
  it('delivers each event to every subscribed handler once, and marks it published', async () => {
    const t = await tenant();
    const emit = (type: string, n: number) =>
      recordEvent(db, {
        type,
        payload: { n },
        organisationId: t.organisation.id,
        propertyId: t.property.id,
      });
    await emit('booking.created', 1);
    await emit('booking.cancelled', 2);
    await emit('room.cleaned', 3); // nobody listens

    expect(await worker.publish()).toBe(3);
    expect(await worker.publish()).toBe(0);
    expect(await db.domainEvent.count({ where: { publishedAt: null } })).toBe(0);

    await expect.poll(() => seen['notify']?.length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => seen['tally']?.length, { timeout: 15_000 }).toBe(1);
    expect(seen['notify']?.map((e) => e.payload['n']).sort()).toEqual([1, 2]);
    expect(seen['tally']?.[0]).toMatchObject({
      type: 'booking.created',
      organisationId: t.organisation.id,
      propertyId: t.property.id,
      payload: { n: 1 },
    });
  });

  it('retries a failing handler', async () => {
    const t = await tenant();
    flakyFailures = 1;
    await recordEvent(db, {
      type: 'payment.received',
      payload: { amountMinor: '500000' },
      organisationId: t.organisation.id,
    });
    await worker.publish();
    await handled('flaky', 1, 30_000);
    expect(flakyFailures).toBe(0);
  }, 40_000);

  it('never publishes an event twice when publishers run at once', async () => {
    const t = await tenant();
    for (let n = 0; n < 20; n++) {
      await recordEvent(db, {
        type: 'booking.created',
        payload: { n },
        organisationId: t.organisation.id,
      });
    }
    const counts = await Promise.all([
      publishPending(pool, worker.boss, HANDLERS, 7),
      publishPending(pool, worker.boss, HANDLERS, 7),
      publishPending(pool, worker.boss, HANDLERS, 7),
    ]);
    let total = counts.reduce((a, b) => a + b, 0);
    while (total < 20) total += await worker.publish();
    expect(total).toBe(20);
    await handled('tally', 20, 20_000);
    const ns = seen['tally']?.map((e) => e.payload['n']);
    expect(new Set(ns).size).toBe(20);
  }, 30_000);
});

describe('scheduled jobs', () => {
  it('registers the hourly cleanup', async () => {
    const schedules = await worker.boss.getSchedules('cleanup');
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ cron: '17 * * * *', timezone: 'UTC' });
  });

  it('cleanup removes rows that no longer matter and keeps the rest', async () => {
    const t = await tenant();
    const user = await makeUser(db);
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);
    const deps = { db, config: TEST_CONFIG, clock };
    const session = async () =>
      (await createSession(deps, { userId: user.id, sharedDevice: false, mfaPassed: true }))
        .session;
    const live = await session();
    const recentlyEnded = await session();
    const longEnded = await session();
    await db.session.update({ where: { id: recentlyEnded.id }, data: { revokedAt: ago(1000) } });
    await db.session.update({
      where: { id: longEnded.id },
      data: { revokedAt: ago(RETENTION.sessionsMs + 1000) },
    });
    const token = (data: { expiresAt: Date; usedAt?: Date }) =>
      db.authToken.create({
        data: {
          userId: user.id,
          purpose: 'PASSWORD_RESET',
          tokenHash: crypto.randomUUID(),
          ...data,
        },
      });
    const liveToken = await token({ expiresAt: new Date(now + 3_600_000) });
    await token({ expiresAt: ago(RETENTION.authTokensMs + 1000) });
    await token({
      expiresAt: new Date(now + 3_600_000),
      usedAt: ago(RETENTION.authTokensMs + 1000),
    });
    await db.rateLimitHit.createMany({
      data: [
        { key: 'ip:1', windowStart: ago(60_000) },
        { key: 'ip:1', windowStart: ago(RETENTION.rateLimitMs + 60_000) },
      ],
    });
    await db.idempotencyKey.createMany({
      data: [
        {
          userId: user.id,
          key: 'live',
          method: 'POST',
          path: '/x',
          requestHash: 'h',
          expiresAt: new Date(now + 1000),
        },
        {
          userId: user.id,
          key: 'old',
          method: 'POST',
          path: '/x',
          requestHash: 'h',
          createdAt: ago(3 * 86_400_000),
          expiresAt: ago(1000),
        },
      ],
    });
    const event = (publishedAt: Date | null) =>
      db.domainEvent.create({
        data: {
          organisationId: t.organisation.id,
          type: 'booking.created',
          payload: {},
          publishedAt,
        },
      });
    const unpublished = await event(null);
    const recent = await event(ago(1000));
    await event(ago(RETENTION.domainEventsMs + 1000));

    await cleanupJob.run({}, { db, clock, logger });

    expect(
      (await db.session.findMany({ where: { userId: user.id } })).map((s) => s.id).sort(),
    ).toEqual([live.id, recentlyEnded.id].sort());
    expect((await db.authToken.findMany()).map((x) => x.id)).toEqual([liveToken.id]);
    expect(await db.rateLimitHit.count()).toBe(1);
    expect((await db.idempotencyKey.findMany()).map((k) => k.key)).toEqual(['live']);
    expect((await db.domainEvent.findMany({ orderBy: { id: 'asc' } })).map((e) => e.id)).toEqual([
      unpublished.id,
      recent.id,
    ]);
  });
});
