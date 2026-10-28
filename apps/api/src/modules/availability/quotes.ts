import {
  addDays,
  calculateTaxes,
  daysBetween,
  localDate,
  MAX_STAY_NIGHTS,
  QUOTE_MINUTES,
  restrictionViolations,
  splitPackage,
  versionsOn,
  type AvailabilityQuery,
  type AvailabilityRoomType,
  type DatedTaxVersion,
  type QuoteBody,
  type QuoteItem,
  type Violation,
} from '@hotel/shared';
import type { z } from 'zod';
import type {
  PackageComponent,
  RateDay,
  RatePlan,
  RevenueCode,
  RoomType,
} from '../../generated/prisma/client.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { sellingPrice } from '../rates/service.ts';

// Availability search and quotes (PRD M2-06, M2-09, M2-10, M2 rules 1, 4–5; T-041).
// Worked out live on every request (M2 rule 5: no cache): rooms left from the inventory,
// prices from the rate calendar (derived plans through their parent), restrictions from the
// plan's own days, taxes from the room revenue code with the versions in force each night.

export interface QuoteDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type ViolationOut = z.input<typeof Violation>;
type PlanWithParts = RatePlan & { components: PackageComponent[] };

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const key = (planId: string, roomTypeId: string, date: string) => `${planId}|${roomTypeId}|${date}`;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

/** One posting line of a night: the room part, or a package component. */
export interface QuoteLine {
  revenueCodeId: string;
  amountMinor: string;
  taxes: { taxRuleId: string; versionId: string; amountMinor: string }[];
}

/** A priced night as the quote keeps it (and T-042/T-073 post it). */
export interface QuoteNight {
  date: string;
  amountMinor: string;
  ruleVersion: number;
  /** The plan whose day priced it: the plan itself, or its parent for derived prices. */
  pricedBy: string;
  lines: QuoteLine[];
  /** Guests it was priced for (package parts per person); bookings must match (T-042). */
  guests?: number;
}

interface Pricing {
  nights: QuoteNight[] | null;
  violations: ViolationOut[];
  netMinor: bigint;
  totalMinor: bigint;
  taxes: Map<string, bigint>;
}

/** Everything one search needs, read once. */
interface Context {
  types: RoomType[];
  plans: Map<string, PlanWithParts>;
  days: Map<string, RateDay>;
  /** Where room charges post; null until the property has one (quotes then refuse). */
  roomCode: RevenueCode | null;
  codes: Map<string, RevenueCode>;
  /** Tax rule versions by rule, as the calculator takes them. */
  versions: Map<string, (DatedTaxVersion & { id: string })[]>;
  /** Tax rule → the code its lines post to. */
  taxCode: Map<string, RevenueCode>;
  /** Rooms left per room type and date. */
  left: Map<string, number>;
}

async function load(db: TenantDb, stay: { arrival: string; departure: string }): Promise<Context> {
  const range = { gte: dbDate(stay.arrival), lte: dbDate(stay.departure) };
  const [types, plans, days, codes, rules, inventory] = await Promise.all([
    db.roomType.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    db.ratePlan.findMany({
      where: { active: true },
      include: { components: true },
      orderBy: [{ kind: 'asc' }, { code: 'asc' }],
    }),
    db.rateDay.findMany({ where: { date: range } }),
    db.revenueCode.findMany(),
    db.taxRule.findMany({ include: { versions: true } }),
    db.roomTypeInventory.findMany({
      where: { date: { gte: dbDate(stay.arrival), lt: dbDate(stay.departure) } },
    }),
  ]);
  // Room charges post to the room revenue code (ROOM if there are several).
  const roomCodes = codes.filter((c) => c.active && c.group === 'ROOM');
  const roomCode = roomCodes.find((c) => c.code === 'ROOM') ?? roomCodes[0] ?? null;
  const codeById = new Map(codes.map((c) => [c.id, c]));
  return {
    types,
    plans: new Map(plans.map((p) => [p.id, p])),
    days: new Map(days.map((d) => [key(d.ratePlanId, d.roomTypeId, day(d.date)), d])),
    roomCode,
    codes: codeById,
    versions: new Map(
      rules.map((r) => [
        r.id,
        r.versions.map((v) => ({
          id: v.id,
          taxRuleId: r.id,
          rateBps: v.rateBps,
          basis: v.basis,
          sequence: v.sequence,
          inclusive: v.inclusive,
          effectiveFrom: day(v.effectiveFrom),
          effectiveTo: v.effectiveTo ? day(v.effectiveTo) : null,
        })),
      ]),
    ),
    taxCode: new Map(
      rules.flatMap((r) => {
        const code = codeById.get(r.revenueCodeId);
        return code ? [[r.id, code] as const] : [];
      }),
    ),
    left: new Map(
      inventory.map((i) => [
        `${i.roomTypeId}|${day(i.date)}`,
        i.capacity - i.outOfOrder - i.sold - i.held + i.overbookLimit,
      ]),
    ),
  };
}

function stayDates(arrival: string, departure: string): string[] {
  return Array.from({ length: daysBetween(arrival, departure) }, (_, i) => addDays(arrival, i));
}

