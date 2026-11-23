import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

// Inventory (PRD M10-01 items, units, locations, par levels and reorder points; M10-02
// requisitions issued by the store keeper; M10-05 stocktakes with variance by item and
// location. Rules: stock quantity is the sum of stock movements, never edited directly;
// every issue has a requester and an approver. AC: on-hand equals the movement sum after any
// sequence of receipts, issues, transfers and adjustments; stocktake variance posts an
// adjustment movement with reason. T-145.)

const db = testDb();
const now = new Date('2026-11-10T09:00:00Z');
const clock = () => new Date(now);

type Item = {
  id: string;
  onHand: string;
  byLocation: { locationId: string; onHand: string }[];
  needsReorder: boolean;
  toPar: string | null;
};
type Setup = { items: Item[]; units: { id: string }[]; locations: { id: string }[] };
type Requisition = {
  id: string;
  number: number;
  status: string;
  mine: boolean;
  lines: { id: string; quantity: string; issued: string }[];
};
type Stocktake = {
  id: string;
  status: string;
  varianceMinor: string | null;
  lines: {
    item: { id: string };
    counted: string | null;
    expected: string | null;
    variance: string | null;
    varianceMinor: string | null;
  }[];
};

beforeEach(async () => {
  await resetDb(db);
});

/** A hotel with a store keeper, a second store keeper, a housekeeping supervisor and two stores. */
async function store() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => {
    const client = c.as(await sessionCookie(db, userId, clock));
    return {
      ...client,
      send: (path: string, body?: object) =>
        client.post(path, body).set('Idempotency-Key', randomUUID()),
    };
  };
  const ok = async <T>(res: Promise<{ status: number; body: unknown }>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body as T;
  };
  const keeperUser = await h.person('store-keeper', h.p1.id);
  const keeper = await as(keeperUser.id);
  const keeper2 = await as((await h.person('store-keeper', h.p1.id)).id);
  const hkUser = await h.person('hk-supervisor', h.p1.id);
  const hk = await as(hkUser.id);
  const gm = await as(h.gm.id);
  const unit = await ok<{ id: string }>(
    keeper.send('/stock-units', { code: 'btl', name: 'Bottle' }),
  );
  const kg = await ok<{ id: string }>(
    keeper.send('/stock-units', { code: 'KG', name: 'Kilogram' }),
  );
  const main = await ok<{ id: string }>(
    keeper.send('/stock-locations', { code: 'MAIN', name: 'Main store' }),
  );
  const bar = await ok<{ id: string }>(
    keeper.send('/stock-locations', { code: 'BAR', name: 'Bar store' }),
  );
  const gin = await ok<Item>(
    keeper.send('/stock-items', {
      code: 'GIN',
      name: 'Gordon’s gin 75cl',
      category: 'Spirits',
      unitId: unit.id,
      par: '24',
      reorderPoint: '6',
      unitCostMinor: '1200000',
    }),
  );
  const rice = await ok<Item>(
    keeper.send('/stock-items', {
      code: 'RICE',
      name: 'Rice',
      category: null,
      unitId: kg.id,
      par: null,
      reorderPoint: null,
      unitCostMinor: '150000',
    }),
  );
  const department = await db.department.create({
    data: { organisationId: h.org.id, propertyId: h.p1.id, code: 'HK', name: 'Housekeeping' },
  });
  const item = async (id: string) =>
    (await ok<Setup>(keeper.get('/stock-items'))).items.find((i) => i.id === id) as Item;
  const adjust = (itemId: string, locationId: string, quantity: string, reason = 'Opening stock') =>
    keeper.send('/stock-movements/adjustments', { itemId, locationId, quantity, reason });
  /** The movement sum straight from the table: the AC's "on-hand equals the movement sum". */
  const ledgerSum = async (itemId: string, locationId?: string) => {
    const sum = await db.stockMovement.aggregate({
      where: { itemId, ...(locationId ? { locationId } : {}) },
      _sum: { quantityMilli: true },
    });
    return sum._sum.quantityMilli ?? 0n;
  };
  return {
    ...h,
    ok,
    as,
    keeper,
    keeperUser,
    keeper2,
    hk,
    hkUser,
    gm,
    unit,
    main,
    bar,
    gin,
    rice,
    department,
    item,
    adjust,
    ledgerSum,
  };
}

