import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Rate changes across properties (PRD M2-13; T-162). P1 sells BAR on its Standard rooms at
// ₦100,000; P2 gets Standard rooms at ₦80,000 and Deluxe rooms with no price yet, on its own
// BAR plan. The owner changes both at once.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Result = {
  dryRun: boolean;
  properties: { name: string; roomTypeCodes: string[]; changedDays: number }[];
  changedDays: number;
};

async function group() {
  const h = await inHouse(db, clock, { checkIn: false });
  await db.property.update({
    where: { id: h.p2.id },
    data: { status: 'LIVE', name: 'Abuja Hotel' },
  });
  await db.property.update({ where: { id: h.p1.id }, data: { name: 'Lagos Hotel' } });
  const owner = await h.as(h.owner.id);
  /** The owner working in P2. */
  const inP2 = <T extends { set: (k: string, v: string) => T }>(req: T) =>
    req.set('X-Property-Id', h.p2.id);
  const std = await h.ok<{ id: string }>(
    inP2(owner.post('/room-types', { code: 'STD', name: 'Standard' })),
  );
  await h.ok(inP2(owner.post('/room-types', { code: 'DLX', name: 'Deluxe' })));
  const policy = await h.ok<{ id: string }>(
    inP2(
      owner.post('/cancellation-policies', {
        name: 'Flexible',
        rules: [{ daysBefore: 1, feeType: 'NIGHTS', value: 1 }],
        noShowFee: { feeType: 'NIGHTS', value: 1 },
      }),
    ),
  );
  const bar2 = await h.ok<{ id: string }>(
    inP2(
      owner.post('/rate-plans', {
        cancellationPolicyId: policy.id,
        code: 'BAR',
        name: 'Best available',
        kind: 'BAR',
      }),
    ),
  );
  await h.ok(
    inP2(
      owner.put('/rate-calendar', {
        ratePlanId: bar2.id,
        roomTypeIds: [std.id],
        from: '2026-11-10',
        to: '2026-12-31',
        set: { amountMinor: '8000000' },
      }),
    ),
  );
  const bar1 = await db.ratePlan.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'BAR' } });
  const price = async (ratePlanId: string, date: string, code = 'STD') => {
    const row = await db.rateDay.findFirst({
      where: { ratePlanId, date: new Date(date), roomType: { code } },
    });
    return row?.amountMinor ?? null;
  };
  const push = (body: object, as = owner) =>
    as.send('/group/rate-changes', {
      propertyIds: [h.p1.id, h.p2.id],
      ratePlanCode: 'BAR',
      from: '2026-12-01',
      to: '2026-12-07',
      ...body,
    });
  return { ...h, ownerSession: owner, bar1, bar2, price, push };
}

