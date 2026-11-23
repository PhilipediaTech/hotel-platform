import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';

// Purchasing (PRD M10-03 "As a manager, I raise purchase orders to suppliers with approval
// limits", po.manage; M10-04 "As a store keeper, I receive goods against a PO (partial receipts
// allowed)", stock.receive; M10 AC: on-hand equals the movement sum after receipts too. T-146.)

const db = testDb();
const now = new Date('2026-11-10T09:00:00Z');
const clock = () => new Date(now);

type Order = {
  id: string;
  number: number;
  status: string;
  totalMinor: string;
  approvedBy: { id: string } | null;
  lines: { id: string; quantity: string; received: string; amountMinor: string }[];
};
type Receipt = { number: number; valueMinor: string; lines: { quantity: string }[] };

beforeEach(async () => {
  await resetDb(db);
});

/** A hotel with a buyer (po.manage, limit ₦100,000), a store keeper, a supplier and two items. */
async function purchasing() {
  const h = await makeHotel(db, now);
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
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
  // A purchasing role: raises orders, its own limit is ₦100,000.
  const buyerRole = await db.role.create({
    data: {
      organisationId: h.org.id,
      name: 'Purchasing',
      permissions: ['po.manage'],
      limits: { 'po.manage': { maxAmountMinor: '10000000' } },
    },
  });
  const buyerUser = await h.person('staff', h.p1.id);
  await db.membership.create({
    data: {
      userId: buyerUser.id,
      organisationId: h.org.id,
      propertyId: h.p1.id,
      roleId: buyerRole.id,
    },
  });
  const buyer = await as(buyerUser.id);
  const keeper = await as((await h.person('store-keeper', h.p1.id)).id);
  const gm = await as(h.gm.id);
  const unit = await ok<{ id: string }>(
    keeper.send('/stock-units', { code: 'BTL', name: 'Bottle' }),
  );
  const main = await ok<{ id: string }>(
    keeper.send('/stock-locations', { code: 'MAIN', name: 'Main store' }),
  );
  const item = (code: string, name: string) =>
    ok<{ id: string }>(
      keeper.send('/stock-items', {
        code,
        name,
        category: null,
        unitId: unit.id,
        par: null,
        reorderPoint: null,
        unitCostMinor: '1000000',
      }),
    );
  const gin = await item('GIN', 'Gin');
  const wine = await item('WINE', 'Red wine');
  const supplier = await ok<{ id: string }>(
    buyer.send('/suppliers', {
      name: 'Lagos Beverages Ltd',
      contactName: 'Tunde',
      phone: '+2348012345678',
      email: 'orders@lagosbev.example',
      note: null,
    }),
  );
  const order = (lines: { itemId: string; quantity: string; unitPriceMinor: string }[]) =>
    ok<Order>(buyer.send('/purchase-orders', { supplierId: supplier.id, lines }));
  const onHand = async (itemId: string) =>
    (await db.stockMovement.aggregate({ where: { itemId }, _sum: { quantityMilli: true } }))._sum
      .quantityMilli ?? 0n;
  return {
    ...h,
    gmUser: h.gm,
    ok,
    as,
    buyer,
    buyerUser,
    keeper,
    gm,
    main,
    gin,
    wine,
    supplier,
    order,
    onHand,
  };
}

describe('suppliers (M10-03)', () => {
  it('keeps suppliers with unique names, for people who order', async () => {
    const p = await purchasing();
    const dup = await p.buyer.send('/suppliers', {
      name: 'lagos beverages ltd',
      contactName: null,
      phone: null,
      email: null,
      note: null,
    });
    expect(errorOf(dup).details).toMatchObject({ issues: [{ path: 'body.name' }] });
    const badEmail = await p.buyer.send('/suppliers', {
      name: 'Abuja Foods',
      contactName: null,
      phone: null,
      email: 'not an email',
      note: null,
    });
    expect(errorOf(badEmail).code).toBe('VALIDATION_ERROR');
    expect((await p.keeper.get('/suppliers')).status).toBe(403);
    await p.ok(p.buyer.patch(`/suppliers/${p.supplier.id}`, { active: false }));
    const offSupplier = await p.buyer.send('/purchase-orders', {
      supplierId: p.supplier.id,
      lines: [{ itemId: p.gin.id, quantity: '1', unitPriceMinor: '100' }],
    });
    expect(errorOf(offSupplier).details).toMatchObject({ issues: [{ path: 'body.supplierId' }] });
  });
});

