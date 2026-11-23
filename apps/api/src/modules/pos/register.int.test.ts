import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Lite POS register (PRD M8-02 open an outlet shift with float; M8-03 tab or table, settle by
// cash, transfer, POS terminal or charge to room with the guest's signature; M8-05 close with
// counts and variance; rules: charge to room only for CHECKED_IN stays, within the folio's
// credit limit; the room charge's folio lines reference the order. AC: a room-charged order
// appears on the folio once; the outlet shift close equals the sum of settlements by method.
// T-142.)

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Order = {
  id: string;
  status: string;
  lines: { name: string; quantity: number; unitPriceMinor: string; amountMinor: string }[];
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
  payments: { method: string; amountMinor: string }[];
  room: { stayId: string; roomNumber: string | null; folioId: string } | null;
};
type Register = {
  shifts: { id: string; outletId: string; status: string; paymentCounts: unknown[] }[];
  methods: string[];
};
type Shift = {
  status: string;
  outlet: string | null;
  requiresSignOff: boolean;
  lines: { method: string; expectedMinor: string; countedMinor: string; varianceMinor: string }[];
};

/** A hotel with a Pool bar: Chapman (₦3,500, option Large +₦1,000) and Zobo, and a cashier. */
async function bar(options: { checkIn?: boolean } = {}) {
  const h = await inHouse(db, clock, options);
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL'] } },
  });
  const code = await db.revenueCode.findFirstOrThrow({
    where: { propertyId: h.p1.id, group: 'FNB' },
  });
  type Outlet = {
    id: string;
    categories: {
      id: string;
      items: { id: string; name: string; modifiers: { id: string }[] }[];
    }[];
  };
  let outlet = await h.ok<Outlet>(h.gm.send('/outlets', { code: 'POOL', name: 'Pool bar' }));
  outlet = await h.ok<Outlet>(h.gm.send(`/outlets/${outlet.id}/categories`, { name: 'Drinks' }));
  const drinks = outlet.categories[0]?.id ?? '';
  await h.ok(
    h.gm.send(`/menu-categories/${drinks}/items`, {
      name: 'Chapman',
      priceMinor: '350000',
      revenueCodeId: code.id,
    }),
  );
  outlet = await h.ok<Outlet>(
    h.gm.send(`/menu-categories/${drinks}/items`, {
      name: 'Zobo',
      priceMinor: '150000',
      revenueCodeId: code.id,
      sortOrder: 1,
    }),
  );
  const [chapman, zobo] = outlet.categories[0]?.items ?? [];
  if (!chapman || !zobo) throw new Error('menu');
  outlet = await h.ok<Outlet>(
    h.gm.send(`/menu-items/${chapman.id}/modifiers`, { name: 'Large', priceMinor: '100000' }),
  );
  await h.ok(h.gm.send(`/menu-items/${zobo.id}/modifiers`, { name: 'Cold' }));
  const large = outlet.categories[0]?.items[0]?.modifiers[0]?.id ?? '';
  const cashierUser = await h.person('pos-cashier', h.p1.id);
  const cashier = await h.as(cashierUser.id);
  const openShift = async (as = cashier, floatMinor = '2000000') =>
    (await h.ok<Register>(as.send('/outlet-shifts', { outletId: outlet.id, floatMinor }))).shifts[0]
      ?.id ?? '';
  const order = async (label = 'Table 4', as = cashier) =>
    h.ok<Order>(as.send('/pos/orders', { outletId: outlet.id, label }));
  const add = (orderId: string, body: object, as = cashier) =>
    as.send(`/pos/orders/${orderId}/lines`, { menuItemId: chapman.id, ...body });
  return { ...h, outlet, chapman, zobo, large, cashier, cashierUser, openShift, order, add };
}

async function signature(h: { org: { id: string }; p1: { id: string } }, userId: string) {
  const id = randomUUID();
  await db.fileObject.create({
    data: {
      id,
      organisationId: h.org.id,
      propertyId: h.p1.id,
      storageKey: `k/${id}`,
      contentType: 'image/png',
      sizeBytes: 1000,
      scan: 'CLEAN',
      entityType: 'PosOrder',
      uploadedById: userId,
    },
  });
  return id;
}

