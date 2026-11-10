import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';
import { createDefaultTaxes } from '../tax/defaults.ts';
import { releaseDueBlocks } from './service.ts';

// Group blocks and allotments (PRD M3-17 "group blocks with rooming list, pick-up and release
// date"; M2-12 "allotments with release days"; M2 rule 1 "sellable … allocated (… group blocks
// not released)"; T-123). The hotel has 4 Standard rooms.

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const TODAY = '2026-11-10';
const ARRIVE = '2026-11-20';
const LEAVE = '2026-11-23';

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Night = {
  roomTypeId: string;
  date: string;
  rooms: number;
  pickedUp: number;
  remaining: number;
  released: boolean;
};
type Block = {
  id: string;
  status: string;
  nights: Night[];
  rooming: { guestName: string; confirmationNo: string }[];
  roomTypes: { rooms: number; pickedUp: number }[];
};

async function hotel() {
  const h = await makeHotel(db, now);
  await db.property.update({ where: { id: h.p1.id }, data: { status: 'LIVE' } });
  await createDefaultTaxes(db, { id: h.p1.id, country: 'NG', settings: {} }, TODAY);
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => {
    const client = c.as(await sessionCookie(db, userId, clock));
    return {
      ...client,
      send: (path: string, body?: object) =>
        client.post(path, body).set('Idempotency-Key', randomUUID()),
    };
  };
  const gm = await as(h.gm.id);
  const fd = await as(h.fd.id);
  const ok = async <T>(res: Promise<{ status: number; body: unknown }>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body as T;
  };
  const std = await ok<{ id: string }>(gm.post('/room-types', { code: 'STD', name: 'Standard' }));
  for (let i = 1; i <= 4; i++) {
    await ok(gm.post('/rooms', { number: String(100 + i), roomTypeId: std.id }));
  }
  const policy = await ok<{ id: string }>(
    gm.post('/cancellation-policies', {
      name: 'Two days',
      rules: [{ daysBefore: 2, feeType: 'NIGHTS', value: 1 }],
      noShowFee: { feeType: 'NIGHTS', value: 1 },
    }),
  );
  const plan = async (code: string, amountMinor: string) => {
    const p = await ok<{ id: string }>(
      gm.post('/rate-plans', {
        cancellationPolicyId: policy.id,
        code,
        name: code,
        kind: 'BAR',
      }),
    );
    await ok(
      gm.put('/rate-calendar', {
        ratePlanId: p.id,
        roomTypeIds: [std.id],
        from: TODAY,
        to: '2026-12-31',
        set: { amountMinor },
      }),
    );
    return p.id;
  };
  const bar = await plan('BAR', '4500000');
  const groupRate = await plan('GRP', '3500000');
  const agent = await db.company.create({
    data: { organisationId: h.org.id, kind: 'TRAVEL_AGENT', name: 'Wakanow' },
  });
  const blockBody = (over: object = {}) => ({
    code: 'OBI-WED',
    name: 'Obi wedding guests',
    ratePlanId: groupRate,
    arrival: ARRIVE,
    departure: LEAVE,
    releaseDate: '2026-11-15',
    rooms: [{ roomTypeId: std.id, count: 3 }],
    ...over,
  });
  const inventory = async (date: string) =>
    db.roomTypeInventory.findFirstOrThrow({
      where: { roomTypeId: std.id, date: new Date(`${date}T00:00:00Z`) },
    });
  const book = async (over: { ratePlanId?: string; groupBlockId?: string | null } = {}) => {
    const q = await ok<{ quoteId: string }>(
      fd.post('/quotes', {
        roomTypeId: std.id,
        ratePlanId: over.ratePlanId ?? groupRate,
        arrival: ARRIVE,
        departure: LEAVE,
        adults: 1,
      }),
    );
    return fd.send('/reservations', {
      source: 'PHONE',
      booker: { firstName: 'Ngozi', lastName: `Guest ${randomUUID().slice(0, 4)}` },
      groupBlockId: over.groupBlockId ?? null,
      stays: [{ quoteId: q.quoteId }],
    });
  };
  return {
    ...h,
    gmId: h.gm.id,
    gm,
    fd,
    ok,
    as,
    std,
    bar,
    groupRate,
    agent,
    blockBody,
    inventory,
    book,
  };
}

