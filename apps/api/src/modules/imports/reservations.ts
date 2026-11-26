import {
  addDays,
  daysBetween,
  inventoryFieldOf,
  type ImportError,
  type ReservationRow,
} from '@hotel/shared';
import type { Company, Guest, Prisma, RatePlan, RoomType } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { takeInventory } from '../availability/inventory.ts';
import { channelQuote, type QuoteNight } from '../availability/quotes.ts';

// Future reservations from the old system (Versions V2 "stronger migration"; T-169; Philip's
// choices 2026-11-26). Each booking gets this property's own confirmation number; the old
// one is kept as its reference (channel_ref, any source but OTA_CHANNEL), shown in its notes,
// found by search, and refused a second time. Every night is charged the old system's
// nightly rate, whatever the rate calendar says now; taxes and posting lines are worked out
// as for an OTA booking at an agreed price (channelQuote). A booking that no longer fits
// (its room type full on a night) is refused, so nothing is overbooked unnoticed. Deposits
// already held stay in the old books. The property need not be live: migration comes first.

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = Tx | TenantDb;

export interface Checked {
  errors: ImportError[];
  summary: Record<string, number>;
}

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);
const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');
const nightsOf = (r: ReservationRow) =>
  Array.from({ length: daysBetween(r.arrival, r.departure) }, (_, i) => addDays(r.arrival, i));

/** The rows of each old booking, in file order. */
function bookings(rows: ReservationRow[]): ReservationRow[][] {
  const by = new Map<string, ReservationRow[]>();
  for (const r of rows) {
    const list = by.get(r.oldConfirmationNo);
    if (list) list.push(r);
    else by.set(r.oldConfirmationNo, [r]);
  }
  return [...by.values()];
}

interface Lookups {
  types: Map<string, RoomType>;
  plans: Map<string, RatePlan>;
  /** The best available rate, for rows without a plan. */
  defaultPlan: RatePlan | null;
  companies: Map<string, Company>;
  hasRoomCode: boolean;
}

async function lookups(db: Client): Promise<Lookups> {
  const [types, plans, companies, roomCodes] = await Promise.all([
    db.roomType.findMany({ where: { active: true } }),
    db.ratePlan.findMany({ where: { active: true }, orderBy: { code: 'asc' } }),
    db.company.findMany({ where: { active: true } }),
    db.revenueCode.count({ where: { active: true, group: 'ROOM' } }),
  ]);
  const bars = plans.filter((p) => p.kind === 'BAR');
  return {
    types: new Map(types.map((t) => [t.code, t])),
    plans: new Map(plans.map((p) => [p.code, p])),
    defaultPlan: bars.find((p) => p.code === 'BAR') ?? bars[0] ?? null,
    companies: new Map(
      companies.filter((c) => c.kind !== 'EVENT_CLIENT').map((c) => [nameKey(c.name), c]),
    ),
    hasRoomCode: roomCodes > 0,
  };
}

/** Guests of the organisation by email and phone (merged-away profiles left out). */
async function knownGuests(db: Client, rows: ReservationRow[]) {
  const emails = [...new Set(rows.flatMap((r) => (r.email ? [r.email] : [])))];
  const phones = [...new Set(rows.flatMap((r) => (r.phone ? [r.phone] : [])))];
  const byKey = new Map<string, Guest>();
  if (emails.length === 0 && phones.length === 0) return byKey;
  const found = await db.guest.findMany({
    where: { mergedIntoId: null, OR: [{ email: { in: emails } }, { phone: { in: phones } }] },
    orderBy: { createdAt: 'asc' },
  });
  for (const g of found) {
    if (g.email && !byKey.has(`email:${g.email.toLowerCase()}`)) {
      byKey.set(`email:${g.email.toLowerCase()}`, g);
    }
    if (g.phone && !byKey.has(`phone:${g.phone}`)) byKey.set(`phone:${g.phone}`, g);
  }
  return byKey;
}

