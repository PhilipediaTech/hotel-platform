import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Kitchen display (PRD M8-06 "As kitchen staff, I see tickets on a kitchen display and bump
// them when done"; S44; T-156). A restaurant with Mains (to the Kitchen display) and Drinks
// (to no display), a cashier on shift and a cook with the Kitchen role.

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Order = {
  id: string;
  unsentKitchenLines: number;
  lines: { id: string; name: string; kitchen: { station: string; sentAt: string | null } | null }[];
};
type Ticket = {
  id: string;
  label: string;
  number: number;
  station: string;
  bumpedAt: string | null;
  bumpedBy: string | null;
  cancelled: boolean;
  lines: { name: string; quantity: number; note: string | null; voided: boolean }[];
};
type Board = {
  outlets: { id: string; name: string; stations: string[] }[];
  waiting: Ticket[];
  bumped: Ticket[];
};

async function restaurant() {
  const h = await inHouse(db, clock);
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL'] } },
  });
  const code = await db.revenueCode.findFirstOrThrow({
    where: { propertyId: h.p1.id, group: 'FNB' },
  });
  type Outlet = { id: string; categories: { id: string; kitchenStation: string | null }[] };
  let outlet = await h.ok<Outlet>(h.gm.send('/outlets', { code: 'REST', name: 'Restaurant' }));
  outlet = await h.ok<Outlet>(
    h.gm.send(`/outlets/${outlet.id}/categories`, { name: 'Mains', kitchenStation: 'Kitchen' }),
  );
  outlet = await h.ok<Outlet>(
    h.gm.send(`/outlets/${outlet.id}/categories`, { name: 'Drinks', sortOrder: 1 }),
  );
  const [mains, drinks] = outlet.categories;
  expect([mains?.kitchenStation, drinks?.kitchenStation]).toEqual(['Kitchen', null]);
  const item = async (categoryId: string, name: string, priceMinor: string) => {
    const o = await h.ok<{ categories: { items: { id: string; name: string }[] }[] }>(
      h.gm.send(`/menu-categories/${categoryId}/items`, {
        name,
        priceMinor,
        revenueCodeId: code.id,
      }),
    );
    return o.categories.flatMap((c) => c.items).find((i) => i.name === name)?.id ?? '';
  };
  const jollof = await item(mains?.id ?? '', 'Jollof rice', '450000');
  const suya = await item(mains?.id ?? '', 'Suya', '300000');
  const zobo = await item(drinks?.id ?? '', 'Zobo', '150000');
  const cashierUser = await h.person('pos-cashier', h.p1.id);
  const cashier = await h.as(cashierUser.id);
  await h.ok(cashier.send('/outlet-shifts', { outletId: outlet.id, floatMinor: '0' }));
  const cookUser = await h.person('kitchen', h.p1.id);
  const cook = await h.as(cookUser.id);
  const order = (label: string) =>
    h.ok<Order>(cashier.send('/pos/orders', { outletId: outlet.id, label }));
  const add = (orderId: string, menuItemId: string, body: object = {}) =>
    h.ok<Order>(cashier.send(`/pos/orders/${orderId}/lines`, { menuItemId, ...body }));
  const send = (orderId: string) =>
    h.ok<Order>(cashier.send(`/pos/orders/${orderId}/send-to-kitchen`));
  const board = (query = '') => h.ok<Board>(cook.get(`/kitchen/tickets${query}`));
  return {
    ...h,
    outlet,
    mains,
    drinks,
    jollof,
    suya,
    zobo,
    cashier,
    cook,
    order,
    add,
    send,
    board,
  };
}

