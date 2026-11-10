import { addDays } from '@hotel/shared';
import type { DbClient } from '../../core/db.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { takeInventory, type InventoryField } from '../availability/inventory.ts';

// Picking up a block (PRD M3-17, M2-12; T-123). Kept apart from the rest of the groups module
// because reservations call it. A block's rooms sit in the inventory's `held`; a confirmed room
// picked up from it moves from held to sold on the same night (the total taken is unchanged), a
// tentative one stays held. A night the block has nothing left for is taken from what is for
// sale, as any booking would be.

type Client = DbClient | Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

export async function pickUpFromBlock(
  db: Client,
  args: {
    propertyId: string;
    blockId: string;
    roomTypeId: string;
    arrival: string;
    departure: string;
    field: InventoryField;
  },
): Promise<void> {
  const nights = await db.$queryRaw<{ id: string; date: Date; remaining: number }[]>`
    SELECT id, date, remaining FROM group_block_nights
    WHERE block_id = ${args.blockId}::uuid AND room_type_id = ${args.roomTypeId}::uuid
      AND date >= ${args.arrival}::date AND date < ${args.departure}::date
    ORDER BY date FOR UPDATE`;
  const fromBlock = new Map(
    nights.filter((n) => n.remaining > 0).map((n) => [n.date.toISOString().slice(0, 10), n.id]),
  );
  for (let date = args.arrival; date < args.departure; date = addDays(date, 1)) {
    const nightId = fromBlock.get(date);
    if (!nightId) {
      await takeInventory(db, {
        propertyId: args.propertyId,
        roomTypeId: args.roomTypeId,
        arrival: date,
        departure: addDays(date, 1),
        field: args.field,
      });
      continue;
    }
    await db.$executeRaw`UPDATE group_block_nights SET remaining = remaining - 1
      WHERE id = ${nightId}::uuid`;
    if (args.field === 'sold') {
      await db.$executeRaw`UPDATE room_type_inventory SET held = held - 1, sold = sold + 1
        WHERE property_id = ${args.propertyId}::uuid AND room_type_id = ${args.roomTypeId}::uuid
          AND date = ${date}::date`;
    }
  }
}
