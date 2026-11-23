import type { PriceSuggestionItem } from '@hotel/shared';
import type { z } from 'zod';
import { recordAudit } from '../../core/audit.ts';
import { localDate } from '@hotel/shared';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { planRoomTypes, writeRateDays, type RateDeps } from './service.ts';

// Price suggestions (PRD M14-13; T-149). Worked out from the hotel's own books, so every
// suggestion shows its arithmetic and nothing is guessed:
// - occupancy on the books now for the room type and date (room type inventory);
// - the same weekday last year (364 days back) at the same number of days before arrival, and
//   how that date finished (stay nights, from the reservations made by then);
// - a rule table, below, turning those into a change.
// Only BAR plans with a price on the date are suggested on (derived plans follow BAR). A
// suggestion never goes below the plan's floor and is rounded like the plan's prices.
// Nothing is stored: accepting writes the price into the rate calendar (audited).

type Suggestion = z.input<typeof PriceSuggestionItem>;

const DAY = 86_400_000;
const addDays = (iso: string, n: number) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY,
  );
const pct = (n: number, d: number) => (d > 0 ? Math.round((n * 100) / d) : 0);
/** Booked nights count once they are on the books; cancelled and no-show ones never stayed. */
const STAYED = ['TENTATIVE', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] as const;

interface Facts {
  sold: number;
  capacity: number;
  daysOut: number;
  lastYear: { soldThen: number; soldFinal: number; capacity: number } | null;
}

/**
 * The rule table. Up when demand is strong now or running ahead of last year; down only close
 * in, when the date is weak and behind last year. Returns basis points and the reasons.
 */
export function suggestChange(f: Facts): { bps: number; reasons: string[] } {
  const occ = f.capacity > 0 ? f.sold / f.capacity : 0;
  const sold = `${pct(f.sold, f.capacity)}% sold (${f.sold} of ${f.capacity}) ${f.daysOut} ${f.daysOut === 1 ? 'day' : 'days'} out`;
  const ly = f.lastYear;
  const lyThen = ly && ly.capacity > 0 ? ly.soldThen / ly.capacity : null;
  const lyFinal = ly && ly.capacity > 0 ? ly.soldFinal / ly.capacity : null;
  const history =
    ly && lyThen !== null && lyFinal !== null
      ? `last year: ${pct(ly.soldThen, ly.capacity)}% at this point, ${pct(ly.soldFinal, ly.capacity)}% in the end`
      : null;
  const why = (lead: string) => [lead, ...(history ? [history] : [])];
  if (occ >= 0.85) return { bps: 1500, reasons: why(`Nearly full: ${sold}`) };
  if (occ >= 0.7) return { bps: 1000, reasons: why(`Strong demand: ${sold}`) };
  if (lyThen !== null && occ - lyThen >= 0.15 && f.sold >= 2) {
    return { bps: 500, reasons: why(`Booking faster than last year: ${sold}`) };
  }
  if (f.daysOut <= 14 && occ <= 0.3 && (lyThen === null || occ <= lyThen - 0.1)) {
    if (lyFinal !== null && lyFinal >= 0.6) {
      // Last year this date filled late: hold the price, it may still come.
      return { bps: 0, reasons: [] };
    }
    return { bps: -1000, reasons: why(`Slow close in: ${sold}`) };
  }
  return { bps: 0, reasons: [] };
}

/** Applies basis points, rounds like the plan's prices and keeps to the plan's floor. */
function priced(current: bigint, bps: number, roundingMinor: bigint, floorMinor: bigint | null) {
  const raw = (current * BigInt(10_000 + bps)) / 10_000n;
  const step = roundingMinor > 0n ? roundingMinor : 100n;
  let rounded = ((raw + step / 2n) / step) * step;
  if (floorMinor !== null && rounded < floorMinor) rounded = floorMinor;
  return rounded;
}

