import type { Prisma, RevenueGroup } from '../../generated/prisma/client.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Revenue codes the system posts to itself (T-063, T-065, T-072, T-073): moving money between
// ledgers and folios, and exchange differences. Created per property on first use; never
// offered for charges, and their lines are not reversed or discounted by hand.

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

export const SYSTEM_CODES = {
  DEPOSIT: { name: 'Advance deposit', group: 'OTHER' },
  TRANSFER: { name: 'Folio transfer', group: 'OTHER' },
  /** Exchange gain or loss when foreign money goes back out at another rate (T-072). */
  FX: { name: 'Exchange difference', group: 'FX' },
  /** A guaranteed guest who never came (night audit step 6, T-073). */
  NOSHOW: { name: 'No-show fee', group: 'FEE' },
  /** A cancellation fee per the plan's policy (T-074). */
  CANCEL: { name: 'Cancellation fee', group: 'FEE' },
  /** A guest who stayed past the check-out time (T-055). */
  LATE: { name: 'Late check-out fee', group: 'FEE' },
} as const satisfies Record<string, { name: string; group: RevenueGroup }>;

export type SystemCode = keyof typeof SYSTEM_CODES;

export const isSystemCode = (code: string): code is SystemCode => code in SYSTEM_CODES;

/** The property's revenue code for `code`, created when first needed. */
export async function systemCodeId(tx: Tx, code: SystemCode): Promise<string> {
  const found = await tx.revenueCode.findFirst({ where: { code } });
  if (found) return found.id;
  const created = await tx.revenueCode.create({
    data: {
      code,
      name: SYSTEM_CODES[code].name,
      group: SYSTEM_CODES[code].group,
    } as unknown as Prisma.RevenueCodeUncheckedCreateInput, // tenant IDs come from the client
  });
  return created.id;
}
