import { formatQuantity, parseQuantity, type RecipeBook } from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { valueMinor } from '../stock/service.ts';
import type { RegisterDeps } from './register.ts';

// Recipes (PRD M8-07; T-157): what one of a menu item uses from stock, and where each outlet's
// sales take it from. Selling depletes stock in register.ts (depleteStock); this is the book.

type BookOut = z.input<typeof RecipeBook>;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

/** Cost as a share of the price, in basis points (null when the price is 0). */
const shareBps = (cost: bigint, price: bigint) =>
  price > 0n ? Number((cost * 10_000n + price / 2n) / price) : null;

export async function getRecipeBook(deps: Pick<RegisterDeps, 'tenantDb'>, tenant: TenantContext) {
  return book(deps.tenantDb, tenant.propertyId);
}

async function book(db: TenantDb, propertyId: string): Promise<BookOut> {
  const [property, outlets, stockItems, locations] = await Promise.all([
    db.property.findUniqueOrThrow({ where: { id: propertyId }, select: { baseCurrency: true } }),
    db.outlet.findMany({
      where: { active: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: {
        stockLocation: { select: { id: true, code: true, name: true } },
        categories: {
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            items: {
              orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
              include: {
                recipe: {
                  include: {
                    lines: {
                      include: { stockItem: { include: { unit: true } } },
                      orderBy: { stockItem: { name: 'asc' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
    db.stockItem.findMany({
      where: { active: true },
      include: { unit: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    }),
    db.stockLocation.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
  ]);
  return {
    currency: property.baseCurrency,
    outlets: outlets.map((o) => ({
      id: o.id,
      name: o.name,
      stockLocation: o.stockLocation,
      items: o.categories.flatMap((c) =>
        c.items.map((i) => {
          const lines = (i.recipe?.lines ?? []).map((l) => ({
            stockItemId: l.stockItemId,
            code: l.stockItem.code,
            name: l.stockItem.name,
            unit: l.stockItem.unit.code,
            quantity: formatQuantity(l.quantityMilli),
            costMinor: valueMinor(l.quantityMilli, l.stockItem.unitCostMinor),
          }));
          const cost = lines.reduce((s, l) => s + l.costMinor, 0n);
          return {
            menuItemId: i.id,
            name: i.name,
            category: c.name,
            priceMinor: i.priceMinor.toString(),
            active: i.active,
            recipe:
              lines.length > 0
                ? {
                    lines: lines.map((l) => ({ ...l, costMinor: l.costMinor.toString() })),
                    costMinor: cost.toString(),
                    costBps: shareBps(cost, i.priceMinor),
                  }
                : null,
          };
        }),
      ),
    })),
    stockItems: stockItems.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      unit: s.unit.code,
      unitCostMinor: s.unitCostMinor.toString(),
    })),
    locations: locations.map((l) => ({ id: l.id, code: l.code, name: l.name })),
  };
}

/** Replaces a menu item's recipe (no lines: no recipe). Applies to sales from now on. */
export async function setRecipe(
  deps: Pick<RegisterDeps, 'tenantDb' | 'clock'>,
  tenant: TenantContext,
  menuItemId: string,
  body: { lines: { stockItemId: string; quantity: string }[] },
): Promise<BookOut> {
  await deps.tenantDb.$transaction(async (tx) => {
    const item = await tx.menuItem.findFirst({ where: { id: menuItemId } });
    if (!item) throw new AppError('NOT_FOUND', 'Menu item not found');
    const ids = body.lines.map((l) => l.stockItemId);
    const found = await tx.stockItem.count({ where: { id: { in: ids }, active: true } });
    if (found !== ids.length) {
      throw invalid('body.lines', 'Choose active stock items of this property');
    }
    const before = await tx.recipe.findUnique({
      where: { menuItemId },
      include: { lines: true },
    });
    if (before) await tx.recipe.delete({ where: { id: before.id } });
    if (body.lines.length > 0) {
      await tx.recipe.create({
        data: {
          menuItemId,
          updatedAt: deps.clock(),
          updatedById: tenant.userId,
          lines: {
            create: body.lines.map((l) => ({
              stockItemId: l.stockItemId,
              quantityMilli: parseQuantity(l.quantity) ?? 0n,
              propertyId: tenant.propertyId,
            })),
          },
        } as unknown as Prisma.RecipeUncheckedCreateInput, // tenant IDs come from the client
      });
    }
    const lines = (ls: { stockItemId: string; quantityMilli: bigint }[]) =>
      ls.map((l) => ({ stockItemId: l.stockItemId, quantity: formatQuantity(l.quantityMilli) }));
    await recordAudit(tx, {
      action: 'pos.recipe_set',
      entityType: 'menu_item',
      entityId: menuItemId,
      before: { lines: lines(before?.lines ?? []) },
      after: { lines: body.lines },
    });
  });
  return book(deps.tenantDb, tenant.propertyId);
}

/** Where an outlet's sales take stock from (null: they use none). */
export async function setOutletStockLocation(
  deps: Pick<RegisterDeps, 'tenantDb'>,
  tenant: TenantContext,
  outletId: string,
  body: { stockLocationId: string | null },
): Promise<BookOut> {
  await deps.tenantDb.$transaction(async (tx) => {
    const outlet = await tx.outlet.findFirst({ where: { id: outletId } });
    if (!outlet) throw new AppError('NOT_FOUND', 'Outlet not found');
    if (body.stockLocationId) {
      const location = await tx.stockLocation.findFirst({
        where: { id: body.stockLocationId, active: true },
      });
      if (!location) {
        throw invalid('body.stockLocationId', 'Choose an active stock location of this property');
      }
    }
    await tx.outlet.update({
      where: { id: outletId },
      data: { stockLocationId: body.stockLocationId },
    });
    await recordAudit(tx, {
      action: 'pos.outlet_stock_location_set',
      entityType: 'outlet',
      entityId: outletId,
      before: { stockLocationId: outlet.stockLocationId },
      after: { stockLocationId: body.stockLocationId },
    });
  });
  return book(deps.tenantDb, tenant.propertyId);
}