/** Plans that sell a room type overnight. */
function sells(plan: RatePlan, roomTypeId: string): boolean {
  return (
    (plan.kind === 'BAR' || plan.kind === 'DERIVED' || plan.kind === 'PACKAGE') &&
    (plan.roomTypeIds.length === 0 || plan.roomTypeIds.includes(roomTypeId))
  );
}

/** Taxes on one line, with the versions in force that night. */
function taxLine(ctx: Context, code: RevenueCode | null, amount: bigint, date: string) {
  const versions = (code?.taxRuleIds ?? []).flatMap((id) =>
    versionsOn(ctx.versions.get(id) ?? [], date),
  );
  const result = calculateTaxes(amount, versions);
  const versionOf = new Map(versions.map((v) => [v.taxRuleId, v.id]));
  return { result, versionOf };
}

/** Prices one plan and room type for the stay, night by night (M2 rules 3–4, M4 rule 1). */
function price(
  ctx: Context,
  plan: PlanWithParts,
  roomTypeId: string,
  stay: { arrival: string; departure: string },
  guests: number,
): Pricing {
  const dates = stayDates(stay.arrival, stay.departure);
  const own = (date: string) => ctx.days.get(key(plan.id, roomTypeId, date));
  const restrictionDays = [...dates, stay.departure].flatMap((date) => {
    const d = own(date);
    return d
      ? [
          {
            date,
            minStay: d.minStay,
            maxStay: d.maxStay,
            closedToArrival: d.closedToArrival,
            closedToDeparture: d.closedToDeparture,
            stopSell: d.stopSell,
          },
        ]
      : [];
  });
  const violations: ViolationOut[] = restrictionViolations(
    restrictionDays,
    stay.arrival,
    stay.departure,
  );
  const taxes = new Map<string, bigint>();
  const nights: QuoteNight[] = [];
  let netMinor = 0n;
  let totalMinor = 0n;
  for (const date of dates) {
    const mine = own(date);
    const parent = plan.parentRatePlanId
      ? ctx.days.get(key(plan.parentRatePlanId, roomTypeId, date))
      : undefined;
    const amount = sellingPrice(plan, mine, parent);
    if (amount === null) {
      violations.push({ rule: 'NO_PRICE', date });
      continue;
    }
    const pricedByOwn = plan.kind !== 'DERIVED' && (mine?.amountMinor ?? null) !== null;
    const source = pricedByOwn ? mine : parent;
    // A package night posts its components to their own codes; the room gets the rest.
    let parts: { code: RevenueCode | null; amount: bigint }[];
    if (plan.kind === 'PACKAGE' && plan.components.length > 0) {
      let split;
      try {
        split = splitPackage(amount, plan.components, guests);
      } catch {
        violations.push({ rule: 'NO_PRICE', date });
        continue;
      }
      parts = [
        { code: ctx.roomCode, amount: split.roomMinor },
        ...split.components.flatMap((c) => {
          const code = ctx.codes.get(c.revenueCodeId);
          return code ? [{ code, amount: c.amountMinor }] : [];
        }),
      ];
    } else {
      parts = [{ code: ctx.roomCode, amount }];
    }
    const lines: QuoteLine[] = [];
    for (const part of parts) {
      const { result, versionOf } = taxLine(ctx, part.code, part.amount, date);
      netMinor += result.netMinor;
      totalMinor += result.totalMinor;
      for (const t of result.taxes) {
        const code = ctx.taxCode.get(t.taxRuleId)?.id ?? t.taxRuleId;
        taxes.set(code, (taxes.get(code) ?? 0n) + t.amountMinor);
      }
      lines.push({
        revenueCodeId: part.code?.id ?? '',
        amountMinor: part.amount.toString(),
        taxes: result.taxes.map((t) => ({
          taxRuleId: t.taxRuleId,
          versionId: versionOf.get(t.taxRuleId) ?? '',
          amountMinor: t.amountMinor.toString(),
        })),
      });
    }
    nights.push({
      date,
      amountMinor: amount.toString(),
      ruleVersion: source?.ruleVersion ?? 1,
      pricedBy: source?.ratePlanId ?? plan.id,
      lines,
    });
  }
  return {
    nights: violations.some((v) => v.rule === 'NO_PRICE') ? null : nights,
    violations: violations.sort((a, b) => a.date.localeCompare(b.date)),
    netMinor,
    totalMinor,
    taxes,
  };
}

/** Rooms left on the fullest night; a night outside the inventory counts as none. */
function roomsLeft(ctx: Context, roomTypeId: string, dates: string[]) {
  const perNight = dates.map((date) => ({
    date,
    left: ctx.left.get(`${roomTypeId}|${date}`) ?? 0,
  }));
  return {
    available: Math.min(...perNight.map((n) => n.left)),
    full: perNight.filter((n) => n.left < 1).map((n) => n.date),
  };
}

