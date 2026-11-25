import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Offline order taking (PRD M8-08 "As a POS cashier, I keep taking orders during an outage;
// they sync when online"; spec tab 2 "Offline": each queued action has a client UUID and
// idempotency key and is replayed in order; T-158). The register queues on the device; here
// the server takes the replay: an order with the ID the device chose, then items naming it,
// each request once whatever happens, with the time it was really taken in the audit trail.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

async function bar() {
  const h = await inHouse(db, clock);
  const code = await db.revenueCode.findFirstOrThrow({
    where: { propertyId: h.p1.id, group: 'FNB' },
  });
  type Outlet = { id: string; categories: { id: string; items: { id: string }[] }[] };
  let outlet = await h.ok<Outlet>(h.gm.send('/outlets', { code: 'POOL', name: 'Pool bar' }));
  outlet = await h.ok<Outlet>(h.gm.send(`/outlets/${outlet.id}/categories`, { name: 'Drinks' }));
  outlet = await h.ok<Outlet>(
    h.gm.send(`/menu-categories/${outlet.categories[0]?.id}/items`, {
      name: 'Zobo',
      priceMinor: '150000',
      revenueCodeId: code.id,
    }),
  );
  const zobo = outlet.categories[0]?.items[0]?.id ?? '';
  const cashier = await h.as((await h.person('pos-cashier', h.p1.id)).id);
  await h.ok(cashier.send('/outlet-shifts', { outletId: outlet.id, floatMinor: '0' }));
  /** A replayed request: the queued action's UUID is its idempotency key. */
  const replay = (path: string, body: object, key: string) =>
    cashier.post(path, body).set('Idempotency-Key', key);
  return { ...h, outlet, zobo, cashier, replay };
}

describe('orders taken offline (M8-08)', () => {
  it('opens the order with the device’s ID, then its items, each once, with when they were taken', async () => {
    const h = await bar();
    const orderId = randomUUID();
    const openKey = randomUUID();
    const takenAt = '2026-11-10T08:40:00.000Z';
    const body = { outletId: h.outlet.id, label: 'Table 9', id: orderId, takenAt };
    const first = await h.replay('/pos/orders', body, openKey);
    expect(first.status).toBe(201);
    expect((first.body as { id: string }).id).toBe(orderId);
    // The same action again (the answer was lost): the same order, not a second one.
    const again = await h.replay('/pos/orders', body, openKey);
    expect((again.body as { id: string }).id).toBe(orderId);
    expect(await db.posOrder.count()).toBe(1);

    const lineKey = randomUUID();
    const item = { menuItemId: h.zobo, quantity: 2, takenAt: '2026-11-10T08:41:00.000Z' };
    await h.replay(`/pos/orders/${orderId}/lines`, item, lineKey);
    await h.replay(`/pos/orders/${orderId}/lines`, item, lineKey);
    expect(await db.posOrderLine.count({ where: { orderId } })).toBe(1);

    const opened = await db.auditEvent.findFirstOrThrow({ where: { action: 'pos.order_opened' } });
    expect(opened.after).toMatchObject({ label: 'Table 9', takenOfflineAt: takenAt });
    const added = await db.auditEvent.findFirstOrThrow({ where: { action: 'pos.item_added' } });
    expect(added.after).toMatchObject({ takenOfflineAt: '2026-11-10T08:41:00.000Z' });
    // Taken online: no offline time.
    await h.ok(h.cashier.send('/pos/orders', { outletId: h.outlet.id, label: 'Bar' }));
    const online = await db.auditEvent.findMany({
      where: { action: 'pos.order_opened' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(online.map((e) => 'takenOfflineAt' in (e.after as object))).toEqual([true, false]);
  });

  it('refuses an ID already used, and a device clock far off', async () => {
    const h = await bar();
    const orderId = randomUUID();
    await h.ok(
      h.cashier.send('/pos/orders', { outletId: h.outlet.id, label: 'Table 1', id: orderId }),
    );
    const reused = await h.cashier.send('/pos/orders', {
      outletId: h.outlet.id,
      label: 'Table 2',
      id: orderId,
    });
    expect(reused.status).toBe(409);
    expect(errorOf(reused).message).toBe('An order with this ID exists already');
    const future = await h.cashier.send('/pos/orders', {
      outletId: h.outlet.id,
      label: 'Table 3',
      takenAt: '2026-11-10T10:00:00.000Z',
    });
    expect(future.status).toBe(400);
    expect(errorOf(future).message).toBe('The time it was taken must be within the last day');
    const old = await h.cashier.send(`/pos/orders/${orderId}/lines`, {
      menuItemId: h.zobo,
      takenAt: '2026-11-08T09:00:00.000Z',
    });
    expect(old.status).toBe(400);
  });
});
