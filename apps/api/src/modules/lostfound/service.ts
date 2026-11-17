import {
  addDays,
  KEEP_DAYS,
  KEEP_DAYS_VALUABLE,
  localDate,
  LOST_CATEGORIES,
  VALUABLE_DISPOSALS,
  type CustodyBody,
  type Disposal,
  type DisposeBody,
  type LostItem,
  type LostItemBody,
  type LostItemDetail,
  type LostStatus,
  type ReturnBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Lost and found (PRD M5-13; T-133). lost_found_items is listed for V1.1 in tab 3 without
// columns: they are designed here, with lost_found_events as the custody trail (append-only).
// An item is HELD (a storage place and a custodian) until it is RETURNED to its owner or, past
// its keep-until date, DISPOSED of. Found in a room, it is linked to the stay that had the room
// then (in house, or checked out up to three days before), so the desk can call the guest.

export interface LostFoundDeps {
  /** For the custodian list (members are read across the organisation). */
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;

const PERSON = { select: { id: true, name: true } } as const;
const ITEM_INCLUDE = {
  room: { select: { id: true, number: true } },
  stay: {
    select: {
      id: true,
      checkedOutAt: true,
      guest: { select: { firstName: true, lastName: true, phone: true } },
    },
  },
  foundBy: PERSON,
  custodian: PERSON,
  closedBy: PERSON,
} as const satisfies Prisma.LostFoundItemInclude;
type ItemRow = Prisma.LostFoundItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
/** How long after check-out a guest is still the likely owner of what is found in the room. */
const OWNER_WINDOW_MS = 3 * 86_400_000;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

async function timeZoneOf(db: Client, propertyId: string) {
  const rows = await db.$queryRaw<{ time_zone: string }[]>`
    SELECT time_zone FROM properties WHERE id = ${propertyId}::uuid`;
  return rows[0]?.time_zone ?? 'Africa/Lagos';
}

function itemOf(i: ItemRow, today: string): z.input<typeof LostItem> {
  const keepUntil = day(i.keepUntil);
  return {
    id: i.id,
    number: i.number,
    description: i.description,
    category: i.category,
    valuable: i.valuable,
    foundAt: iso(i.foundAt),
    foundWhere: i.foundWhere,
    room: i.room,
    owner: i.stay
      ? {
          stayId: i.stay.id,
          guestName: `${i.stay.guest.firstName} ${i.stay.guest.lastName}`.trim(),
          phone: i.stay.guest.phone,
          checkedOutAt: i.stay.checkedOutAt ? iso(i.stay.checkedOutAt) : null,
        }
      : null,
    foundBy: i.foundBy,
    storageLocation: i.storageLocation,
    custodian: i.custodian,
    status: i.status as LostStatus,
    keepUntil,
    canDispose: i.status === 'HELD' && keepUntil < today,
    returnedToName: i.returnedToName,
    disposal: (i.disposal as Disposal | null) ?? null,
    closedAt: i.closedAt ? iso(i.closedAt) : null,
  };
}

async function detailOf(
  db: Client,
  tenant: TenantContext,
  clock: Clock,
  itemId: string,
): Promise<z.input<typeof LostItemDetail>> {
  const item = await db.lostFoundItem.findFirst({
    where: { id: itemId },
    include: {
      ...ITEM_INCLUDE,
      events: { include: { custodian: PERSON, byUser: PERSON }, orderBy: { id: 'asc' } },
    },
  });
  if (!item) throw new AppError('NOT_FOUND', 'Item not found.');
  const today = localDate(clock(), await timeZoneOf(db, tenant.propertyId));
  return {
    ...itemOf(item, today),
    returnedToPhone: item.returnedToPhone,
    returnedIdNote: item.returnedIdNote,
    closedBy: item.closedBy,
    events: item.events.map((e) => ({
      kind: e.kind as z.input<typeof LostItemDetail>['events'][number]['kind'],
      note: e.note,
      storageLocation: e.storageLocation,
      custodian: e.custodian,
      by: e.byUser,
      at: iso(e.at),
    })),
  };
}

/** Active members of this property whose role has lostfound.manage. */
export async function custodiansOf(db: Db, tenant: TenantContext) {
  const members = await db.membership.findMany({
    where: {
      active: true,
      organisationId: tenant.organisationId,
      OR: [{ propertyId: tenant.propertyId }, { propertyId: null }],
      user: { status: 'ACTIVE' },
      role: { permissions: { has: 'lostfound.manage' } },
    },
    include: { user: PERSON },
  });
  const people = new Map(members.map((m) => [m.user.id, m.user]));
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function checkCustodian(deps: LostFoundDeps, tenant: TenantContext, userId: string) {
  const people = await custodiansOf(deps.db, tenant);
  if (!people.some((p) => p.id === userId)) {
    throw invalid('custodianId', 'Choose someone at this property who handles lost and found');
  }
}

export async function listItems(
  deps: LostFoundDeps,
  tenant: TenantContext,
  query: { status?: LostStatus | undefined; q?: string | undefined },
) {
  const q = query.q?.trim();
  const number = q && /^(lf-?)?\d+$/i.test(q) ? Number(q.replace(/\D/g, '')) : null;
  const [rows, used, custodians, zone, rooms] = await Promise.all([
    deps.tenantDb.lostFoundItem.findMany({
      where: {
        status: query.status ?? 'HELD',
        ...(q
          ? {
              OR: [
                { description: { contains: q, mode: 'insensitive' } },
                { category: { contains: q, mode: 'insensitive' } },
                { foundWhere: { contains: q, mode: 'insensitive' } },
                { room: { number: q } },
                ...(number !== null ? [{ number }] : []),
              ],
            }
          : {}),
      },
      include: ITEM_INCLUDE,
      orderBy: { number: 'desc' },
      take: 200,
    }),
    deps.tenantDb.lostFoundItem.findMany({ distinct: ['category'], select: { category: true } }),
    custodiansOf(deps.db, tenant),
    timeZoneOf(deps.tenantDb, tenant.propertyId),
    deps.tenantDb.room.findMany({
      where: { active: true },
      select: { id: true, number: true },
      orderBy: [{ floor: 'asc' }, { number: 'asc' }],
    }),
  ]);
  const today = localDate(deps.clock(), zone);
  return {
    data: rows.map((r) => itemOf(r, today)),
    categories: [...new Set([...LOST_CATEGORIES, ...used.map((u) => u.category)])],
    custodians,
    rooms,
  };
}

export function getItem(deps: LostFoundDeps, tenant: TenantContext, itemId: string) {
  return detailOf(deps.tenantDb, tenant, deps.clock, itemId);
}

/** The stay that had the room when the item was found: in house, or just checked out. */
async function likelyStay(tx: Tx, roomId: string, foundAt: Date) {
  const stay = await tx.stay.findFirst({
    where: {
      roomId,
      checkedInAt: { lte: foundAt },
      OR: [
        { checkedOutAt: null },
        { checkedOutAt: { gte: new Date(foundAt.getTime() - OWNER_WINDOW_MS) } },
      ],
    },
    orderBy: { checkedInAt: 'desc' },
    select: { id: true },
  });
  return stay?.id ?? null;
}

export async function createItem(
  deps: LostFoundDeps,
  tenant: TenantContext,
  body: z.output<typeof LostItemBody>,
) {
  const now = deps.clock();
  const foundAt = body.foundAt ? new Date(body.foundAt) : now;
  if (foundAt.getTime() > now.getTime() + 60_000) {
    throw invalid('foundAt', 'That time is in the future');
  }
  const custodianId = body.custodianId ?? tenant.userId;
  if (body.custodianId) await checkCustodian(deps, tenant, body.custodianId);
  if (!body.roomId && !body.foundWhere) {
    throw invalid('foundWhere', 'Say where it was found: a room or a place');
  }
  return deps.tenantDb.$transaction(async (tx) => {
    if (body.roomId && !(await tx.room.findFirst({ where: { id: body.roomId } }))) {
      throw invalid('roomId', 'Choose a room of this property');
    }
    const stayId = body.roomId ? await likelyStay(tx, body.roomId, foundAt) : null;
    const zone = await timeZoneOf(tx, tenant.propertyId);
    const keepUntil = addDays(
      localDate(foundAt, zone),
      body.valuable ? KEEP_DAYS_VALUABLE : KEEP_DAYS,
    );
    const number = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.LOST_FOUND);
    const item = await tx.lostFoundItem.create({
      data: {
        number,
        description: body.description,
        category: body.category,
        valuable: body.valuable,
        foundAt,
        foundWhere: body.foundWhere,
        roomId: body.roomId,
        stayId,
        foundById: tenant.userId,
        storageLocation: body.storageLocation,
        custodianId,
        keepUntil: dbDate(keepUntil),
        events: {
          create: {
            kind: 'LOGGED',
            note: body.note,
            storageLocation: body.storageLocation,
            custodianId,
            byUserId: tenant.userId,
          },
        },
      } as unknown as Prisma.LostFoundItemUncheckedCreateInput, // tenant IDs come from the client
    });
    await recordAudit(tx, {
      action: 'lost_found.logged',
      entityType: 'lost_found_item',
      entityId: item.id,
      after: {
        number,
        description: body.description,
        category: body.category,
        valuable: body.valuable,
        roomId: body.roomId,
        foundWhere: body.foundWhere,
        stayId,
        storageLocation: body.storageLocation,
        custodianId,
        keepUntil,
      },
    });
    return detailOf(tx, tenant, deps.clock, item.id);
  });
}

/** Locks a held item for a change; anything else is refused. */
async function heldItem(tx: Tx, itemId: string) {
  await tx.$queryRaw`SELECT id FROM lost_found_items WHERE id = ${itemId}::uuid FOR UPDATE`;
  const item = await tx.lostFoundItem.findFirst({ where: { id: itemId } });
  if (!item) throw new AppError('NOT_FOUND', 'Item not found.');
  if (item.status !== 'HELD') {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      `This item was already ${item.status === 'RETURNED' ? 'returned' : 'disposed of'}.`,
      { status: item.status },
    );
  }
  return item;
}

export async function moveItem(
  deps: LostFoundDeps,
  tenant: TenantContext,
  itemId: string,
  body: z.output<typeof CustodyBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    // The item first: another property's item is not found, whoever is named.
    const before = await heldItem(tx, itemId);
    await checkCustodian(deps, tenant, body.custodianId);
    await tx.lostFoundItem.update({
      where: { id: itemId },
      data: {
        storageLocation: body.storageLocation,
        custodianId: body.custodianId,
        events: {
          create: {
            kind: 'CUSTODY',
            note: body.note,
            storageLocation: body.storageLocation,
            custodianId: body.custodianId,
            byUserId: tenant.userId,
          },
        },
      },
    });
    await recordAudit(tx, {
      action: 'lost_found.custody',
      entityType: 'lost_found_item',
      entityId: itemId,
      before: { storageLocation: before.storageLocation, custodianId: before.custodianId },
      after: { storageLocation: body.storageLocation, custodianId: body.custodianId },
    });
    return detailOf(tx, tenant, deps.clock, itemId);
  });
}

