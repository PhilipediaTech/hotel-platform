import { daysBetween, type ExtendBody } from '@hotel/shared';
import type { z } from 'zod';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { releaseInventory, takeInventory } from '../availability/inventory.ts';
import { priceExtension, type QuoteNight } from '../availability/quotes.ts';
import { freeRooms, guarded, loadStay, lockRoom } from './rooms.ts';
import { getReservation, type ReservationDeps } from './service.ts';

// Extend or shorten a checked-in stay (PRD M3-12; tab 4 POST /stays/{id}/extend; T-054). The
// nights already priced keep their price (M2 rule 4): the stay moves to a new quote made of
// those nights plus the added ones, priced on the stay's plan at today's rates. Inventory and
// the guest's room follow in the same transaction. Before check-in, dates change through the
// reservation (a new quote for the whole stay, M3-03).

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const MAX_NIGHTS = 60;

const invalid = (message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: 'body.departure', code: 'custom', message }],
  });

/** Net, total and taxes per tax code of quoted nights (inclusive taxes are inside the line). */
async function totalsOf(tx: Tx, nights: QuoteNight[]) {
  const rules = await tx.taxRule.findMany({ include: { versions: true, revenueCode: true } });
  const inclusive = new Map(rules.flatMap((r) => r.versions.map((v) => [v.id, v.inclusive])));
  const codeOf = new Map(rules.map((r) => [r.id, r.revenueCode]));
  let netMinor = 0n;
  let totalMinor = 0n;
  const taxes = new Map<string, { code: string; name: string; amountMinor: bigint }>();
  for (const line of nights.flatMap((n) => n.lines)) {
    let added = 0n;
    let inside = 0n;
    for (const t of line.taxes) {
      const amount = BigInt(t.amountMinor);
      if (inclusive.get(t.versionId)) inside += amount;
      else added += amount;
      const code = codeOf.get(t.taxRuleId);
      const key = code?.code ?? t.taxRuleId;
      const sum = taxes.get(key) ?? { code: key, name: code?.name ?? '', amountMinor: 0n };
      sum.amountMinor += amount;
      taxes.set(key, sum);
    }
    netMinor += BigInt(line.amountMinor) - inside;
    totalMinor += BigInt(line.amountMinor) + added;
  }
  return {
    netMinor,
    totalMinor,
    taxes: [...taxes.values()].map((t) => ({ ...t, amountMinor: t.amountMinor.toString() })),
  };
}

/**
 * Moves a checked-in stay's departure to `to` inside a transaction (M3-12): inventory, the
 * room's allocation, the nights and a new quote of them follow. Extending passes the added
 * nights, priced beforehand; shortening passes none. Check-out uses it for an early departure.
 */
