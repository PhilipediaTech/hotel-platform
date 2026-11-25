import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Recipes (PRD M8-07 "As a manager, I link recipes to stock items so sales deplete stock";
// rule: stock is the sum of movements; T-157). A restaurant selling Jollof rice (₦4,500) and
// Zobo (₦1,500); a kitchen store with rice (₦1,500 a kg) and oil (₦3,000 a litre).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Book = {
  outlets: {
    id: string;
    stockLocation: { id: string } | null;
    items: {
      menuItemId: string;
      name: string;
      recipe: {
        lines: { name: string; quantity: string; costMinor: string }[];
        costMinor: string;
        costBps: number | null;
      } | null;
    }[];
  }[];
};
type Movement = {
  kind: string;
  quantity: string;
  reason: string | null;
  posOrderNumber: string | null;
};

async function kitchen() {
  const h = await inHouse(db, clock);
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH'] } },
  });
  const code = await db.revenueCode.findFirstOrThrow({
    where: { propertyId: h.p1.id, group: 'FNB' },
  });
  type Outlet = { id: string; categories: { id: string; items: { id: string; name: string }[] }[] };
  let outlet = await h.ok<Outlet>(h.gm.send('/outlets', { code: 'REST', name: 'Restaurant' }));
  outlet = await h.ok<Outlet>(h.gm.send(`/outlets/${outlet.id}/categories`, { name: 'Menu' }));
  const category = outlet.categories[0]?.id ?? '';
  const item = async (name: string, priceMinor: string) =>
    (
      await h.ok<Outlet>(
        h.gm.send(`/menu-categories/${category}/items`, {
          name,
          priceMinor,
          revenueCodeId: code.id,
        }),
      )
    ).categories[0]?.items.find((i) => i.name === name)?.id ?? '';
  const jollof = await item('Jollof rice', '450000');
  const zobo = await item('Zobo', '150000');
  const kg = await h.ok<{ id: string }>(
    h.gm.send('/stock-units', { code: 'KG', name: 'Kilogram' }),
  );
  const litre = await h.ok<{ id: string }>(h.gm.send('/stock-units', { code: 'L', name: 'Litre' }));
  const store = await h.ok<{ id: string }>(
    h.gm.send('/stock-locations', { code: 'KIT', name: 'Kitchen store' }),
  );
  const stock = (code: string, name: string, unitId: string, unitCostMinor: string) =>
    h.ok<{ id: string }>(
      h.gm.send('/stock-items', {
        code,
        name,
        category: null,
        unitId,
        par: null,
        reorderPoint: null,
        unitCostMinor,
      }),
    );
  const rice = await stock('RICE', 'Rice', kg.id, '150000');
  const oil = await stock('OIL', 'Vegetable oil', litre.id, '300000');
  await h.ok(
    h.gm.send('/stock-movements/adjustments', {
      itemId: rice.id,
      locationId: store.id,
      quantity: '1',
      reason: 'Opening stock',
    }),
  );
  const cashierUser = await h.person('pos-cashier', h.p1.id);
  const cashier = await h.as(cashierUser.id);
  await h.ok(cashier.send('/outlet-shifts', { outletId: outlet.id, floatMinor: '0' }));
  const sell = async (lines: { menuItemId: string; quantity: number }[], label = 'Table 1') => {
    const o = await h.ok<{ id: string; number: string }>(
      cashier.send('/pos/orders', { outletId: outlet.id, label }),
    );
    for (const l of lines) await h.ok(cashier.send(`/pos/orders/${o.id}/lines`, l));
    const { totalMinor } = await h.ok<{ totalMinor: string }>(cashier.get(`/pos/orders/${o.id}`));
    await h.ok(
      cashier.send(`/pos/orders/${o.id}/settle`, {
        payments: [{ method: 'CASH', amountMinor: totalMinor }],
      }),
    );
    return o;
  };
  const onHand = async (itemId: string) =>
    (
      await db.stockMovement.aggregate({
        where: { itemId, locationId: store.id },
        _sum: { quantityMilli: true },
      })
    )._sum.quantityMilli ?? 0n;
  const book = () => h.ok<Book>(h.gm.get('/recipes'));
  return { ...h, outlet, jollof, zobo, rice, oil, store, cashier, sell, onHand, book };
}

