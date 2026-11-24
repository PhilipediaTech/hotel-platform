import type { OutletItem } from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Lite POS setup (PRD M8-01; T-141). Tab 3 names outlets, menu_categories, menu_items and
// modifiers without columns: designed here. Every change answers the whole outlet, menu
// included. Nothing is deleted; entries are switched off. Price and revenue code changes,
// and switching anything off or on, are audited.

export interface PosDeps {
  tenantDb: TenantDb;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
  });

const OUTLET_INCLUDE = {
  categories: {
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      items: {
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: {
          revenueCode: { select: { id: true, code: true, name: true } },
          modifiers: { orderBy: { name: 'asc' } },
        },
      },
    },
  },
} as const satisfies Prisma.OutletInclude;
type OutletRow = Prisma.OutletGetPayload<{ include: typeof OUTLET_INCLUDE }>;

function outletItem(o: OutletRow): z.input<typeof OutletItem> {
  return {
    id: o.id,
    code: o.code,
    name: o.name,
    active: o.active,
    categories: o.categories.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      active: c.active,
      kitchenStation: c.kitchenStation,
      items: c.items.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        priceMinor: i.priceMinor.toString(),
        revenueCode: i.revenueCode,
        sortOrder: i.sortOrder,
        active: i.active,
        modifiers: i.modifiers.map((m) => ({
          id: m.id,
          name: m.name,
          priceMinor: m.priceMinor.toString(),
          active: m.active,
        })),
      })),
    })),
  };
}

async function outletView(db: Client, outletId: string) {
  const o = await db.outlet.findFirstOrThrow({ where: { id: outletId }, include: OUTLET_INCLUDE });
  return outletItem(o);
}

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function checkRevenueCode(tx: Client, revenueCodeId: string, path: string) {
  const code = await tx.revenueCode.findFirst({ where: { id: revenueCodeId, active: true } });
  if (!code) throw invalid(path, 'Choose an active revenue code of this property');
}

export async function listOutlets(deps: PosDeps, tenant: TenantContext) {
  const [outlets, codes, property] = await Promise.all([
    deps.tenantDb.outlet.findMany({ include: OUTLET_INCLUDE, orderBy: { name: 'asc' } }),
    deps.tenantDb.revenueCode.findMany({ where: { active: true }, orderBy: { code: 'asc' } }),
    deps.tenantDb.property.findUniqueOrThrow({ where: { id: tenant.propertyId } }),
  ]);
  return {
    data: outlets.map(outletItem),
    currency: property.baseCurrency,
    revenueCodes: codes.map((c) => ({ id: c.id, code: c.code, name: c.name, group: c.group })),
  };
}

export async function createOutlet(deps: PosDeps, body: { code: string; name: string }) {
  return deps.tenantDb.$transaction(async (tx) => {
    const taken = await tx.outlet.findFirst({ where: { code: body.code } });
    if (taken) throw invalid('body.code', `${body.code} is already an outlet here`);
    const o = await tx.outlet.create({
      data: { code: body.code, name: body.name } as unknown as Prisma.OutletUncheckedCreateInput,
    });
    await recordAudit(tx, {
      action: 'pos.outlet_created',
      entityType: 'outlet',
      entityId: o.id,
      after: body,
    });
    return outletView(tx, o.id);
  });
}

export async function updateOutlet(
  deps: PosDeps,
  outletId: string,
  body: { name?: string | undefined; active?: boolean | undefined },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.outlet.findFirst({ where: { id: outletId } });
    if (!before) throw new AppError('NOT_FOUND', 'Outlet not found.');
    const after = await tx.outlet.update({ where: { id: outletId }, data: defined(body) });
    await recordAudit(tx, {
      action: 'pos.outlet_updated',
      entityType: 'outlet',
      entityId: outletId,
      before: { name: before.name, active: before.active },
      after: { name: after.name, active: after.active },
    });
    return outletView(tx, outletId);
  });
}

async function categoryOf(tx: Client, categoryId: string) {
  const c = await tx.menuCategory.findFirst({ where: { id: categoryId } });
  if (!c) throw new AppError('NOT_FOUND', 'Menu section not found.');
  return c;
}

async function sameCategoryName(tx: Client, outletId: string, name: string, except: string | null) {
  const taken = await tx.menuCategory.findFirst({
    where: {
      outletId,
      name: { equals: name, mode: 'insensitive' },
      ...(except ? { id: { not: except } } : {}),
    },
  });
  if (taken) throw invalid('body.name', 'This outlet already has a section by that name');
}

export async function addMenuCategory(
  deps: PosDeps,
  outletId: string,
  body: { name: string; sortOrder: number },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const outlet = await tx.outlet.findFirst({ where: { id: outletId } });
    if (!outlet) throw new AppError('NOT_FOUND', 'Outlet not found.');
    await sameCategoryName(tx, outletId, body.name, null);
    await tx.menuCategory.create({
      data: { outletId, ...body } as unknown as Prisma.MenuCategoryUncheckedCreateInput,
    });
    return outletView(tx, outletId);
  });
}