const guestKeys = (r: ReservationRow) => [
  ...(r.email ? [`email:${r.email}`] : []),
  ...(r.phone ? [`phone:${r.phone}`] : []),
];

/** Old confirmation numbers already imported, with the booking they became. */
async function imported(db: Client, rows: ReservationRow[]) {
  const found = await db.reservation.findMany({
    where: {
      source: { not: 'OTA_CHANNEL' },
      channelRef: { in: [...new Set(rows.map((r) => r.oldConfirmationNo))] },
    },
    select: { channelRef: true, confirmationNo: true },
  });
  return new Map(found.map((r) => [r.channelRef ?? '', r.confirmationNo]));
}

/** The plan a row is booked on, or why it can't be. */
function planFor(
  l: Lookups,
  r: ReservationRow,
  type: RoomType,
  company: Company | null,
): RatePlan | string {
  const plan = r.ratePlanCode ? l.plans.get(r.ratePlanCode) : l.defaultPlan;
  if (!plan) {
    return r.ratePlanCode
      ? `No active rate plan ${r.ratePlanCode}`
      : 'No best available rate plan here: give a rate plan code';
  }
  if (plan.roomTypeIds.length > 0 && !plan.roomTypeIds.includes(type.id)) {
    return `${plan.code} does not sell ${type.code}`;
  }
  if (plan.kind === 'NEGOTIATED' && plan.companyId !== company?.id) {
    return `${plan.code} is for one company: give that company on the booking`;
  }
  return plan;
}