describe('group blocks hold rooms (M3-17, M2 rule 1)', () => {
  it('holds the rooms on every night, so they are no longer for sale', async () => {
    const h = await hotel();
    const block = await h.ok<Block>(h.gm.send('/group-blocks', h.blockBody()));
    expect(block.status).toBe('ACTIVE');
    expect(block.nights.map((n) => [n.date, n.rooms, n.remaining])).toEqual([
      ['2026-11-20', 3, 3],
      ['2026-11-21', 3, 3],
      ['2026-11-22', 3, 3],
    ]);
    expect((await h.inventory('2026-11-20')).held).toBe(3);
    // One room is left to sell: after one general booking, the next can't even be priced.
    await h.ok(h.book({ ratePlanId: h.bar }));
    const full = await h.fd.post('/quotes', {
      roomTypeId: h.std.id,
      ratePlanId: h.bar,
      arrival: ARRIVE,
      departure: LEAVE,
      adults: 1,
    });
    expect(full.status).toBe(409);
    expect(errorOf(full).code).toBe('BOOKING_CONFLICT');
  });

  it('refuses to hold more rooms than there are, naming the nights', async () => {
    const h = await hotel();
    const refused = await h.gm.send(
      '/group-blocks',
      h.blockBody({ rooms: [{ roomTypeId: h.std.id, count: 5 }] }),
    );
    expect(refused.status).toBe(409);
    expect(errorOf(refused).details?.['nights']).toHaveLength(3);
    expect(await db.groupBlock.count()).toBe(0);
    expect((await h.inventory('2026-11-20')).held).toBe(0);
  });

  it('checks the release date, the rate plan and the code', async () => {
    const h = await hotel();
    const path = async (over: object) =>
      (
        errorOf(await h.gm.send('/group-blocks', h.blockBody(over))).details as {
          issues: { path: string }[];
        }
      ).issues[0]?.path;
    expect(await path({ releaseDate: null })).toBe('body.releaseDate');
    expect(await path({ releaseDate: '2026-11-21' })).toBe('body.releaseDate');
    expect(await path({ releaseDate: '2026-11-09' })).toBe('body.releaseDate');
    expect(await path({ ratePlanId: randomUUID() })).toBe('body.ratePlanId');
    await h.ok(h.gm.send('/group-blocks', h.blockBody()));
    expect(errorOf(await h.gm.send('/group-blocks', h.blockBody())).message).toContain(
      'already has the code',
    );
  });
});

describe('pick-up and rooming list (M3-17)', () => {
  it('a booking against the block takes from it, at its rate, and is on the rooming list', async () => {
    const h = await hotel();
    const block = await h.ok<Block>(h.gm.send('/group-blocks', h.blockBody()));
    await h.ok(h.book({ groupBlockId: block.id }));
    const inv = await h.inventory('2026-11-21');
    expect([inv.held, inv.sold]).toEqual([2, 1]);
    const after = await h.ok<Block>(h.gm.get(`/group-blocks/${block.id}`));
    expect(after.nights.every((n) => n.pickedUp === 1 && n.remaining === 2)).toBe(true);
    expect(after.rooming).toHaveLength(1);
    expect(after.roomTypes[0]).toMatchObject({ rooms: 3, pickedUp: 1 });
    const wrongRate = await h.book({ groupBlockId: block.id, ratePlanId: h.bar });
    expect(wrongRate.status).toBe(400);
  });

  it('picking up more than the block holds takes from what is for sale', async () => {
    const h = await hotel();
    const block = await h.ok<Block>(
      h.gm.send('/group-blocks', h.blockBody({ rooms: [{ roomTypeId: h.std.id, count: 1 }] })),
    );
    await h.ok(h.book({ groupBlockId: block.id }));
    await h.ok(h.book({ groupBlockId: block.id }));
    const inv = await h.inventory('2026-11-20');
    expect([inv.held, inv.sold]).toEqual([0, 2]);
  });

  it('books a reservation for each name on the rooming list, saying which could not be', async () => {
    const h = await hotel();
    const block = await h.ok<Block>(h.gm.send('/group-blocks', h.blockBody()));
    const result = await h.ok<{
      booked: { line: number; confirmationNo: string }[];
      failed: { line: number; message: string }[];
      block: Block;
    }>(
      h.gm.post(`/group-blocks/${block.id}/rooming-list`, {
        rooms: [
          { firstName: 'Ada', lastName: 'Obi', roomTypeId: h.std.id },
          { firstName: 'Bayo', lastName: 'Ade', roomTypeId: h.std.id },
          { firstName: 'Chi', lastName: 'Eze', roomTypeId: randomUUID() },
        ],
      }),
    );
    expect(result.booked.map((b) => b.line)).toEqual([1, 2]);
    expect(result.failed.map((f) => f.line)).toEqual([3]);
    expect(result.block.rooming.map((r) => r.guestName).sort()).toEqual(['Ada Obi', 'Bayo Ade']);
    expect(result.block.nights[0]?.remaining).toBe(1);
  });
});