export async function applyDeparture(
  tx: Tx,
  args: {
    propertyId: string;
    stayId: string;
    /** The version the caller saw; null when the caller holds the stay locked already. */
    version: number | null;
    to: string;
    added: QuoteNight[];
    reason: string | null;
    now: Date;
  },
) {
  const stay = await tx.stay.findUniqueOrThrow({
    where: { id: args.stayId },
    include: { quote: true, room: true },
  });
  if (args.version !== null && stay.version !== args.version) {
    throw new AppError('VERSION_CONFLICT', 'Someone changed this stay; reload and try again');
  }
  const from = day(stay.departure);
  const { to, added, now } = args;
  const range = { propertyId: args.propertyId, roomTypeId: stay.roomTypeId };
  const kept = (stay.quote.nights as unknown as QuoteNight[]).filter((n) => n.date < to);

  if (to > from) {
    await takeInventory(tx, { ...range, arrival: from, departure: to, field: 'sold' });
    if (stay.room) {
      await lockRoom(tx, stay.room.id);
      const free = await freeRooms(tx, stay, from, to);
      if (!free.some((r) => r.id === stay.room?.id)) {
        throw new AppError(
          'BOOKING_CONFLICT',
          `Room ${stay.room.number} is taken or blocked on some of the added nights; move the guest first`,
          { roomId: stay.room.id },
        );
      }
      const last = await tx.roomAllocation.findFirst({
        where: { stayId: stay.id, active: true, endDate: dbDate(from) },
      });
      if (last) {
        await guarded(() =>
          tx.roomAllocation.update({ where: { id: last.id }, data: { endDate: dbDate(to) } }),
        );
      }
    }
  } else {
    await releaseInventory(tx, { ...range, arrival: to, departure: from, field: 'sold' });
    const allocations = await tx.roomAllocation.findMany({
      where: { stayId: stay.id, active: true },
    });
    for (const a of allocations) {
      if (day(a.startDate) >= to) {
        await tx.roomAllocation.update({ where: { id: a.id }, data: { active: false } });
      } else if (day(a.endDate) > to) {
        await tx.roomAllocation.update({ where: { id: a.id }, data: { endDate: dbDate(to) } });
      }
    }
  }

  // The stay's price record: the nights it keeps and the ones added.
  const nights = [...kept, ...added];
  const totals = await totalsOf(tx, nights);
  const quote = await tx.quote.create({
    data: {
      ratePlanId: stay.ratePlanId,
      roomTypeId: stay.roomTypeId,
      arrival: stay.arrival,
      departure: dbDate(to),
      nights: nights as unknown as object,
      taxes: totals.taxes,
      totalMinor: totals.totalMinor,
      currency: stay.quote.currency,
      expiresAt: now,
      createdAt: now,
    } as never,
  });
  // Nights go in through the stay (stay_nights have no property column).
  await tx.stay.update({
    where: { id: stay.id },
    data: {
      departure: dbDate(to),
      quoteId: quote.id,
      version: { increment: 1 },
      nights:
        to > from
          ? {
              create: added.map((n) => ({
                date: dbDate(n.date),
                amountMinor: BigInt(n.amountMinor),
                ratePlanId: n.pricedBy,
                ruleVersion: n.ruleVersion,
              })),
            }
          : { deleteMany: { date: { gte: dbDate(to) } } },
    },
  });
  await tx.reservation.update({
    where: { id: stay.reservationId },
    data: { version: { increment: 1 } },
  });
  const differenceMinor = totals.totalMinor - stay.quote.totalMinor;
  await recordAudit(tx, {
    action: to > from ? 'stay.extended' : 'stay.shortened',
    entityType: 'stay',
    entityId: stay.id,
    reason: args.reason ?? undefined,
    before: { departure: from, totalMinor: stay.quote.totalMinor.toString() },
    after: { departure: to, totalMinor: totals.totalMinor.toString() },
  });
  await recordEvent(tx, {
    type: 'stay.departure_changed',
    payload: {
      stayId: stay.id,
      reservationId: stay.reservationId,
      from,
      to,
      differenceMinor: differenceMinor.toString(),
    },
  });
  return { reservationId: stay.reservationId, differenceMinor };
}

export async function extendStay(
  deps: ReservationDeps,
  tenant: TenantContext,
  stayId: string,
  ifMatch: string,
  body: z.output<typeof ExtendBody>,
) {
  const before = await loadStay(deps.tenantDb, stayId);
  const version = Number(/^(?:W\/)?"?(\d+)"?$/.exec(ifMatch.trim())?.[1] ?? -1);
  if (version !== before.version) {
    throw new AppError('VERSION_CONFLICT', 'Someone changed this stay; reload and try again', {
      version: before.version,
    });
  }
  if (before.isDayUse) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'A day-use stay keeps its time; sell another day-use or book a night',
      { reason: 'DAY_USE' },
    );
  }
  if (before.status !== 'CHECKED_IN') {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'Only a checked-in stay is extended or shortened; change the dates on the reservation',
      { status: before.status },
    );
  }
  const today = await businessDate(deps.tenantDb, tenant.propertyId, deps.clock);
  const arrival = day(before.arrival);
  const from = day(before.departure);
  const to = body.departure;
  if (to === from) throw invalid('That is already the departure date');
  if (to <= arrival) throw invalid('The guest stays at least one night');
  if (to < today) throw invalid('The departure is the business date or later');
  if (daysBetween(arrival, to) > MAX_NIGHTS) throw invalid(`At most ${MAX_NIGHTS} nights`);

  // Added nights are priced before the transaction, as a quote is.
  let added: QuoteNight[] = [];
  if (to > from) {
    const priced = await priceExtension(deps.tenantDb, {
      ratePlanId: before.ratePlanId,
      roomTypeId: before.roomTypeId,
      from,
      to,
      guests: before.adults + before.children,
    });
    if (priced.violations.length > 0 || !priced.nights) {
      throw new AppError(
        'RESTRICTION_VIOLATED',
        priced.violations.length > 0
          ? 'Some of the added nights cannot be sold on this rate plan'
          : 'This rate plan is no longer sold; change the stay on the reservation',
        { violations: priced.violations },
      );
    }
    added = priced.nights;
  }

  const now = deps.clock();
  const result = await deps.tenantDb.$transaction((tx) =>
    applyDeparture(tx, {
      propertyId: tenant.propertyId,
      stayId,
      version: before.version,
      to,
      added,
      reason: body.reason ?? null,
      now,
    }),
  );
  return {
    ...(await getReservation(deps, result.reservationId)),
    differenceMinor: result.differenceMinor.toString(),
  };
}
