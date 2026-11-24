import { addDays, INVENTORY_DAYS } from '@hotel/shared';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelError, createOffChannelManager } from '../../core/channel-manager.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { retryDelayMs, syncAll, syncConnection } from './sync.ts';

// Availability, prices and restrictions to the channel manager (PRD M11-07; T-152). The
// hotel has room type Standard (room 101), sold on 10 and 11 November, and the plan BAR at
// NGN 100,000 from 10 November to 31 December (no price after).

const db = testDb();
let now = new Date('2026-11-10T09:00:00Z');
const clock = () => new Date(now);
const later = (ms: number) => {
  now = new Date(now.getTime() + ms);
};
const MINUTE = 60_000;
const LAST = addDays(TODAY, INVENTORY_DAYS - 1);
const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

beforeEach(async () => {
  now = new Date('2026-11-10T09:00:00Z');
  await resetDb(db);
});

type View = {
  connection: {
    fullSyncPending: boolean;
    fullSyncAt: string | null;
    checkedAt: string | null;
    syncError: string | null;
    retryAt: string | null;
  } | null;
  logs: { kind: string; status: string; items: number; message: string | null }[];
};

async function hotel(options: { derived?: boolean } = {}) {
  const h = await inHouse(db, clock);
  const bar = await db.ratePlan.findFirstOrThrow({ where: { code: 'BAR' } });
  const nrf = options.derived
    ? await h.ok<{ id: string }>(
        h.gm.post('/rate-plans', {
          cancellationPolicyId: bar.cancellationPolicyId,
          code: 'NRF',
          name: 'Non-refundable',
          kind: 'DERIVED',
          parentRatePlanId: bar.id,
          derivationBps: -1000,
        }),
      )
    : null;
  const connect = (ids = [bar.id, ...(nrf ? [nrf.id] : [])]) =>
    h.ok(h.gm.send('/channel-connection', { ratePlanIds: ids }));
  // Nothing is recorded for a property without a connection.
  expect(await db.channelAriChange.count()).toBe(0);
  await connect();
  const connection = await db.channelConnection.findFirstOrThrow();
  const mappings = await db.channelMapping.findMany();
  const ext = {
    property: connection.externalPropertyId ?? '',
    std: mappings.find((m) => m.kind === 'ROOM_TYPE')?.externalId ?? '',
    bar: mappings.find((m) => m.ratePlanId === bar.id)?.externalId ?? '',
    nrf: mappings.find((m) => nrf && m.ratePlanId === nrf.id)?.externalId ?? '',
  };
  const setupCalls = h.channel.calls.length;
  const run = (opts = {}) => syncConnection(db, h.channel, clock, connection.id, opts);
  /** ARI calls since setup (or since `clear`). */
  let from = setupCalls;
  const pushes = (method: 'updateAvailability' | 'updateRestrictions') =>
    h.channel.calls
      .slice(from)
      .filter((c) => c.method === method)
      .map((c) => c.input as Record<string, unknown>[]);
  const clear = () => {
    from = h.channel.calls.length;
  };
  const get = () => h.ok<View>(h.gm.get('/channel-connection'));
  return { ...h, bar, nrf, connect, connection, ext, run, pushes, clear, get };
}

const open = (rate: string) => ({
  rate,
  minStayArrival: 1,
  maxStay: 0,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
});
const closed = {
  minStayArrival: 1,
  maxStay: 0,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: true,
};