export async function listPriceSuggestions(
  deps: RateDeps,
  tenant: TenantContext,
  query: { days: number },
) {
  const db = deps.tenantDb;
  const property = await db.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
    select: { timeZone: true, baseCurrency: true },
  });
  const today = localDate(deps.clock(), property.timeZone);
  const last = addDays(today, query.days - 1);
  const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const lyFrom = addDays(today, -364);
  const lyTo = addDays(last, -364);

  const plans = await db.ratePlan.findMany({
    where: { kind: 'BAR', active: true },
    orderBy: { code: 'asc' },
  });
  if (plans.length === 0) return { data: [], currency: property.baseCurrency };
  const [roomTypes, days, inventory, lyInventory, lyNights] = await Promise.all([
    db.roomType.findMany({ select: { id: true, code: true, name: true } }),
    db.rateDay.findMany({
      where: {
        ratePlanId: { in: plans.map((p) => p.id) },
        date: { gte: asDate(today), lte: asDate(last) },
        amountMinor: { not: null },
      },
    }),
    db.roomTypeInventory.findMany({ where: { date: { gte: asDate(today), lte: asDate(last) } } }),
    db.roomTypeInventory.findMany({ where: { date: { gte: asDate(lyFrom), lte: asDate(lyTo) } } }),
    db.stay.findMany({
      where: {
        status: { in: [...STAYED] },
        isDayUse: false,
        arrival: { lte: asDate(lyTo) },
        departure: { gt: asDate(lyFrom) },
      },
      select: {
        roomTypeId: true,
        reservation: { select: { createdAt: true } },
        nights: {
          where: { date: { gte: asDate(lyFrom), lte: asDate(lyTo) } },
          select: { date: true },
        },
      },
    }),
  ]);
  const typeById = new Map(roomTypes.map((t) => [t.id, t]));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const inv = new Map(inventory.map((i) => [`${i.roomTypeId}|${iso(i.date)}`, i]));
  const lyInv = new Map(lyInventory.map((i) => [`${i.roomTypeId}|${iso(i.date)}`, i]));
  // Last year's nights per room type and date, each with when it was booked.
  const lyBooked = new Map<string, Date[]>();
  for (const s of lyNights) {
    for (const n of s.nights) {
      const k = `${s.roomTypeId}|${iso(n.date)}`;
      lyBooked.set(k, [...(lyBooked.get(k) ?? []), s.reservation.createdAt]);
    }
  }

  const out: Suggestion[] = [];
  for (const plan of plans) {
    const types = new Set(await planRoomTypes(db, plan));
    for (const day of days.filter((d) => d.ratePlanId === plan.id && types.has(d.roomTypeId))) {
      const date = iso(day.date);
      const current = day.amountMinor;
      const type = typeById.get(day.roomTypeId);
      const now = inv.get(`${day.roomTypeId}|${date}`);
      if (current === null || !type || !now) continue;
      const capacity = now.capacity - now.outOfOrder;
      if (capacity <= 0) continue;
      const daysOut = daysBetween(today, date);
      const lyDate = addDays(date, -364);
      const lyKey = `${day.roomTypeId}|${lyDate}`;
      const lyStock = lyInv.get(lyKey);
      const booked = lyBooked.get(lyKey) ?? [];
      // "At this point" last year: booked by the same number of days before that date.
      const cutoff = new Date(`${addDays(lyDate, -daysOut)}T23:59:59.999Z`);
      const lastYear = lyStock
        ? {
            soldThen: booked.filter((at) => at <= cutoff).length,
            soldFinal: booked.length,
            capacity: lyStock.capacity - lyStock.outOfOrder,
          }
        : null;
      const facts = { sold: now.sold, capacity, daysOut, lastYear };
      const { bps, reasons } = suggestChange(facts);
      if (bps === 0) continue;
      const suggested = priced(current, bps, plan.roundingMinor, plan.floorMinor);
      if (suggested === current) continue;
      out.push({
        ratePlan: { id: plan.id, code: plan.code, name: plan.name },
        roomType: { id: type.id, code: type.code, name: type.name },
        date,
        currentMinor: current.toString(),
        suggestedMinor: suggested.toString(),
        changeBps: Number(((suggested - current) * 10_000n) / current),
        sold: now.sold,
        capacity,
        daysOut,
        lastYear: lastYear ? { date: lyDate, ...lastYear } : null,
        reasons,
      });
    }
  }
  out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.roomType.code.localeCompare(b.roomType.code) ||
      a.ratePlan.code.localeCompare(b.ratePlan.code),
  );
  return { data: out, currency: property.baseCurrency };
}

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
  });

/** M14-13: accepted suggestions become prices, one room type and date each. */
export async function acceptPriceSuggestions(
  deps: RateDeps,
  tenant: TenantContext,
  body: {
    items: {
      ratePlanId: string;
      roomTypeId: string;
      date: string;
      amountMinor: string;
      suggestedMinor?: string | undefined;
    }[];
  },
) {
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
    select: { timeZone: true },
  });
  const today = localDate(deps.clock(), property.timeZone);
  return deps.tenantDb.$transaction(async (tx) => {
    let changedDays = 0;
    const plans = new Map<string, Set<string>>();
    for (const [i, item] of body.items.entries()) {
      const path = `body.items.${i}`;
      if (item.date < today) throw invalid(`${path}.date`, 'Prices change from today on');
      if (!plans.has(item.ratePlanId)) {
        const plan = await tx.ratePlan.findFirst({ where: { id: item.ratePlanId } });
        if (!plan?.active || plan.kind !== 'BAR') {
          throw invalid(`${path}.ratePlanId`, 'Choose an active best-available plan');
        }
        plans.set(plan.id, new Set(await planRoomTypes(tx, plan)));
      }
      if (!plans.get(item.ratePlanId)?.has(item.roomTypeId)) {
        throw invalid(`${path}.roomTypeId`, 'Choose a room type this plan sells');
      }
      const weekday = ((new Date(`${item.date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
      changedDays += await writeRateDays(tx, tenant.propertyId, item.ratePlanId, {
        roomTypeIds: [item.roomTypeId],
        from: item.date,
        to: item.date,
        weekdays: [weekday],
        set: { amountMinor: item.amountMinor },
      });
    }
    if (changedDays > 0) {
      await recordAudit(tx, {
        action: 'rates.suggestions_accepted',
        entityType: 'property',
        entityId: tenant.propertyId,
        after: { items: body.items, changedDays },
      });
    }
    return { changedDays };
  });
}