export async function checkReservations(
  db: Client,
  rows: ReservationRow[],
  tenant: TenantContext,
  today: string,
): Promise<Checked> {
  // Booking's own permission, beside the import's.
  if (!tenant.permissions.has('reservation.create')) {
    throw new AppError('FORBIDDEN', 'Importing bookings needs the permission to make them.', {
      permission: 'reservation.create',
    });
  }
  const errors: ImportError[] = [];
  const l = await lookups(db);
  if (!l.hasRoomCode && rows.length > 0) {
    errors.push({
      row: null,
      column: null,
      message: 'Add a room revenue code (Tax and FX) before importing bookings',
    });
  }
  const done = await imported(db, rows);
  const guests = await knownGuests(db, rows);
  const typeIds = [...new Set(rows.flatMap((r) => l.types.get(r.roomTypeCode)?.id ?? []))];
  const from = rows.reduce((m, r) => (r.arrival < m ? r.arrival : m), '9999-12-31');
  const to = rows.reduce((m, r) => (r.departure > m ? r.departure : m), '0000-01-01');
  const inventory =
    typeIds.length === 0
      ? []
      : await db.roomTypeInventory.findMany({
          where: { roomTypeId: { in: typeIds }, date: { gte: dbDate(from), lt: dbDate(to) } },
        });
  // Rooms left per type and night, taken as the file's bookings are counted.
  const left = new Map(
    inventory.map((i) => [
      `${i.roomTypeId}|${day(i.date)}`,
      i.capacity - i.outOfOrder - i.sold - i.held + i.overbookLimit,
    ]),
  );
  const seen = new Set<string>();
  let guestsNew = 0;
  let reservationsNew = 0;
  let staysNew = 0;
  let nights = 0;
  for (const group of bookings(rows)) {
    const head = group[0] as ReservationRow;
    const before = done.get(head.oldConfirmationNo);
    if (before !== undefined) {
      for (const r of group) {
        errors.push({
          row: r.row,
          column: 'old_confirmation_no',
          message: `${r.oldConfirmationNo} was imported before (${before})`,
        });
      }
      continue;
    }
    const company = head.companyName ? l.companies.get(nameKey(head.companyName)) : null;
    let groupOk = true;
    const taken: string[] = [];
    for (const r of group) {
      const fail = (column: string, message: string) => {
        errors.push({ row: r.row, column, message });
        groupOk = false;
      };
      if (r !== head) {
        if (nameKey(r.companyName ?? '') !== nameKey(head.companyName ?? '')) {
          fail('company_name', `Rows of one booking share its company (row ${head.row})`);
          continue;
        }
        if (r.source !== head.source) {
          fail('source', `Rows of one booking share its source (row ${head.row})`);
          continue;
        }
      }
      if (r.companyName && !company) {
        fail('company_name', `No company or travel agent called ${r.companyName}`);
        continue;
      }
      if (r.arrival < today) {
        fail('arrival', 'Only bookings still to come: arrival today or later');
        continue;
      }
      const type = l.types.get(r.roomTypeCode);
      if (!type) {
        fail('room_type_code', `No active room type ${r.roomTypeCode}`);
        continue;
      }
      if (r.adults + r.children > type.maxOccupancy) {
        fail('adults', `${type.name} takes at most ${type.maxOccupancy} guests`);
        continue;
      }
      const plan = planFor(l, r, type, company ?? null);
      if (typeof plan === 'string') {
        fail('rate_plan_code', plan);
        continue;
      }
      const flagged = guestKeys(r)
        .map((k) => guests.get(k))
        .find((g) => g?.doNotRent);
      if (flagged) {
        fail(
          r.email && guests.get(`email:${r.email}`)?.doNotRent ? 'email' : 'phone',
          'This guest is flagged do-not-rent: book them at the desk, with a manager',
        );
        continue;
      }
      const full = nightsOf(r).filter((date) => {
        const k = `${type.id}|${date}`;
        const n = left.get(k) ?? 0;
        if (n < 1) return true;
        left.set(k, n - 1);
        taken.push(k);
        return false;
      });
      if (full.length > 0) {
        fail(
          'arrival',
          `No ${type.code} room is left on ${full.slice(0, 5).join(', ')}${full.length > 5 ? ` and ${full.length - 5} more nights` : ''}`,
        );
        continue;
      }
    }
    if (!groupOk) {
      // A booking that can't be made gives back the rooms its other rows counted.
      for (const k of taken) left.set(k, (left.get(k) ?? 0) + 1);
      continue;
    }
    reservationsNew++;
    staysNew += group.length;
    for (const r of group) {
      nights += daysBetween(r.arrival, r.departure);
      // As applying does: a guest is matched by email or phone, else added once.
      const keys = guestKeys(r);
      if (!keys.some((k) => guests.has(k) || seen.has(k))) guestsNew++;
      for (const k of keys) seen.add(k);
    }
  }
  return {
    errors,
    summary: {
      reservationsNew,
      staysNew,
      nights,
      guestsNew,
    },
  };
}