async function checkStay(
  deps: QuoteDeps,
  tenant: TenantContext,
  stay: { arrival: string; departure: string },
  where: 'query' | 'body',
) {
  const property = await deps.db.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
    select: { timeZone: true, baseCurrency: true },
  });
  const today = localDate(deps.clock(), property.timeZone);
  if (stay.arrival < today) throw invalid(`${where}.arrival`, 'Arrival is today or later');
  const nights = daysBetween(stay.arrival, stay.departure);
  if (nights < 1) throw invalid(`${where}.departure`, 'Departure is after arrival');
  if (nights > MAX_STAY_NIGHTS) {
    throw invalid(`${where}.departure`, `At most ${MAX_STAY_NIGHTS} nights per search`);
  }
  return { currency: property.baseCurrency, nights };
}

export async function getAvailability(
  deps: QuoteDeps,
  tenant: TenantContext,
  query: z.output<typeof AvailabilityQuery>,
) {
  const { currency, nights } = await checkStay(deps, tenant, query, 'query');
  const ctx = await load(deps.tenantDb, query);
  const dates = stayDates(query.arrival, query.departure);
  const guests = query.adults + query.children;
  const roomTypes: z.input<typeof AvailabilityRoomType>[] = ctx.types
    .filter((t) => (!query.roomTypeId || t.id === query.roomTypeId) && t.maxOccupancy >= guests)
    .map((type) => {
      const { available } = roomsLeft(ctx, type.id, dates);
      const plans = [...ctx.plans.values()]
        .filter((p) => sells(p, type.id))
        .map((plan) => {
          const p = price(ctx, plan, type.id, query, guests);
          return {
            ratePlanId: plan.id,
            code: plan.code,
            name: plan.name,
            kind: plan.kind,
            mealPlan: plan.mealPlan as z.input<
              typeof AvailabilityRoomType
            >['plans'][number]['mealPlan'],
            guarantee: plan.guarantee,
            roomMinor: p.nights
              ? p.nights.reduce((s, n) => s + BigInt(n.amountMinor), 0n).toString()
              : null,
            totalMinor: p.nights ? p.totalMinor.toString() : null,
            sellable: p.violations.length === 0 && available > 0,
            violations: p.violations,
          };
        });
      return {
        roomTypeId: type.id,
        code: type.code,
        name: type.name,
        maxOccupancy: type.maxOccupancy,
        available,
        plans,
      };
    });
  return { arrival: query.arrival, departure: query.departure, nights, currency, roomTypes };
}

export async function createQuote(
  deps: QuoteDeps,
  tenant: TenantContext,
  body: z.output<typeof QuoteBody>,
): Promise<z.input<typeof QuoteItem>> {
  const { currency } = await checkStay(deps, tenant, body, 'body');
  const ctx = await load(deps.tenantDb, body);
  const type = ctx.types.find((t) => t.id === body.roomTypeId);
  if (!type) throw invalid('body.roomTypeId', 'Choose an active room type of this property');
  const plan = ctx.plans.get(body.ratePlanId);
  if (!plan || !sells(plan, type.id)) {
    throw invalid(
      'body.ratePlanId',
      `Choose an active rate plan that sells ${type.name} overnight`,
    );
  }
  const guests = body.adults + body.children;
  if (guests > type.maxOccupancy) {
    throw invalid('body.adults', `${type.name} takes at most ${type.maxOccupancy} guests`);
  }
  if (!ctx.roomCode) {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      'Add a room revenue code (Tax and FX) before selling rooms',
    );
  }
  const p = price(ctx, plan, type.id, body, guests);
  if (p.violations.length > 0 || !p.nights) {
    throw new AppError('RESTRICTION_VIOLATED', 'This stay cannot be sold on this rate plan', {
      violations: p.violations,
    });
  }
  const { full } = roomsLeft(ctx, type.id, stayDates(body.arrival, body.departure));
  if (full.length > 0) {
    throw new AppError('BOOKING_CONFLICT', `No ${type.name} room is left on some nights`, {
      roomTypeId: type.id,
      dates: full,
    });
  }
  const now = deps.clock();
  const taxes = [...p.taxes.entries()].map(([codeId, amount]) => {
    const code = ctx.codes.get(codeId);
    return { code: code?.code ?? '', name: code?.name ?? '', amountMinor: amount.toString() };
  });
  const quote = await deps.tenantDb.quote.create({
    data: {
      ratePlanId: plan.id,
      roomTypeId: type.id,
      arrival: dbDate(body.arrival),
      departure: dbDate(body.departure),
      nights: p.nights.map((n) => ({ ...n, guests })) as unknown as object,
      taxes,
      totalMinor: p.totalMinor,
      currency,
      expiresAt: new Date(now.getTime() + QUOTE_MINUTES * 60_000),
      createdAt: now,
    } as never,
  });
  return {
    quoteId: quote.id,
    ratePlanId: plan.id,
    roomTypeId: type.id,
    arrival: body.arrival,
    departure: body.departure,
    currency,
    nights: p.nights.map((n) => ({
      date: n.date,
      amountMinor: n.amountMinor,
      ruleVersion: n.ruleVersion,
    })),
    taxes,
    netMinor: p.netMinor.toString(),
    totalMinor: p.totalMinor.toString(),
    createdAt: iso(quote.createdAt),
    expiresAt: iso(quote.expiresAt),
  };
}