describe('POS register (M8-02, M8-03, M8-05)', () => {
  it('takes an order, settles it by cash and terminal, and the close expects the settlements', async () => {
    const h = await bar();
    expect((await h.fd.get('/pos/register')).status).toBe(403);
    expect(
      errorOf(await h.cashier.send('/pos/orders', { outletId: h.outlet.id, label: 'T1' })).code,
    ).toBe('SHIFT_NOT_OPEN');
    const shiftId = await h.openShift();
    expect(
      errorOf(await h.cashier.send('/outlet-shifts', { outletId: h.outlet.id, floatMinor: '0' }))
        .code,
    ).toBe('STATE_TRANSITION_INVALID');

    const menu = await h.ok<{ categories: { items: { name: string }[] }[] }>(
      h.cashier.get(`/menu-items?outletId=${h.outlet.id}`),
    );
    expect(menu.categories[0]?.items.map((i) => i.name)).toEqual(['Chapman', 'Zobo']);

    const o = await h.order();
    // An option of another item is refused.
    const cold = await db.menuModifier.findFirstOrThrow({ where: { name: 'Cold' } });
    expect(errorOf(await h.add(o.id, { modifierIds: [cold.id] })).code).toBe('VALIDATION_ERROR');
    await h.ok(h.add(o.id, { quantity: 2, modifierIds: [h.large] }));
    now = new Date(now.getTime() + 60_000);
    const order = await h.ok<Order>(h.add(o.id, { menuItemId: h.zobo.id }));
    expect(order.lines).toEqual([
      expect.objectContaining({ name: 'Chapman (Large)', quantity: 2, amountMinor: '900000' }),
      expect.objectContaining({ name: 'Zobo', quantity: 1, amountMinor: '150000' }),
    ]);
    // Lagos taxes apply as on any charge.
    expect(BigInt(order.taxMinor)).toBeGreaterThan(0n);
    expect(BigInt(order.subtotalMinor) + BigInt(order.taxMinor)).toBe(BigInt(order.totalMinor));
    const total = BigInt(order.totalMinor);

    // The payments must add up exactly; nothing is posted otherwise.
    const short = await h.cashier.send(`/pos/orders/${o.id}/settle`, {
      payments: [{ method: 'CASH', amountMinor: String(total - 1n) }],
    });
    expect(errorOf(short).code).toBe('VALIDATION_ERROR');
    expect(await db.folio.count({ where: { kind: 'POS' } })).toBe(0);
    expect(
      errorOf(
        await h.cashier.send(`/pos/orders/${o.id}/settle`, {
          payments: [{ method: 'POS_TERMINAL', amountMinor: String(total) }],
        }),
      ).code,
    ).toBe('VALIDATION_ERROR'); // the terminal slip number is required

    const cash = 500000n;
    const paid = await h.ok<Order>(
      h.cashier.send(`/pos/orders/${o.id}/settle`, {
        payments: [
          { method: 'CASH', amountMinor: String(cash) },
          { method: 'POS_TERMINAL', amountMinor: String(total - cash), externalRef: 'MPT-1' },
        ],
      }),
    );
    expect(paid.status).toBe('PAID');
    expect(paid.totalMinor).toBe(String(total));
    expect(paid.payments.map((p) => p.method).sort()).toEqual(['CASH', 'POS_TERMINAL']);
    const folio = await db.folio.findFirstOrThrow({
      where: { kind: 'POS' },
      include: { lines: true },
    });
    expect(folio.status).toBe('SETTLED');
    const charges = folio.lines.filter((l) => l.kind === 'CHARGE');
    expect(charges.every((l) => l.sourceType === 'POS_ORDER' && l.sourceId === o.id)).toBe(true);
    expect(folio.lines.every((l) => l.shiftId === shiftId)).toBe(true);
    expect(folio.lines.reduce((s, l) => s + l.amountMinor, 0n)).toBe(total);
    expect(
      errorOf(
        await h.cashier.send(`/pos/orders/${o.id}/settle`, {
          payments: [{ method: 'CASH', amountMinor: String(total) }],
        }),
      ).code,
    ).toBe('STATE_TRANSITION_INVALID');

    // A transfer once the hotel switches it off is refused.
    await db.property.update({
      where: { id: h.p1.id },
      data: { settings: { paymentMethods: ['CASH', 'POS_TERMINAL'] } },
    });
    const o2 = await h.order('Bar 2');
    const two = await h.ok<Order>(h.add(o2.id, { menuItemId: h.zobo.id }));
    const transfer = await h.cashier.send(`/pos/orders/${o2.id}/settle`, {
      payments: [{ method: 'BANK_TRANSFER', amountMinor: two.totalMinor, externalRef: 'TRF-9' }],
    });
    expect(errorOf(transfer).code).toBe('VALIDATION_ERROR');
    await h.ok(
      h.cashier.send(`/pos/orders/${o2.id}/settle`, {
        payments: [{ method: 'CASH', amountMinor: two.totalMinor }],
      }),
    );

    // AC: the close equals the float plus the settlements by method.
    const reg = await h.ok<Register>(h.cashier.get('/pos/register'));
    expect(reg.shifts[0]?.paymentCounts).toEqual([
      { method: 'CASH', count: 2 },
      { method: 'POS_TERMINAL', count: 1 },
    ]);
    const expectedCash = 2000000n + cash + BigInt(two.totalMinor);
    const closed = await h.ok<Shift>(
      h.cashier.send(`/outlet-shifts/${shiftId}/close`, {
        counts: [
          { method: 'CASH', currency: 'NGN', countedMinor: String(expectedCash) },
          { method: 'POS_TERMINAL', currency: 'NGN', countedMinor: String(total - cash) },
        ],
      }),
    );
    expect(closed.status).toBe('CLOSED');
    expect(closed.outlet).toBe('Pool bar');
    expect(closed.lines).toEqual([
      expect.objectContaining({ method: 'CASH', expectedMinor: String(expectedCash) }),
      expect.objectContaining({ method: 'POS_TERMINAL', expectedMinor: String(total - cash) }),
    ]);
    expect(closed.lines.every((l) => l.varianceMinor === '0')).toBe(true);
    // Closed: no more orders until a new shift.
    expect(
      errorOf(await h.cashier.send('/pos/orders', { outletId: h.outlet.id, label: 'T9' })).code,
    ).toBe('SHIFT_NOT_OPEN');
  }, 60_000);

  it('charges an order to a checked-in room once, signed, within the credit limit', async () => {
    const h = await bar({ checkIn: false });
    const shiftId = await h.openShift();
    const o = await h.order('Room service');
    const order = await h.ok<Order>(h.add(o.id, {}));
    const sig = await signature(h, h.cashierUser.id);
    const charge = (body: object) =>
      h.cashier.send(`/pos/orders/${o.id}/charge-to-room`, {
        stayId: h.stayId,
        signatureFileId: sig,
        ...body,
      });

    // Only a checked-in stay.
    expect(errorOf(await charge({})).code).toBe('STATE_TRANSITION_INVALID');
    const folioId = await h.checkIn();
    const rooms = await h.ok<{ data: { stayId: string; roomNumber: string; guest: string }[] }>(
      h.cashier.get('/pos/rooms'),
    );
    expect(rooms.data).toEqual([{ stayId: h.stayId, roomNumber: '101', guest: 'Ada Obi' }]);

    // The guest signs first.
    expect(errorOf(await charge({ signatureFileId: randomUUID() })).code).toBe('VALIDATION_ERROR');

    // Within the credit limit: the POS setting when the folio has none of its own.
    expect((await h.cashier.get('/pos/settings')).status).toBe(403);
    await h.ok(h.gm.put('/pos/settings', { roomChargeLimitMinor: '100000' }));
    const over = await charge({});
    expect(over.status).toBe(409);
    expect(errorOf(over).code).toBe('CREDIT_LIMIT_EXCEEDED');
    const posLines = () =>
      db.folioLine.count({
        where: { folioId: folioId, kind: 'CHARGE', sourceType: 'POS_ORDER', sourceId: o.id },
      });
    expect(await posLines()).toBe(0);
    await h.ok(h.gm.put('/pos/settings', { roomChargeLimitMinor: null }));
    // The folio's own limit comes first.
    await db.folio.update({ where: { id: folioId }, data: { creditLimitMinor: 1n } });
    expect(errorOf(await charge({})).code).toBe('CREDIT_LIMIT_EXCEEDED');
    await db.folio.update({ where: { id: folioId }, data: { creditLimitMinor: null } });

    // AC: charged at once from two screens, it appears on the folio once.
    const [a, b] = await Promise.all([charge({}), charge({})]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await posLines()).toBe(1);
    const done = await h.ok<Order>(h.cashier.get(`/pos/orders/${o.id}`));
    expect(done.status).toBe('ROOM_CHARGED');
    expect(done.room).toEqual({ stayId: h.stayId, roomNumber: '101', folioId: folioId });
    expect(done.totalMinor).toBe(order.totalMinor);
    const folio = await h.folio();
    const line = folio.windows[0]?.lines.find(
      (l) => l.kind === 'CHARGE' && l.description.includes('Chapman'),
    );
    expect(line?.description).toBe('Pool bar: Chapman');
    const row = await db.folioLine.findUniqueOrThrow({ where: { id: line?.id ?? '' } });
    expect(row.shiftId).toBe(shiftId);

    // Room charges are not in the drawer: the close expects the float only.
    const closed = await h.ok<Shift>(
      h.cashier.send(`/outlet-shifts/${shiftId}/close`, {
        counts: [{ method: 'CASH', currency: 'NGN', countedMinor: '2000000' }],
      }),
    );
    expect(closed.lines).toEqual([
      expect.objectContaining({ method: 'CASH', expectedMinor: '2000000', varianceMinor: '0' }),
    ]);
  }, 60_000);

  it('cancels only an empty order, and a supervisor signs off an outlet variance', async () => {
    const h = await bar();
    const shiftId = await h.openShift(h.cashier, '1000000');
    const empty = await h.order('Mistake');
    expect((await h.ok<Order>(h.cashier.send(`/pos/orders/${empty.id}/cancel`))).status).toBe(
      'CANCELLED',
    );
    const tab = await h.order('Tab Chidi');
    await h.ok(h.add(tab.id, {}));
    expect(errorOf(await h.cashier.send(`/pos/orders/${tab.id}/cancel`)).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    // A colleague adds to the tab only on their own shift at the outlet.
    const other = await h.as((await h.person('pos-cashier', h.p1.id)).id);
    expect(errorOf(await h.add(tab.id, {}, other)).code).toBe('SHIFT_NOT_OPEN');
    await h.openShift(other, '0');
    await h.ok(h.add(tab.id, { menuItemId: h.zobo.id }, other));
    const open = await h.ok<{ data: { id: string }[] }>(
      h.cashier.get(`/pos/orders?outletId=${h.outlet.id}`),
    );
    expect(open.data.map((o) => o.id)).toEqual([tab.id]);

    // A desk shift is not closed through the outlet route.
    await h.ok(h.fd.send('/shifts', { floatMinor: '0' }));
    const desk = await db.cashierShift.findFirstOrThrow({
      where: { outletId: null, userId: h.fdId },
    });
    expect((await h.gm.send(`/outlet-shifts/${desk.id}/close`, { counts: [] })).status).toBe(400);
    expect(
      (
        await h.gm.send(`/outlet-shifts/${desk.id}/close`, {
          counts: [{ method: 'CASH', currency: 'NGN', countedMinor: '0' }],
        })
      ).status,
    ).toBe(404);

    // ₦5,000 short: waits for sign-off, with a leakage alert.
    const closing = await h.ok<Shift>(
      h.cashier.send(`/outlet-shifts/${shiftId}/close`, {
        counts: [{ method: 'CASH', currency: 'NGN', countedMinor: '500000' }],
      }),
    );
    expect(closing).toMatchObject({ status: 'CLOSING', requiresSignOff: true });
    expect(
      await db.leakageAlert.count({ where: { ruleCode: 'SHIFT_VARIANCE', entityId: shiftId } }),
    ).toBe(1);
    const waiting = await h.ok<{ data: { id: string; outlet: string | null }[] }>(
      h.gm.get('/shifts?status=CLOSING'),
    );
    expect(waiting.data).toEqual([expect.objectContaining({ id: shiftId, outlet: 'Pool bar' })]);
    await h.ok(
      h.cashier.send(`/outlet-shifts/${shiftId}/variance-note`, { note: 'Change given twice' }),
    );
    const signed = await h.ok<Shift>(h.gm.send(`/shifts/${shiftId}/sign-off`, { note: null }));
    expect(signed.status).toBe('CLOSED');
  }, 60_000);
});