/** Books every checked row: one reservation per old booking, confirmed. */
export async function applyReservations(
  tx: Tx,
  tenant: TenantContext,
  rows: ReservationRow[],
  now: Date,
  importId: string,
) {
  const property = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
  const l = await lookups(tx);
  const guests = await knownGuests(tx, rows);
  let reservationsWritten = 0;
  let staysWritten = 0;
  let guestsWritten = 0;
  const guestFor = async (r: ReservationRow): Promise<Guest> => {
    const keys = guestKeys(r);
    const known = keys.map((k) => guests.get(k)).find(Boolean);
    if (known) return known;
    const created = await tx.guest.create({
      data: {
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        phone: r.phone,
      } as unknown as Prisma.GuestUncheckedCreateInput,
    });
    guestsWritten++;
    for (const k of keys) guests.set(k, created);
    await recordAudit(tx, {
      action: 'guest.created',
      entityType: 'guest',
      entityId: created.id,
      propertyId: null,
      after: { firstName: created.firstName, lastName: created.lastName, importJobId: importId },
    });
    return created;
  };

  for (const group of bookings(rows)) {
    const head = group[0] as ReservationRow;
    const company = head.companyName ? (l.companies.get(nameKey(head.companyName)) ?? null) : null;
    const source =
      head.source ??
      (company?.kind === 'TRAVEL_AGENT' ? 'TRAVEL_AGENT' : company ? 'CORPORATE' : 'DIRECT');
    const stays = [];
    for (const r of group) {
      const type = l.types.get(r.roomTypeCode) as RoomType;
      const plan = planFor(l, r, type, company) as RatePlan;
      const rate = BigInt(r.nightlyRateMinor);
      const quote = await channelQuote(tx, {
        roomTypeId: type.id,
        ratePlanId: plan.id,
        arrival: r.arrival,
        departure: r.departure,
        guests: r.adults + r.children,
        amounts: new Map(nightsOf(r).map((date) => [date, rate])),
        currency: property.baseCurrency,
        now,
      });
      if (!quote) throw new Error(`Import ${importId}: row ${r.row} could not be priced`);
      stays.push({ r, type, quote, guest: await guestFor(r) });
    }
    const booker = (stays[0] as (typeof stays)[number]).guest;
    const n = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.CONFIRMATION);
    const confirmationNo = `${property.code}-${String(n).padStart(5, '0')}`;
    const notes = [`Imported from the old system (${head.oldConfirmationNo}).`, head.notes]
      .filter(Boolean)
      .join(' ');
    const reservation = await tx.reservation.create({
      data: {
        confirmationNo,
        bookerGuestId: booker.id,
        companyId: company && company.kind !== 'TRAVEL_AGENT' ? company.id : null,
        travelAgentId: company?.kind === 'TRAVEL_AGENT' ? company.id : null,
        source,
        channelRef: head.oldConfirmationNo,
        status: 'CONFIRMED',
        // Deposits held stay in the old books (Philip, 2026-11-26).
        guarantee: company && company.kind !== 'TRAVEL_AGENT' ? 'COMPANY' : 'NONE',
        notes,
        createdById: tenant.userId,
        createdAt: now,
        history: { create: { toStatus: 'CONFIRMED', byUserId: tenant.userId, at: now } },
      } as unknown as Prisma.ReservationUncheckedCreateInput,
    });
    for (const s of stays) {
      await tx.stay.create({
        data: {
          reservationId: reservation.id,
          guestId: s.guest.id,
          roomTypeId: s.type.id,
          ratePlanId: s.quote.ratePlanId,
          quoteId: s.quote.id,
          arrival: s.quote.arrival,
          departure: s.quote.departure,
          adults: s.r.adults,
          children: s.r.children,
          status: 'CONFIRMED',
          nights: {
            create: (s.quote.nights as unknown as QuoteNight[]).map((night) => ({
              date: dbDate(night.date),
              amountMinor: BigInt(night.amountMinor),
              ratePlanId: night.pricedBy,
              ruleVersion: night.ruleVersion,
            })),
          },
        } as unknown as Prisma.StayUncheckedCreateInput,
      });
    }
    const field = inventoryFieldOf('CONFIRMED');
    // Same order everywhere, so two bookings never wait on each other's nights.
    for (const s of [...stays].sort((a, b) => a.type.id.localeCompare(b.type.id))) {
      if (field) {
        await takeInventory(tx, {
          propertyId: tenant.propertyId,
          roomTypeId: s.type.id,
          arrival: s.r.arrival,
          departure: s.r.departure,
          field,
        });
      }
    }
    await recordAudit(tx, {
      action: 'reservation.created',
      entityType: 'reservation',
      entityId: reservation.id,
      after: {
        confirmationNo,
        oldConfirmationNo: head.oldConfirmationNo,
        importJobId: importId,
        status: 'CONFIRMED',
        source,
        bookerGuestId: booker.id,
        stays: stays.map((s) => ({
          quoteId: s.quote.id,
          guestId: s.guest.id,
          arrival: s.r.arrival,
          departure: s.r.departure,
        })),
      },
    });
    await recordEvent(tx, {
      type: 'reservation.created',
      payload: { reservationId: reservation.id, confirmationNo, status: 'CONFIRMED' },
    });
    reservationsWritten++;
    staysWritten += stays.length;
  }
  return { reservationsWritten, staysWritten, guestsWritten };
}
