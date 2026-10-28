import { addDays } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultTaxes } from '../tax/defaults.ts';
import { takeInventory } from './inventory.ts';

// Availability search and quotes (PRD M2-06, M2-09, M2-10, M2 rules 1, 4–5 and acceptance;
// tab 4 POST /quotes example; T-041).

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const TODAY = '2026-11-10';
const ARRIVE = '2026-11-12';
const LEAVE = '2026-11-14';

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Plan = {
  ratePlanId: string;
  code: string;
  roomMinor: string | null;
  totalMinor: string | null;
  sellable: boolean;
  violations: { rule: string; date: string; limit?: number }[];
};
type Type = { roomTypeId: string; code: string; available: number; plans: Plan[] };

async function hotel(rooms = 3) {
  const h = await makeHotel(db, now);
  await createDefaultTaxes(db, { id: h.p1.id, country: 'NG', settings: {} }, TODAY);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId, clock));
  const gm = await as(h.gm.id);
  const ok = async <T>(res: Promise<{ status: number; body: unknown }>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body as T;
  };
  const std = await ok<{ id: string }>(gm.post('/room-types', { code: 'STD', name: 'Standard' }));
  const ste = await ok<{ id: string }>(
    gm.post('/room-types', { code: 'STE', name: 'Suite', maxOccupancy: 4 }),
  );
  const roomIds: string[] = [];
  for (let i = 1; i <= rooms; i++) {
    roomIds.push(
      (await ok<{ id: string }>(gm.post('/rooms', { number: String(100 + i), roomTypeId: std.id })))
        .id,
    );
  }
  await ok(gm.post('/rooms', { number: '301', roomTypeId: ste.id }));
  const policy = await ok<{ id: string }>(
    gm.post('/cancellation-policies', {
      name: 'Flexible',
      rules: [],
      noShowFee: { feeType: 'NIGHTS', value: 1 },
    }),
  );
  const plan = (body: object) =>
    ok<{ id: string }>(gm.post('/rate-plans', { cancellationPolicyId: policy.id, ...body }));
  const bar = await plan({ code: 'BAR', name: 'Best available', kind: 'BAR' });
  const corp = await plan({
    code: 'CORP',
    name: 'Corporate',
    kind: 'DERIVED',
    parentRatePlanId: bar.id,
    derivationBps: -1000,
  });
  const bb = await plan({
    code: 'BB',
    name: 'Bed and breakfast',
    kind: 'PACKAGE',
    parentRatePlanId: bar.id,
    derivationAmountMinor: '1000000',
    mealPlan: 'BREAKFAST',
  });
  const fnb = await db.revenueCode.findFirstOrThrow({
    where: { propertyId: h.p1.id, code: 'FNB' },
  });
  await ok(
    gm.post('/packages', {
      ratePlanId: bb.id,
      components: [
        { name: 'Breakfast', revenueCodeId: fnb.id, amountMinor: '500000', perPerson: true },
      ],
    }),
  );
  const rates = (body: object) => ok(gm.put('/rate-calendar', body));
  await rates({
    ratePlanId: bar.id,
    roomTypeIds: [std.id, ste.id],
    from: TODAY,
    to: '2026-12-31',
    set: { amountMinor: '4500000' },
  });
  const search = async (query: string) => {
    const res = await gm.get(`/availability?${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { nights: number; currency: string; roomTypes: Type[] };
  };
  const quote = (body: object) =>
    gm.post('/quotes', {
      roomTypeId: std.id,
      ratePlanId: bar.id,
      arrival: ARRIVE,
      departure: LEAVE,
      adults: 2,
      ...body,
    });
  return { ...h, as, gm, std, ste, roomIds, bar, corp, bb, rates, search, quote };
}

const planOf = (types: Type[], typeId: string, code: string) =>
  types.find((t) => t.roomTypeId === typeId)?.plans.find((p) => p.code === code);

describe('quotes (M2 rule 4; tab 4 example)', () => {
  it('prices two nights at ₦45,000 with service, VAT and consumption tax exactly as the API example', async () => {
    const h = await hotel();
    const res = await h.quote({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ratePlanId: h.bar.id,
      roomTypeId: h.std.id,
      currency: 'NGN',
      nights: [
        { date: '2026-11-12', amountMinor: '4500000', ruleVersion: 1 },
        { date: '2026-11-13', amountMinor: '4500000', ruleVersion: 1 },
      ],
      taxes: [
        { code: 'SVC', name: 'Service charge', amountMinor: '900000' },
        { code: 'VAT', name: 'VAT', amountMinor: '742500' },
        { code: 'LCT', name: 'Lagos consumption tax', amountMinor: '450000' },
      ],
      netMinor: '9000000',
      totalMinor: '11092500',
      expiresAt: '2026-11-10T09:30:00Z',
    });
    const stored = await db.quote.findUniqueOrThrow({
      where: { id: (res.body as { quoteId: string }).quoteId },
    });
    expect(stored).toMatchObject({ totalMinor: 11_092_500n, currency: 'NGN' });
    // Each night keeps the tax lines and versions it was priced with.
    const nights = stored.nights as { lines: { taxes: { versionId: string }[] }[] }[];
    expect(nights[0]?.lines[0]?.taxes.map((t) => t.versionId).every(Boolean)).toBe(true);
  });

  it('prices a package: breakfast for two posts to F&B, the room gets the rest, the total is the package price', async () => {
    const h = await hotel();
    const res = await h.quote({ ratePlanId: h.bb.id, departure: '2026-11-13' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      nights: [{ amountMinor: '5500000' }],
      netMinor: '5500000',
      totalMinor: '6778750',
    });
    const stored = await db.quote.findFirstOrThrow({ where: { ratePlanId: h.bb.id } });
    const lines = (stored.nights as { lines: { amountMinor: string }[] }[])[0]?.lines ?? [];
    expect(lines.map((l) => l.amountMinor)).toEqual(['4500000', '1000000']);
  });

  it('uses each night’s tax version: VAT 10% from the second night', async () => {
    const h = await hotel();
    const vat = await db.taxRule.findFirstOrThrow({ where: { propertyId: h.p1.id, name: 'VAT' } });
    const added = await h.gm.post(`/tax-rules/${vat.id}/versions`, {
      effectiveFrom: '2026-11-13',
      rateBps: 1000,
      basis: 'NET_PLUS_PRIOR',
      sequence: 2,
    });
    expect(added.status).toBe(201);
    const res = await h.quote({});
    // 7.5% × ₦49,500 + 10% × ₦49,500.
    expect(
      (res.body as { taxes: { code: string; amountMinor: string }[] }).taxes.find(
        (t) => t.code === 'VAT',
      ),
    ).toEqual({
      code: 'VAT',
      name: 'VAT',
      amountMinor: '866250',
    });
  });

  it('refuses restricted stays with the reasons (422) and sold-out nights (409)', async () => {
    const h = await hotel(1);
    await h.rates({
      ratePlanId: h.bar.id,
      roomTypeIds: [h.std.id],
      from: ARRIVE,
      to: ARRIVE,
      set: { minStay: 3 },
    });
    const restricted = await h.quote({});
    expect(restricted.status).toBe(422);
    expect(errorOf(restricted)).toMatchObject({
      code: 'RESTRICTION_VIOLATED',
      details: { violations: [{ rule: 'MIN_STAY', date: ARRIVE, limit: 3 }] },
    });
    await takeInventory(db, {
      propertyId: h.p1.id,
      roomTypeId: h.std.id,
      arrival: '2026-11-13',
      departure: '2026-11-14',
      field: 'sold',
    });
    const full = await h.quote({ arrival: '2026-11-13', departure: '2026-11-15' });
    expect(full.status).toBe(409);
    expect(errorOf(full)).toMatchObject({
      code: 'BOOKING_CONFLICT',
      details: { dates: ['2026-11-13'] },
    });
  });

  it('checks dates, guests and the plan', async () => {
    const h = await hotel();
    const day = await h.gm.post('/rate-plans', {
      code: 'DAY',
      name: 'Day use',
      kind: 'DAY_USE',
      dayUseMaxMinutes: 360,
      cancellationPolicyId: (await db.cancellationPolicy.findFirstOrThrow()).id,
    });
    const paths = async (body: object) =>
      ((errorOf(await h.quote(body)).details?.['issues'] ?? []) as { path: string }[]).map(
        (i) => i.path,
      );
    expect(await paths({ arrival: '2026-11-09' })).toEqual(['body.arrival']);
    expect(await paths({ departure: ARRIVE })).toEqual(['body.departure']);
    expect(await paths({ departure: addDays(ARRIVE, 61) })).toEqual(['body.departure']);
    expect(await paths({ adults: 3 })).toEqual(['body.adults']);
    expect(await paths({ ratePlanId: (day.body as { id: string }).id })).toEqual([
      'body.ratePlanId',
    ]);
  });
});

describe('availability search (M2-10, M2 rules 1 and 5)', () => {
  it('lists room types that fit the guests with rooms left and every plan’s price', async () => {
    const h = await hotel(3);
    const result = await h.search(`arrival=${ARRIVE}&departure=${LEAVE}&adults=2`);
    expect(result).toMatchObject({ nights: 2, currency: 'NGN' });
    expect(result.roomTypes.map((t) => [t.code, t.available])).toEqual([
      ['STD', 3],
      ['STE', 1],
    ]);
    expect(planOf(result.roomTypes, h.std.id, 'BAR')).toMatchObject({
      roomMinor: '9000000',
      totalMinor: '11092500',
      sellable: true,
      violations: [],
    });
    expect(planOf(result.roomTypes, h.std.id, 'CORP')).toMatchObject({
      roomMinor: '8100000',
      sellable: true,
    });
    expect(planOf(result.roomTypes, h.std.id, 'BB')).toMatchObject({
      roomMinor: '11000000',
      sellable: true,
    });
    // Three guests: only the suite fits.
    const three = await h.search(`arrival=${ARRIVE}&departure=${LEAVE}&adults=2&children=1`);
    expect(three.roomTypes.map((t) => t.code)).toEqual(['STE']);
    const one = await h.search(
      `arrival=${ARRIVE}&departure=${LEAVE}&adults=1&roomTypeId=${h.ste.id}`,
    );
    expect(one.roomTypes.map((t) => t.code)).toEqual(['STE']);
  });

  it('closed to arrival blocks arriving that day but not staying through it (PRD acceptance)', async () => {
    const h = await hotel();
    await h.rates({
      ratePlanId: h.bar.id,
      roomTypeIds: [h.std.id],
      from: '2026-11-13',
      to: '2026-11-13',
      set: { closedToArrival: true },
    });
    const through = await h.search(`arrival=2026-11-12&departure=2026-11-15&adults=2`);
    expect(planOf(through.roomTypes, h.std.id, 'BAR')).toMatchObject({
      sellable: true,
      violations: [],
    });
    const arriving = await h.search(`arrival=2026-11-13&departure=2026-11-15&adults=2`);
    expect(planOf(arriving.roomTypes, h.std.id, 'BAR')).toMatchObject({
      sellable: false,
      violations: [{ rule: 'CLOSED_TO_ARRIVAL', date: '2026-11-13' }],
    });
    // Restrictions are the plan's own: Corporate still sells.
    expect(planOf(arriving.roomTypes, h.std.id, 'CORP')?.sellable).toBe(true);
  });

  it('counts out-of-order rooms, bookings and overbooking (M2 rule 1, M2-09)', async () => {
    const h = await hotel(2);
    await h.gm.post('/room-blocks', {
      roomId: h.roomIds[0],
      kind: 'OUT_OF_ORDER',
      startDate: ARRIVE,
      endDate: LEAVE,
      reason: 'AC',
    });
    await takeInventory(db, {
      propertyId: h.p1.id,
      roomTypeId: h.std.id,
      arrival: '2026-11-13',
      departure: LEAVE,
      field: 'sold',
    });
    let result = await h.search(`arrival=${ARRIVE}&departure=${LEAVE}&adults=2`);
    expect(result.roomTypes.find((t) => t.code === 'STD')).toMatchObject({ available: 0 });
    expect(planOf(result.roomTypes, h.std.id, 'BAR')?.sellable).toBe(false);
    await h.gm.put('/inventory/overbooking', {
      roomTypeIds: [h.std.id],
      from: TODAY,
      to: '2026-11-30',
      limit: 1,
    });
    result = await h.search(`arrival=${ARRIVE}&departure=${LEAVE}&adults=2`);
    expect(result.roomTypes.find((t) => t.code === 'STD')).toMatchObject({ available: 1 });
    expect((await h.quote({})).status).toBe(201);
  });

  it('marks nights with no price and stop-sell; derived prices follow BAR changes for new quotes', async () => {
    const h = await hotel();
    await h.rates({
      ratePlanId: h.bar.id,
      roomTypeIds: [h.std.id],
      from: '2026-11-13',
      to: '2026-11-13',
      set: { amountMinor: null },
    });
    let result = await h.search(`arrival=${ARRIVE}&departure=${LEAVE}&adults=2`);
    expect(planOf(result.roomTypes, h.std.id, 'BAR')).toMatchObject({
      roomMinor: null,
      sellable: false,
      violations: [{ rule: 'NO_PRICE', date: '2026-11-13' }],
    });
    expect(planOf(result.roomTypes, h.std.id, 'CORP')?.violations).toEqual([
      { rule: 'NO_PRICE', date: '2026-11-13' },
    ]);
    await h.rates({
      ratePlanId: h.bar.id,
      roomTypeIds: [h.std.id],
      from: '2026-11-13',
      to: '2026-11-13',
      set: { amountMinor: '6000000', stopSell: true },
    });
    result = await h.search(`arrival=${ARRIVE}&departure=${LEAVE}&adults=2`);
    expect(planOf(result.roomTypes, h.std.id, 'BAR')?.violations).toEqual([
      { rule: 'STOP_SELL', date: '2026-11-13' },
    ]);
    // Corporate: ₦45,000 − 10% and ₦60,000 − 10%.
    expect(planOf(result.roomTypes, h.std.id, 'CORP')).toMatchObject({
      roomMinor: '9450000',
      sellable: true,
    });
  });

  it('needs availability.read', async () => {
    const h = await hotel(1);
    const attendant = await h.person('hk-attendant', h.p1.id);
    const res = await (
      await h.as(attendant.id)
    ).get(`/availability?arrival=${ARRIVE}&departure=${LEAVE}&adults=1`);
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ permission: 'availability.read' });
  });
});
