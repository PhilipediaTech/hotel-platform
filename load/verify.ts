import { readFileSync } from 'node:fs';
import { loadConfig } from '../apps/api/src/core/config.ts';
import { createDb } from '../apps/api/src/core/db.ts';

// After `k6 run load/k6/booking.js`: no night of the load-test hotel is sold beyond its rooms
// (spec tab 8 concurrency rule, under load; T-101). Exits 1 if any is.
//   npm run load:verify

const session = JSON.parse(readFileSync(new URL('./.session.json', import.meta.url), 'utf8')) as {
  propertyId: string;
};
const db = createDb(loadConfig(process.env).databaseUrl);
try {
  const rows = await db.roomTypeInventory.findMany({ where: { propertyId: session.propertyId } });
  const over = rows.filter((r) => r.sold + r.held > r.capacity - r.outOfOrder + r.overbookLimit);
  const sold = rows.reduce((a, r) => a + r.sold, 0);
  console.log(`${rows.length} room-type nights, ${sold} room nights sold.`);
  if (over.length > 0) {
    for (const r of over) {
      console.log(
        `✖ ${r.date.toISOString().slice(0, 10)}: sold ${r.sold} + held ${r.held} of ${r.capacity}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log('✔ No night sold beyond its rooms.');
  }
} finally {
  await db.$disconnect();
}
