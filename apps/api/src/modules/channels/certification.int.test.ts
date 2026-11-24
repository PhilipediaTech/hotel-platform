import { randomUUID } from 'node:crypto';
import { addDays, INVENTORY_DAYS } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { syncConnection } from './sync.ts';

// Channex's PMS certification tests 1–10 (docs.channex.io, "PMS Certification Tests"; T-154),
// done the way a tester does them: through the same API the screens use (rate calendar,
// room blocks), then one sync run. Channex's setup: a USD property, a Twin and a Double room
// type, and a Best Available Rate (100) and a Bed & Breakfast Rate (120) for each. The tests
// are dated November 2027 to May 2028, so the clock starts on 1 January 2027 (the 500-day
// horizon then reaches 15 May 2028). Each scenario must go in one call per endpoint.

const db = testDb();
const now = new Date('2027-01-01T09:00:00Z');
const clock = () => new Date(now);
const TODAY = '2027-01-01';
const LAST = addDays(TODAY, INVENTORY_DAYS - 1);

beforeEach(async () => {
  await resetDb(db);
});

type Push = Record<string, unknown>;

/** Values in a fixed order (room type or rate plan, then date): their order in a call is free. */
const key = (v: Push) => `${String(v.roomTypeId ?? v.ratePlanId)}|${String(v.dateFrom)}`;
const byKey = (a: Push, b: Push) => key(a).localeCompare(key(b));
function sortAll<T extends Push | Push[]>(xs: T[]): T[] {
  if (xs.every((x) => Array.isArray(x))) {
    return xs.map((x) => [...(x as Push[])].sort(byKey)) as T[];
  }
  return [...(xs as Push[])].sort(byKey) as T[];
}

async function certificationHotel() {
  const h = await makeHotel(db, clock());
  await db.property.update({
    where: { id: h.p1.id },
    data: { status: 'LIVE', baseCurrency: 'USD', timeZone: 'Europe/London' },
  });
  const c = hotelClient(db, clock, h.p1.id);
  const gm = c.as(await sessionCookie(db, h.gm.id, clock));
  const ok = async <T>(res: Promise<{ status: number; body: unknown }>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body as T;
  };
  const send = (path: string, body: object) =>
    ok(gm.post(path, body).set('Idempotency-Key', randomUUID()));

  const twin = await ok<{ id: string }>(gm.post('/room-types', { code: 'TWN', name: 'Twin Room' }));
  const double = await ok<{ id: string }>(
    gm.post('/room-types', { code: 'DBL', name: 'Double Room' }),
  );
  const rooms: Record<'twin' | 'double', string[]> = { twin: [], double: [] };
  for (let i = 1; i <= 8; i++) {
    rooms.twin.push(
      (await ok<{ id: string }>(gm.post('/rooms', { number: `1${i}`, roomTypeId: twin.id }))).id,
    );
  }
  for (let i = 1; i <= 5; i++) {
    rooms.double.push(
      (await ok<{ id: string }>(gm.post('/rooms', { number: `2${i}`, roomTypeId: double.id }))).id,
    );
  }
  const policy = await ok<{ id: string }>(
    gm.post('/cancellation-policies', {
      name: 'Flexible',
      rules: [{ daysBefore: 1, feeType: 'NIGHTS', value: 1 }],
      noShowFee: { feeType: 'NIGHTS', value: 1 },
    }),
  );
  const plan = (code: string, name: string, mealPlan: string) =>
    ok<{ id: string }>(
      gm.post('/rate-plans', {
        cancellationPolicyId: policy.id,
        code,
        name,
        kind: 'BAR',
        mealPlan,
      }),
    );
  const bar = await plan('BAR', 'Best Available Rate', 'ROOM_ONLY');
  const bb = await plan('BB', 'Bed & Breakfast Rate', 'BREAKFAST');

  /** One save on the rate calendar (S13), for one plan and room type. */
  const rate = (
    planId: string,
    roomTypeId: string,
    from: string,
    to: string,
    set: Record<string, unknown>,
  ) =>
    ok(gm.put('/rate-calendar', { ratePlanId: planId, roomTypeIds: [roomTypeId], from, to, set }));
  // The default prices over the whole horizon (a save covers at most 366 days).
  for (const [p, amountMinor] of [
    [bar.id, '10000'],
    [bb.id, '12000'],
  ] as const) {
    for (const t of [twin.id, double.id]) {
      await rate(p, t, TODAY, addDays(TODAY, 365), { amountMinor });
      await rate(p, t, addDays(TODAY, 366), LAST, { amountMinor });
    }
  }

  await ok(
    gm
      .post('/channel-connection', { ratePlanIds: [bar.id, bb.id] })
      .set('Idempotency-Key', randomUUID()),
  );
  const connection = await db.channelConnection.findFirstOrThrow();
  const mappings = await db.channelMapping.findMany();
  const ext = (planId: string | null, roomTypeId: string) =>
    mappings.find((m) => m.ratePlanId === planId && m.roomTypeId === roomTypeId)?.externalId ?? '';
  const ids = {
    property: connection.externalPropertyId ?? '',
    twin: ext(null, twin.id),
    double: ext(null, double.id),
    twinBar: ext(bar.id, twin.id),
    twinBb: ext(bb.id, twin.id),
    doubleBar: ext(bar.id, double.id),
    doubleBb: ext(bb.id, double.id),
  };

  let from = c.channel.calls.length;
  /** Runs one sync (no quiet period: the scenario's edits are all made) and answers its calls. */
  const sync = async () => {
    from = c.channel.calls.length;
    expect(await syncConnection(db, c.channel, clock, connection.id, { quietMs: 0 })).toBe('SENT');
    const calls = c.channel.calls.slice(from);
    return {
      availability: calls
        .filter((x) => x.method === 'updateAvailability')
        .map((x) => [...(x.input as Push[])].sort(byKey)),
      restrictions: calls
        .filter((x) => x.method === 'updateRestrictions')
        .map((x) => [...(x.input as Push[])].sort(byKey)),
    };
  };
  const block = (roomId: string, startDate: string, endDate: string) =>
    send('/room-blocks', { roomId, kind: 'OUT_OF_ORDER', startDate, endDate, reason: 'Test' });
  return { twin, double, bar, bb, rooms, rate, block, sync, ids, connection, channel: c.channel };
}

