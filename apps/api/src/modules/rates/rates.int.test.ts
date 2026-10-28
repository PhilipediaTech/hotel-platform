import { splitPackage } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectViolation, resetDb, SQLSTATE, testDb } from '../../../test/db.ts';
import { makeRoomType } from '../../../test/factories.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

// Rate plans, rate calendar, restrictions, cancellation policies and packages (PRD M2-04–
// M2-08, M2 rules 3 and 6; tab 4 row "Rates"; T-033).

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const TODAY = '2026-11-10'; // a Tuesday

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Plan = { id: string; version: number; kind: string; components: { name: string }[] };
type Day = {
  roomTypeId: string;
  date: string;
  amountMinor: string | null;
  ownAmountMinor: string | null;
  minStay: number | null;
  closedToArrival: boolean;
  stopSell: boolean;
  ruleVersion: number | null;
};

async function hotel() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId, clock));
  const gm = await as(h.gm.id);
  const std = await makeRoomType(db, h.p1, { code: 'STD', name: 'Standard' });
  const dlx = await makeRoomType(db, h.p1, { code: 'DLX', name: 'Deluxe' });
  const policy = await gm.post('/cancellation-policies', {
    name: 'Flexible',
    rules: [{ daysBefore: 1, feeType: 'NIGHTS', value: 1 }],
    noShowFee: { feeType: 'NIGHTS', value: 1 },
  });
  expect(policy.status).toBe(201);
  const policyId = (policy.body as { id: string }).id;
  const plan = async (extra: object) => {
    const res = await gm.post('/rate-plans', { cancellationPolicyId: policyId, ...extra });
    return res;
  };
  const bar = (await plan({ code: 'BAR', name: 'Best available', kind: 'BAR' })).body as Plan;
  const setRates = (body: object) => gm.put('/rate-calendar', body);
  const calendar = async (ratePlanId: string, from = TODAY, to = '2026-11-16') =>
    (
      (await gm.get(`/rate-calendar?ratePlanId=${ratePlanId}&from=${from}&to=${to}`)).body as {
        days: Day[];
      }
    ).days;
  return { ...h, as, gm, std, dlx, policyId, plan, bar, setRates, calendar };
}

const issuesOf = (res: { body: unknown }) =>
  (errorOf(res).details?.['issues'] as { path: string }[]).map((i) => i.path);
const audit = (action: string) =>
  db.auditEvent.findMany({ where: { action }, orderBy: { id: 'asc' } });

describe('cancellation policies', () => {
  it('stores rules longest notice first, audited', async () => {
    const h = await hotel();
    const res = await h.gm.post('/cancellation-policies', {
      name: 'Non-refundable after 7 days',
      rules: [
        { daysBefore: 1, feeType: 'PERCENT', value: 100 },
        { daysBefore: 7, feeType: 'NIGHTS', value: 1 },
      ],
      noShowFee: { feeType: 'PERCENT', value: 100 },
    });
    expect(res.status).toBe(201);
    expect(
      (res.body as { rules: { daysBefore: number }[] }).rules.map((r) => r.daysBefore),
    ).toEqual([7, 1]);
    expect((await audit('cancellationpolicy.created')).length).toBe(2);
    expect(
      issuesOf(
        await h.gm.post('/cancellation-policies', {
          name: 'Bad',
          rules: [],
          noShowFee: { feeType: 'NIGHTS', value: 31 },
        }),
      ),
    ).toEqual(['body.noShowFee.value']);
  });
});

