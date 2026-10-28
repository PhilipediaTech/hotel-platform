import { addDays, INVENTORY_DAYS } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectViolation, resetDb, SQLSTATE, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import {
  rebuildAllInventory,
  rebuildInventory,
  releaseInventory,
  takeInventory,
} from './inventory.ts';

// Room-type inventory: build, rebuild, blocks, overbooking (PRD M2 rules 1–2, M2-09,
// acceptance; tab 2 "Inventory and concurrency"; T-040).

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const TODAY = '2026-11-10';
const LAST = addDays(TODAY, INVENTORY_DAYS - 1);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Day = {
  roomTypeId: string;
  date: string;
  capacity: number;
  outOfOrder: number;
  available: number;
  overbookLimit: number;
};

async function hotel(rooms = 10) {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId, clock));
  const gm = await as(h.gm.id);
  const type = (await gm.post('/room-types', { code: 'STD', name: 'Standard' })).body as {
    id: string;
  };
  const roomIds: string[] = [];
  for (let i = 1; i <= rooms; i++) {
    const res = await gm.post('/rooms', { number: String(100 + i), roomTypeId: type.id });
    roomIds.push((res.body as { id: string }).id);
  }
  const inventory = async (from = TODAY, to = addDays(TODAY, 6)) =>
    ((await gm.get(`/inventory?from=${from}&to=${to}`)).body as { days: Day[] }).days.filter(
      (d) => d.roomTypeId === type.id,
    );
  const row = (date: string) =>
    db.roomTypeInventory.findUniqueOrThrow({
      where: {
        propertyId_roomTypeId_date: {
          propertyId: h.p1.id,
          roomTypeId: type.id,
          date: new Date(date),
        },
      },
    });
  const take = (arrival: string, departure: string, field: 'sold' | 'held' = 'sold') =>
    takeInventory(db, { propertyId: h.p1.id, roomTypeId: type.id, arrival, departure, field });
  return { ...h, as, gm, type, roomIds, inventory, row, take };
}

describe('build and rebuild', () => {
  it('keeps a row per room type and day from today for the whole horizon', async () => {
    const h = await hotel(10);
    expect(await db.roomTypeInventory.count()).toBe(INVENTORY_DAYS);
    expect(await h.row(TODAY)).toMatchObject({
      capacity: 10,
      outOfOrder: 0,
      sold: 0,
      held: 0,
      overbookLimit: 0,
    });
    expect(await h.row(LAST)).toMatchObject({ capacity: 10 });
    const days = await h.inventory();
    expect(days).toHaveLength(7);
    expect(days.every((d) => d.available === 10)).toBe(true);
  });

  it('follows rooms: deactivating and moving rooms between types', async () => {
    const h = await hotel(3);
    const dlx = (await h.gm.post('/room-types', { code: 'DLX', name: 'Deluxe' })).body as {
      id: string;
    };
    await h.gm.patch(`/rooms/${h.roomIds[0]}`, { active: false }).set('If-Match', '"0"');
    await h.gm.patch(`/rooms/${h.roomIds[1]}`, { roomTypeId: dlx.id }).set('If-Match', '"0"');
    expect((await h.row(TODAY)).capacity).toBe(1);
    const deluxe = await db.roomTypeInventory.findUniqueOrThrow({
      where: {
        propertyId_roomTypeId_date: {
          propertyId: h.p1.id,
          roomTypeId: dlx.id,
          date: new Date(TODAY),
        },
      },
    });
    expect(deluxe.capacity).toBe(1);
  });

  it('extends the horizon daily and repairs drift', async () => {
    const h = await hotel(2);
    await db.roomTypeInventory.updateMany({
      where: { date: new Date(TODAY) },
      data: { capacity: 7 },
    });
    now = new Date('2026-11-15T09:00:00Z');
    expect(await rebuildAllInventory(db, clock)).toBe(5); // five new last days
    expect(await h.row(addDays(LAST, 5))).toMatchObject({ capacity: 2 });
    // Past days are history: left as they were.
    expect((await h.row(TODAY)).capacity).toBe(7);
    await db.roomTypeInventory.updateMany({
      where: { date: new Date('2026-11-20') },
      data: { capacity: 9 },
    });
    expect(await rebuildAllInventory(db, clock)).toBe(1);
    expect((await h.row('2026-11-20')).capacity).toBe(2);
  });
});

