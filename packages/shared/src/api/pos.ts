import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Uuid } from './primitives.ts';

// Lite POS setup (PRD M8-01 "As a manager, I set up outlets, menu categories, items,
// modifiers, prices and revenue codes", pos.setup; tab 3 outlets, menu_categories,
// menu_items, modifiers; T-141). Prices are in the property's base currency and post to the
// item's revenue code, whose tax rules apply as on any folio charge. Nothing is deleted:
// outlets, categories, items and modifiers are switched off, so past orders keep them.

const Name = z.string().trim().min(1).max(80);
const Price = AmountMinor.refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, 'More than zero');
const PriceOrZero = AmountMinor.refine((v) => /^\d+$/.test(v), 'Zero or more');
const Optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();

export const MenuModifierItem = z
  .object({ id: Uuid, name: z.string(), priceMinor: AmountMinor, active: z.boolean() })
  .meta({ id: 'MenuModifier' });

export const MenuItemItem = z
  .object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    priceMinor: AmountMinor,
    revenueCode: z.object({ id: Uuid, code: z.string(), name: z.string() }),
    sortOrder: z.number().int(),
    active: z.boolean(),
    modifiers: z.array(MenuModifierItem),
  })
  .meta({ id: 'MenuItem' });

export const MenuCategoryItem = z
  .object({
    id: Uuid,
    name: z.string(),
    sortOrder: z.number().int(),
    active: z.boolean(),
    items: z.array(MenuItemItem),
  })
  .meta({ id: 'MenuCategory' });

export const OutletItem = z
  .object({
    id: Uuid,
    code: z.string(),
    name: z.string(),
    active: z.boolean(),
    categories: z.array(MenuCategoryItem),
  })
  .meta({ id: 'Outlet' });

const Setup = z.object({
  data: z.array(OutletItem),
  currency: z.string(),
  /** Active revenue codes to post items to. */
  revenueCodes: z.array(
    z.object({ id: Uuid, code: z.string(), name: z.string(), group: z.string() }),
  ),
});

const SETUP = { tags: ['POS'], propertyScoped: true as const, permission: 'pos.setup' };
const ADDED = 'Tab 3 names the tables; the routes are designed in T-141.';

export const listOutlets = defineRoute({
  ...SETUP,
  operationId: 'listOutlets',
  method: 'get',
  path: '/outlets',
  summary: 'Outlets with their full menus, switched-off entries included (M8-01)',
  description: ADDED,
  response: Setup,
});

export const createOutlet = defineRoute({
  ...SETUP,
  operationId: 'createOutlet',
  method: 'post',
  path: '/outlets',
  summary: 'Add an outlet (M8-01)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: z.object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,12}$/, '2 to 12 letters, digits or dashes'),
    name: Name,
  }),
  response: OutletItem,
});

export const updateOutlet = defineRoute({
  ...SETUP,
  operationId: 'updateOutlet',
  method: 'patch',
  path: '/outlets/{outletId}',
  summary: 'Rename an outlet, or switch it off or on (M8-01)',
  description: ADDED,
  params: z.object({ outletId: Uuid }),
  body: z.object({ name: Name.optional(), active: z.boolean().optional() }),
  response: OutletItem,
});

export const addMenuCategory = defineRoute({
  ...SETUP,
  operationId: 'addMenuCategory',
  method: 'post',
  path: '/outlets/{outletId}/categories',
  summary: "Add a section to an outlet's menu (M8-01)",
  description: ADDED,
  idempotent: true,
  status: 201,
  params: z.object({ outletId: Uuid }),
  body: z.object({ name: Name, sortOrder: z.number().int().min(0).max(999).default(0) }),
  response: OutletItem,
});

export const updateMenuCategory = defineRoute({
  ...SETUP,
  operationId: 'updateMenuCategory',
  method: 'patch',
  path: '/menu-categories/{categoryId}',
  summary: 'Rename, reorder or switch a menu section (M8-01)',
  description: ADDED,
  params: z.object({ categoryId: Uuid }),
  body: z.object({
    name: Name.optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    active: z.boolean().optional(),
  }),
  response: OutletItem,
});

export const addMenuItem = defineRoute({
  ...SETUP,
  operationId: 'addMenuItem',
  method: 'post',
  path: '/menu-categories/{categoryId}/items',
  summary: 'Add an item with its price and revenue code (M8-01)',
  description: ADDED,
  idempotent: true,
  status: 201,
  params: z.object({ categoryId: Uuid }),
  body: z.object({
    name: Name,
    description: Optional(300).default(null),
    priceMinor: Price,
    revenueCodeId: Uuid,
    sortOrder: z.number().int().min(0).max(999).default(0),
  }),
  response: OutletItem,
});

export const updateMenuItem = defineRoute({
  ...SETUP,
  operationId: 'updateMenuItem',
  method: 'patch',
  path: '/menu-items/{itemId}',
  summary: 'Change an item, its price or revenue code, or switch it (M8-01)',
  description: `${ADDED} Price and revenue code changes are audited.`,
  params: z.object({ itemId: Uuid }),
  body: z.object({
    name: Name.optional(),
    description: Optional(300).optional(),
    priceMinor: Price.optional(),
    revenueCodeId: Uuid.optional(),
    categoryId: Uuid.optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    active: z.boolean().optional(),
  }),
  response: OutletItem,
});

export const addMenuModifier = defineRoute({
  ...SETUP,
  operationId: 'addMenuModifier',
  method: 'post',
  path: '/menu-items/{itemId}/modifiers',
  summary: 'Add an option to an item, free or priced (M8-01)',
  description: ADDED,
  idempotent: true,
  status: 201,
  params: z.object({ itemId: Uuid }),
  body: z.object({ name: Name, priceMinor: PriceOrZero.default('0') }),
  response: OutletItem,
});

export const updateMenuModifier = defineRoute({
  ...SETUP,
  operationId: 'updateMenuModifier',
  method: 'patch',
  path: '/modifiers/{modifierId}',
  summary: 'Change an option or switch it (M8-01)',
  description: ADDED,
  params: z.object({ modifierId: Uuid }),
  body: z.object({
    name: Name.optional(),
    priceMinor: PriceOrZero.optional(),
    active: z.boolean().optional(),
  }),
  response: OutletItem,
});

export const POS_ROUTES = {
  listOutlets,
  createOutlet,
  updateOutlet,
  addMenuCategory,
  updateMenuCategory,
  addMenuItem,
  updateMenuItem,
  addMenuModifier,
  updateMenuModifier,
} as const;