describe('rate plans (M2-05, M2-08)', () => {
  it('creates a BAR plan in the property currency with an ETag', async () => {
    const h = await hotel();
    expect(h.bar).toMatchObject({
      code: 'BAR',
      kind: 'BAR',
      currency: 'NGN',
      mealPlan: 'ROOM_ONLY',
      guarantee: 'NONE',
      roundingMinor: '10000',
      roomTypeIds: [],
      version: 0,
      components: [],
    });
    const [event] = await audit('rateplan.created');
    expect(event?.after).toMatchObject({ planCode: 'BAR', kind: 'BAR' });
  });

  it('checks each kind’s fields', async () => {
    const h = await hotel();
    const refused = async (extra: object) => issuesOf(await h.plan({ name: 'X', ...extra }));
    expect(await refused({ code: 'NEG', kind: 'NEGOTIATED' })).toEqual(['body.kind']);
    expect(await refused({ code: 'D1', kind: 'DERIVED', derivationBps: -1000 })).toEqual([
      'body.derivationBps',
    ]);
    expect(
      await refused({ code: 'B2', kind: 'BAR', parentRatePlanId: h.bar.id, derivationBps: -500 }),
    ).toEqual(['body.parentRatePlanId']);
    expect(await refused({ code: 'DU', kind: 'DAY_USE' })).toEqual(['body.dayUseMaxMinutes']);
    expect(await refused({ code: 'BAR', kind: 'BAR' })).toEqual(['body.code']);
    // A derived plan can't hang off another derived plan.
    const corp = (
      await h.plan({
        code: 'CORP',
        name: 'Corporate',
        kind: 'DERIVED',
        parentRatePlanId: h.bar.id,
        derivationBps: -1000,
      })
    ).body as Plan;
    expect(
      await refused({
        code: 'D2',
        kind: 'DERIVED',
        parentRatePlanId: corp.id,
        derivationBps: -500,
      }),
    ).toEqual(['body.parentRatePlanId']);
    // Day-use: price of its own and a longest stay.
    const day = await h.plan({
      code: 'DAY',
      name: 'Day use',
      kind: 'DAY_USE',
      dayUseMaxMinutes: 360,
    });
    expect(day.status).toBe(201);
  });

  it('changes a plan with its version; a stale version or orphaning children is refused', async () => {
    const h = await hotel();
    await h.plan({
      code: 'CORP',
      name: 'Corporate',
      kind: 'DERIVED',
      parentRatePlanId: h.bar.id,
      derivationBps: -1000,
    });
    const ok = await h.gm
      .patch(`/rate-plans/${h.bar.id}`, { roundingMinor: '100000', isPublic: true })
      .set('If-Match', '"0"');
    expect(ok.status).toBe(200);
    expect(ok.headers['etag']).toBe('"1"');
    const [event] = await audit('rateplan.updated');
    expect(event).toMatchObject({
      before: { roundingMinor: '10000', isPublic: false },
      after: { roundingMinor: '100000', isPublic: true },
    });
    const stale = await h.gm.patch(`/rate-plans/${h.bar.id}`, { name: 'X' }).set('If-Match', '"0"');
    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    const orphan = await h.gm
      .patch(`/rate-plans/${h.bar.id}`, { active: false })
      .set('If-Match', '"1"');
    expect(orphan.status).toBe(409);
    expect(errorOf(orphan).details).toEqual({ activeChildren: 1 });
  });
});