describe('release (M3-17, M2-12)', () => {
  it('a group gives back what is not picked up on its release date', async () => {
    const h = await hotel();
    const block = await h.ok<Block>(h.gm.send('/group-blocks', h.blockBody()));
    await h.ok(h.book({ groupBlockId: block.id }));
    now = new Date('2026-11-14T23:30:00Z'); // 00:30 on the 15th in Lagos
    expect(await releaseDueBlocks(db, clock)).toBe(3);
    const inv = await h.inventory('2026-11-20');
    expect([inv.held, inv.sold]).toEqual([0, 1]);
    const row = await db.groupBlock.findUniqueOrThrow({ where: { id: block.id } });
    expect(row.status).toBe('RELEASED');
    expect(await releaseDueBlocks(db, clock)).toBe(0);
  });

  it('an allotment gives back each night its release days before', async () => {
    const h = await hotel();
    const body = h.blockBody({
      code: 'WAKA',
      name: 'Wakanow allotment',
      companyId: h.agent.id,
      releaseDate: null,
      releaseDays: 7,
    });
    const allot = await h.ok<Block>(h.gm.send('/allotments', body));
    now = new Date('2026-11-13T09:00:00Z');
    expect(await releaseDueBlocks(db, clock)).toBe(1);
    const gm = await h.as(h.gmId);
    const after = await h.ok<Block>(gm.get(`/allotments/${allot.id}`));
    expect(after.nights.map((n) => n.released)).toEqual([true, false, false]);
    expect(after.status).toBe('ACTIVE');
    expect((await h.inventory('2026-11-20')).held).toBe(0);
    expect((await h.inventory('2026-11-21')).held).toBe(3);
    // An allotment is for a company or agent.
    const noCompany = await gm.send('/allotments', { ...body, code: 'X', companyId: null });
    expect(noCompany.status).toBe(400);
  });

  it('can be released or cancelled by hand', async () => {
    const h = await hotel();
    const block = await h.ok<Block>(h.gm.send('/group-blocks', h.blockBody()));
    const done = await h.ok<Block>(
      h.gm.post(`/group-blocks/${block.id}/release`, { cancel: true }),
    );
    expect(done.status).toBe('CANCELLED');
    expect((await h.inventory('2026-11-22')).held).toBe(0);
    expect((await h.gm.post(`/group-blocks/${block.id}/release`, {})).status).toBe(409);
    // A released block takes no more bookings.
    expect((await h.book({ groupBlockId: block.id })).status).toBe(400);
  });
});

describe('changing a block', () => {
  it('adds rooms while there are rooms, and takes away no more than are left unbooked', async () => {
    const h = await hotel();
    const block = await h.ok<Block>(
      h.gm.send('/group-blocks', h.blockBody({ rooms: [{ roomTypeId: h.std.id, count: 2 }] })),
    );
    await h.ok(h.book({ groupBlockId: block.id }));
    const update = (count: number) =>
      h.gm.put(`/group-blocks/${block.id}`, {
        code: 'OBI-WED',
        name: 'Obi wedding guests',
        ratePlanId: h.groupRate,
        releaseDate: '2026-11-15',
        rooms: [{ roomTypeId: h.std.id, count }],
      });
    const more = await h.ok<Block>(update(4));
    expect(more.nights[0]).toMatchObject({ rooms: 4, remaining: 3 });
    expect((await h.inventory('2026-11-20')).held).toBe(3);
    expect((await update(5)).status).toBe(409);
    const refused = await update(0);
    expect(refused.status).toBe(409);
    expect(errorOf(refused).message).toContain('can go down to 1');
    const fewer = await h.ok<Block>(update(1));
    expect(fewer.nights[0]).toMatchObject({ rooms: 1, remaining: 0 });
    expect((await h.inventory('2026-11-20')).held).toBe(0);
  });
});

describe('permissions', () => {
  it('group blocks need group.manage, allotments allotment.manage', async () => {
    const h = await hotel();
    expect((await h.fd.send('/group-blocks', h.blockBody())).status).toBe(403);
    expect((await h.fd.get('/allotments')).status).toBe(403);
    const sales = await h.as((await h.person('reservations', h.p1.id)).id);
    expect((await sales.send('/group-blocks', h.blockBody())).status).toBe(201);
    expect((await sales.get('/allotments')).status).toBe(403);
    expect((await h.gm.get('/allotments')).status).toBe(200);
  });
});
