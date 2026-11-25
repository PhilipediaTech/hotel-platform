import type { KitchenBoard, KitchenTicketItem } from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { Clock } from '../../core/clock.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Kitchen display (PRD M8-06; tab 5 S44; T-156). The register sends tickets (register.ts,
// sendKitchenLines); here the kitchen sees a station's tickets, oldest first, bumps each when
// done and recalls one bumped by mistake. Bumping is not audited (it moves no money and
// happens hundreds of times a day); who bumped and when is kept on the ticket.

export interface KitchenDeps {
  tenantDb: TenantDb;
  clock: Clock;
}

type ItemOut = z.input<typeof KitchenTicketItem>;
type BoardOut = z.input<typeof KitchenBoard>;

/** Bumped tickets shown for recall: the last ones, from the last 12 hours. */
const RECALL_COUNT = 10;
const RECALL_MS = 12 * 3_600_000;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const TICKET = {
  order: { select: { number: true, label: true, status: true } },
  sentBy: { select: { name: true } },
  bumpedBy: { select: { name: true } },
  lines: { orderBy: [{ addedAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.KitchenTicketInclude;
type Row = Prisma.KitchenTicketGetPayload<{ include: typeof TICKET }>;

function toItem(t: Row): ItemOut {
  return {
    id: t.id,
    orderId: t.orderId,
    orderNumber: t.order.number,
    label: t.order.label,
    number: t.number,
    station: t.station,
    sentAt: iso(t.sentAt),
    sentBy: t.sentBy.name,
    bumpedAt: t.bumpedAt ? iso(t.bumpedAt) : null,
    bumpedBy: t.bumpedBy?.name ?? null,
    cancelled: t.order.status === 'CANCELLED',
    lines: t.lines.map((l) => ({
      id: l.id,
      name: l.name,
      quantity: l.quantity,
      note: l.note,
      voided: l.voidedAt !== null,
    })),
  };
}

export async function getKitchenBoard(
  deps: KitchenDeps,
  query: { outletId?: string | undefined; station?: string | undefined },
): Promise<BoardOut> {
  const db = deps.tenantDb;
  const categories = await db.menuCategory.findMany({
    where: { active: true, kitchenStation: { not: null }, outlet: { active: true } },
    select: { kitchenStation: true, outlet: { select: { id: true, name: true } } },
    orderBy: [{ outlet: { name: 'asc' } }, { kitchenStation: 'asc' }],
  });
  const outlets = new Map<string, { id: string; name: string; stations: string[] }>();
  for (const c of categories) {
    const o = outlets.get(c.outlet.id) ?? { ...c.outlet, stations: [] };
    if (c.kitchenStation && !o.stations.includes(c.kitchenStation)) {
      o.stations.push(c.kitchenStation);
    }
    outlets.set(c.outlet.id, o);
  }
  const list = [...outlets.values()];
  const outlet = query.outletId ? outlets.get(query.outletId) : list[0];
  if (query.outletId && !outlet) {
    throw new AppError('NOT_FOUND', 'No kitchen display at this outlet');
  }
  const station = query.station ?? outlet?.stations[0];
  if (!outlet || !station) return { outlets: list, waiting: [], bumped: [] };
  const where = { outletId: outlet.id, station };
  const [waiting, bumped] = await Promise.all([
    db.kitchenTicket.findMany({
      where: { ...where, bumpedAt: null },
      include: TICKET,
      orderBy: [{ sentAt: 'asc' }, { number: 'asc' }, { id: 'asc' }],
      take: 100,
    }),
    db.kitchenTicket.findMany({
      where: {
        ...where,
        bumpedAt: { gte: new Date(deps.clock().getTime() - RECALL_MS) },
      },
      include: TICKET,
      orderBy: [{ bumpedAt: 'desc' }, { id: 'desc' }],
      take: RECALL_COUNT,
    }),
  ]);
  return { outlets: list, waiting: waiting.map(toItem), bumped: bumped.map(toItem) };
}

async function ticket(db: TenantDb, ticketId: string): Promise<Row> {
  const t = await db.kitchenTicket.findUnique({ where: { id: ticketId }, include: TICKET });
  if (!t) throw new AppError('NOT_FOUND', 'Ticket not found');
  return t;
}

/** Done: off the display. Bumping twice changes nothing. */
export async function bumpKitchenTicket(
  deps: KitchenDeps,
  tenant: TenantContext,
  ticketId: string,
): Promise<ItemOut> {
  await ticket(deps.tenantDb, ticketId);
  await deps.tenantDb.kitchenTicket.updateMany({
    where: { id: ticketId, bumpedAt: null },
    data: { bumpedAt: deps.clock(), bumpedById: tenant.userId },
  });
  return toItem(await ticket(deps.tenantDb, ticketId));
}

/** Back on the display. Recalling a waiting ticket changes nothing. */
export async function recallKitchenTicket(
  deps: KitchenDeps,
  _tenant: TenantContext,
  ticketId: string,
): Promise<ItemOut> {
  await ticket(deps.tenantDb, ticketId);
  await deps.tenantDb.kitchenTicket.updateMany({
    where: { id: ticketId, bumpedAt: { not: null } },
    data: { bumpedAt: null, bumpedById: null },
  });
  return toItem(await ticket(deps.tenantDb, ticketId));
}