describe('purchase orders with approval limits (M10-03)', () => {
  it('a draft within the buyer’s limit is approved at once', async () => {
    const p = await purchasing();
    const draft = await p.order([
      { itemId: p.gin.id, quantity: '6', unitPriceMinor: '1200000' },
      { itemId: p.wine.id, quantity: '1.5', unitPriceMinor: '900000' },
    ]);
    // ₦72,000 + ₦13,500.
    expect(draft).toMatchObject({ number: 1, status: 'DRAFT', totalMinor: '8550000' });
    expect(draft.lines.map((l) => l.amountMinor).sort()).toEqual(['1350000', '7200000']);
    const approved = await p.ok<Order>(p.buyer.send(`/purchase-orders/${draft.id}/approve`, {}));
    expect(approved).toMatchObject({ status: 'APPROVED', approvedBy: { id: p.buyerUser.id } });
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('above the limit it waits for a manager, as a draft, and the manager is recorded', async () => {
    const p = await purchasing();
    const draft = await p.order([{ itemId: p.gin.id, quantity: '100', unitPriceMinor: '1200000' }]);
    const noReason = await p.buyer.send(`/purchase-orders/${draft.id}/approve`, {});
    expect(errorOf(noReason).code).toBe('VALIDATION_ERROR');
    const asked = await p.buyer.send(`/purchase-orders/${draft.id}/approve`, {
      reason: 'Christmas stock',
    });
    expect(asked.status).toBe(202);
    const { approvalRequestId } = asked.body as { approvalRequestId: string };
    expect(
      await db.approvalRequest.findUniqueOrThrow({ where: { id: approvalRequestId } }),
    ).toMatchObject({
      action: 'po.approve',
      amountMinor: 120000000n,
    });
    expect((await p.ok<Order>(p.buyer.get(`/purchase-orders/${draft.id}`))).status).toBe('DRAFT');
    // Goods can't arrive against a draft.
    const early = await p.keeper.send('/goods-receipts', {
      purchaseOrderId: draft.id,
      locationId: p.main.id,
      lines: [{ lineId: draft.lines[0]?.id, quantity: '1' }],
    });
    expect(errorOf(early).code).toBe('STATE_TRANSITION_INVALID');
    await p.ok(p.gm.send(`/approvals/${approvalRequestId}/approve`, {}));
    expect(await p.ok<Order>(p.buyer.get(`/purchase-orders/${draft.id}`))).toMatchObject({
      status: 'APPROVED',
      approvedBy: { id: p.gmUser.id },
    });
  });

  it('an order changed while waiting is not approved as it now stands', async () => {
    const p = await purchasing();
    const draft = await p.order([{ itemId: p.gin.id, quantity: '100', unitPriceMinor: '1200000' }]);
    const asked = await p.buyer.send(`/purchase-orders/${draft.id}/approve`, { reason: 'Stock' });
    const { approvalRequestId } = asked.body as { approvalRequestId: string };
    await p.ok(
      p.buyer.put(`/purchase-orders/${draft.id}`, {
        supplierId: p.supplier.id,
        lines: [{ itemId: p.gin.id, quantity: '500', unitPriceMinor: '1200000' }],
      }),
    );
    const late = await p.gm.send(`/approvals/${approvalRequestId}/approve`, {});
    expect(errorOf(late).code).toBe('STATE_TRANSITION_INVALID');
    expect((await p.ok<Order>(p.buyer.get(`/purchase-orders/${draft.id}`))).status).toBe('DRAFT');
  });

  it('only drafts change; approved orders can’t be edited, and cancelling stops at receipts', async () => {
    const p = await purchasing();
    const o = await p.order([{ itemId: p.gin.id, quantity: '2', unitPriceMinor: '100000' }]);
    await p.ok(p.buyer.send(`/purchase-orders/${o.id}/approve`, {}));
    const edit = await p.buyer.put(`/purchase-orders/${o.id}`, {
      supplierId: p.supplier.id,
      lines: [{ itemId: p.gin.id, quantity: '3', unitPriceMinor: '100000' }],
    });
    expect(errorOf(edit).code).toBe('STATE_TRANSITION_INVALID');
    await p.ok(
      p.keeper.send('/goods-receipts', {
        purchaseOrderId: o.id,
        locationId: p.main.id,
        lines: [{ lineId: o.lines[0]?.id, quantity: '1' }],
      }),
    );
    expect(errorOf(await p.buyer.send(`/purchase-orders/${o.id}/cancel`)).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    const closed = await p.ok<Order & { closeReason: string }>(
      p.buyer.send(`/purchase-orders/${o.id}/close`, { reason: 'Supplier out of stock' }),
    );
    expect(closed).toMatchObject({ status: 'CLOSED', closeReason: 'Supplier out of stock' });
    const other = await p.order([{ itemId: p.wine.id, quantity: '1', unitPriceMinor: '100' }]);
    expect(await p.ok<Order>(p.buyer.send(`/purchase-orders/${other.id}/cancel`))).toMatchObject({
      status: 'CANCELLED',
    });
  });
});

describe('receiving goods against an order (M10-04)', () => {
  it('receives in part then in full, adding stock at the order’s price', async () => {
    const p = await purchasing();
    const o = await p.order([
      { itemId: p.gin.id, quantity: '12', unitPriceMinor: '1250000' },
      { itemId: p.wine.id, quantity: '6', unitPriceMinor: '900000' },
    ]);
    await p.ok(p.gm.send(`/purchase-orders/${o.id}/approve`, {}));
    const [ginLine, wineLine] = [
      o.lines.find((l) => l.quantity === '12'),
      o.lines.find((l) => l.quantity === '6'),
    ];
    const first = await p.ok<Receipt>(
      p.keeper.send('/goods-receipts', {
        purchaseOrderId: o.id,
        locationId: p.main.id,
        supplierRef: 'DN-4471',
        lines: [{ lineId: ginLine?.id, quantity: '10' }],
      }),
    );
    expect(first).toMatchObject({ number: 1, valueMinor: '12500000' });
    expect((await p.ok<Order>(p.buyer.get(`/purchase-orders/${o.id}`))).status).toBe('PARTIAL');
    const over = await p.keeper.send('/goods-receipts', {
      purchaseOrderId: o.id,
      locationId: p.main.id,
      lines: [{ lineId: ginLine?.id, quantity: '3' }],
    });
    expect(errorOf(over).message).toBe('Only 2 still to come');
    await p.ok(
      p.keeper.send('/goods-receipts', {
        purchaseOrderId: o.id,
        locationId: p.main.id,
        lines: [
          { lineId: ginLine?.id, quantity: '2' },
          { lineId: wineLine?.id, quantity: '6' },
        ],
      }),
    );
    expect((await p.ok<Order>(p.buyer.get(`/purchase-orders/${o.id}`))).status).toBe('RECEIVED');
    // On hand is the movement sum, receipts included; the order's price is the new cost.
    expect(await p.onHand(p.gin.id)).toBe(12000n);
    expect(await p.onHand(p.wine.id)).toBe(6000n);
    const receipts = await db.stockMovement.findMany({ where: { kind: 'RECEIPT' } });
    expect(receipts).toHaveLength(3);
    expect(receipts.every((m) => m.goodsReceiptId && m.orderLineId)).toBe(true);
    expect((await db.stockItem.findUniqueOrThrow({ where: { id: p.gin.id } })).unitCostMinor).toBe(
      1250000n,
    );
    const done = await p.keeper.send('/goods-receipts', {
      purchaseOrderId: o.id,
      locationId: p.main.id,
      lines: [{ lineId: wineLine?.id, quantity: '1' }],
    });
    expect(errorOf(done).code).toBe('STATE_TRANSITION_INVALID');
    const list = await p.ok<{ awaiting: Order[]; data: Receipt[] }>(
      p.keeper.get('/goods-receipts'),
    );
    expect(list.awaiting).toEqual([]);
    expect(list.data.map((r) => r.number)).toEqual([2, 1]);
  });

  it('a RECEIPT movement exists only as part of a goods receipt (database rule)', async () => {
    const p = await purchasing();
    await expect(
      db.stockMovement.create({
        data: {
          propertyId: p.p1.id,
          itemId: p.gin.id,
          locationId: p.main.id,
          kind: 'RECEIPT',
          quantityMilli: 1000n,
          unitCostMinor: 0n,
          byUserId: p.buyerUser.id,
        },
      }),
    ).rejects.toThrow(/stock_movements_kind_check/);
  });
});