describe('recipes (M8-07)', () => {
  it('shows each item’s recipe cost against its price, and replaces a recipe as a whole', async () => {
    const h = await kitchen();
    const before = await h.book();
    expect(before.outlets[0]?.stockLocation).toBeNull();
    expect(before.outlets[0]?.items.map((i) => [i.name, i.recipe])).toEqual([
      ['Jollof rice', null],
      ['Zobo', null],
    ]);
    const set = await h.ok<Book>(
      h.gm.put(`/menu-items/${h.jollof}/recipe`, {
        lines: [
          { stockItemId: h.rice.id, quantity: '0.25' },
          { stockItemId: h.oil.id, quantity: '0.05' },
        ],
      }),
    );
    // 0.25 kg × ₦1,500 + 0.05 l × ₦3,000 = ₦375 + ₦150 = ₦525 of ₦4,500: 11.67%.
    expect(set.outlets[0]?.items[0]?.recipe).toEqual({
      lines: [
        {
          stockItemId: h.rice.id,
          code: 'RICE',
          name: 'Rice',
          unit: 'KG',
          quantity: '0.25',
          costMinor: '37500',
        },
        {
          stockItemId: h.oil.id,
          code: 'OIL',
          name: 'Vegetable oil',
          unit: 'L',
          quantity: '0.05',
          costMinor: '15000',
        },
      ],
      costMinor: '52500',
      costBps: 1167,
    });
    // Replaced, not added to.
    const again = await h.ok<Book>(
      h.gm.put(`/menu-items/${h.jollof}/recipe`, {
        lines: [{ stockItemId: h.rice.id, quantity: '0.3' }],
      }),
    );
    expect(again.outlets[0]?.items[0]?.recipe?.lines.map((l) => [l.name, l.quantity])).toEqual([
      ['Rice', '0.3'],
    ]);
    // No lines: no recipe.
    const cleared = await h.ok<Book>(h.gm.put(`/menu-items/${h.jollof}/recipe`, { lines: [] }));
    expect(cleared.outlets[0]?.items[0]?.recipe).toBeNull();
    expect(await db.auditEvent.count({ where: { action: 'pos.recipe_set' } })).toBe(3);

    // Refused: an item twice, zero, an unknown stock item.
    const twice = await h.gm.put(`/menu-items/${h.jollof}/recipe`, {
      lines: [
        { stockItemId: h.rice.id, quantity: '1' },
        { stockItemId: h.rice.id, quantity: '2' },
      ],
    });
    expect(twice.status).toBe(400);
    expect(
      (
        await h.gm.put(`/menu-items/${h.jollof}/recipe`, {
          lines: [{ stockItemId: h.rice.id, quantity: '0' }],
        })
      ).status,
    ).toBe(400);
    const unknown = await h.gm.put(`/menu-items/${h.jollof}/recipe`, {
      lines: [{ stockItemId: h.p1.id, quantity: '1' }],
    });
    expect(errorOf(unknown).message).toBe('Choose active stock items of this property');
  });

  it('takes the recipes of what is sold out of the outlet’s location, even below zero', async () => {
    const h = await kitchen();
    await h.ok(
      h.gm.put(`/menu-items/${h.jollof}/recipe`, {
        lines: [
          { stockItemId: h.rice.id, quantity: '0.25' },
          { stockItemId: h.oil.id, quantity: '0.05' },
        ],
      }),
    );
    // No location yet: sales use no stock.
    await h.sell([{ menuItemId: h.jollof, quantity: 1 }]);
    expect(await h.onHand(h.rice.id)).toBe(1000n);

    await h.ok(h.gm.put(`/outlets/${h.outlet.id}/stock-location`, { stockLocationId: h.store.id }));
    const order = await h.sell([
      { menuItemId: h.jollof, quantity: 2 },
      { menuItemId: h.zobo, quantity: 1 },
    ]);
    // 2 × 0.25 kg of rice; oil had none and goes below zero (the stocktake shows it).
    expect(await h.onHand(h.rice.id)).toBe(500n);
    expect(await h.onHand(h.oil.id)).toBe(-100n);
    const ledger = await h.ok<{ data: Movement[] }>(
      h.gm.get(`/stock-movements?itemId=${h.rice.id}`),
    );
    expect(ledger.data.find((m) => m.kind === 'SALE')).toMatchObject({
      kind: 'SALE',
      quantity: '-0.5',
      reason: `Sold: 2 × Jollof rice (${order.number})`,
      posOrderNumber: order.number,
    });
    // Zobo has no recipe: nothing for it.
    expect(await db.stockMovement.count({ where: { kind: 'SALE' } })).toBe(2);

    // A voided item uses nothing.
    const o = await h.ok<{ id: string; lines: { id: string; name: string }[] }>(
      h.cashier.send('/pos/orders', { outletId: h.outlet.id, label: 'Table 9' }),
    );
    const added = await h.ok<{ lines: { id: string }[] }>(
      h.cashier.send(`/pos/orders/${o.id}/lines`, { menuItemId: h.jollof, quantity: 1 }),
    );
    await h.ok(h.cashier.send(`/pos/orders/${o.id}/lines`, { menuItemId: h.zobo, quantity: 1 }));
    await h.ok(
      h.gm.send(`/pos/orders/${o.id}/lines/${added.lines[0]?.id}/void`, { reason: 'Wrong order' }),
    );
    const { totalMinor } = await h.ok<{ totalMinor: string }>(h.cashier.get(`/pos/orders/${o.id}`));
    await h.ok(
      h.cashier.send(`/pos/orders/${o.id}/settle`, {
        payments: [{ method: 'CASH', amountMinor: totalMinor }],
      }),
    );
    expect(await h.onHand(h.rice.id)).toBe(500n);
  });

  it('only for pos.recipe, and only active stock locations', async () => {
    const h = await kitchen();
    expect((await h.cashier.get('/recipes')).status).toBe(403);
    expect((await h.cashier.put(`/menu-items/${h.jollof}/recipe`, { lines: [] })).status).toBe(403);
    const bad = await h.gm.put(`/outlets/${h.outlet.id}/stock-location`, {
      stockLocationId: h.rice.id,
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad).message).toBe('Choose an active stock location of this property');
    const cleared = await h.ok<Book>(
      h.gm.put(`/outlets/${h.outlet.id}/stock-location`, { stockLocationId: null }),
    );
    expect(cleared.outlets[0]?.stockLocation).toBeNull();
  });
});
