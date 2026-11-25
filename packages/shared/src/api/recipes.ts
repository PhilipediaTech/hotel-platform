import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Uuid } from './primitives.ts';
import { parseQuantity, Quantity } from './stock.ts';

// Recipes (PRD M8-07 "As a manager, I link recipes to stock items so sales deplete stock",
// pos.recipe; tab 3 recipes, recipe_lines; T-157). A menu item's recipe says what one of it
// uses from stock; each outlet names the stock location its sales take from. When an order is
// settled or charged to a room, each item sold takes its recipe's stock out of that location
// (SALE movements). A sale is never refused for stock: a location can go below zero, and the
// stocktake shows the difference. The book shows each recipe's cost against the price.

const Positive = Quantity.refine((v) => (parseQuantity(v) ?? 0n) > 0n, 'More than zero');

export const RecipeBook = z
  .object({
    currency: z.string(),
    outlets: z.array(
      z.object({
        id: Uuid,
        name: z.string(),
        /** Where its sales take stock from; null: its sales use no stock. */
        stockLocation: z.object({ id: Uuid, code: z.string(), name: z.string() }).nullable(),
        items: z.array(
          z.object({
            menuItemId: Uuid,
            name: z.string(),
            category: z.string(),
            priceMinor: AmountMinor,
            active: z.boolean(),
            recipe: z
              .object({
                lines: z.array(
                  z.object({
                    stockItemId: Uuid,
                    code: z.string(),
                    name: z.string(),
                    unit: z.string(),
                    /** For one sold, in the stock item's unit. */
                    quantity: Quantity,
                    costMinor: AmountMinor,
                  }),
                ),
                /** What one sold costs in stock, at today's unit costs. */
                costMinor: AmountMinor,
                /** That cost as a share of the price, in basis points (3000 = 30%). */
                costBps: z.number().int().nullable(),
              })
              .nullable(),
          }),
        ),
      }),
    ),
    /** Active stock items a recipe can use. */
    stockItems: z.array(
      z.object({
        id: Uuid,
        code: z.string(),
        name: z.string(),
        unit: z.string(),
        unitCostMinor: AmountMinor,
      }),
    ),
    /** Active stock locations an outlet can take from. */
    locations: z.array(z.object({ id: Uuid, code: z.string(), name: z.string() })),
  })
  .meta({ id: 'RecipeBook' });

const RECIPE = { tags: ['POS'], propertyScoped: true as const, permission: 'pos.recipe' };
const ADDED = 'Not in tab 4 (tab 3 names recipes, recipe_lines): designed in T-157.';

export const getRecipeBook = defineRoute({
  ...RECIPE,
  operationId: 'getRecipeBook',
  method: 'get',
  path: '/recipes',
  summary: 'Every outlet’s menu items with their recipes and costs, and where they take stock',
  description: ADDED,
  response: RecipeBook,
});

export const setRecipe = defineRoute({
  ...RECIPE,
  operationId: 'setRecipe',
  method: 'put',
  path: '/menu-items/{menuItemId}/recipe',
  summary: 'Set what one of a menu item uses from stock (no lines: no recipe)',
  description: `${ADDED} Replaces the recipe as a whole; applies to sales from then on.`,
  params: z.object({ menuItemId: Uuid }),
  body: z.object({
    lines: z
      .array(z.object({ stockItemId: Uuid, quantity: Positive }))
      .max(30)
      .refine(
        (lines) => new Set(lines.map((l) => l.stockItemId)).size === lines.length,
        'Each stock item once',
      ),
  }),
  response: RecipeBook,
});

export const setOutletStockLocation = defineRoute({
  ...RECIPE,
  operationId: 'setOutletStockLocation',
  method: 'put',
  path: '/outlets/{outletId}/stock-location',
  summary: 'Choose where an outlet’s sales take stock from (null: none)',
  description: ADDED,
  params: z.object({ outletId: Uuid }),
  body: z.object({ stockLocationId: Uuid.nullable() }),
  response: RecipeBook,
});

export const RECIPE_ROUTES = { getRecipeBook, setRecipe, setOutletStockLocation } as const;