describe('items, units and locations (M10-01)', () => {
  it('keeps items with their unit, par level and reorder point, and says when to reorder', async () => {
    const s = await store();
    expect(s.gin).toMatchObject({
      onHand: '0',
      needsReorder: true,
      toPar: '24',
      byLocation: [],
    });
    await s.ok(s.adjust(s.gin.id, s.main.id, '10'));
    expect(await s.item(s.gin.id)).toMatchObject({
      onHand: '10',
      needsReorder: false,
      toPar: '14',
    });
    await s.ok(s.adjust(s.gin.id, s.main.id, '-4', 'Two broken, two spoiled'));
    expect(await s.item(s.gin.id)).toMatchObject({ onHand: '6', needsReorder: true });

    // Codes are unique, levels make sense, and the unit must be an active one of this hotel.
    const dup = await s.keeper.send('/stock-items', {
      code: 'gin',
      name: 'Another gin',
      category: null,
      unitId: s.unit.id,
      par: null,
      reorderPoint: null,
      unitCostMinor: '0',
    });
    expect(errorOf(dup).code).toBe('VALIDATION_ERROR');
    const levels = await s.keeper.patch(`/stock-items/${s.gin.id}`, { reorderPoint: '30' });
    expect(errorOf(levels).details).toMatchObject({
      issues: [{ path: 'body.reorderPoint' }],
    });
    await s.ok(s.keeper.patch(`/stock-units/${s.unit.id}`, { active: false }));
    const offUnit = await s.keeper.send('/stock-items', {
      code: 'VODKA',
      name: 'Vodka',
      category: null,
      unitId: s.unit.id,
      par: null,
      reorderPoint: null,
      unitCostMinor: '0',
    });
    expect(errorOf(offUnit).details).toMatchObject({ issues: [{ path: 'body.unitId' }] });

    // A department can see the list to request from it, but not change it.
    expect((await s.hk.get('/stock-items')).status).toBe(200);
    const refused = await s.hk.patch(`/stock-items/${s.gin.id}`, { name: 'Mine now' });
    expect(refused.status).toBe(403);
    const audit = await db.auditEvent.findMany({
      where: { action: { startsWith: 'stock.' } },
      select: { action: true },
    });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['stock.item_created', 'stock.unit_updated', 'stock.adjusted']),
    );
  });
});