const open = (rate: string, over: Partial<Record<string, unknown>> = {}) => ({
  rate,
  minStayArrival: 1,
  maxStay: 0,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
  ...over,
});

describe('Channex PMS certification tests 1–10', () => {
  it('passes each scenario in one call per endpoint, with the values Channex asks for', async () => {
    const h = await certificationHotel();
    const value = (ratePlanId: string, dateFrom: string, dateTo: string, rest: object) => ({
      propertyId: h.ids.property,
      ratePlanId,
      dateFrom,
      dateTo,
      ...rest,
    });

    // 1. Full sync: 500 days, one availability call (all rooms), one restrictions call (all rates).
    const full = await h.sync();
    expect(full.availability).toHaveLength(1);
    expect(full.restrictions).toHaveLength(1);
    expect(full.availability[0]).toEqual(
      sortAll([
        {
          propertyId: h.ids.property,
          roomTypeId: h.ids.twin,
          dateFrom: TODAY,
          dateTo: LAST,
          availability: 8,
        },
        {
          propertyId: h.ids.property,
          roomTypeId: h.ids.double,
          dateFrom: TODAY,
          dateTo: LAST,
          availability: 5,
        },
      ]),
    );
    expect(full.restrictions[0]).toEqual(
      sortAll([
        value(h.ids.twinBar, TODAY, LAST, open('100.00')),
        value(h.ids.twinBb, TODAY, LAST, open('120.00')),
        value(h.ids.doubleBar, TODAY, LAST, open('100.00')),
        value(h.ids.doubleBb, TODAY, LAST, open('120.00')),
      ]),
    );

    // 2. Single date, single rate: Twin BAR on 22 November 2027 at 333.
    await h.rate(h.bar.id, h.twin.id, '2027-11-22', '2027-11-22', { amountMinor: '33300' });
    const two = await h.sync();
    expect(two.availability).toEqual([]);
    expect(two.restrictions).toEqual(
      sortAll([[value(h.ids.twinBar, '2027-11-22', '2027-11-22', open('333.00'))]]),
    );

    // 3. Single date, three rates: one call.
    await h.rate(h.bar.id, h.twin.id, '2027-11-21', '2027-11-21', { amountMinor: '33300' });
    await h.rate(h.bar.id, h.double.id, '2027-11-25', '2027-11-25', { amountMinor: '44400' });
    await h.rate(h.bb.id, h.double.id, '2027-11-29', '2027-11-29', { amountMinor: '45623' });
    const three = await h.sync();
    expect(three.restrictions).toEqual(
      sortAll([
        [
          value(h.ids.twinBar, '2027-11-21', '2027-11-21', open('333.00')),
          value(h.ids.doubleBar, '2027-11-25', '2027-11-25', open('444.00')),
          value(h.ids.doubleBb, '2027-11-29', '2027-11-29', open('456.23')),
        ],
      ]),
    );

    // 4. Date ranges, three rates: one call, as ranges.
    await h.rate(h.bar.id, h.twin.id, '2027-11-01', '2027-11-10', { amountMinor: '24100' });
    await h.rate(h.bar.id, h.double.id, '2027-11-10', '2027-11-16', { amountMinor: '31266' });
    await h.rate(h.bb.id, h.double.id, '2027-11-01', '2027-11-20', { amountMinor: '11100' });
    const four = await h.sync();
    expect(four.restrictions).toEqual(
      sortAll([
        [
          value(h.ids.twinBar, '2027-11-01', '2027-11-10', open('241.00')),
          value(h.ids.doubleBar, '2027-11-10', '2027-11-16', open('312.66')),
          value(h.ids.doubleBb, '2027-11-01', '2027-11-20', open('111.00')),
        ],
      ]),
    );

    // 5. Minimum stay (counted from arrival).
    await h.rate(h.bar.id, h.twin.id, '2027-11-23', '2027-11-23', { minStay: 3 });
    await h.rate(h.bar.id, h.double.id, '2027-11-25', '2027-11-25', { minStay: 2 });
    await h.rate(h.bb.id, h.double.id, '2027-11-15', '2027-11-15', { minStay: 5 });
    const five = await h.sync();
    expect(five.restrictions).toEqual(
      sortAll([
        [
          value(h.ids.twinBar, '2027-11-23', '2027-11-23', open('100.00', { minStayArrival: 3 })),
          value(h.ids.doubleBar, '2027-11-25', '2027-11-25', open('444.00', { minStayArrival: 2 })),
          value(h.ids.doubleBb, '2027-11-15', '2027-11-15', open('111.00', { minStayArrival: 5 })),
        ],
      ]),
    );

    // 6. Stop sell.
    await h.rate(h.bar.id, h.twin.id, '2027-11-14', '2027-11-14', { stopSell: true });
    await h.rate(h.bar.id, h.double.id, '2027-11-16', '2027-11-16', { stopSell: true });
    await h.rate(h.bb.id, h.double.id, '2027-11-20', '2027-11-20', { stopSell: true });
    const six = await h.sync();
    expect(six.restrictions).toEqual(
      sortAll([
        [
          value(h.ids.twinBar, '2027-11-14', '2027-11-14', open('100.00', { stopSell: true })),
          value(h.ids.doubleBar, '2027-11-16', '2027-11-16', open('312.66', { stopSell: true })),
          value(h.ids.doubleBb, '2027-11-20', '2027-11-20', open('111.00', { stopSell: true })),
        ],
      ]),
    );

    // 7. Several restrictions over ranges: one call (each plan's dates as ranges of equal days).
    await h.rate(h.bar.id, h.twin.id, '2027-11-01', '2027-11-10', {
      closedToArrival: true,
      closedToDeparture: false,
      maxStay: 4,
      minStay: 1,
    });
    await h.rate(h.bb.id, h.twin.id, '2027-11-12', '2027-11-16', {
      closedToArrival: false,
      closedToDeparture: true,
      minStay: 6,
    });
    await h.rate(h.bar.id, h.double.id, '2027-11-10', '2027-11-16', {
      closedToArrival: true,
      minStay: 2,
    });
    await h.rate(h.bb.id, h.double.id, '2027-11-01', '2027-11-20', { minStay: 10 });
    const seven = await h.sync();
    expect(seven.restrictions).toHaveLength(1);
    const sevenValues = seven.restrictions[0] ?? [];
    expect(sevenValues).toContainEqual(
      value(
        h.ids.twinBar,
        '2027-11-01',
        '2027-11-10',
        open('241.00', { closedToArrival: true, maxStay: 4 }),
      ),
    );
    expect(sevenValues).toContainEqual(
      value(
        h.ids.twinBb,
        '2027-11-12',
        '2027-11-16',
        open('120.00', { closedToDeparture: true, minStayArrival: 6 }),
      ),
    );
    // Double BB 1–20 November: min stay 10 throughout; 20 November is still stop-sell (test 6).
    expect(sevenValues).toContainEqual(
      value(h.ids.doubleBb, '2027-11-01', '2027-11-19', open('111.00', { minStayArrival: 10 })),
    );
    expect(sevenValues).toContainEqual(
      value(
        h.ids.doubleBb,
        '2027-11-20',
        '2027-11-20',
        open('111.00', { minStayArrival: 10, stopSell: true }),
      ),
    );

    // 8. Half a year: two plans, one call.
    await h.rate(h.bar.id, h.twin.id, '2027-12-01', '2028-05-01', {
      amountMinor: '43200',
      closedToArrival: false,
      closedToDeparture: false,
      minStay: 2,
    });
    await h.rate(h.bar.id, h.double.id, '2027-12-01', '2028-05-01', {
      amountMinor: '34200',
      minStay: 3,
    });
    const eight = await h.sync();
    expect(eight.restrictions).toEqual(
      sortAll([
        [
          value(h.ids.twinBar, '2027-12-01', '2028-05-01', open('432.00', { minStayArrival: 2 })),
          value(h.ids.doubleBar, '2027-12-01', '2028-05-01', open('342.00', { minStayArrival: 3 })),
        ],
      ]),
    );

    // 9. Availability on single dates (rooms taken out of order): one call.
    await h.block(h.rooms.twin[0] ?? '', '2027-11-21', '2027-11-22');
    for (const room of h.rooms.double) await h.block(room, '2027-11-25', '2027-11-26');
    const nine = await h.sync();
    expect(nine.restrictions).toEqual([]);
    expect(nine.availability).toEqual(
      sortAll([
        [
          {
            propertyId: h.ids.property,
            roomTypeId: h.ids.twin,
            dateFrom: '2027-11-21',
            dateTo: '2027-11-21',
            availability: 7,
          },
          {
            propertyId: h.ids.property,
            roomTypeId: h.ids.double,
            dateFrom: '2027-11-25',
            dateTo: '2027-11-25',
            availability: 0,
          },
        ],
      ]),
    );

    // 10. Availability over ranges: Twin 3 from 10 to 16 November, Double 4 from 17 to 24.
    for (const room of h.rooms.twin.slice(0, 5)) await h.block(room, '2027-11-10', '2027-11-17');
    await h.block(h.rooms.double[0] ?? '', '2027-11-17', '2027-11-25');
    const ten = await h.sync();
    expect(ten.availability).toEqual(
      sortAll([
        [
          {
            propertyId: h.ids.property,
            roomTypeId: h.ids.twin,
            dateFrom: '2027-11-10',
            dateTo: '2027-11-16',
            availability: 3,
          },
          {
            propertyId: h.ids.property,
            roomTypeId: h.ids.double,
            dateFrom: '2027-11-17',
            dateTo: '2027-11-24',
            availability: 4,
          },
        ],
      ]),
    );
  });

  it('waits for edits made one after another, so they go together (test 3 done by hand)', async () => {
    const h = await certificationHotel();
    await h.sync();
    await h.rate(h.bar.id, h.twin.id, '2027-11-21', '2027-11-21', { amountMinor: '33300' });
    // Two minutes of quiet by default: the next edit is still to come.
    expect(await syncConnection(db, h.channel, clock, h.connection.id)).toBe('WAITING');
    await h.rate(h.bar.id, h.double.id, '2027-11-25', '2027-11-25', { amountMinor: '44400' });
    expect(await syncConnection(db, h.channel, clock, h.connection.id)).toBe('WAITING');
    const sent = await h.sync();
    expect(sent.restrictions).toHaveLength(1);
    expect(sent.restrictions[0]).toHaveLength(2);
  });
});