describe('rate calendar and bulk edit (M2-04, M2-06)', () => {
  it('derived plans follow BAR: −10% of ₦50,000 is ₦45,000, then ₦54,000 after BAR goes to ₦60,000', async () => {
    const h = await hotel();
    const corp = (
      await h.plan({
        code: 'CORP',
        name: 'Corporate',
        kind: 'DERIVED',
        parentRatePlanId: h.bar.id,
        derivationBps: -1000,
      })
    ).body as Plan;
    const set = (amountMinor: string) =>
      h.setRates({
        ratePlanId: h.bar.id,
        roomTypeIds: [h.std.id],
        from: TODAY,
        to: TODAY,
        set: { amountMinor },
      });
    expect((await set('5000000')).body).toEqual({ changedDays: 1 });
    const first = (await h.calendar(corp.id, TODAY, TODAY)).find((d) => d.roomTypeId === h.std.id);
    expect(first).toMatchObject({ amountMinor: '4500000', ownAmountMinor: null });

    await set('6000000');
    const after = (await h.calendar(corp.id, TODAY, TODAY)).find((d) => d.roomTypeId === h.std.id);
    expect(after?.amountMinor).toBe('5400000');
    // BAR's day got a new rule version: quotes made before keep the old one.
    const barDay = (await h.calendar(h.bar.id, TODAY, TODAY)).find(
      (d) => d.roomTypeId === h.std.id,
    );
    expect(barDay).toMatchObject({ amountMinor: '6000000', ruleVersion: 2 });
  });

  it('edits by date range and weekday, and only counts days that really change', async () => {
    const h = await hotel();
    const base = {
      ratePlanId: h.bar.id,
      roomTypeIds: [h.std.id, h.dlx.id],
      from: TODAY,
      to: '2026-11-16',
    };
    expect((await h.setRates({ ...base, set: { amountMinor: '5000000' } })).body).toEqual({
      changedDays: 14,
    });
    // Friday and Saturday dearer.
    expect(
      (await h.setRates({ ...base, weekdays: [5, 6], set: { amountMinor: '6000000' } })).body,
    ).toEqual({ changedDays: 4 });
    const std = (await h.calendar(h.bar.id)).filter((d) => d.roomTypeId === h.std.id);
    expect(std.map((d) => [d.date, d.amountMinor])).toEqual([
      ['2026-11-10', '5000000'],
      ['2026-11-11', '5000000'],
      ['2026-11-12', '5000000'],
      ['2026-11-13', '6000000'],
      ['2026-11-14', '6000000'],
      ['2026-11-15', '5000000'],
      ['2026-11-16', '5000000'],
    ]);
    // The same again changes nothing and writes no audit event.
    const events = (await audit('rates.updated')).length;
    expect(
      (await h.setRates({ ...base, weekdays: [5, 6], set: { amountMinor: '6000000' } })).body,
    ).toEqual({ changedDays: 0 });
    expect((await audit('rates.updated')).length).toBe(events);
  });

  it('sets restrictions without touching prices, and clears prices', async () => {
    const h = await hotel();
    const base = {
      ratePlanId: h.bar.id,
      roomTypeIds: [h.std.id],
      from: '2026-12-24',
      to: '2026-12-26',
    };
    await h.setRates({ ...base, set: { amountMinor: '7000000' } });
    await h.setRates({ ...base, to: '2026-12-24', set: { closedToArrival: true, minStay: 3 } });
    await h.setRates({ ...base, from: '2026-12-26', set: { stopSell: true } });
    const days = await h.calendar(h.bar.id, '2026-12-24', '2026-12-26');
    const std = days.filter((d) => d.roomTypeId === h.std.id);
    expect(std.map((d) => [d.amountMinor, d.closedToArrival, d.minStay, d.stopSell])).toEqual([
      ['7000000', true, 3, false],
      ['7000000', false, null, false],
      ['7000000', false, null, true],
    ]);
    await h.setRates({ ...base, set: { amountMinor: null } });
    const cleared = await h.calendar(h.bar.id, '2026-12-24', '2026-12-24');
    expect(cleared.find((d) => d.roomTypeId === h.std.id)).toMatchObject({
      amountMinor: null,
      closedToArrival: true,
    });
    const [event] = await audit('rates.updated');
    expect(event).toMatchObject({ entityId: h.bar.id, after: { set: { amountMinor: '7000000' } } });
  });

  it('refuses past dates, long ranges, prices on derived plans and bad stays', async () => {
    const h = await hotel();
    const corp = (
      await h.plan({
        code: 'CORP',
        name: 'Corporate',
        kind: 'DERIVED',
        parentRatePlanId: h.bar.id,
        derivationBps: -1000,
      })
    ).body as Plan;
    const base = { ratePlanId: h.bar.id, roomTypeIds: [h.std.id], from: TODAY, to: TODAY };
    expect(
      issuesOf(await h.setRates({ ...base, from: '2026-11-09', set: { stopSell: true } })),
    ).toEqual(['body.from']);
    expect(
      issuesOf(await h.setRates({ ...base, to: '2027-11-11', set: { stopSell: true } })),
    ).toEqual(['body.to']);
    expect(
      issuesOf(await h.setRates({ ...base, ratePlanId: corp.id, set: { amountMinor: '100' } })),
    ).toEqual(['body.set.amountMinor']);
    expect(issuesOf(await h.setRates({ ...base, set: { minStay: 5, maxStay: 3 } }))).toEqual([
      'body.set.maxStay',
    ]);
    await h.setRates({ ...base, set: { minStay: 5 } });
    expect(issuesOf(await h.setRates({ ...base, set: { maxStay: 3 } }))).toEqual([
      'body.set.maxStay',
    ]);
    expect(issuesOf(await h.setRates({ ...base, set: {} }))).toEqual(['body.set']);
    // Restrictions on a derived plan are its own.
    expect(
      (await h.setRates({ ...base, ratePlanId: corp.id, set: { closedToArrival: true } })).status,
    ).toBe(200);
  });

  it('only sells the plan’s room types and reads at most 62 days', async () => {
    const h = await hotel();
    const deluxeOnly = (
      await h.plan({ code: 'DLXO', name: 'Deluxe only', kind: 'BAR', roomTypeIds: [h.dlx.id] })
    ).body as Plan;
    expect(
      issuesOf(
        await h.setRates({
          ratePlanId: deluxeOnly.id,
          roomTypeIds: [h.std.id],
          from: TODAY,
          to: TODAY,
          set: { amountMinor: '100' },
        }),
      ),
    ).toEqual(['body.roomTypeIds']);
    expect(new Set((await h.calendar(deluxeOnly.id)).map((d) => d.roomTypeId))).toEqual(
      new Set([h.dlx.id]),
    );
    const long = await h.gm.get(
      `/rate-calendar?ratePlanId=${h.bar.id}&from=${TODAY}&to=2027-01-11`,
    );
    expect(issuesOf(long)).toEqual(['query.to']);
  });

  it('turns the rates setup step into a real check', async () => {
    const h = await hotel();
    const step = async () =>
      (
        (await h.gm.get(`/properties/${h.p1.id}`)).body as {
          checklist: { steps: { id: string; status: string }[] };
        }
      ).checklist.steps.find((s) => s.id === 'rates')?.status;
    expect(await step()).toBe('TODO');
    await h.setRates({
      ratePlanId: h.bar.id,
      roomTypeIds: [h.std.id],
      from: TODAY,
      to: TODAY,
      set: { amountMinor: '5000000' },
    });
    expect(await step()).toBe('DONE');
  });

  it('lets everyone read the calendar; changes need rate.manage', async () => {
    const h = await hotel();
    const fd = await h.as(h.fd.id);
    expect(
      (await fd.get(`/rate-calendar?ratePlanId=${h.bar.id}&from=${TODAY}&to=${TODAY}`)).status,
    ).toBe(200);
    const refused = await fd.put('/rate-calendar', {
      ratePlanId: h.bar.id,
      roomTypeIds: [h.std.id],
      from: TODAY,
      to: TODAY,
      set: { stopSell: true },
    });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).details).toEqual({ permission: 'rate.manage' });
  });
});