describe('pushing rate changes to several properties (M2-13)', () => {
  it('previews, then moves each property’s own prices by a share', async () => {
    const h = await group();
    const preview = await h.ok<Result>(
      h.push({ price: { mode: 'PERCENT', bps: 1000 }, dryRun: true }),
    );
    expect(preview).toEqual({
      dryRun: true,
      properties: [
        expect.objectContaining({ name: 'Lagos Hotel', roomTypeCodes: ['STD'], changedDays: 7 }),
        // Deluxe has no price: it stays so.
        expect.objectContaining({
          name: 'Abuja Hotel',
          roomTypeCodes: ['DLX', 'STD'],
          changedDays: 7,
        }),
      ] as unknown[],
      changedDays: 14,
    });
    // A preview writes nothing.
    expect(await h.price(h.bar1.id, '2026-12-01')).toBe(10_000_000n);

    const done = await h.ok<Result>(h.push({ price: { mode: 'PERCENT', bps: 1000 } }));
    expect(done).toMatchObject({ dryRun: false, changedDays: 14 });
    expect(await h.price(h.bar1.id, '2026-12-01')).toBe(11_000_000n);
    expect(await h.price(h.bar2.id, '2026-12-07')).toBe(8_800_000n);
    expect(await h.price(h.bar2.id, '2026-12-01', 'DLX')).toBeNull();
    // Outside the range: as it was.
    expect(await h.price(h.bar1.id, '2026-11-30')).toBe(10_000_000n);
    expect(await h.price(h.bar2.id, '2026-12-08')).toBe(8_000_000n);
    const audit = await db.auditEvent.findMany({
      where: { action: 'rates.updated', after: { path: ['group'], equals: true } },
    });
    expect(audit.map((a) => a.propertyId).sort()).toEqual([h.p1.id, h.p2.id].sort());
    expect(audit.every((a) => a.actorUserId === h.owner.id)).toBe(true);

    // Down by an amount, on weekends, Standard rooms only.
    const weekend = await h.ok<Result>(
      h.push({
        roomTypeCodes: ['STD'],
        weekdays: [6, 7],
        price: { mode: 'AMOUNT', amountMinor: '-500000' },
      }),
    );
    // 5 and 6 December 2026 are a Saturday and Sunday.
    expect(weekend.properties.map((p) => p.changedDays)).toEqual([2, 2]);
    expect(await h.price(h.bar1.id, '2026-12-05')).toBe(10_500_000n);
    expect(await h.price(h.bar1.id, '2026-12-04')).toBe(11_000_000n);
  });

  it('sets restrictions, and one price where every property is in one currency', async () => {
    const h = await group();
    const res = await h.ok<Result>(
      h.push({
        roomTypeCodes: ['STD'],
        price: { mode: 'SET', amountMinor: '9500000' },
        restrictions: { minStay: 2, stopSell: true },
      }),
    );
    expect(res.changedDays).toBe(14);
    const day = await db.rateDay.findFirstOrThrow({
      where: { ratePlanId: h.bar2.id, date: new Date('2026-12-03'), roomType: { code: 'STD' } },
    });
    expect(day).toMatchObject({ amountMinor: 9_500_000n, minStay: 2, stopSell: true });

    // In two currencies, one price makes no sense.
    await db.property.update({ where: { id: h.p2.id }, data: { baseCurrency: 'GHS' } });
    const mixed = await h.push({ price: { mode: 'SET', amountMinor: '9000000' } });
    expect(mixed.status).toBe(400);
    expect(errorOf(mixed).details).toMatchObject({
      issues: [
        {
          path: 'body.price',
          message: 'One price for all needs properties in one currency: use a percentage instead',
        },
      ],
    });
  });

  it('refuses the whole change when any property can’t take it, naming each problem', async () => {
    const h = await group();
    const corp = await h.push({ ratePlanCode: 'CORP', price: { mode: 'PERCENT', bps: 500 } });
    expect(corp.status).toBe(400);
    expect(errorOf(corp).details).toMatchObject({
      issues: [
        { path: 'body.propertyIds.0', message: 'Lagos Hotel has no active rate plan CORP' },
        { path: 'body.propertyIds.1', message: 'Abuja Hotel has no active rate plan CORP' },
      ],
    });
    const suite = await h.push({ roomTypeCodes: ['DLX'], price: { mode: 'PERCENT', bps: 500 } });
    expect(errorOf(suite).details).toMatchObject({
      issues: [
        { path: 'body.propertyIds.0', message: 'Lagos Hotel: BAR doesn’t sell room type DLX' },
      ],
    });
    const past = await h.push({ from: '2026-11-01', price: { mode: 'PERCENT', bps: 500 } });
    expect(errorOf(past).details).toMatchObject({
      issues: [
        { message: 'Lagos Hotel: prices and restrictions change from 2026-11-10 on' },
        { message: 'Abuja Hotel: prices and restrictions change from 2026-11-10 on' },
      ],
    });
    // Nothing was written anywhere.
    expect(await h.price(h.bar1.id, '2026-12-01')).toBe(10_000_000n);
    expect(await h.price(h.bar2.id, '2026-12-01')).toBe(8_000_000n);
    expect((await h.push({})).status).toBe(400);
  });

  it('only where the caller manages group rates: a GM in their own property, never another', async () => {
    const h = await group();
    const other = await h.push({ price: { mode: 'PERCENT', bps: 500 } }, h.gm);
    expect(other.status).toBe(400);
    expect(errorOf(other).details).toMatchObject({
      issues: [
        { path: 'body.propertyIds.1', message: 'You can’t change group rates in this property' },
      ],
    });
    const own = await h.gm.send('/group/rate-changes', {
      propertyIds: [h.p1.id],
      ratePlanCode: 'BAR',
      from: '2026-12-01',
      to: '2026-12-01',
      price: { mode: 'PERCENT', bps: 500 },
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(await h.price(h.bar1.id, '2026-12-01')).toBe(10_500_000n);
    expect((await h.push({ price: { mode: 'PERCENT', bps: 500 } }, h.fd)).status).toBe(403);
  });
});