describe('sending availability, prices and restrictions (M11-07)', () => {
  it('sends everything on the first run as date ranges, then nothing until something changes', async () => {
    const h = await hotel();
    expect(await h.run()).toBe('SENT');
    expect(h.pushes('updateAvailability')).toEqual([
      [
        {
          propertyId: h.ext.property,
          roomTypeId: h.ext.std,
          dateFrom: TODAY,
          dateTo: '2026-11-11',
          availability: 0,
        },
        {
          propertyId: h.ext.property,
          roomTypeId: h.ext.std,
          dateFrom: '2026-11-12',
          dateTo: LAST,
          availability: 1,
        },
      ],
    ]);
    // Rates as decimal strings; nights with no price are stop-sell.
    expect(h.pushes('updateRestrictions')).toEqual([
      [
        {
          propertyId: h.ext.property,
          ratePlanId: h.ext.bar,
          dateFrom: TODAY,
          dateTo: '2026-12-31',
          ...open('100000.00'),
        },
        {
          propertyId: h.ext.property,
          ratePlanId: h.ext.bar,
          dateFrom: '2027-01-01',
          dateTo: LAST,
          ...closed,
        },
      ],
    ]);
    const view = await h.get();
    expect(view.connection).toMatchObject({
      fullSyncPending: false,
      fullSyncAt: now.toISOString(),
      checkedAt: now.toISOString(),
      syncError: null,
    });
    expect(view.logs.slice(0, 3)).toMatchObject([
      { kind: 'FULL_SYNC', status: 'OK', items: 4 },
      { kind: 'RESTRICTIONS', status: 'OK', items: 2 },
      { kind: 'AVAILABILITY', status: 'OK', items: 2 },
    ]);

    h.clear();
    later(MINUTE);
    expect(await h.run()).toBe('SKIPPED');
    // At the latest every 15 minutes everything is compared again; nothing differs.
    later(15 * MINUTE);
    expect(await h.run()).toBe('UP_TO_DATE');
    expect(h.pushes('updateAvailability')).toEqual([]);
    expect(h.pushes('updateRestrictions')).toEqual([]);
  });

  it('sends only what changed: a price (with the derived plan worked out), a minimum stay, a room sold', async () => {
    const h = await hotel({ derived: true });
    await h.run();
    h.clear();
    later(MINUTE);
    const std = await db.roomType.findFirstOrThrow();
    await h.ok(
      h.gm.put('/rate-calendar', {
        ratePlanId: h.bar.id,
        roomTypeIds: [std.id],
        from: '2026-11-20',
        to: '2026-11-21',
        set: { amountMinor: '12000000' },
      }),
    );
    await h.ok(
      h.gm.put('/rate-calendar', {
        ratePlanId: h.bar.id,
        roomTypeIds: [std.id],
        from: '2026-11-25',
        to: '2026-11-25',
        set: { minStay: 2 },
      }),
    );
    await db.roomTypeInventory.update({
      where: {
        propertyId_roomTypeId_date: {
          propertyId: h.p1.id,
          roomTypeId: std.id,
          date: new Date('2026-11-15T00:00:00Z'),
        },
      },
      data: { sold: { increment: 1 } },
    });
    // Each change left a sign: the next run starts straight away.
    expect(await db.channelAriChange.count()).toBeGreaterThanOrEqual(3);
    expect(await h.run()).toBe('SENT');
    expect(h.pushes('updateAvailability')).toEqual([
      [
        {
          propertyId: h.ext.property,
          roomTypeId: h.ext.std,
          dateFrom: '2026-11-15',
          dateTo: '2026-11-15',
          availability: 0,
        },
      ],
    ]);
    const base = { propertyId: h.ext.property };
    expect(h.pushes('updateRestrictions')).toEqual([
      [
        {
          ...base,
          ratePlanId: h.ext.bar,
          dateFrom: '2026-11-20',
          dateTo: '2026-11-21',
          ...open('120000.00'),
        },
        {
          ...base,
          ratePlanId: h.ext.bar,
          dateFrom: '2026-11-25',
          dateTo: '2026-11-25',
          ...open('100000.00'),
          minStayArrival: 2,
        },
        // 10% off the parent.
        {
          ...base,
          ratePlanId: h.ext.nrf,
          dateFrom: '2026-11-20',
          dateTo: '2026-11-21',
          ...open('108000.00'),
        },
      ],
    ]);
    // The signs it saw are gone.
    expect(await db.channelAriChange.count()).toBe(0);
  });

  it('waits after a refusal (Retry-After, else 1, 2, 4… minutes) and then sends it all again', async () => {
    expect([1, 2, 3, 10].map((n) => retryDelayMs(n, null))).toEqual([
      MINUTE,
      2 * MINUTE,
      4 * MINUTE,
      30 * MINUTE,
    ]);
    expect(retryDelayMs(1, 300)).toBe(5 * MINUTE);
    const h = await hotel();
    h.channel.failNext = {
      method: 'updateAvailability',
      error: new ChannelError('Channex answered 429: Too Many Requests', 429, 120),
    };
    expect(await h.run()).toBe('FAILED');
    const failed = await h.get();
    expect(failed.connection).toMatchObject({
      syncError: 'Channex answered 429: Too Many Requests',
      retryAt: new Date(now.getTime() + 2 * MINUTE).toISOString(),
      fullSyncPending: true,
    });
    expect(failed.logs[0]).toMatchObject({ kind: 'AVAILABILITY', status: 'FAILED', items: 2 });
    h.clear();
    later(MINUTE);
    expect(await h.run()).toBe('SKIPPED');
    await syncAll(db, h.channel, clock, silent);
    expect(h.pushes('updateAvailability')).toEqual([]);
    later(MINUTE);
    expect(await h.run()).toBe('SENT');
    expect(h.pushes('updateAvailability')[0]).toHaveLength(2);
    expect(h.pushes('updateRestrictions')[0]).toHaveLength(2);
    expect((await h.get()).connection).toMatchObject({ syncError: null, retryAt: null });
    // A second failure in a row waits longer.
    h.channel.failNext = {
      method: 'updateRestrictions',
      error: new ChannelError('Channex answered 503: Service Unavailable', 503),
    };
    await h.ok(h.gm.send('/channel-connection/full-sync'));
    expect(await h.run()).toBe('FAILED');
    const c = await db.channelConnection.findFirstOrThrow();
    expect(c.syncFailures).toBe(1);
    expect(c.syncRetryAt?.getTime()).toBe(now.getTime() + MINUTE);
  });

  it('logs warnings, and counts the values as sent', async () => {
    const h = await hotel();
    h.channel.warnNext = [{ warning: 'Date is in the past', date: TODAY }];
    expect(await h.run()).toBe('SENT');
    const view = await h.get();
    expect(view.logs.find((l) => l.kind === 'AVAILABILITY')).toMatchObject({
      status: 'WARNING',
      message: '1 values were not taken as sent',
    });
    const log = await db.channelSyncLog.findFirstOrThrow({ where: { status: 'WARNING' } });
    expect(log.details).toEqual({ warnings: [{ warning: 'Date is in the past', date: TODAY }] });
    h.clear();
    later(15 * MINUTE);
    expect(await h.run()).toBe('UP_TO_DATE');
  });

  it('sends nothing while paused, and what changed meanwhile once resumed', async () => {
    const h = await hotel();
    await h.run();
    await h.ok(h.gm.patch('/channel-connection', { paused: true }));
    const std = await db.roomType.findFirstOrThrow();
    await h.ok(
      h.gm.put('/rate-calendar', {
        ratePlanId: h.bar.id,
        roomTypeIds: [std.id],
        from: '2026-11-20',
        to: '2026-11-20',
        set: { stopSell: true },
      }),
    );
    expect(await db.channelAriChange.count()).toBe(0);
    h.clear();
    later(MINUTE);
    expect(await h.run()).toBe('SKIPPED');
    expect(h.pushes('updateRestrictions')).toEqual([]);
    await h.ok(h.gm.patch('/channel-connection', { paused: false }));
    expect(await h.run()).toBe('SENT');
    expect(h.pushes('updateRestrictions')).toEqual([
      [
        {
          propertyId: h.ext.property,
          ratePlanId: h.ext.bar,
          dateFrom: '2026-11-20',
          dateTo: '2026-11-20',
          ...open('100000.00'),
          stopSell: true,
        },
      ],
    ]);
  });

  it('closes a plan taken off, on every date, once', async () => {
    const h = await hotel({ derived: true });
    await h.run();
    await h.connect([h.bar.id]);
    h.clear();
    later(MINUTE);
    expect(await h.run()).toBe('SENT');
    expect(h.pushes('updateAvailability')).toEqual([]);
    expect(h.pushes('updateRestrictions')).toEqual([
      [
        {
          propertyId: h.ext.property,
          ratePlanId: h.ext.nrf,
          dateFrom: TODAY,
          // Already closed from 1 January (no price there).
          dateTo: '2026-12-31',
          ...closed,
        },
      ],
    ]);
    h.clear();
    later(15 * MINUTE);
    expect(await h.run()).toBe('UP_TO_DATE');
  });

  it('sends everything again on request and once a day', async () => {
    const h = await hotel();
    await h.run();
    h.clear();
    later(MINUTE);
    const requested = await h.ok<View>(h.gm.send('/channel-connection/full-sync'));
    expect(requested.connection).toMatchObject({ fullSyncPending: true });
    expect(await db.auditEvent.count({ where: { action: 'channel.full_sync_requested' } })).toBe(1);
    expect(await h.run()).toBe('SENT');
    expect(h.pushes('updateAvailability')[0]).toHaveLength(2);
    expect(h.pushes('updateRestrictions')[0]).toHaveLength(2);
    expect((await h.get()).logs[0]).toMatchObject({ kind: 'FULL_SYNC', status: 'OK', items: 4 });

    // Not while paused, nor for a user without the permission.
    await h.ok(h.gm.patch('/channel-connection', { paused: true }));
    const paused = await h.gm.send('/channel-connection/full-sync');
    expect(paused.status).toBe(409);
    expect(errorOf(paused).message).toBe('The connection is paused: resume it first');
    const fd = await h.fd.send('/channel-connection/full-sync');
    expect(fd.status).toBe(403);
    await h.ok(h.gm.patch('/channel-connection', { paused: false }));

    h.clear();
    later(24 * 60 * MINUTE);
    expect(await h.run()).toBe('SENT');
    // A day on: today is 11 November, and the new last day has no inventory yet (0 rooms).
    expect(h.pushes('updateAvailability')[0]).toHaveLength(3);
    expect(h.pushes('updateRestrictions')[0]).toHaveLength(2);
    expect(await db.channelSyncLog.count({ where: { kind: 'FULL_SYNC' } })).toBe(3);
  });

  it('spreads a big send over runs, within the per-minute limit', async () => {
    const h = await hotel();
    const tiny = { chunk: 1, callsPerRun: 1 };
    expect(await h.run(tiny)).toBe('MORE_TO_SEND');
    expect(h.pushes('updateAvailability')).toHaveLength(1);
    expect(h.pushes('updateRestrictions')).toHaveLength(1);
    expect(await db.channelConnection.findFirstOrThrow()).toMatchObject({
      fullSyncPending: true,
      syncLockedUntil: null,
    });
    later(MINUTE);
    expect(await h.run(tiny)).toBe('SENT');
    expect(
      h
        .pushes('updateAvailability')
        .flat()
        .map((v) => v['dateFrom']),
    ).toEqual([TODAY, '2026-11-12']);
    expect(
      h
        .pushes('updateRestrictions')
        .flat()
        .map((v) => v['dateFrom']),
    ).toEqual([TODAY, '2027-01-01']);
    expect(await db.channelConnection.findFirstOrThrow()).toMatchObject({
      fullSyncPending: false,
    });
  });

  it('never runs twice at once, and does nothing without a channel manager', async () => {
    const h = await hotel();
    await db.channelConnection.update({
      where: { id: h.connection.id },
      data: { syncLockedUntil: new Date(now.getTime() + MINUTE) },
    });
    expect(await h.run()).toBe('SKIPPED');
    await syncAll(db, createOffChannelManager(), clock, silent);
    expect(h.pushes('updateAvailability')).toEqual([]);
    later(2 * MINUTE);
    await syncAll(db, h.channel, clock, silent);
    expect(h.pushes('updateAvailability')).toHaveLength(1);
  });
});
