import { housekeepingSettingsOf, type HousekeepingSettings } from '@hotel/shared';
import { recordAudit } from '../../core/audit.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Housekeeping settings (T-129): whether rooms must pass inspection before a guest gets them
// (M5 rule 1 "INSPECTED (if inspection on)"). Kept in the property settings under
// `housekeeping`; off until the hotel turns it on.

type Client = TenantDb | Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

export async function housekeepingSettings(
  db: Client,
  propertyId: string,
): Promise<HousekeepingSettings> {
  const p = await db.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { settings: true },
  });
  return housekeepingSettingsOf(p.settings);
}

/** Only INSPECTED rooms are ready for a guest at this property. */
export async function inspectionRequired(db: Client, propertyId: string): Promise<boolean> {
  return (await housekeepingSettings(db, propertyId)).inspectionRequired;
}

export async function updateHousekeepingSettings(
  deps: { tenantDb: TenantDb },
  tenant: TenantContext,
  body: HousekeepingSettings,
): Promise<HousekeepingSettings> {
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM properties WHERE id = ${tenant.propertyId}::uuid FOR UPDATE`;
    const p = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
    const settings = (p.settings ?? {}) as Record<string, unknown>;
    const before = housekeepingSettingsOf(settings);
    await tx.property.update({
      where: { id: tenant.propertyId },
      data: { settings: { ...settings, housekeeping: body } as never },
    });
    if (before.inspectionRequired !== body.inspectionRequired) {
      await recordAudit(tx, {
        action: 'housekeeping.settings_updated',
        entityType: 'property',
        entityId: tenant.propertyId,
        before,
        after: body,
      });
    }
    return body;
  });
}