describe('packages (M2-07)', () => {
  it('sets components that split the package price into lines adding up to it', async () => {
    const h = await hotel();
    const fnb = await db.revenueCode.create({
      data: { propertyId: h.p1.id, code: 'FNB', name: 'Food and beverage', group: 'FNB' },
    });
    const vat = await db.revenueCode.create({
      data: { propertyId: h.p1.id, code: 'VAT', name: 'VAT', group: 'TAX' },
    });
    const bb = (
      await h.plan({
        code: 'BB',
        name: 'Bed and breakfast',
        kind: 'PACKAGE',
        mealPlan: 'BREAKFAST',
      })
    ).body as Plan;
    const res = await h.gm.post('/packages', {
      ratePlanId: bb.id,
      components: [
        { name: 'Breakfast', revenueCodeId: fnb.id, amountMinor: '500000', perPerson: true },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      components: [{ name: 'Breakfast', amountMinor: '500000', perPerson: true }],
    });
    const listed = (await h.gm.get('/packages')).body as { data: Plan[] };
    expect(listed.data.map((p) => p.id)).toEqual([bb.id]);

    // ₦60,000 for two: room ₦50,000 + breakfast 2 × ₦5,000.
    await h.setRates({
      ratePlanId: bb.id,
      roomTypeIds: [h.std.id],
      from: TODAY,
      to: TODAY,
      set: { amountMinor: '6000000' },
    });
    const price = (await h.calendar(bb.id, TODAY, TODAY)).find((d) => d.roomTypeId === h.std.id);
    const parts = await db.packageComponent.findMany({ where: { ratePlanId: bb.id } });
    const split = splitPackage(BigInt(price?.amountMinor ?? '0'), parts, 2);
    expect(split.roomMinor).toBe(5_000_000n);
    expect(split.roomMinor + split.components.reduce((s, c) => s + c.amountMinor, 0n)).toBe(
      6_000_000n,
    );

    expect(
      issuesOf(
        await h.gm.post('/packages', {
          ratePlanId: bb.id,
          components: [{ name: 'Tax', revenueCodeId: vat.id, amountMinor: '1' }],
        }),
      ),
    ).toEqual(['body.components']);
    expect(
      issuesOf(await h.gm.post('/packages', { ratePlanId: h.bar.id, components: [] })),
    ).toEqual(['body.ratePlanId']);
    expect((await audit('package.updated')).length).toBe(1);
  });
});

describe('database guards', () => {
  it('keeps plan kinds consistent and stays sane', async () => {
    const h = await hotel();
    const plan = (data: object) =>
      db.ratePlan.create({
        data: {
          organisationId: h.org.id,
          propertyId: h.p1.id,
          code: `X${Math.random().toString(36).slice(2, 6)}`,
          name: 'X',
          kind: 'BAR',
          cancellationPolicyId: h.policyId,
          currency: 'NGN',
          ...data,
        },
      });
    await expectViolation(plan({ kind: 'DERIVED' }), SQLSTATE.CHECK, 'rate_plans_parent_check');
    await expectViolation(plan({ kind: 'DAY_USE' }), SQLSTATE.CHECK, 'rate_plans_day_use_check');
    await expectViolation(
      db.rateDay.create({
        data: {
          propertyId: h.p1.id,
          ratePlanId: h.bar.id,
          roomTypeId: h.std.id,
          date: new Date('2026-12-01'),
          minStay: 4,
          maxStay: 2,
        },
      }),
      SQLSTATE.CHECK,
      'rate_days_stay_check',
    );
  });
});
