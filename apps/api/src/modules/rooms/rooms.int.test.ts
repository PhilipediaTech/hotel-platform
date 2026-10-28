import { addDays, localDate } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectViolation, resetDb, SQLSTATE, testDb } from '../../../test/db.ts';
import { makeRoom, makeRoomType } from '../../../test/factories.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { syncBlockStatuses } from './service.ts';

// Room types, rooms, QR tokens and blocks (PRD M2-01–M2-03; tab 4 row "Rooms"; T-031).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z'); // 10:00 in Lagos
});

const TODAY = '2026-11-10';

async function hotel() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId, clock));
  return { ...h, c, as, mgr: await as(h.gm.id) };
}

type Body = Record<string, unknown> & { id: string; version: number };
const body = (res: { body: unknown }) => res.body as Body;
const issuesOf = (res: { body: unknown }) =>
  (errorOf(res).details?.['issues'] as { path: string; message: string }[]).map((i) => i.path);
const audit = (action: string) =>
  db.auditEvent.findMany({ where: { action }, orderBy: { id: 'asc' } });

async function withType(h: Awaited<ReturnType<typeof hotel>>, extra: object = {}) {
  const res = await h.mgr.post('/room-types', { code: 'dlx', name: 'Deluxe', ...extra });
  expect(res.status).toBe(201);
  return body(res);
}

async function addRoom(
  h: Awaited<ReturnType<typeof hotel>>,
  roomTypeId: string,
  extra: object = {},
) {
  const res = await h.mgr.post('/rooms', { number: '101', roomTypeId, ...extra });
  expect(res.status).toBe(201);
  return body(res);
}

describe('room types (M2-01)', () => {
  it('creates a type with occupancy, amenities, photos and description; audited', async () => {
    const h = await hotel();
    const photo = await db.fileObject.create({
      data: {
        organisationId: h.org.id,
        propertyId: h.p1.id,
        storageKey: `org/${h.org.id}/property/${h.p1.id}/photo-1`,
        contentType: 'image/jpeg',
        sizeBytes: 1000,
        scan: 'CLEAN',
        entityType: 'RoomType',
        uploadedById: h.owner.id,
      },
    });
    const res = await h.mgr.post('/room-types', {
      code: 'dlx',
      name: 'Deluxe King',
      baseOccupancy: 2,
      maxOccupancy: 3,
      description: 'Sea view, 32 m²',
      amenities: ['King bed', 'Air conditioning', 'Wi-Fi'],
      photoFileIds: [photo.id],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: 'DLX',
      name: 'Deluxe King',
      baseOccupancy: 2,
      maxOccupancy: 3,
      amenities: ['King bed', 'Air conditioning', 'Wi-Fi'],
      photoFileIds: [photo.id],
      active: true,
      roomCount: 0,
    });
    // The photo now belongs to the room type.
    expect((await db.fileObject.findUniqueOrThrow({ where: { id: photo.id } })).entityId).toBe(
      body(res).id,
    );
    const [event] = await audit('roomtype.created');
    expect(event).toMatchObject({ entityType: 'room_type', after: { typeCode: 'DLX' } });

    // Everyone at the property can read them.
    const fd = await h.as(h.fd.id);
    expect(((await fd.get('/room-types')).body as { data: unknown[] }).data).toHaveLength(1);
  });

  it('refuses duplicate codes, base above max and photos of another kind', async () => {
    const h = await hotel();
    await withType(h);
    expect(issuesOf(await h.mgr.post('/room-types', { code: 'DLX', name: 'Again' }))).toEqual([
      'body.code',
    ]);
    expect(
      issuesOf(
        await h.mgr.post('/room-types', {
          code: 'STD',
          name: 'S',
          baseOccupancy: 3,
          maxOccupancy: 2,
        }),
      ),
    ).toEqual(['body.maxOccupancy']);
    const csv = await db.fileObject.create({
      data: {
        organisationId: h.org.id,
        propertyId: h.p1.id,
        storageKey: `org/${h.org.id}/property/${h.p1.id}/import-1`,
        contentType: 'text/csv',
        sizeBytes: 10,
        entityType: 'ImportJob',
        uploadedById: h.owner.id,
      },
    });
    expect(
      issuesOf(await h.mgr.post('/room-types', { code: 'STD', name: 'S', photoFileIds: [csv.id] })),
    ).toEqual(['body.photoFileIds']);
  });

  it('deactivates a type only once it has no active rooms', async () => {
    const h = await hotel();
    const type = await withType(h);
    const room = await addRoom(h, type.id);
    const refused = await h.mgr.patch(`/room-types/${type.id}`, { active: false });
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { activeRooms: 1 },
    });
    await h.mgr.patch(`/rooms/${room.id}`, { active: false }).set('If-Match', '"0"');
    const ok = await h.mgr.patch(`/room-types/${type.id}`, { active: false, name: 'Old Deluxe' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ active: false, name: 'Old Deluxe', roomCount: 0 });
    const [event] = await audit('roomtype.updated');
    expect(event?.after).toEqual({ name: 'Old Deluxe', active: false });
  });

  it('needs roomtype.manage to change types', async () => {
    const h = await hotel();
    const fd = await h.as(h.fd.id);
    const res = await fd.post('/room-types', { code: 'STD', name: 'Standard' });
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ permission: 'roomtype.manage' });
  });
});

