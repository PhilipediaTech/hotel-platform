import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTenant, makeProperty } from '../../test/factories.ts';
import { resetDb, testDb } from '../../test/db.ts';
import { COUNTER, nextPropertyCounter } from './counters.ts';

const db = testDb();

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('nextPropertyCounter', () => {
  it('counts 1, 2, 3 per property and name', async () => {
    const { property } = await makeTenant(db);
    const values = [];
    for (let i = 0; i < 3; i++)
      values.push(await nextPropertyCounter(db, property.id, COUNTER.FOLIO));
    expect(values).toEqual([1, 2, 3]);
    await expect(nextPropertyCounter(db, property.id, COUNTER.TASK)).resolves.toBe(1);
  });

  it('keeps properties independent', async () => {
    const { organisation, property } = await makeTenant(db);
    const other = await makeProperty(db, organisation.id);
    await nextPropertyCounter(db, property.id, COUNTER.CONFIRMATION);
    await nextPropertyCounter(db, property.id, COUNTER.CONFIRMATION);
    await expect(nextPropertyCounter(db, other.id, COUNTER.CONFIRMATION)).resolves.toBe(1);
  });

  it('never hands out the same number to 20 concurrent callers', async () => {
    const { property } = await makeTenant(db);
    const values = await Promise.all(
      Array.from({ length: 20 }, () => nextPropertyCounter(db, property.id, COUNTER.CONFIRMATION)),
    );
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('gives the number back when the surrounding transaction rolls back', async () => {
    const { property } = await makeTenant(db);
    await expect(
      db.$transaction(async (tx) => {
        await nextPropertyCounter(tx, property.id, COUNTER.CONFIRMATION);
        throw new Error('booking failed');
      }),
    ).rejects.toThrow('booking failed');
    await expect(nextPropertyCounter(db, property.id, COUNTER.CONFIRMATION)).resolves.toBe(1);
  });

  it('rejects an unknown property', async () => {
    await expect(
      nextPropertyCounter(db, '00000000-0000-4000-8000-000000000000', COUNTER.TASK),
    ).rejects.toThrow(/property_counters_property_id_fkey/);
  });
});