describe('kitchen display (M8-06)', () => {
  it('sends kitchen items as a ticket, shows it oldest first, and bumps it when done', async () => {
    const h = await restaurant();
    // Nothing before anything is sent; the station is known.
    expect(await h.board()).toEqual({
      outlets: [{ id: h.outlet.id, name: 'Restaurant', stations: ['Kitchen'] }],
      waiting: [],
      bumped: [],
    });
    const t4 = await h.order('Table 4');
    await h.add(t4.id, h.jollof, { quantity: 2, note: 'No pepper' });
    later(1);
    const added = await h.add(t4.id, h.zobo);
    expect(added.unsentKitchenLines).toBe(1);
    expect(added.lines.map((l) => l.kitchen)).toEqual([{ station: 'Kitchen', sentAt: null }, null]);
    const sent = await h.send(t4.id);
    expect(sent.unsentKitchenLines).toBe(0);
    expect(sent.lines[0]?.kitchen?.sentAt).not.toBeNull();
    // Sending again sends nothing more.
    await h.send(t4.id);

    later(2);
    const t7 = await h.order('Table 7');
    await h.add(t7.id, h.suya);
    await h.send(t7.id);
    // A second round on Table 4.
    later(1);
    await h.add(t4.id, h.suya);
    await h.send(t4.id);

    const board = await h.board();
    expect(board.waiting.map((t) => [t.label, t.number])).toEqual([
      ['Table 4', 1],
      ['Table 7', 1],
      ['Table 4', 2],
    ]);
    // Only the kitchen's items; the drink never goes.
    expect(board.waiting[0]?.lines).toEqual([
      {
        id: expect.any(String) as string,
        name: 'Jollof rice',
        quantity: 2,
        note: 'No pepper',
        voided: false,
      },
    ]);

    const first = board.waiting[0];
    const bumped = await h.ok<Ticket>(h.cook.send(`/kitchen/tickets/${first?.id}/bump`));
    expect(bumped.bumpedAt).not.toBeNull();
    expect(bumped.bumpedBy).toBeTruthy();
    // Twice changes nothing; recall puts it back.
    await h.ok(h.cook.send(`/kitchen/tickets/${first?.id}/bump`));
    let after = await h.board();
    expect(after.waiting).toHaveLength(2);
    expect(after.bumped.map((t) => t.id)).toEqual([first?.id]);
    await h.ok(h.cook.send(`/kitchen/tickets/${first?.id}/recall`));
    after = await h.board();
    expect(after.waiting.map((t) => t.label)).toEqual(['Table 4', 'Table 7', 'Table 4']);
    expect(after.bumped).toEqual([]);
  });

  it('sends what is left when the order is settled, and shows voided items struck through', async () => {
    const h = await restaurant();
    const o = await h.order('Counter');
    await h.add(o.id, h.jollof);
    later(1);
    const withSuya = await h.add(o.id, h.suya);
    await h.send(o.id);
    // Voided after it was sent: still on the ticket, marked.
    const suyaLine = withSuya.lines.find((l) => l.name === 'Suya');
    await h.ok(
      h.gm.send(`/pos/orders/${o.id}/lines/${suyaLine?.id}/void`, { reason: 'Guest changed mind' }),
    );
    expect((await h.board()).waiting[0]?.lines.map((l) => [l.name, l.voided])).toEqual([
      ['Jollof rice', false],
      ['Suya', true],
    ]);

    // Counter service: paid first, cooked after; settling sends what is left.
    later(1);
    const quick = await h.order('Takeaway');
    const priced = await h.add(quick.id, h.jollof);
    await h.add(quick.id, h.zobo);
    const total = await h.ok<{ totalMinor: string }>(h.cashier.get(`/pos/orders/${quick.id}`));
    await h.ok(
      h.cashier.send(`/pos/orders/${quick.id}/settle`, {
        payments: [{ method: 'CASH', amountMinor: total.totalMinor }],
      }),
    );
    expect(priced.unsentKitchenLines).toBe(1);
    const board = await h.board();
    expect(board.waiting.map((t) => [t.label, t.lines.map((l) => l.name)])).toEqual([
      ['Counter', ['Jollof rice', 'Suya']],
      ['Takeaway', ['Jollof rice']],
    ]);
    const event = await db.auditEvent.count({ where: { action: 'pos.sent_to_kitchen' } });
    expect(event).toBe(1);
  });

  it('only for kitchen staff: the cashier cannot bump, the cook cannot take orders', async () => {
    const h = await restaurant();
    expect((await h.cashier.get('/kitchen/tickets')).status).toBe(403);
    const o = await h.order('Table 1');
    await h.add(o.id, h.jollof);
    expect((await h.cook.send(`/pos/orders/${o.id}/send-to-kitchen`)).status).toBe(403);
    await h.send(o.id);
    const [ticket] = (await h.board()).waiting;
    expect((await h.cashier.send(`/kitchen/tickets/${ticket?.id}/bump`)).status).toBe(403);
    // A display another outlet doesn't have.
    const wrong = await h.cook.get(`/kitchen/tickets?outletId=${h.p1.id}`);
    expect(wrong.status).toBe(404);
    expect(errorOf(wrong).message).toBe('No kitchen display at this outlet');
    // A section taken off its display sends nothing more.
    await h.ok(h.gm.patch(`/menu-categories/${h.mains?.id}`, { kitchenStation: '' }));
    const next = await h.order('Table 2');
    const added = await h.add(next.id, h.suya);
    expect(added.unsentKitchenLines).toBe(0);
  });
});
