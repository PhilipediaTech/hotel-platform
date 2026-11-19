import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Lite POS setup (PRD M8-01 "As a manager, I set up outlets, menu categories, items,
// modifiers, prices and revenue codes", pos.setup; T-141).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Outlet = {
  id: string;
  code: string;
  active: boolean;
  categories: {
    id: string;
    name: string;
    active: boolean;
    items: {
      id: string;
      name: string;
      priceMinor: string;
      active: boolean;
      revenueCode: { id: string };
      modifiers: { id: string; name: string; priceMinor: string }[];
    }[];
  }[];
};

describe('POS setup (M8-01)', () => {
  it('builds an outlet menu with prices, revenue codes and options', async () => {
    const h = await inHouse(db, clock);
    const code = await db.revenueCode.findFirstOrThrow({ where: { propertyId: h.p1.id } });
    expect((await h.fd.get('/outlets')).status).toBe(403);

    const bar = await h.ok<Outlet>(h.gm.send('/outlets', { code: 'pool-bar', name: 'Pool bar' }));
    expect(bar.code).toBe('POOL-BAR');
    expect(errorOf(await h.gm.send('/outlets', { code: 'POOL-BAR', name: 'Again' })).code).toBe(
      'VALIDATION_ERROR',
    );
    let o = await h.ok<Outlet>(h.gm.send(`/outlets/${bar.id}/categories`, { name: 'Drinks' }));
    expect(errorOf(await h.gm.send(`/outlets/${bar.id}/categories`, { name: 'drinks' })).code).toBe(
      'VALIDATION_ERROR',
    );
    const drinks = o.categories[0];
    if (!drinks) throw new Error('no category');

    const add = (body: object) => h.gm.send(`/menu-categories/${drinks.id}/items`, body);
    expect(errorOf(await add({ name: 'Free', priceMinor: '0', revenueCodeId: code.id })).code).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      errorOf(
        await add({
          name: 'Bad code',
          priceMinor: '100',
          revenueCodeId: '00000000-0000-4000-8000-000000000000',
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    o = await h.ok<Outlet>(add({ name: 'Chapman', priceMinor: '350000', revenueCodeId: code.id }));
    const chapman = o.categories[0]?.items[0];
    if (!chapman) throw new Error('no item');
    expect(chapman).toMatchObject({ priceMinor: '350000', revenueCode: { id: code.id } });

    await h.ok(h.gm.send(`/menu-items/${chapman.id}/modifiers`, { name: 'No ice' }));
    o = await h.ok<Outlet>(
      h.gm.send(`/menu-items/${chapman.id}/modifiers`, { name: 'Large', priceMinor: '100000' }),
    );
    expect(o.categories[0]?.items[0]?.modifiers.map((m) => [m.name, m.priceMinor])).toEqual([
      ['Large', '100000'],
      ['No ice', '0'],
    ]);

    // A price change is audited; switching off keeps the item.
    await h.ok(h.gm.patch(`/menu-items/${chapman.id}`, { priceMinor: '400000' }));
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'pos.item_updated' } });
    expect(audit.before).toEqual({ priceMinor: '350000' });
    expect(audit.after).toEqual({ priceMinor: '400000' });
    o = await h.ok<Outlet>(h.gm.patch(`/menu-items/${chapman.id}`, { active: false }));
    expect(o.categories[0]?.items[0]).toMatchObject({ active: false, priceMinor: '400000' });

    // An item moves only within its outlet.
    const kitchen = await h.ok<Outlet>(h.gm.send('/outlets', { code: 'REST', name: 'Restaurant' }));
    const mains = (
      await h.ok<Outlet>(h.gm.send(`/outlets/${kitchen.id}/categories`, { name: 'Mains' }))
    ).categories[0];
    expect(
      errorOf(await h.gm.patch(`/menu-items/${chapman.id}`, { categoryId: mains?.id })).code,
    ).toBe('VALIDATION_ERROR');

    await h.ok(h.gm.patch(`/outlets/${bar.id}`, { active: false }));
    const all = await h.ok<{ data: Outlet[]; currency: string; revenueCodes: unknown[] }>(
      h.gm.get('/outlets'),
    );
    expect(all.data.map((x) => [x.code, x.active])).toEqual([
      ['POOL-BAR', false],
      ['REST', true],
    ]);
    expect(all.currency).toBe('NGN');
    expect(all.revenueCodes.length).toBeGreaterThan(0);
  });
});