describe('rooms and QR tokens (M2-02)', () => {
  it('creates rooms with an unguessable QR token and lists them in natural order', async () => {
    const h = await hotel();
    const type = await withType(h);
    const res = await h.mgr.post('/rooms', {
      number: '1001',
      roomTypeId: type.id,
      floor: '10',
      building: 'Tower',
      features: ['Balcony', 'Sea view'],
    });
    expect(res.status).toBe(201);
    expect(res.headers['etag']).toBe('"0"');
    expect(res.body).toMatchObject({
      number: '1001',
      floor: '10',
      building: 'Tower',
      features: ['Balcony', 'Sea view'],
      hkStatus: 'DIRTY',
      active: true,
      version: 0,
      blocks: [],
    });
    expect(body(res)['qrToken']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await addRoom(h, type.id, { number: '102' });
    await addRoom(h, type.id, { number: '101' });
    const list = (await h.mgr.get('/rooms')).body as {
      data: { number: string; qrToken: string }[];
    };
    expect(list.data.map((r) => r.number)).toEqual(['101', '102', '1001']);
    expect(new Set(list.data.map((r) => r.qrToken)).size).toBe(3);
    expect((await audit('room.created')).length).toBe(3);
  });

  it('refuses a taken number and an inactive or unknown type', async () => {
    const h = await hotel();
    const type = await withType(h);
    await addRoom(h, type.id);
    expect(issuesOf(await h.mgr.post('/rooms', { number: '101', roomTypeId: type.id }))).toEqual([
      'body.number',
    ]);
    const other = await makeRoomType(db, h.p2); // another property of the same organisation
    expect(issuesOf(await h.mgr.post('/rooms', { number: '102', roomTypeId: other.id }))).toEqual([
      'body.roomTypeId',
    ]);
  });

  it('links connecting rooms both ways and moves the link', async () => {
    const h = await hotel();
    const type = await withType(h);
    const a = await addRoom(h, type.id, { number: '101' });
    const b = await addRoom(h, type.id, { number: '102', connectingRoomId: a.id });
    const c = await addRoom(h, type.id, { number: '103' });
    const rooms = async () =>
      Object.fromEntries(
        ((await h.mgr.get('/rooms')).body as { data: Body[] }).data.map((r) => [
          String(r['number']),
          r['connectingRoomId'],
        ]),
      );
    expect(await rooms()).toEqual({ '101': b.id, '102': a.id, '103': null });

    // 103 can't take 101 while 101 connects to 102.
    const taken = await h.mgr
      .patch(`/rooms/${c.id}`, { connectingRoomId: a.id })
      .set('If-Match', '"0"');
    expect(issuesOf(taken)).toEqual(['body.connectingRoomId']);
    // 102 switches to 103: 101 is let go.
    const moved = await h.mgr
      .patch(`/rooms/${b.id}`, { connectingRoomId: c.id })
      .set('If-Match', `"${b.version}"`);
    expect(moved.status).toBe(200);
    expect(await rooms()).toEqual({ '101': null, '102': c.id, '103': b.id });
    // Not to itself.
    const self = await h.mgr
      .patch(`/rooms/${b.id}`, { connectingRoomId: b.id })
      .set('If-Match', '"1"');
    expect(issuesOf(self)).toEqual(['body.connectingRoomId']);
  });

  it('needs the current version to change a room, and audits only what changed', async () => {
    const h = await hotel();
    const type = await withType(h);
    const room = await addRoom(h, type.id);
    const ok = await h.mgr.patch(`/rooms/${room.id}`, { floor: '1' }).set('If-Match', '"0"');
    expect(ok.status).toBe(200);
    expect(ok.headers['etag']).toBe('"1"');
    expect(body(ok).version).toBe(1);

    const stale = await h.mgr.patch(`/rooms/${room.id}`, { floor: '2' }).set('If-Match', '"0"');
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toMatchObject({ code: 'VERSION_CONFLICT', details: { version: 1 } });

    const [event] = await audit('room.updated');
    expect(event).toMatchObject({ before: {}, after: { floor: '1' } });
    expect(Object.keys(event?.after as object)).toEqual(['floor']);
  });

  it('turns the room-type and room setup steps into real checks', async () => {
    const h = await hotel();
    const steps = async () =>
      Object.fromEntries(
        (
          (await h.mgr.get(`/properties/${h.p1.id}`)).body as {
            checklist: { steps: { id: string; status: string }[] };
          }
        ).checklist.steps.map((s) => [s.id, s.status]),
      );
    expect(await steps()).toMatchObject({ 'room-types': 'TODO', rooms: 'TODO' });
    const type = await withType(h);
    expect(await steps()).toMatchObject({ 'room-types': 'DONE', rooms: 'TODO' });
    await addRoom(h, type.id);
    expect(await steps()).toMatchObject({ 'room-types': 'DONE', rooms: 'DONE' });
  });
});

describe('out-of-order and out-of-service blocks (M2-03)', () => {
  async function blocked(kind = 'OUT_OF_ORDER', startDate = TODAY, endDate = addDays(TODAY, 3)) {
    const h = await hotel();
    const type = await withType(h);
    const room = await addRoom(h, type.id);
    const res = await h.mgr.post('/room-blocks', {
      roomId: room.id,
      kind,
      startDate,
      endDate,
      reason: 'Air conditioner leaking',
    });
    return { h, room, res };
  }

  const roomRow = (id: string) => db.room.findUniqueOrThrow({ where: { id } });

  it('takes the room out of order from today, with reason, and lists the block', async () => {
    const { h, room, res } = await blocked();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'OUT_OF_ORDER',
      startDate: TODAY,
      endDate: '2026-11-13',
      reason: 'Air conditioner leaking',
      releasedAt: null,
    });
    expect(await roomRow(room.id)).toMatchObject({ hkStatus: 'OUT_OF_ORDER', version: 1 });
    const listed = ((await h.mgr.get('/rooms')).body as { data: { blocks: Body[] }[] }).data[0];
    expect(listed?.blocks.map((b) => b.id)).toEqual([body(res).id]);
    const [event] = await audit('room.blocked');
    expect(event).toMatchObject({
      entityType: 'room',
      entityId: room.id,
      reason: 'Air conditioner leaking',
      after: { kind: 'OUT_OF_ORDER', startDate: TODAY, endDate: '2026-11-13' },
    });
  });

  it('marks out of service the same way', async () => {
    const { room, res } = await blocked('OUT_OF_SERVICE');
    expect(res.status).toBe(201);
    expect((await roomRow(room.id)).hkStatus).toBe('OUT_OF_SERVICE');
  });

  it('leaves the room alone until a future block starts, then the job applies it', async () => {
    const { room, res } = await blocked('OUT_OF_ORDER', '2026-11-12', '2026-11-14');
    expect(res.status).toBe(201);
    expect((await roomRow(room.id)).hkStatus).toBe('DIRTY');

    now = new Date('2026-11-11T23:30:00Z'); // 00:30 on the 12th in Lagos
    expect(await syncBlockStatuses(db, clock)).toEqual({ started: 1, ended: 0 });
    expect((await roomRow(room.id)).hkStatus).toBe('OUT_OF_ORDER');
    expect(await syncBlockStatuses(db, clock)).toEqual({ started: 0, ended: 0 });

    now = new Date('2026-11-14T08:00:00Z'); // the block ended
    expect(await syncBlockStatuses(db, clock)).toEqual({ started: 0, ended: 1 });
    expect((await roomRow(room.id)).hkStatus).toBe('DIRTY');
  });

  it('refuses overlapping, past, reversed and over-long blocks', async () => {
    const { h, room } = await blocked();
    const block = (startDate: string, endDate: string) =>
      h.mgr.post('/room-blocks', {
        roomId: room.id,
        kind: 'OUT_OF_SERVICE',
        startDate,
        endDate,
        reason: 'Painting',
      });
    const overlap = await block('2026-11-12', '2026-11-15');
    expect(issuesOf(overlap)).toEqual(['body.startDate']);
    expect(errorOf(overlap).message).toMatch(/already blocked from 2026-11-10 to 2026-11-13/);
    // Back-to-back is fine: the end date is exclusive.
    expect((await block('2026-11-13', '2026-11-14')).status).toBe(201);
    expect(issuesOf(await block('2026-11-09', '2026-11-10'))).toEqual(['body.startDate']);
    expect(issuesOf(await block('2026-11-20', '2026-11-20'))).toEqual(['body.endDate']);
    expect(issuesOf(await block('2026-11-20', '2027-11-22'))).toEqual(['body.endDate']);
  });

  it('lets only one of two simultaneous blocks through', async () => {
    const { h, room } = await blocked('OUT_OF_ORDER', '2026-12-01', '2026-12-02');
    const block = () =>
      h.mgr.post('/room-blocks', {
        roomId: room.id,
        kind: 'OUT_OF_ORDER',
        startDate: '2026-12-10',
        endDate: '2026-12-12',
        reason: 'Plumbing',
      });
    const statuses = (await Promise.all([block(), block()])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 400]);
  });

  it('releases a block early: the room comes back dirty; releasing twice is refused', async () => {
    const { h, room, res } = await blocked();
    const id = body(res).id;
    const released = await h.mgr.post(`/room-blocks/${id}/release`);
    expect(released.status).toBe(200);
    expect(body(released)['releasedAt']).toBe('2026-11-10T09:00:00Z');
    expect(await roomRow(room.id)).toMatchObject({ hkStatus: 'DIRTY', version: 2 });
    const [event] = await audit('room.block_released');
    expect(event).toMatchObject({ entityId: room.id, after: { releasedOn: TODAY, early: true } });
    // Released blocks no longer show on the room.
    const listed = ((await h.mgr.get('/rooms')).body as { data: { blocks: Body[] }[] }).data[0];
    expect(listed?.blocks).toEqual([]);

    const again = await h.mgr.post(`/room-blocks/${id}/release`);
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('STATE_TRANSITION_INVALID');
  });

  it('needs room.block', async () => {
    const h = await hotel();
    const type = await withType(h);
    const room = await addRoom(h, type.id);
    const fd = await h.as(h.fd.id);
    const res = await fd.post('/room-blocks', {
      roomId: room.id,
      kind: 'OUT_OF_ORDER',
      startDate: TODAY,
      endDate: addDays(TODAY, 1),
      reason: 'x',
    });
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ permission: 'room.block' });
  });

  it('uses the property date, not UTC', () => {
    // 23:30 UTC on the 10th is already the 11th in Lagos.
    expect(localDate(new Date('2026-11-10T23:30:00Z'), 'Africa/Lagos')).toBe('2026-11-11');
  });
});