describe('blocks (M2-03, M2 rule 2)', () => {
  it('takes out-of-order rooms out of availability; out of service stays counted', async () => {
    const h = await hotel(10);
    for (const roomId of h.roomIds.slice(0, 2)) {
      await h.gm.post('/room-blocks', {
        roomId,
        kind: 'OUT_OF_ORDER',
        startDate: TODAY,
        endDate: addDays(TODAY, 3),
        reason: 'Leak',
      });
    }
    await h.gm.post('/room-blocks', {
      roomId: h.roomIds[2],
      kind: 'OUT_OF_SERVICE',
      startDate: TODAY,
      endDate: addDays(TODAY, 3),
      reason: 'Painting',
    });
    const days = await h.inventory(TODAY, addDays(TODAY, 3));
    expect(days.map((d) => [d.outOfOrder, d.available])).toEqual([
      [2, 8],
      [2, 8],
      [2, 8],
      [0, 10],
    ]);
    const block = await db.roomBlock.findFirstOrThrow({ where: { roomId: h.roomIds[0] } });
    await h.gm.post(`/room-blocks/${block.id}/release`);
    expect((await h.row(TODAY)).outOfOrder).toBe(1);
  });

  it('10 rooms, 2 out of order, 3 sold and 1 held leaves 4 (PRD acceptance)', async () => {
    const h = await hotel(10);
    for (const roomId of h.roomIds.slice(0, 2)) {
      await h.gm.post('/room-blocks', {
        roomId,
        kind: 'OUT_OF_ORDER',
        startDate: TODAY,
        endDate: addDays(TODAY, 1),
        reason: 'x',
      });
    }
    for (let i = 0; i < 3; i++) await h.take(TODAY, addDays(TODAY, 1));
    await h.take(TODAY, addDays(TODAY, 1), 'held');
    expect((await h.inventory(TODAY, TODAY))[0]?.available).toBe(4);
    // The hold goes: 5 again.
    await releaseInventory(db, {
      propertyId: h.p1.id,
      roomTypeId: h.type.id,
      arrival: TODAY,
      departure: addDays(TODAY, 1),
      field: 'held',
    });
    expect((await h.inventory(TODAY, TODAY))[0]?.available).toBe(5);
  });

  it('refuses to take a sold room out of order or out of use', async () => {
    const h = await hotel(1);
    await h.take(addDays(TODAY, 1), addDays(TODAY, 2));
    const block = await h.gm.post('/room-blocks', {
      roomId: h.roomIds[0],
      kind: 'OUT_OF_ORDER',
      startDate: TODAY,
      endDate: addDays(TODAY, 3),
      reason: 'AC',
    });
    expect(block.status).toBe(409);
    expect(errorOf(block)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { conflicts: [{ roomTypeId: h.type.id, date: addDays(TODAY, 1) }] },
    });
    expect(await db.roomBlock.count()).toBe(0);
    const off = await h.gm
      .patch(`/rooms/${h.roomIds[0]}`, { active: false })
      .set('If-Match', '"0"');
    expect(off.status).toBe(409);
    expect((await db.room.findUniqueOrThrow({ where: { id: h.roomIds[0] } })).active).toBe(true);
  });
});

