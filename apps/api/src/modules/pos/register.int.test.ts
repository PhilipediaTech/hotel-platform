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
// T-142.) Voids and discounts (M8-04; T-143) are at the end.

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

// M8-04 (T-143): "As a POS cashier, I void an item or apply a discount; above limit needs
// approval" (pos.void, amount limit). Rule: voided items stay on the order with reason.
type Adjusted = Omit<Order, 'lines'> & {
  discountMinor: string;
  lines: (Order['lines'][number] & {
    id: string;
    voided: { by: string; reason: string } | null;
    discount: { amountMinor: string; reason: string } | null;
    totalMinor: string;
  })[];
};

/** Sets the POS Cashier role's pos.void amount limit (null = none). */
async function cashierLimit(orgId: string, maxAmountMinor: string | null) {
  const role = await db.role.findFirstOrThrow({
    where: { organisationId: orgId, name: 'POS Cashier' },
  });
  await db.role.update({
    where: { id: role.id },
    data: { limits: maxAmountMinor ? { 'pos.void': { maxAmountMinor } } : {} },
  });
}

describe('POS voids and discounts (M8-04)', () => {
  it('voids an item with its reason, at once within the limit and after approval above it', async () => {
    const h = await bar();
    await h.openShift();
    const o = await h.order();
    await h.ok(h.add(o.id, {}));
    now = new Date(now.getTime() + 60_000);
    const both = await h.ok<Adjusted>(h.add(o.id, { menuItemId: h.zobo.id }));
    const [chapman, zobo] = both.lines;
    if (!chapman || !zobo) throw new Error('lines');
    const voidOf = (lineId: string, body: object, as = h.cashier) =>
      as.send(`/pos/orders/${o.id}/lines/${lineId}/void`, body);

    // pos.void is needed, and a reason.
    expect((await voidOf(zobo.id, { reason: 'Wrong drink' }, h.fd)).status).toBe(403);
    expect(errorOf(await voidOf(zobo.id, { reason: ' ' })).code).toBe('VALIDATION_ERROR');

    // No limit set: every void waits for a manager.
    const asked = await voidOf(zobo.id, { reason: 'Wrong drink' });
    expect(asked.status).toBe(202);
    const { approvalRequestId } = asked.body as { approvalRequestId: string };
    const request = await db.approvalRequest.findUniqueOrThrow({
      where: { id: approvalRequestId },
    });
    expect(request).toMatchObject({ action: 'pos.void', amountMinor: BigInt(zobo.totalMinor) });
    let order = await h.ok<Adjusted>(h.cashier.get(`/pos/orders/${o.id}`));
    expect(order.lines.every((l) => l.voided === null)).toBe(true);
    // The cashier cannot approve their own request.
    expect((await h.cashier.send(`/approvals/${approvalRequestId}/approve`, {})).status).toBe(403);
    await h.ok(h.gm.send(`/approvals/${approvalRequestId}/approve`, {}));

    // Rule: the voided item stays on the order with its reason, and is not charged.
    order = await h.ok<Adjusted>(h.cashier.get(`/pos/orders/${o.id}`));
    expect(order.lines).toHaveLength(2);
    expect(order.lines[1]).toMatchObject({
      name: 'Zobo',
      voided: { reason: 'Wrong drink' },
      totalMinor: '0',
    });
    expect(order.totalMinor).toBe(chapman.totalMinor);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'pos.item_voided' } });
    expect(audit).toMatchObject({ reason: 'Wrong drink', approvalRequestId });
    expect(errorOf(await voidOf(zobo.id, { reason: 'Again' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );

    // Within the cashier's limit it happens at once.
    await cashierLimit(h.org.id, '1000000');
    order = await h.ok<Adjusted>(voidOf(chapman.id, { reason: 'Guest left' }));
    expect(order.lines.every((l) => l.voided !== null)).toBe(true);
    expect(order.totalMinor).toBe('0');
    // Nothing left to charge: it cannot be settled, only closed, and the voids stay on it.
    expect(
      errorOf(
        await h.cashier.send(`/pos/orders/${o.id}/settle`, {
          payments: [{ method: 'CASH', amountMinor: '1' }],
        }),
      ).code,
    ).toBe('STATE_TRANSITION_INVALID');
    const closed = await h.ok<Adjusted>(h.cashier.send(`/pos/orders/${o.id}/cancel`));
    expect(closed.status).toBe('CANCELLED');
    expect(closed.lines.map((l) => l.voided?.reason)).toEqual(['Guest left', 'Wrong drink']);
  }, 60_000);

  it('discounts an item; settlement posts it off the charge and its taxes', async () => {
    const h = await bar();
    await cashierLimit(h.org.id, '100000'); // NGN 1,000
    const shiftId = await h.openShift();
    const o = await h.order();
    await h.ok(h.add(o.id, { quantity: 2, modifierIds: [h.large] }));
    now = new Date(now.getTime() + 60_000);
    const start = await h.ok<Adjusted>(h.add(o.id, { menuItemId: h.zobo.id }));
    const [chapman, zobo] = start.lines;
    if (!chapman || !zobo) throw new Error('lines');
    const discount = (lineId: string, body: object) =>
      h.cashier.send(`/pos/orders/${o.id}/lines/${lineId}/discount`, body);

    // A percent or an amount, never both, never more than the item charges.
    expect(
      errorOf(await discount(zobo.id, { percent: 10, amountMinor: '100', reason: 'x' })).code,
    ).toBe('VALIDATION_ERROR');
    const tooMuch = String(BigInt(zobo.totalMinor) + 1n);
    expect(errorOf(await discount(zobo.id, { amountMinor: tooMuch, reason: 'x' })).code).toBe(
      'VALIDATION_ERROR',
    );

    // NGN 500 is within the NGN 1,000 limit: at once.
    let order = await h.ok<Adjusted>(
      discount(zobo.id, { amountMinor: '50000', reason: 'Regular guest' }),
    );
    expect(order.lines[1]?.discount).toMatchObject({
      amountMinor: '50000',
      reason: 'Regular guest',
    });
    expect(order.lines[1]?.totalMinor).toBe(String(BigInt(zobo.totalMinor) - 50000n));
    expect(errorOf(await discount(zobo.id, { percent: 5, reason: 'Again' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );

    // 10% of the Chapmans is over NGN 1,000: a manager approves.
    const asked = await discount(chapman.id, { percent: 10, reason: 'Slow service' });
    expect(asked.status).toBe(202);
    const { approvalRequestId } = asked.body as { approvalRequestId: string };
    const tenth = (BigInt(chapman.totalMinor) * 1000n * 2n + 10_000n) / 20_000n;
    const request = await db.approvalRequest.findUniqueOrThrow({
      where: { id: approvalRequestId },
    });
    expect(request).toMatchObject({ action: 'pos.discount', amountMinor: tenth });
    await h.ok(h.gm.send(`/approvals/${approvalRequestId}/approve`, {}));
    order = await h.ok<Adjusted>(h.cashier.get(`/pos/orders/${o.id}`));
    expect(order.discountMinor).toBe(String(50000n + tenth));
    const gross = BigInt(chapman.totalMinor) + BigInt(zobo.totalMinor);
    expect(order.totalMinor).toBe(String(gross - 50000n - tenth));
    expect(BigInt(order.subtotalMinor) + BigInt(order.taxMinor)).toBe(BigInt(order.totalMinor));

    // Settled: the discount lines take their share off the charge and each tax.
    const paid = await h.ok<Adjusted>(
      h.cashier.send(`/pos/orders/${o.id}/settle`, {
        payments: [{ method: 'CASH', amountMinor: order.totalMinor }],
      }),
    );
    expect(paid).toMatchObject({
      status: 'PAID',
      totalMinor: order.totalMinor,
      subtotalMinor: order.subtotalMinor,
      taxMinor: order.taxMinor,
      discountMinor: order.discountMinor,
    });
    const folio = await db.folio.findFirstOrThrow({
      where: { kind: 'POS' },
      include: { lines: true },
    });
    expect(folio.lines.reduce((s, l) => s + l.amountMinor, 0n)).toBe(BigInt(order.totalMinor));
    const discounts = folio.lines.filter((l) => l.kind === 'DISCOUNT');
    expect(discounts).toHaveLength(2);
    expect(
      discounts.every(
        (d) =>
          d.amountMinor < 0n &&
          d.sourceType === 'POS_ORDER' &&
          d.sourceId === o.id &&
          d.shiftId === shiftId,
      ),
    ).toBe(true);
    const zoboDiscount = discounts.find((d) => d.reason === 'Regular guest');
    const parts = folio.lines.filter(
      (l) => l.id === zoboDiscount?.id || l.parentLineId === zoboDiscount?.id,
    );
    expect(parts.length).toBeGreaterThan(1); // the taxes give up their share
    expect(parts.reduce((s, l) => s + l.amountMinor, 0n)).toBe(-50000n);
  }, 60_000);

  it('an approval for an order settled meanwhile no longer applies', async () => {
    const h = await bar();
    await h.openShift();
    const o = await h.order();
    const added = await h.ok<Adjusted>(h.add(o.id, {}));
    const asked = await h.cashier.send(`/pos/orders/${o.id}/lines/${added.lines[0]?.id}/void`, {
      reason: 'Spilled',
    });
    expect(asked.status).toBe(202);
    const { approvalRequestId } = asked.body as { approvalRequestId: string };
    await h.ok(
      h.cashier.send(`/pos/orders/${o.id}/settle`, {
        payments: [{ method: 'CASH', amountMinor: added.totalMinor }],
      }),
    );
    const late = await h.gm.send(`/approvals/${approvalRequestId}/approve`, {});
    expect(errorOf(late).code).toBe('STATE_TRANSITION_INVALID');
    const request = await db.approvalRequest.findUniqueOrThrow({
      where: { id: approvalRequestId },
    });
    expect(request.status).toBe('FAILED');
    expect(await db.posOrderLine.count({ where: { voidedAt: { not: null } } })).toBe(0);
  }, 60_000);
});