export async function returnItem(
  deps: LostFoundDeps,
  tenant: TenantContext,
  itemId: string,
  body: z.output<typeof ReturnBody>,
) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    await heldItem(tx, itemId);
    await tx.lostFoundItem.update({
      where: { id: itemId },
      data: {
        status: 'RETURNED',
        returnedToName: body.toName,
        returnedToPhone: body.toPhone,
        returnedIdNote: body.idNote,
        closedAt: now,
        closedById: tenant.userId,
        events: {
          create: {
            kind: 'RETURNED',
            note: [`To ${body.toName}`, body.idNote, body.note].filter(Boolean).join(' · '),
            byUserId: tenant.userId,
          },
        },
      },
    });
    await recordAudit(tx, {
      action: 'lost_found.returned',
      entityType: 'lost_found_item',
      entityId: itemId,
      after: { toName: body.toName, toPhone: body.toPhone, idNote: body.idNote, note: body.note },
    });
    return detailOf(tx, tenant, deps.clock, itemId);
  });
}

export async function disposeItem(
  deps: LostFoundDeps,
  tenant: TenantContext,
  itemId: string,
  body: z.output<typeof DisposeBody>,
) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    const item = await heldItem(tx, itemId);
    const today = localDate(now, await timeZoneOf(tx, tenant.propertyId));
    const keepUntil = day(item.keepUntil);
    if (today <= keepUntil) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `Keep it until ${keepUntil}: the owner may still come for it.`,
        { keepUntil },
      );
    }
    if (item.valuable && !VALUABLE_DISPOSALS.includes(body.disposal)) {
      throw invalid('disposal', 'Valuables go to the police or are handled otherwise');
    }
    await tx.lostFoundItem.update({
      where: { id: itemId },
      data: {
        status: 'DISPOSED',
        disposal: body.disposal,
        closedAt: now,
        closedById: tenant.userId,
        events: { create: { kind: 'DISPOSED', note: body.note, byUserId: tenant.userId } },
      },
    });
    await recordAudit(tx, {
      action: 'lost_found.disposed',
      entityType: 'lost_found_item',
      entityId: itemId,
      after: { disposal: body.disposal, note: body.note },
    });
    return detailOf(tx, tenant, deps.clock, itemId);
  });
}
