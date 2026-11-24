import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelError } from '../../core/channel-manager.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Channel manager connection (PRD M11-07; tab 2 ChannelManager with a fake; T-151). The hotel
// has room type Standard (room 101) and the best-available plan BAR.

const db = testDb();
const now = new Date('2026-11-10T09:00:00Z');
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
});

type View = {
  provider: string;
  connection: {
    status: string;
    externalPropertyId: string | null;
    lastError: string | null;
  } | null;
  roomTypes: { id: string; code: string; rooms: number; mapped: boolean }[];
  ratePlans: { id: string; code: string; selected: boolean; mappedRoomTypes: number }[];
  logs: { kind: string; status: string; items: number; message: string | null }[];
};

async function hotel() {
  const h = await inHouse(db, clock);
  const bar = await db.ratePlan.findFirstOrThrow({ where: { code: 'BAR' } });
  const get = () => h.ok<View>(h.gm.get('/channel-connection'));
  const connect = (ratePlanIds = [bar.id]) => h.gm.send('/channel-connection', { ratePlanIds });
  const methods = () => h.channel.calls.map((c) => c.method);
  return { ...h, bar, get, connect, methods };
}

describe('connecting the channel manager (M11-07)', () => {
  it('creates the property, its room types and the chosen plans once, and keeps their IDs', async () => {
    const h = await hotel();
    const before = await h.get();
    expect(before).toMatchObject({
      provider: 'FAKE',
      connection: null,
      roomTypes: [{ code: 'STD', rooms: 1, mapped: false }],
      ratePlans: [{ code: 'BAR', selected: false, mappedRoomTypes: 0 }],
    });
    const after = await h.ok<View>(h.connect());
    expect(after).toMatchObject({
      connection: { status: 'ACTIVE', lastError: null },
      roomTypes: [{ code: 'STD', mapped: true }],
      ratePlans: [{ code: 'BAR', selected: true, mappedRoomTypes: 1 }],
      logs: [{ kind: 'SETUP', status: 'OK', items: 3 }],
    });
    expect(after.connection?.externalPropertyId).toBeTruthy();
    const property = await db.property.findUniqueOrThrow({ where: { id: h.p1.id } });
    const std = await db.roomType.findFirstOrThrow({ where: { code: 'STD' } });
    expect(h.channel.calls).toEqual([
      {
        method: 'createProperty',
        input: expect.objectContaining({
          title: property.name,
          currency: 'NGN',
          timezone: property.timeZone,
          propertyType: 'hotel',
        }) as unknown,
      },
      {
        method: 'createRoomType',
        input: {
          propertyId: after.connection?.externalPropertyId,
          title: std.name,
          countOfRooms: 1,
          occAdults: std.maxOccupancy,
          defaultOccupancy: Math.min(std.baseOccupancy, std.maxOccupancy),
        },
      },
      {
        method: 'createRatePlan',
        input: expect.objectContaining({
          title: `${h.bar.name} · ${std.name}`,
          currency: 'NGN',
          occupancy: std.maxOccupancy,
          mealType: 'room_only',
        }) as unknown,
      },
    ]);
    // Running it again makes nothing new.
    await h.ok(h.connect());
    expect(h.methods()).toHaveLength(3);
    expect(await db.channelMapping.count()).toBe(2);
    expect(await db.auditEvent.count({ where: { action: 'channel.setup' } })).toBe(2);
  });

  it('keeps what was made when the channel manager fails half-way, and finishes on the next try', async () => {
    const h = await hotel();
    h.channel.failNext = {
      method: 'createRatePlan',
      error: new ChannelError('Channex answered 422: Validation Error', 422),
    };
    const failed = await h.connect();
    expect(failed.status).toBe(502);
    expect(errorOf(failed)).toMatchObject({
      code: 'CHANNEL_UNAVAILABLE',
      message:
        'Channex answered 422: Validation Error. What was set up so far is kept: try again to finish.',
    });
    const half = await h.get();
    expect(half).toMatchObject({
      connection: { status: 'CONNECTING', lastError: 'Channex answered 422: Validation Error' },
      roomTypes: [{ mapped: true }],
      ratePlans: [{ selected: false }],
      logs: [{ status: 'FAILED', items: 2 }],
    });
    await h.ok(h.connect());
    expect(h.methods()).toEqual([
      'createProperty',
      'createRoomType',
      'createRatePlan',
      'createRatePlan',
    ]);
    expect(await h.get()).toMatchObject({
      connection: { status: 'ACTIVE', lastError: null },
      ratePlans: [{ selected: true }],
    });
  });

  it('stops sending a plan left out, and takes it back without making it again', async () => {
    const h = await hotel();
    const derived = await h.ok<{ id: string }>(
      h.gm.post('/rate-plans', {
        cancellationPolicyId: h.bar.cancellationPolicyId,
        code: 'NRF',
        name: 'Non-refundable',
        kind: 'DERIVED',
        parentRatePlanId: h.bar.id,
        derivationBps: -1000,
      }),
    );
    await h.ok(h.connect([h.bar.id, derived.id]));
    await h.ok(h.connect([h.bar.id]));
    const view = await h.get();
    expect(view.ratePlans.find((p) => p.code === 'NRF')).toMatchObject({ selected: false });
    expect(await db.channelMapping.count({ where: { active: false } })).toBe(1);
    await h.ok(h.connect([h.bar.id, derived.id]));
    expect(h.methods().filter((m) => m === 'createRatePlan')).toHaveLength(2);
    expect(await db.channelMapping.count({ where: { active: false } })).toBe(0);
  });

  it('runs one setup at a time, refuses plans that can’t be sold online, and needs channel.manage', async () => {
    const h = await hotel();
    await h.ok(h.connect());
    const connection = await db.channelConnection.findFirstOrThrow();
    await db.channelConnection.update({
      where: { id: connection.id },
      data: { setupLockedUntil: new Date(now.getTime() + 60_000) },
    });
    expect(errorOf(await h.connect())).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      message: 'A setup is already running: try again shortly',
    });
    // A lease left by a run that died expires.
    await db.channelConnection.update({
      where: { id: connection.id },
      data: { setupLockedUntil: new Date(now.getTime() - 1) },
    });
    await h.ok(h.connect());
    const corporate = await db.ratePlan.create({
      data: {
        organisationId: h.org.id,
        propertyId: h.p1.id,
        code: 'CORP',
        name: 'Corporate',
        kind: 'NEGOTIATED',
        cancellationPolicyId: h.bar.cancellationPolicyId,
        currency: 'NGN',
      },
    });
    const refused = await h.connect([corporate.id]);
    expect(errorOf(refused).details).toMatchObject({ issues: [{ path: 'body.ratePlanIds.0' }] });
    expect((await h.fd.get('/channel-connection')).status).toBe(403);
  });

  it('pauses and resumes a connected property', async () => {
    const h = await hotel();
    expect(errorOf(await h.gm.patch('/channel-connection', { paused: true })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    await h.ok(h.connect());
    expect(await h.ok<View>(h.gm.patch('/channel-connection', { paused: true }))).toMatchObject({
      connection: { status: 'PAUSED' },
    });
    // A setup run while paused stays paused.
    expect(await h.ok<View>(h.connect())).toMatchObject({ connection: { status: 'PAUSED' } });
    expect(await h.ok<View>(h.gm.patch('/channel-connection', { paused: false }))).toMatchObject({
      connection: { status: 'ACTIVE' },
    });
    expect(
      await db.auditEvent.count({
        where: { action: { in: ['channel.paused', 'channel.resumed'] } },
      }),
    ).toBe(2);
  });

  it('skips room types with no rooms: Channex needs at least one', async () => {
    const h = await hotel();
    await h.ok(h.gm.post('/room-types', { code: 'STE', name: 'Suite' }));
    const view = await h.ok<View>(h.connect());
    expect(view.roomTypes.map((t) => [t.code, t.rooms, t.mapped])).toEqual(
      expect.arrayContaining([
        ['STD', 1, true],
        ['STE', 0, false],
      ]),
    );
    expect(h.methods().filter((m) => m === 'createRoomType')).toHaveLength(1);
  });
});
