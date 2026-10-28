import type { Prisma } from '../../generated/prisma/client.ts';
import type { DbClient } from '../../core/db.ts';

// Revenue codes and taxes a new property starts with (T-032). Nigerian properties get the
// Lagos EXAMPLE rates, which the owner must confirm with their accountant: the S25 screen
// says so and the setup checklist's tax step stays open until they are confirmed. The order
// is the spec's fixture order (service → VAT on net + service → consumption tax on net).
//
// Philip, 2026-10-28: "Pre-fill Lagos examples (VAT 7.5%, consumption tax 5%, service charge
// 10%), clearly marked for me to confirm with my accountant."

export const EXAMPLE_TAXES = [
  {
    code: 'SVC',
    codeName: 'Service charge',
    group: 'SERVICE_CHARGE',
    name: 'Service charge',
    authority: 'Hotel',
    rateBps: 1000,
    basis: 'NET',
    sequence: 1,
  },
  {
    code: 'VAT',
    codeName: 'VAT',
    group: 'TAX',
    name: 'VAT',
    authority: 'FIRS',
    rateBps: 750,
    basis: 'NET_PLUS_PRIOR',
    sequence: 2,
  },
  {
    code: 'LCT',
    codeName: 'Lagos consumption tax',
    group: 'TAX',
    name: 'Lagos consumption tax',
    authority: 'LIRS',
    rateBps: 500,
    basis: 'NET',
    sequence: 3,
  },
] as const;

/** Income codes every property gets, with the example taxes each one carries. */
const INCOME_CODES = [
  { code: 'ROOM', name: 'Room revenue', group: 'ROOM', taxes: ['SVC', 'VAT', 'LCT'] },
  { code: 'FNB', name: 'Food and beverage', group: 'FNB', taxes: ['SVC', 'VAT', 'LCT'] },
  { code: 'MISC', name: 'Other charges', group: 'OTHER', taxes: ['VAT'] },
] as const;

/** Countries with example taxes; elsewhere the owner sets their own. */
const EXAMPLE_COUNTRIES = new Set(['NG']);

export interface TaxSettings {
  /** Started from EXAMPLE_TAXES. */
  examples?: boolean;
  confirmedAt?: string;
  confirmedById?: string;
}

export function taxSettingsOf(settings: Prisma.JsonValue): TaxSettings {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const taxes = (s as Record<string, unknown>)['taxes'];
  return taxes && typeof taxes === 'object' ? taxes : {};
}

/**
 * Creates the default revenue codes (and, in Nigeria, the example taxes from `from`, the
 * property's date). Does nothing if the property already has revenue codes.
 */
export async function createDefaultTaxes(
  db: DbClient,
  property: { id: string; country: string; settings: Prisma.JsonValue },
  from: string,
): Promise<void> {
  if ((await db.revenueCode.count({ where: { propertyId: property.id } })) > 0) return;
  const examples = EXAMPLE_COUNTRIES.has(property.country);
  const ruleIds = new Map<string, string>();

  if (examples) {
    for (const t of EXAMPLE_TAXES) {
      const code = await db.revenueCode.create({
        data: { propertyId: property.id, code: t.code, name: t.codeName, group: t.group },
      });
      const rule = await db.taxRule.create({
        data: {
          propertyId: property.id,
          name: t.name,
          authority: t.authority,
          revenueCodeId: code.id,
          versions: {
            create: {
              effectiveFrom: new Date(`${from}T00:00:00Z`),
              rateBps: t.rateBps,
              basis: t.basis,
              sequence: t.sequence,
            },
          },
        },
      });
      ruleIds.set(t.code, rule.id);
    }
  }
  await db.revenueCode.createMany({
    data: INCOME_CODES.map((c) => ({
      propertyId: property.id,
      code: c.code,
      name: c.name,
      group: c.group,
      taxRuleIds: c.taxes.flatMap((t) => (ruleIds.has(t) ? [ruleIds.get(t) as string] : [])),
    })),
  });
  if (examples) {
    const settings =
      property.settings &&
      typeof property.settings === 'object' &&
      !Array.isArray(property.settings)
        ? property.settings
        : {};
    await db.property.update({
      where: { id: property.id },
      data: { settings: { ...settings, taxes: { examples: true } } },
    });
  }
}