export async function updateMenuCategory(
  deps: PosDeps,
  categoryId: string,
  body: { name?: string | undefined; sortOrder?: number | undefined; active?: boolean | undefined },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const c = await categoryOf(tx, categoryId);
    if (body.name) await sameCategoryName(tx, c.outletId, body.name, c.id);
    await tx.menuCategory.update({ where: { id: c.id }, data: defined(body) });
    if (body.active !== undefined && body.active !== c.active) {
      await recordAudit(tx, {
        action: body.active ? 'pos.category_on' : 'pos.category_off',
        entityType: 'outlet',
        entityId: c.outletId,
        after: { categoryId: c.id, name: c.name },
      });
    }
    return outletView(tx, c.outletId);
  });
}

async function itemOf(tx: Client, itemId: string) {
  const i = await tx.menuItem.findFirst({ where: { id: itemId }, include: { category: true } });
  if (!i) throw new AppError('NOT_FOUND', 'Menu item not found.');
  return i;
}

export async function addMenuItem(
  deps: PosDeps,
  categoryId: string,
  body: {
    name: string;
    description: string | null;
    priceMinor: string;
    revenueCodeId: string;
    sortOrder: number;
  },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const c = await categoryOf(tx, categoryId);
    await checkRevenueCode(tx, body.revenueCodeId, 'body.revenueCodeId');
    const item = await tx.menuItem.create({
      data: {
        categoryId: c.id,
        name: body.name,
        description: body.description,
        priceMinor: BigInt(body.priceMinor),
        revenueCodeId: body.revenueCodeId,
        sortOrder: body.sortOrder,
      } as unknown as Prisma.MenuItemUncheckedCreateInput,
    });
    await recordAudit(tx, {
      action: 'pos.item_created',
      entityType: 'menu_item',
      entityId: item.id,
      after: { name: body.name, priceMinor: body.priceMinor, revenueCodeId: body.revenueCodeId },
    });
    return outletView(tx, c.outletId);
  });
}

export async function updateMenuItem(
  deps: PosDeps,
  itemId: string,
  body: {
    name?: string | undefined;
    description?: string | null | undefined;
    priceMinor?: string | undefined;
    revenueCodeId?: string | undefined;
    categoryId?: string | undefined;
    sortOrder?: number | undefined;
    active?: boolean | undefined;
  },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await itemOf(tx, itemId);
    if (body.revenueCodeId) await checkRevenueCode(tx, body.revenueCodeId, 'body.revenueCodeId');
    if (body.categoryId) {
      const target = await categoryOf(tx, body.categoryId);
      if (target.outletId !== before.category.outletId) {
        throw invalid('body.categoryId', 'Move it to a section of the same outlet');
      }
    }
    const { priceMinor, ...rest } = body;
    const after = await tx.menuItem.update({
      where: { id: itemId },
      data: {
        ...defined(rest),
        ...(priceMinor !== undefined ? { priceMinor: BigInt(priceMinor) } : {}),
      },
    });
    const watched = {
      priceMinor: [before.priceMinor.toString(), after.priceMinor.toString()],
      revenueCodeId: [before.revenueCodeId, after.revenueCodeId],
      active: [before.active, after.active],
      name: [before.name, after.name],
    } as const;
    const changed = Object.entries(watched).filter(([, [a, b]]) => a !== b);
    if (changed.length > 0) {
      await recordAudit(tx, {
        action: 'pos.item_updated',
        entityType: 'menu_item',
        entityId: itemId,
        before: Object.fromEntries(changed.map(([k, [a]]) => [k, a])),
        after: Object.fromEntries(changed.map(([k, [, b]]) => [k, b])),
      });
    }
    return outletView(tx, before.category.outletId);
  });
}

export async function addMenuModifier(
  deps: PosDeps,
  itemId: string,
  body: { name: string; priceMinor: string },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const item = await itemOf(tx, itemId);
    const taken = await tx.menuModifier.findFirst({
      where: { itemId, name: { equals: body.name, mode: 'insensitive' } },
    });
    if (taken) throw invalid('body.name', 'This item already has that option');
    await tx.menuModifier.create({
      data: {
        itemId,
        name: body.name,
        priceMinor: BigInt(body.priceMinor),
      } as unknown as Prisma.MenuModifierUncheckedCreateInput,
    });
    return outletView(tx, item.category.outletId);
  });
}

export async function updateMenuModifier(
  deps: PosDeps,
  modifierId: string,
  body: {
    name?: string | undefined;
    priceMinor?: string | undefined;
    active?: boolean | undefined;
  },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const m = await tx.menuModifier.findFirst({
      where: { id: modifierId },
      include: { item: { include: { category: true } } },
    });
    if (!m) throw new AppError('NOT_FOUND', 'Option not found.');
    if (body.name) {
      const taken = await tx.menuModifier.findFirst({
        where: {
          itemId: m.itemId,
          name: { equals: body.name, mode: 'insensitive' },
          id: { not: m.id },
        },
      });
      if (taken) throw invalid('body.name', 'This item already has that option');
    }
    const { priceMinor, ...rest } = body;
    const after = await tx.menuModifier.update({
      where: { id: m.id },
      data: {
        ...defined(rest),
        ...(priceMinor !== undefined ? { priceMinor: BigInt(priceMinor) } : {}),
      },
    });
    if (after.priceMinor !== m.priceMinor) {
      await recordAudit(tx, {
        action: 'pos.modifier_price_changed',
        entityType: 'menu_item',
        entityId: m.itemId,
        before: { modifier: m.name, priceMinor: m.priceMinor.toString() },
        after: { modifier: after.name, priceMinor: after.priceMinor.toString() },
      });
    }
    return outletView(tx, m.item.category.outletId);
  });
}
