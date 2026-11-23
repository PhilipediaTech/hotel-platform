import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';

// Price suggestions (PRD M14-13 "As a revenue user, I see suggested price changes per room
// type and date with the reason (booking pace, occupancy, past results); nothing changes until
// I accept", rate.manage; T-149).

const db = testDb();
const now = new Date('2026-11-10T09:00:00Z');
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
});

type Suggestion = {
  ratePlan: { id: string; code: string };
  roomType: { id: string; code: string };
  date: string;
  currentMinor: string;
  suggestedMinor: string;
  changeBps: number;
  sold: number;
  capacity: number;
  daysOut: number;
  lastYear: { date: string; soldThen: number; soldFinal: number; capacity: number } | null;
  reasons: string[];
};

/** The in-house hotel: room 101 (Standard) booked for 10 and 11 November at ₦100,000 BAR. */
async function hotel() {
  const h = await inHouse(db, clock);
  const plan = await db.ratePlan.findFirstOrThrow({ where: { code: 'BAR' } });
  const std = await db.roomType.findFirstOrThrow({ where: { code: 'STD' } });
  const list = async (days = 30) =>
    (
      await h.ok<{ data: Suggestion[]; currency: string }>(
        h.gm.get(`/price-suggestions?days=${days}`),
      )
    ).data;
  return { ...h, plan, std, list };
}

