import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';

// Revenue codes, tax rules and their dated versions (tab 4 row "Tax and FX"; PRD M4-17;
// S25; T-032). Lists are open to everyone at the property (charges are posted to codes);
// changes need tax.manage. Exchange rates arrive with T-065.

const TAX = 'tax.manage';

export const REVENUE_GROUPS = [
  'ROOM',
  'FNB',
  'OTHER',
  'TAX',
  'SERVICE_CHARGE',
  'FX',
  'FEE',
] as const;
/** Groups whose codes carry tax lines; they have no taxes of their own. */
export const TAX_LINE_GROUPS = ['TAX', 'SERVICE_CHARGE'] as const;
export const TAX_BASES = ['NET', 'NET_PLUS_PRIOR'] as const;

const Text = (max: number) => z.string().trim().min(1).max(max);
const UniqueIds = z
  .array(Uuid)
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, 'Each tax once');

// ── Revenue codes ──────────────────────────────────────────────────────────────────────

export const RevenueCodeItem = z
  .object({
    id: Uuid,
    code: z.string(),
    name: z.string(),
    group: z.enum(REVENUE_GROUPS),
    /** Taxes on lines of this code, applied in their versions' sequence order. */
    taxRuleIds: z.array(Uuid),
    active: z.boolean(),
  })
  .meta({ id: 'RevenueCode' });

export const RevenueCodeBody = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{2,12}$/, 'Two to twelve letters, digits, dashes or underscores'),
  name: Text(80),
  group: z.enum(REVENUE_GROUPS),
  taxRuleIds: UniqueIds.default([]),
});

/** Code and group are fixed: posted lines keep pointing at them. */
export const RevenueCodePatchBody = z
  .object({ name: Text(80), taxRuleIds: UniqueIds, active: z.boolean() })
  .partial();

export const listRevenueCodes = defineRoute({
  operationId: 'listRevenueCodes',
  method: 'get',
  path: '/revenue-codes',
  summary: 'Revenue codes of the property',
  tags: ['Tax'],
  propertyScoped: true,
  response: z.object({ data: z.array(RevenueCodeItem) }),
});

export const createRevenueCode = defineRoute({
  operationId: 'createRevenueCode',
  method: 'post',
  path: '/revenue-codes',
  summary: 'Add a revenue code',
  tags: ['Tax'],
  propertyScoped: true,
  permission: TAX,
  body: RevenueCodeBody,
  status: 201,
  response: RevenueCodeItem,
});

export const updateRevenueCode = defineRoute({
  operationId: 'updateRevenueCode',
  method: 'patch',
  path: '/revenue-codes/{revenueCodeId}',
  summary: 'Rename a revenue code, change its taxes, or deactivate it',
  tags: ['Tax'],
  propertyScoped: true,
  permission: TAX,
  params: z.object({ revenueCodeId: Uuid }),
  body: RevenueCodePatchBody,
  response: RevenueCodeItem,
});

// ── Tax rules ──────────────────────────────────────────────────────────────────────────

export const TaxVersionItem = z
  .object({
    id: Uuid,
    effectiveFrom: IsoDate,
    /** Exclusive; null = in force until a newer version starts. */
    effectiveTo: IsoDate.nullable(),
    /** Basis points: 750 = 7.5%. */
    rateBps: z.number().int(),
    /** NET, or NET_PLUS_PRIOR = net plus every tax with a lower sequence. */
    basis: z.enum(TAX_BASES),
    sequence: z.number().int(),
    /** The tax is inside the line amount rather than added on top. */
    inclusive: z.boolean(),
    createdAt: Instant,
  })
  .meta({ id: 'TaxRuleVersion' });

export const TaxRuleItem = z
  .object({
    id: Uuid,
    name: z.string(),
    /** Who the tax is paid to, e.g. FIRS; "Hotel" for a service charge. */
    authority: z.string(),
    /** The code its tax lines post to. */
    revenueCodeId: Uuid,
    /** Oldest first. */
    versions: z.array(TaxVersionItem),
    /** The version in force today (property date), if any. */
    currentVersionId: Uuid.nullable(),
  })
  .meta({ id: 'TaxRule' });

export const TaxConfirmation = z
  .object({
    /** The rules started from the platform's example rates (Lagos), not the hotel's own. */
    examples: z.boolean(),
    confirmedAt: Instant.nullable(),
    confirmedBy: z.object({ id: Uuid, name: z.string() }).nullable(),
  })
  .meta({ id: 'TaxConfirmation' });

export const TaxVersionBody = z.object({
  /** Today (property date) or later; versions never reach back. */
  effectiveFrom: IsoDate,
  rateBps: z.number().int().min(0).max(10_000),
  basis: z.enum(TAX_BASES).default('NET'),
  sequence: z.number().int().min(1).max(99),
  inclusive: z.boolean().default(false),
});

export const TaxRuleBody = z.object({
  name: Text(80),
  authority: Text(80),
  revenueCodeId: Uuid,
  version: TaxVersionBody,
});

export const listTaxRules = defineRoute({
  operationId: 'listTaxRules',
  method: 'get',
  path: '/tax-rules',
  summary: 'Tax rules with their versions, and whether the rates were confirmed',
  tags: ['Tax'],
  propertyScoped: true,
  response: z.object({ data: z.array(TaxRuleItem), confirmation: TaxConfirmation }),
});

export const createTaxRule = defineRoute({
  operationId: 'createTaxRule',
  method: 'post',
  path: '/tax-rules',
  summary: 'Add a tax or service charge with its first version',
  tags: ['Tax'],
  propertyScoped: true,
  permission: TAX,
  body: TaxRuleBody,
  status: 201,
  response: TaxRuleItem,
});

export const addTaxRuleVersion = defineRoute({
  operationId: 'addTaxRuleVersion',
  method: 'post',
  path: '/tax-rules/{taxRuleId}/versions',
  summary: 'Change a tax from a date: new rate, basis, order or inclusiveness',
  description:
    'The version in force ends the day before. Earlier versions never change, so lines already posted keep their taxes (PRD M4 rule 1). A rate of 0 ends a tax.',
  tags: ['Tax'],
  propertyScoped: true,
  permission: TAX,
  params: z.object({ taxRuleId: Uuid }),
  body: TaxVersionBody,
  status: 201,
  response: TaxRuleItem,
});

export const confirmTaxes = defineRoute({
  operationId: 'confirmTaxes',
  method: 'post',
  path: '/tax-rules/confirm',
  summary: 'Record that the tax rules and rates were checked (setup checklist)',
  tags: ['Tax'],
  propertyScoped: true,
  permission: TAX,
  response: TaxConfirmation,
});

export const TAX_ROUTES = {
  listRevenueCodes,
  createRevenueCode,
  updateRevenueCode,
  listTaxRules,
  createTaxRule,
  addTaxRuleVersion,
  confirmTaxes,
} as const;