describe('taking nights and overbooking (M2-09, tab 2)', () => {
  it('overbooking limit 1 allows exactly one more booking than capacity (PRD acceptance)', async () => {
    const h = await hotel(1);
    const res = await h.gm.put('/inventory/overbooking', {
      roomTypeIds: [h.type.id],
      from: TODAY,
      to: addDays(TODAY, 30),
      limit: 1,
    });
    expect(res.body).toEqual({ changedDays: 31 });
    await h.take(TODAY, addDays(TODAY, 2));
    await h.take(TODAY, addDays(TODAY, 2));
    const third = await h.take(TODAY, addDays(TODAY, 2)).catch((e: unknown) => e);
    expect(third).toMatchObject({
      code: 'BOOKING_CONFLICT',
      details: { dates: [TODAY, addDays(TODAY, 1)] },
    });
    expect((await h.row(TODAY)).sold).toBe(2);
  });

  it('takes all nights or none, and refuses nights outside the horizon', async () => {
    const h = await hotel(1);
    await h.take(addDays(TODAY, 1), addDays(TODAY, 2));
    const err = await h.take(TODAY, addDays(TODAY, 3)).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'BOOKING_CONFLICT',
      details: { dates: [addDays(TODAY, 1)] },
    });
    // takeInventory leaves partial updates to the caller's transaction; inside one, nothing stays.
    await db
      .$transaction(async (tx) => {
        await takeInventory(tx, {
          propertyId: h.p1.id,
          roomTypeId: h.type.id,
          arrival: TODAY,
          departure: addDays(TODAY, 3),
          field: 'sold',
        });
      })
      .catch(() => undefined);
    expect((await h.row(TODAY)).sold).toBe(0);
    const late = await h.take(LAST, addDays(LAST, 2)).catch((e: unknown) => e);
    expect(late).toMatchObject({
      code: 'BOOKING_CONFLICT',
      details: { dates: [addDays(LAST, 1)] },
    });
  });

  it('refuses a lower limit than what is already sold, and checks the range', async () => {
    const h = await hotel(1);
    const set = (limit: number, from = TODAY, to = addDays(TODAY, 5)) =>
      h.gm.put('/inventory/overbooking', { roomTypeIds: [h.type.id], from, to, limit });
    await set(1);
    await h.take(addDays(TODAY, 2), addDays(TODAY, 3));
    await h.take(addDays(TODAY, 2), addDays(TODAY, 3));
    const lower = await set(0);
    expect(lower.status).toBe(409);
    expect(errorOf(lower).details).toEqual({
      conflicts: [{ roomTypeId: h.type.id, date: addDays(TODAY, 2) }],
    });
    expect((await set(0, '2026-11-09')).status).toBe(400);
    expect((await set(0, TODAY, addDays(LAST, 1))).status).toBe(400);
    const [event] = await db.auditEvent.findMany({
      where: { action: 'inventory.overbooking_set' },
    });
    expect(event?.after).toMatchObject({ limit: 1, changedDays: 6 });
  });

  it('needs rate.overbook to set limits and availability.read to look', async () => {
    const h = await hotel(1);
    const fd = await h.as(h.fd.id);
    expect((await fd.get(`/inventory?from=${TODAY}&to=${TODAY}`)).status).toBe(200);
    const refused = await fd.put('/inventory/overbooking', {
      roomTypeIds: [h.type.id],
      from: TODAY,
      to: TODAY,
      limit: 1,
    });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).details).toEqual({ permission: 'rate.overbook' });
    const long = await h.gm.get(`/inventory?from=${TODAY}&to=${addDays(TODAY, 62)}`);
    expect(long.status).toBe(400);
  });
});

describe('database guards', () => {
  it('never lets sold + held + out of order pass capacity + overbooking', async () => {
    const h = await hotel(2);
    await expectViolation(
      db.roomTypeInventory.update({
        where: {
          propertyId_roomTypeId_date: {
            propertyId: h.p1.id,
            roomTypeId: h.type.id,
            date: new Date(TODAY),
          },
        },
        data: { sold: 3 },
      }),
      SQLSTATE.CHECK,
      'inventory_within_capacity',
    );
    await expectViolation(
      db.roomTypeInventory.update({
        where: {
          propertyId_roomTypeId_date: {
            propertyId: h.p1.id,
            roomTypeId: h.type.id,
            date: new Date(TODAY),
          },
        },
        data: { overbookLimit: 51 },
      }),
      SQLSTATE.CHECK,
      'inventory_counts_check',
    );
    // Rebuilding a whole property in one go is idempotent.
    expect(await rebuildInventory(db, h.p1.id, TODAY)).toBe(0);
  });
});