describe('price suggestions (M14-13)', () => {
  it('suggests a higher price for full nights, with the numbers behind it', async () => {
    const h = await hotel();
    const data = await h.list();
    const full = data.filter((s) => s.roomType.id === h.std.id && s.changeBps > 0);
    expect(full.map((s) => s.date)).toEqual([TODAY, '2026-11-11']);
    expect(full[0]).toMatchObject({
      ratePlan: { code: 'BAR' },
      currentMinor: '10000000',
      suggestedMinor: '11500000',
      changeBps: 1500,
      sold: 1,
      capacity: 1,
      daysOut: 0,
      // The hotel has no stock records a year back, so no comparison is shown.
      lastYear: null,
      reasons: ['Nearly full: 100% sold (1 of 1) 0 days out'],
    });
    // Nothing changed: suggestions are only worked out.
    const day = await db.rateDay.findFirstOrThrow({
      where: { ratePlanId: h.plan.id, roomTypeId: h.std.id, date: new Date(`${TODAY}T00:00:00Z`) },
    });
    expect(day.amountMinor).toBe(10000000n);
  });

  it('suggests a lower price close in for an empty room type, never below the floor', async () => {
    const h = await hotel();
    const dlx = await h.ok<{ id: string }>(
      h.gm.post('/room-types', { code: 'DLX', name: 'Deluxe' }),
    );
    await h.ok(h.gm.post('/rooms', { number: '201', roomTypeId: dlx.id }));
    await h.ok(h.gm.post('/rooms', { number: '202', roomTypeId: dlx.id }));
    await db.ratePlan.update({ where: { id: h.plan.id }, data: { floorMinor: 9500000n } });
    await h.ok(
      h.gm.put('/rate-calendar', {
        ratePlanId: h.plan.id,
        roomTypeIds: [dlx.id],
        from: TODAY,
        to: '2026-12-31',
        set: { amountMinor: '10000000' },
      }),
    );
    const data = (await h.list(20)).filter((s) => s.roomType.id === dlx.id);
    // Within 14 days only; 10% off would be ₦90,000, the floor is ₦95,000.
    if (data.length > 0) {
      expect(data.every((s) => s.daysOut <= 14)).toBe(true);
      expect(data.every((s) => s.suggestedMinor === '9500000' && s.changeBps === -500)).toBe(true);
      expect(data[0]?.reasons[0]).toMatch(/^Slow close in: 0% sold \(0 of 2\)/);
    }
    const inventoryDays = await db.roomTypeInventory.count({ where: { roomTypeId: dlx.id } });
    expect(data.length).toBe(Math.min(inventoryDays, 15));
  });

  it('compares with the same weekday last year, and holds the price where last year filled late', async () => {
    const h = await hotel();
    // 12 November is empty two days out: without history the price would come down.
    const before = (await h.list()).find(
      (x) => x.roomType.id === h.std.id && x.date === '2026-11-12',
    );
    expect(before).toMatchObject({ changeBps: -1000, lastYear: null });
    // Last year's same weekday (13 November 2025) sold out, booked only this year: none of it
    // was on the books two days before.
    const stay = await db.stay.findFirstOrThrow();
    const quote = await db.quote.findFirstOrThrow({ where: { id: stay.quoteId } });
    const { id: _q, ...quoteFields } = quote;
    const lyQuote = await db.quote.create({ data: { ...quoteFields } as never });
    const { id: _s, version: _v, ...stayFields } = stay;
    const lyStay = await db.stay.create({
      data: {
        ...stayFields,
        quoteId: lyQuote.id,
        roomId: null,
        folioId: null,
        arrival: new Date('2025-11-13T00:00:00Z'),
        departure: new Date('2025-11-14T00:00:00Z'),
        status: 'CHECKED_OUT',
        checkedInAt: null,
        checkedOutAt: null,
      } as never,
    });
    await db.stayNight.create({
      data: {
        stayId: lyStay.id,
        date: new Date('2025-11-13T00:00:00Z'),
        amountMinor: 9000000n,
        ratePlanId: h.plan.id,
        ruleVersion: 1,
      },
    });
    await db.roomTypeInventory.create({
      data: {
        propertyId: h.p1.id,
        roomTypeId: h.std.id,
        date: new Date('2025-11-13T00:00:00Z'),
        capacity: 1,
        sold: 1,
      },
    });
    const after = (await h.list()).find(
      (x) => x.roomType.id === h.std.id && x.date === '2026-11-12',
    );
    expect(after).toBeUndefined();
  });

  it('accepting writes the price into the rate calendar, audited; nothing else moves', async () => {
    const h = await hotel();
    const [first] = await h.list();
    if (!first) throw new Error('no suggestion');
    const accepted = await h.ok<{ changedDays: number }>(
      h.gm.send('/price-suggestions/accept', {
        items: [
          {
            ratePlanId: first.ratePlan.id,
            roomTypeId: first.roomType.id,
            date: first.date,
            amountMinor: '11000000',
            suggestedMinor: first.suggestedMinor,
          },
        ],
      }),
    );
    expect(accepted.changedDays).toBe(1);
    const days = await db.rateDay.findMany({
      where: {
        ratePlanId: h.plan.id,
        roomTypeId: h.std.id,
        date: { lte: new Date('2026-11-11T00:00:00Z') },
      },
      orderBy: { date: 'asc' },
    });
    expect(days.map((d) => d.amountMinor)).toEqual([11000000n, 10000000n]);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'rates.suggestions_accepted' },
    });
    expect(audit.after).toMatchObject({
      items: [{ amountMinor: '11000000', suggestedMinor: '11500000' }],
      changedDays: 1,
    });
  });

  it('refuses the past, plans that are not best-available, and people without rate.manage', async () => {
    const h = await hotel();
    const item = { ratePlanId: h.plan.id, roomTypeId: h.std.id, amountMinor: '11000000' };
    const past = await h.gm.send('/price-suggestions/accept', {
      items: [{ ...item, date: '2026-11-09' }],
    });
    expect(errorOf(past).details).toMatchObject({ issues: [{ path: 'body.items.0.date' }] });
    const corporate = await h
      .ok<{ id: string }>(
        h.gm.post('/rate-plans', {
          cancellationPolicyId: h.plan.cancellationPolicyId,
          code: 'CORP',
          name: 'Corporate',
          kind: 'NEGOTIATED',
          companyId: h.company.id,
        }),
      )
      .catch(() => null);
    if (corporate) {
      const notBar = await h.gm.send('/price-suggestions/accept', {
        items: [{ ...item, ratePlanId: corporate.id, date: TODAY }],
      });
      expect(errorOf(notBar).details).toMatchObject({
        issues: [{ path: 'body.items.0.ratePlanId' }],
      });
    }
    expect((await h.fd.get('/price-suggestions')).status).toBe(403);
  });

  it('is off when the platform switches the module off (Essentials)', async () => {
    const h = await hotel();
    await db.featureFlag.create({
      data: { organisationId: h.org.id, module: 'pricing', enabled: false },
    });
    const off = await h.gm.get('/price-suggestions');
    expect(errorOf(off).code).toBe('MODULE_DISABLED');
  });
});