describe('on hand is the sum of movements (M10 rule and AC)', () => {
  it('after adjustments, transfers and issues, on hand per location equals the movement sum', async () => {
    const s = await store();
    await s.ok(s.adjust(s.gin.id, s.main.id, '12'));
    await s.ok(s.adjust(s.rice.id, s.main.id, '50.5'));
    await s.ok(
      s.keeper.send('/stock-movements/transfers', {
        itemId: s.gin.id,
        fromLocationId: s.main.id,
        toLocationId: s.bar.id,
        quantity: '5',
      }),
    );
    const req = await s.ok<Requisition>(
      s.hk.send('/requisitions', {
        departmentId: s.department.id,
        lines: [
          { itemId: s.gin.id, quantity: '2' },
          { itemId: s.rice.id, quantity: '7.25' },
        ],
      }),
    );
    const [ginLine, riceLine] = req.lines;
    await s.ok(
      s.keeper.send(`/requisitions/${req.id}/issue`, {
        locationId: s.main.id,
        lines: [{ lineId: riceLine?.id, quantity: '7.25' }],
      }),
    );
    await s.ok(
      s.keeper.send(`/requisitions/${req.id}/issue`, {
        locationId: s.bar.id,
        lines: [{ lineId: ginLine?.id, quantity: '2' }],
      }),
    );
    await s.ok(s.adjust(s.gin.id, s.bar.id, '-0.5', 'Spilled half a bottle'));

    const gin = await s.item(s.gin.id);
    const rice = await s.item(s.rice.id);
    expect(gin.onHand).toBe('9.5');
    expect(new Map(gin.byLocation.map((b) => [b.locationId, b.onHand]))).toEqual(
      new Map([
        [s.main.id, '7'],
        [s.bar.id, '2.5'],
      ]),
    );
    expect(rice.onHand).toBe('43.25');
    expect(await s.ledgerSum(s.gin.id)).toBe(9500n);
    expect(await s.ledgerSum(s.gin.id, s.bar.id)).toBe(2500n);
    expect(await s.ledgerSum(s.rice.id)).toBe(43250n);

    // The ledger shows every movement, newest first; a transfer is two rows.
    const ledger = await s.ok<{ data: { kind: string; quantity: string }[] }>(
      s.keeper.get(`/stock-movements?itemId=${s.gin.id}`),
    );
    expect(ledger.data.map((m) => [m.kind, m.quantity])).toEqual(
      expect.arrayContaining([
        ['ADJUSTMENT', '12'],
        ['TRANSFER', '-5'],
        ['TRANSFER', '5'],
        ['ISSUE', '-2'],
        ['ADJUSTMENT', '-0.5'],
      ]),
    );
    expect(ledger.data).toHaveLength(5);
  });

  it('never takes a location below zero', async () => {
    const s = await store();
    await s.ok(s.adjust(s.gin.id, s.main.id, '3'));
    const tooMuchOut = await s.adjust(s.gin.id, s.main.id, '-4', 'Breakage');
    expect(errorOf(tooMuchOut)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Only 3 BTL at Main store',
    });
    const tooMuchMoved = await s.keeper.send('/stock-movements/transfers', {
      itemId: s.gin.id,
      fromLocationId: s.bar.id,
      toLocationId: s.main.id,
      quantity: '1',
    });
    expect(errorOf(tooMuchMoved).message).toBe('Only 0 BTL at Bar store');
    const sameLocation = await s.keeper.send('/stock-movements/transfers', {
      itemId: s.gin.id,
      fromLocationId: s.main.id,
      toLocationId: s.main.id,
      quantity: '1',
    });
    expect(errorOf(sameLocation).code).toBe('VALIDATION_ERROR');
    const noReason = await s.adjust(s.gin.id, s.main.id, '1', '  ');
    expect(errorOf(noReason).code).toBe('VALIDATION_ERROR');
    expect(await s.ledgerSum(s.gin.id)).toBe(3000n);
  });

  it('is enforced by the database: movements are append-only and issues need two people', async () => {
    const s = await store();
    await s.ok(s.adjust(s.gin.id, s.main.id, '3'));
    const m = await db.stockMovement.findFirstOrThrow({ where: { itemId: s.gin.id } });
    await expect(
      db.stockMovement.update({ where: { id: m.id }, data: { quantityMilli: 9000n } }),
    ).rejects.toThrow();
    await expect(db.stockMovement.delete({ where: { id: m.id } })).rejects.toThrow();
    const req = await s.ok<Requisition>(
      s.hk.send('/requisitions', {
        departmentId: s.department.id,
        lines: [{ itemId: s.gin.id, quantity: '1' }],
      }),
    );
    // An issue whose requester approved it themselves is refused by the CHECK.
    await expect(
      db.stockMovement.create({
        data: {
          propertyId: s.p1.id,
          itemId: s.gin.id,
          locationId: s.main.id,
          kind: 'ISSUE',
          quantityMilli: -1000n,
          unitCostMinor: 0n,
          requisitionId: req.id,
          requisitionLineId: req.lines[0]?.id ?? '',
          byUserId: s.hkUser.id,
          requestedById: s.hkUser.id,
          approvedById: s.hkUser.id,
        },
      }),
    ).rejects.toThrow(/stock_movements_issue_check/);
  });

  it('keeps two issues racing for the last bottles from overdrawing the store', async () => {
    const s = await store();
    await s.ok(s.adjust(s.gin.id, s.main.id, '3'));
    const raise = () =>
      s.ok<Requisition>(
        s.hk.send('/requisitions', {
          departmentId: s.department.id,
          lines: [{ itemId: s.gin.id, quantity: '2' }],
        }),
      );
    const [a, b] = [await raise(), await raise()];
    const results = await Promise.all(
      [a, b].map((r) =>
        s.keeper.send(`/requisitions/${r.id}/issue`, {
          locationId: s.main.id,
          lines: [{ lineId: r.lines[0]?.id, quantity: '2' }],
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await s.ledgerSum(s.gin.id, s.main.id)).toBe(1000n);
  });
});

describe('requisitions (M10-02)', () => {
  it('a department raises one; another person issues it, in part then in full, recording both', async () => {
    const s = await store();
    await s.ok(s.adjust(s.gin.id, s.main.id, '10'));
    const req = await s.ok<Requisition>(
      s.hk.send('/requisitions', {
        departmentId: s.department.id,
        note: 'Minibar restock',
        lines: [{ itemId: s.gin.id, quantity: '6' }],
      }),
    );
    expect(req).toMatchObject({ number: 1, status: 'SUBMITTED', mine: true });
    const line = req.lines[0]?.id;
    const partial = await s.ok<Requisition>(
      s.keeper.send(`/requisitions/${req.id}/issue`, {
        locationId: s.main.id,
        lines: [{ lineId: line, quantity: '4' }],
      }),
    );
    expect(partial).toMatchObject({ status: 'PARTIAL', mine: false, lines: [{ issued: '4' }] });
    const over = await s.keeper.send(`/requisitions/${req.id}/issue`, {
      locationId: s.main.id,
      lines: [{ lineId: line, quantity: '3' }],
    });
    expect(errorOf(over).message).toBe('Only 2 still asked for');
    const done = await s.ok<Requisition>(
      s.keeper2.send(`/requisitions/${req.id}/issue`, {
        locationId: s.main.id,
        lines: [{ lineId: line, quantity: '2' }],
      }),
    );
    expect(done).toMatchObject({ status: 'ISSUED', lines: [{ issued: '6' }] });
    const issues = await db.stockMovement.findMany({
      where: { kind: 'ISSUE' },
      orderBy: { at: 'asc' },
    });
    // Every issue has its requester and its approver (M10 rule).
    expect(issues.map((m) => [m.quantityMilli, m.requestedById, m.approvedById])).toEqual([
      [-4000n, s.hkUser.id, s.keeperUser.id],
      [-2000n, s.hkUser.id, expect.any(String)],
    ]);
    expect((await s.item(s.gin.id)).onHand).toBe('4');
    const closedAlready = await s.keeper.send(`/requisitions/${req.id}/close`, { reason: 'x' });
    expect(errorOf(closedAlready).code).toBe('STATE_TRANSITION_INVALID');
  });

  it('the person who raised it can’t issue it, even holding stock.manage', async () => {
    const s = await store();
    await s.ok(s.adjust(s.gin.id, s.main.id, '10'));
    const req = await s.ok<Requisition>(
      s.keeper.send('/requisitions', {
        departmentId: s.department.id,
        lines: [{ itemId: s.gin.id, quantity: '1' }],
      }),
    );
    const own = await s.keeper.send(`/requisitions/${req.id}/issue`, {
      locationId: s.main.id,
      lines: [{ lineId: req.lines[0]?.id, quantity: '1' }],
    });
    expect(errorOf(own)).toMatchObject({ code: 'FORBIDDEN' });
    expect(await s.ledgerSum(s.gin.id)).toBe(10000n);
  });

  it('only its requester withdraws it, and only before anything is issued; the store closes with a reason', async () => {
    const s = await store();
    await s.ok(s.adjust(s.gin.id, s.main.id, '10'));
    const raise = () =>
      s.ok<Requisition>(
        s.hk.send('/requisitions', {
          departmentId: s.department.id,
          lines: [{ itemId: s.gin.id, quantity: '2' }],
        }),
      );
    const a = await raise();
    expect((await s.keeper.send(`/requisitions/${a.id}/cancel`)).status).toBe(403);
    expect(await s.ok<Requisition>(s.hk.send(`/requisitions/${a.id}/cancel`))).toMatchObject({
      status: 'CANCELLED',
    });
    const b = await raise();
    await s.ok(
      s.keeper.send(`/requisitions/${b.id}/issue`, {
        locationId: s.main.id,
        lines: [{ lineId: b.lines[0]?.id, quantity: '1' }],
      }),
    );
    expect(errorOf(await s.hk.send(`/requisitions/${b.id}/cancel`)).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    const noReason = await s.keeper.send(`/requisitions/${b.id}/close`, { reason: '' });
    expect(errorOf(noReason).code).toBe('VALIDATION_ERROR');
    expect(
      await s.ok<Requisition>(
        s.keeper.send(`/requisitions/${b.id}/close`, { reason: 'Out of stock until Friday' }),
      ),
    ).toMatchObject({ status: 'CLOSED', closeReason: 'Out of stock until Friday' });
    const list = await s.ok<{ data: Requisition[] }>(s.hk.get('/requisitions?status=CLOSED'));
    expect(list.data.map((r) => r.id)).toEqual([b.id]);
  });
});

describe('stocktakes (M10-05)', () => {
  it('counts blind, then posts each variance as an adjustment with its reason', async () => {
    const s = await store();
    await s.ok(s.adjust(s.gin.id, s.main.id, '10'));
    await s.ok(s.adjust(s.rice.id, s.main.id, '20'));
    const started = await s.ok<Stocktake>(s.keeper.send('/stocktakes', { locationId: s.main.id }));
    expect(started.lines.map((l) => l.expected)).toEqual([null, null]);
    const again = await s.keeper.send('/stocktakes', { locationId: s.main.id });
    expect(errorOf(again)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      message: 'This location is already being counted',
    });

    const counted = await s.ok<Stocktake>(
      s.keeper.put(`/stocktakes/${started.id}/counts`, {
        counts: [{ itemId: s.gin.id, counted: '8' }],
      }),
    );
    // Still blind: nothing about the books shows while counting.
    expect(counted.lines.find((l) => l.item.id === s.gin.id)).toMatchObject({
      counted: '8',
      expected: null,
      variance: null,
    });
    // Stock moves during the count: the variance is against the books when posted.
    await s.ok(s.adjust(s.gin.id, s.main.id, '1', 'Found a bottle'));

    const noReason = await s.keeper.send(`/stocktakes/${started.id}/post`, {});
    expect(errorOf(noReason).details).toMatchObject({ issues: [{ path: 'body.reason' }] });
    const posted = await s.ok<Stocktake>(
      s.keeper.send(`/stocktakes/${started.id}/post`, {
        reason: 'Bar took 3 without a requisition',
      }),
    );
    expect(posted.status).toBe('POSTED');
    expect(posted.lines.find((l) => l.item.id === s.gin.id)).toMatchObject({
      item: { id: s.gin.id },
      counted: '8',
      expected: '11',
      variance: '-3',
      varianceMinor: '-3600000',
    });
    // Rice was not counted: left as it is.
    expect(posted.lines.find((l) => l.item.id === s.rice.id)).toMatchObject({
      counted: null,
      variance: null,
    });
    expect(posted.varianceMinor).toBe('-3600000');

    const adjustment = await db.stockMovement.findFirstOrThrow({
      where: { stocktakeId: started.id },
    });
    expect(adjustment).toMatchObject({
      kind: 'ADJUSTMENT',
      quantityMilli: -3000n,
      reason: 'Stocktake 1: Bar took 3 without a requisition',
      locationId: s.main.id,
    });
    expect((await s.item(s.gin.id)).onHand).toBe('8');
    expect((await s.item(s.rice.id)).onHand).toBe('20');
    expect(await s.ledgerSum(s.gin.id)).toBe(8000n);

    const late = await s.keeper.put(`/stocktakes/${started.id}/counts`, {
      counts: [{ itemId: s.gin.id, counted: '1' }],
    });
    expect(errorOf(late).code).toBe('STATE_TRANSITION_INVALID');
    // A new count of the same location can start once this one is posted.
    expect((await s.keeper.send('/stocktakes', { locationId: s.main.id })).status).toBe(201);
  });

  it('posts nothing when the counts match, and needs no reason then', async () => {
    const s = await store();
    await s.ok(s.adjust(s.gin.id, s.bar.id, '4'));
    const t = await s.ok<Stocktake>(s.keeper.send('/stocktakes', { locationId: s.bar.id }));
    await s.ok(
      s.keeper.put(`/stocktakes/${t.id}/counts`, { counts: [{ itemId: s.gin.id, counted: '4' }] }),
    );
    const posted = await s.ok<Stocktake>(s.keeper.send(`/stocktakes/${t.id}/post`, {}));
    expect(posted).toMatchObject({ status: 'POSTED', varianceMinor: '0' });
    expect(await db.stockMovement.count({ where: { stocktakeId: t.id } })).toBe(0);
    const abandoned = await s.ok<Stocktake>(s.keeper.send('/stocktakes', { locationId: s.bar.id }));
    expect(
      await s.ok<Stocktake>(s.keeper.send(`/stocktakes/${abandoned.id}/cancel`)),
    ).toMatchObject({ status: 'CANCELLED' });
    // Departments that only request stock can't count it.
    expect((await s.hk.get('/stocktakes')).status).toBe(403);
  });
});