describe('database guards', () => {
  it('keeps occupancy sane, rooms off themselves and unreleased blocks apart', async () => {
    const h = await makeHotel(db, now);
    const type = await makeRoomType(db, h.p1);
    await expectViolation(
      db.roomType.update({ where: { id: type.id }, data: { baseOccupancy: 3, maxOccupancy: 2 } }),
      SQLSTATE.CHECK,
      'room_types_occupancy_check',
    );
    const room = await makeRoom(db, type);
    await expectViolation(
      db.room.update({ where: { id: room.id }, data: { connectingRoomId: room.id } }),
      SQLSTATE.CHECK,
      'rooms_connecting_not_self_check',
    );
    const block = (start: string, end: string, releasedAt: Date | null = null) =>
      db.roomBlock.create({
        data: {
          propertyId: h.p1.id,
          roomId: room.id,
          kind: 'OUT_OF_ORDER',
          startDate: new Date(start),
          endDate: new Date(end),
          reason: 'x',
          createdById: h.owner.id,
          releasedAt,
        },
      });
    await expectViolation(
      block('2026-11-10', '2026-11-10'),
      SQLSTATE.CHECK,
      'room_blocks_dates_check',
    );
    await block('2026-11-10', '2026-11-12');
    await expectViolation(
      block('2026-11-11', '2026-11-13'),
      SQLSTATE.EXCLUSION,
      'room_blocks_no_overlap',
    );
    // Released blocks don't count.
    await block('2026-11-11', '2026-11-13', now);
    // A room of another property can't be blocked here (composite key).
    const elsewhere = await makeRoom(db, await makeRoomType(db, h.p2));
    await expectViolation(
      db.roomBlock.create({
        data: {
          propertyId: h.p1.id,
          roomId: elsewhere.id,
          kind: 'OUT_OF_ORDER',
          startDate: new Date('2026-11-20'),
          endDate: new Date('2026-11-21'),
          reason: 'x',
          createdById: h.owner.id,
        },
      }),
      SQLSTATE.FOREIGN_KEY,
      'room_blocks_property_id_room_id_fkey',
    );
  });
});
