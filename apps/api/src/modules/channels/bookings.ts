import { createHash } from 'node:crypto';
import {
  addDays,
  daysBetween,
  MODIFIABLE_STATUSES,
  type ChannelBookingItem,
  type ReservationBody,
} from '@hotel/shared';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { ChannelBookingRevision, Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import {
  ChannelError,
  channexSignatureOk,
  type ChannelBookingRevisionData,
  type ChannelManager,
} from '../../core/channel-manager.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { defineJob } from '../../core/jobs.ts';
import { recordEvent, type EventHandler } from '../../core/outbox.ts';
import { runAsTenant, type TenantContext } from '../../core/tenancy.ts';
import { createTenantDb, type TenantDb } from '../../core/tenant-db.ts';
import { channelQuote } from '../availability/quotes.ts';
import {
  bookFromChannel,
  cancelReservation,
  updateReservation,
  type ReservationDeps,
} from '../reservations/service.ts';

// OTA bookings in from the channel manager (PRD M11-07 "import OTA bookings as reservations",
// AC "an OTA booking imported twice creates one reservation"; M4 rule 6 for the webhook; T-153).
//
// - The booking feed holds every revision not acknowledged yet. The worker reads it every
//   minute; Channex's signed webhook makes it read at once (it is a signal, never the booking
//   itself: deliveries are unordered, so the booking is always read back from the feed).
// - Each revision is saved whole (card details left out) before it is acknowledged, because
//   Channex then removes the guest's contact details. Acknowledged, it leaves the feed.
// - A revision is a full picture of the booking, so only the latest of a booking is applied:
//   the reservation (source OTA_CHANNEL, channelRef = the channel manager's booking ID) is
//   made, changed or cancelled to match it. Applying the same picture again changes nothing.
// - Anything that cannot be applied safely is held for staff with its reason (a room or plan
//   not set up, no room left, another currency, a guest already in house, a booking cancelled
//   here, a different number of rooms…): they try again once it is fixed, or mark it handled.
// - The OTA's nightly prices are kept; taxes are worked out as for any booking. An OTA
//   cancellation carries no fee here (the OTA charges it).

export interface ChannelBookingDeps {
  db: Db;
  clock: Clock;
  channel: ChannelManager;
  logger?: Logger;
}

const LEASE_MS = 5 * 60_000;
/** Feed pages per run (each page is acknowledged before the next is read). */
const MAX_PAGES = 10;
const PROVIDER = 'CHANNEX';
const NOTES_MAX = 2000;

type Held = {
  outcome: 'HELD';
  reason: HoldReason;
  message: string;
  reservationId: string | null;
};
type Applied = { outcome: 'APPLIED'; reservationId: string | null; message: string };
type Result = Held | Applied;

export type HoldReason =
  | 'UNMAPPED_ROOM'
  | 'UNMAPPED_RATE'
  | 'NO_ROOM'
  | 'CURRENCY'
  | 'IN_HOUSE'
  | 'CANCELLED_HERE'
  | 'ROOMS_CHANGED'
  | 'INVALID'
  | 'REFUSED';

const held = (reason: HoldReason, message: string, reservationId: string | null = null): Held => ({
  outcome: 'HELD',
  reason,
  message,
  reservationId,
});
const applied = (reservationId: string | null, message: string): Applied => ({
  outcome: 'APPLIED',
  reservationId,
  message,
});

// ── Reading a revision ──────────────────────────────────────────────────────────────────

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Text = z.string().nullable().optional();
const Amount = z.union([z.string(), z.number()]).nullable().optional();

const RevisionRoom = z.object({
  room_type_id: Text,
  rate_plan_id: Text,
  checkin_date: IsoDay.nullable().optional(),
  checkout_date: IsoDay.nullable().optional(),
  occupancy: z
    .object({
      adults: z.number().int().min(0).nullable().optional(),
      children: z.number().int().min(0).nullable().optional(),
    })
    .nullable()
    .optional(),
  days: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .nullable()
    .optional(),
  amount: Amount,
  guests: z
    .array(z.object({ name: Text, surname: Text }))
    .nullable()
    .optional(),
});

/** What we read of a Channex booking revision (the rest is kept as sent). */
const Revision = z.object({
  booking_id: z.string().min(1),
  status: z.enum(['new', 'modified', 'cancelled']),
  ota_name: Text,
  ota_reservation_code: Text,
  arrival_date: IsoDay.nullable().optional(),
  departure_date: IsoDay.nullable().optional(),
  currency: Text,
  customer: z.object({ name: Text, surname: Text, mail: Text, phone: Text }).nullable().optional(),
  rooms: z.array(RevisionRoom).nullable().optional(),
  notes: Text,
  payment_collect: Text,
  inserted_at: Text,
});
type RevisionData = z.infer<typeof Revision>;

/** "12500.00" (or 12500) → 1250000 minor units; null when it is not an amount. */
export function minorOf(v: unknown): bigint | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v >= 0 ? BigInt(Math.round(v * 100)) : null;
  }
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (!m) return null;
  return BigInt(m[1] ?? '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

/** Channex's inserted_at has no zone; it is UTC. */
function receivedAtOf(v: unknown, fallback: Date): Date {
  if (typeof v !== 'string') return fallback;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(t) ? fallback : new Date(t);
}

const clean = (v: string | null | undefined, max = 100) => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return t === '' ? null : t;
};

/** A phone as the guest book keeps it (+ and digits), or null when it is not one. */
export function phoneOf(v: string | null | undefined): string | null {
  const raw = (v ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return raw.startsWith('+') ? `+${digits}` : digits;
}

function emailOf(v: string | null | undefined): string | null {
  const t = (v ?? '').trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(t) ? t : null;
}

const guestNameOf = (r: Pick<RevisionData, 'customer'>) =>
  [clean(r.customer?.name), clean(r.customer?.surname)].filter(Boolean).join(' ') || 'Guest';

const KIND = { new: 'NEW', modified: 'MODIFIED', cancelled: 'CANCELLED' } as const;

/** Card details and the raw OTA message are never kept. */
function keptPayload(attributes: Record<string, unknown>): Prisma.InputJsonObject {
  const { guarantee: _g, raw_message: _r, ...rest } = attributes;
  return rest as Prisma.InputJsonObject;
}

// ── Taking revisions in ─────────────────────────────────────────────────────────────────

interface Connection {
  id: string;
  propertyId: string;
  externalPropertyId: string | null;
}

/** Saves one revision as sent, once (a revision read again is left as it is). */
async function save(
  db: Db,
  connection: Connection,
  data: ChannelBookingRevisionData,
  now: Date,
): Promise<void> {
  const parsed = Revision.safeParse(data.attributes);
  const a = data.attributes;
  const base = {
    propertyId: connection.propertyId,
    connectionId: connection.id,
    externalId: data.id,
    payload: keptPayload(a),
    receivedAt: receivedAtOf(a.inserted_at, now),
    takenAt: now,
  };
  const row: Prisma.ChannelBookingRevisionCreateManyInput = parsed.success
    ? {
        ...base,
        externalBookingId: parsed.data.booking_id,
        kind: KIND[parsed.data.status],
        otaName: clean(parsed.data.ota_name),
        otaCode: clean(parsed.data.ota_reservation_code),
        guestName: guestNameOf(parsed.data),
        ...validDates(parsed.data.arrival_date, parsed.data.departure_date),
      }
    : {
        ...base,
        externalBookingId:
          typeof a.booking_id === 'string' && a.booking_id ? a.booking_id : data.id,
        kind: a.status === 'cancelled' ? 'CANCELLED' : a.status === 'modified' ? 'MODIFIED' : 'NEW',
        guestName: 'Guest',
        outcome: 'HELD',
        holdReason: 'INVALID',
        message: 'The booking could not be read; see it on the channel manager',
      };
  await db.channelBookingRevision.createMany({ data: [row], skipDuplicates: true });
}

function validDates(arrival: string | null | undefined, departure: string | null | undefined) {
  if (!arrival || !departure || departure <= arrival) return { arrival: null, departure: null };
  return {
    arrival: new Date(`${arrival}T00:00:00Z`),
    departure: new Date(`${departure}T00:00:00Z`),
  };
}

export type PullOutcome = 'SKIPPED' | 'DONE' | 'FAILED';

/**
 * One run for one connection: read the feed to the end (saving, then acknowledging each
 * revision), then apply what is waiting.
 */
export async function pullBookings(
  deps: ChannelBookingDeps,
  connectionId: string,
): Promise<PullOutcome> {
  const { db, clock, channel } = deps;
  const now = clock();
  const claimed = await db.channelConnection.updateMany({
    where: {
      id: connectionId,
      status: 'ACTIVE',
      externalPropertyId: { not: null },
      OR: [{ bookingsLockedUntil: null }, { bookingsLockedUntil: { lt: now } }],
    },
    data: { bookingsLockedUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count !== 1) return 'SKIPPED';
  const connection = await db.channelConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const release = (data: Prisma.ChannelConnectionUpdateInput) =>
    db.channelConnection.update({
      where: { id: connectionId },
      data: { ...data, bookingsLockedUntil: null },
    });

  try {
    let taken = 0;
    try {
      const seen = new Set<string>();
      for (let page = 0; page < MAX_PAGES; page++) {
        const feed = await channel.bookingFeed(connection.externalPropertyId ?? '');
        const fresh = feed.filter((r) => !seen.has(r.id));
        if (fresh.length === 0) break;
        for (const revision of fresh) {
          seen.add(revision.id);
          await save(db, connection, revision, clock());
          // Saved first: once acknowledged, the guest's contact details are gone.
          await channel.ackBookingRevision(revision.id);
          await db.channelBookingRevision.updateMany({
            where: { connectionId, externalId: revision.id, ackedAt: null },
            data: { ackedAt: clock() },
          });
          taken += 1;
        }
      }
    } catch (err) {
      if (!(err instanceof ChannelError)) throw err;
      await db.channelSyncLog.create({
        data: {
          propertyId: connection.propertyId,
          connectionId,
          kind: 'BOOKING',
          status: 'FAILED',
          items: taken,
          message: err.message,
        },
      });
      // What was taken is applied all the same; the feed is read again next minute.
      await applyWaiting(deps, connection);
      await release({ bookingsError: err.message });
      return 'FAILED';
    }
    const counts = await applyWaiting(deps, connection);
    if (taken > 0 || counts.applied + counts.held > 0) {
      await db.channelSyncLog.create({
        data: {
          propertyId: connection.propertyId,
          connectionId,
          kind: 'BOOKING',
          status: counts.held > 0 ? 'WARNING' : 'OK',
          items: taken,
          message: `${taken} taken in, ${counts.applied} applied, ${counts.held} held for staff`,
        },
      });
    }
    await release({ bookingsCheckedAt: clock(), bookingsError: null });
    return 'DONE';
  } catch (err) {
    await release({}).catch(() => undefined);
    throw err;
  }
}

/** Applies the latest waiting revision of each booking; older ones are superseded. */
async function applyWaiting(
  deps: ChannelBookingDeps,
  connection: Connection,
): Promise<{ applied: number; held: number }> {
  const waiting = await deps.db.channelBookingRevision.findMany({
    where: { connectionId: connection.id, outcome: 'PENDING' },
    orderBy: [{ receivedAt: 'asc' }, { takenAt: 'asc' }, { id: 'asc' }],
  });
  const latest = new Map<string, ChannelBookingRevision>();
  for (const r of waiting) latest.set(r.externalBookingId, r);
  const counts = { applied: 0, held: 0 };
  for (const row of latest.values()) {
    try {
      const outcome = await applyRevision(deps, null, row.id);
      if (outcome === 'APPLIED') counts.applied += 1;
      if (outcome === 'HELD') counts.held += 1;
    } catch (err) {
      // Left waiting: tried again next minute (another change raced it, the database…).
      deps.logger?.warn(
        { propertyId: connection.propertyId, db: pgErrorInfo(err) },
        'Channel booking not applied yet',
      );
    }
  }
  return counts;
}

/** The booking page's system tenant, for work nobody started: audit shows SYSTEM. */
function systemTenant(property: { id: string; organisationId: string }): TenantContext {
  return {
    userId: null as unknown as string,
    organisationId: property.organisationId,
    propertyId: property.id,
    roles: [],
    permissions: new Set(),
  };
}

/**
 * Makes the reservation match one revision, or holds the revision for staff. `tenant` is
 * the member trying again (S41), or null for the worker. Answers the outcome, or SUPERSEDED
 * when a later revision of the booking already counts.
 */
export async function applyRevision(
  deps: ChannelBookingDeps,
  tenant: TenantContext | null,
  revisionId: string,
): Promise<'APPLIED' | 'HELD' | 'SUPERSEDED'> {
  const row = await deps.db.channelBookingRevision.findUniqueOrThrow({
    where: { id: revisionId },
    include: { property: true },
  });
  // Out of order: a later revision of this booking was already applied or held.
  const later = await deps.db.channelBookingRevision.findFirst({
    where: {
      connectionId: row.connectionId,
      externalBookingId: row.externalBookingId,
      id: { not: row.id },
      outcome: { in: ['APPLIED', 'HELD', 'DISMISSED'] },
      receivedAt: { gt: row.receivedAt },
    },
  });
  if (later) {
    await deps.db.channelBookingRevision.update({
      where: { id: row.id },
      data: { outcome: 'SUPERSEDED' },
    });
    return 'SUPERSEDED';
  }
  const actor = tenant ?? systemTenant(row.property);
  const result = await runAsTenant(actor, async () => {
    const rdeps: ReservationDeps = {
      db: deps.db,
      tenantDb: createTenantDb(deps.db),
      clock: deps.clock,
    };
    return decide(rdeps, actor, row);
  });
  await deps.db.$transaction(async (tx) => {
    await tx.channelBookingRevision.update({
      where: { id: row.id },
      data: {
        outcome: result.outcome,
        holdReason: result.outcome === 'HELD' ? result.reason : null,
        message: result.message,
        reservationId: result.reservationId,
      },
    });
    // This picture of the booking now counts: earlier ones waiting or held are done with.
    await tx.channelBookingRevision.updateMany({
      where: {
        connectionId: row.connectionId,
        externalBookingId: row.externalBookingId,
        id: { not: row.id },
        outcome: { in: ['PENDING', 'HELD'] },
        receivedAt: { lte: row.receivedAt },
      },
      data: { outcome: 'SUPERSEDED' },
    });
  });
  return result.outcome;
}

// ── Deciding what a revision does ──────────────────────────────────────────────────────

interface WantedStay {
  roomTypeId: string;
  ratePlanId: string;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  amounts: Map<string, bigint>;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Body = z.output<typeof ReservationBody>;

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The stays a revision asks for, or why they cannot be booked. */
async function wantedStays(
  db: TenantDb,
  row: ChannelBookingRevision,
  r: RevisionData,
  currency: string,
): Promise<WantedStay[] | Held> {
  if (r.currency && r.currency.toUpperCase() !== currency) {
    return held(
      'CURRENCY',
      `The booking is in ${r.currency.toUpperCase()}; the hotel sells in ${currency}`,
    );
  }
  const rooms = r.rooms ?? [];
  if (rooms.length === 0 || rooms.length > 20) {
    return held('INVALID', 'The booking has no rooms (or more than 20)');
  }
  const mappings = await db.channelMapping.findMany({ where: { connectionId: row.connectionId } });
  const roomTypeOf = new Map(
    mappings.filter((m) => m.kind === 'ROOM_TYPE').map((m) => [m.externalId, m.roomTypeId]),
  );
  const planOf = new Map(
    mappings
      .filter((m) => m.kind === 'RATE_PLAN' && m.ratePlanId)
      .map((m) => [m.externalId, { ratePlanId: m.ratePlanId ?? '', roomTypeId: m.roomTypeId }]),
  );
  const out: WantedStay[] = [];
  for (const [i, room] of rooms.entries()) {
    const n = rooms.length > 1 ? ` (room ${i + 1})` : '';
    const roomTypeId = room.room_type_id ? roomTypeOf.get(room.room_type_id) : undefined;
    if (!roomTypeId) {
      return held('UNMAPPED_ROOM', `The OTA sold a room type that is not set up here${n}`);
    }
    const plan = room.rate_plan_id ? planOf.get(room.rate_plan_id) : undefined;
    if (plan?.roomTypeId !== roomTypeId) {
      return held('UNMAPPED_RATE', `The OTA sold a rate plan that is not set up here${n}`);
    }
    const arrival = room.checkin_date ?? r.arrival_date;
    const departure = room.checkout_date ?? r.departure_date;
    if (!arrival || !departure || departure <= arrival || daysBetween(arrival, departure) > 90) {
      return held('INVALID', `The booking’s dates cannot be read${n}`);
    }
    const nights = daysBetween(arrival, departure);
    const dates = Array.from({ length: nights }, (_, d) => addDays(arrival, d));
    const amounts = new Map<string, bigint>();
    const days = room.days ?? {};
    for (const date of dates) {
      const v = minorOf(days[date]);
      if (v !== null) amounts.set(date, v);
    }
    if (amounts.size !== nights) {
      // No price per night: the room's total, spread evenly (the remainder on the first).
      const total = minorOf(room.amount);
      if (total === null) return held('INVALID', `The booking has no price for some nights${n}`);
      const each = total / BigInt(nights);
      dates.forEach((date, d) =>
        amounts.set(date, d === 0 ? total - each * BigInt(nights - 1) : each),
      );
    }
    out.push({
      roomTypeId,
      ratePlanId: plan.ratePlanId,
      arrival,
      departure,
      adults: Math.max(1, room.occupancy?.adults ?? 1),
      children: room.occupancy?.children ?? 0,
      amounts,
    });
  }
  return out;
}

/** Why a booking or change was refused, as a hold; anything else is thrown (tried again). */
function heldFrom(err: unknown, reservationId: string | null = null): Held {
  if (err instanceof AppError) {
    if (err.code === 'BOOKING_CONFLICT') {
      return held('NO_ROOM', 'No room of this type is left on some nights', reservationId);
    }
    // Someone changed the reservation meanwhile: tried again on the next run.
    if (err.code !== 'VERSION_CONFLICT') {
      return held('REFUSED', err.message, reservationId);
    }
  }
  throw err;
}

class NotPriced extends Error {}

async function quotesFor(
  db: TenantDb | Tx,
  wanted: WantedStay[],
  currency: string,
  now: Date,
): Promise<{ id: string }[]> {
  const quotes = [];
  for (const w of wanted) {
    const quote = await channelQuote(db, {
      ...w,
      guests: w.adults + w.children,
      currency,
      now,
    });
    if (!quote) throw new NotPriced();
    quotes.push(quote);
  }
  return quotes;
}

const NOT_PRICED = held(
  'REFUSED',
  'The rate plan cannot take these nights (switched off, or no room revenue code)',
);

function notesOf(r: RevisionData): string | null {
  const parts = [
    [clean(r.ota_name), clean(r.ota_reservation_code)].filter(Boolean).join(' '),
    r.payment_collect === 'ota'
      ? 'Paid to the OTA'
      : r.payment_collect === 'property'
        ? 'The guest pays the hotel'
        : null,
    ...(r.rooms ?? []).flatMap((room, i) => {
      const names = (room.guests ?? [])
        .map((g) => [clean(g.name), clean(g.surname)].filter(Boolean).join(' '))
        .filter(Boolean);
      return names.length > 0 && (r.rooms?.length ?? 0) > 1
        ? [`Room ${i + 1}: ${names.join(', ')}`]
        : [];
    }),
    clean(r.notes, NOTES_MAX),
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(' · ').slice(0, NOTES_MAX) : null;
}

const sameStay = (
  s: {
    roomTypeId: string;
    ratePlanId: string;
    arrival: Date;
    departure: Date;
    adults: number;
    children: number;
    nights: { date: Date; amountMinor: bigint }[];
  },
  w: WantedStay,
) =>
  s.roomTypeId === w.roomTypeId &&
  s.ratePlanId === w.ratePlanId &&
  day(s.arrival) === w.arrival &&
  day(s.departure) === w.departure &&
  s.adults === w.adults &&
  s.children === w.children &&
  s.nights.length === w.amounts.size &&
  s.nights.every((n) => w.amounts.get(day(n.date)) === n.amountMinor);

/** Pairs each stay with a room of the revision: same everything first, then same type. */
function pair<S extends { roomTypeId: string }>(stays: S[], wanted: WantedStay[]) {
  const left = [...stays];
  const out: { stay: S; wanted: WantedStay }[] = [];
  const rest: WantedStay[] = [];
  const take = (test: (s: S) => boolean) => {
    const i = left.findIndex(test);
    return i >= 0 ? left.splice(i, 1)[0] : undefined;
  };
  for (const w of wanted) {
    const stay = take((s) => sameStay(s as never, w));
    if (stay) out.push({ stay, wanted: w });
    else rest.push(w);
  }
  const rest2: WantedStay[] = [];
  for (const w of rest) {
    const stay = take((s) => s.roomTypeId === w.roomTypeId);
    if (stay) out.push({ stay, wanted: w });
    else rest2.push(w);
  }
  for (const w of rest2) {
    const stay = take(() => true);
    if (stay) out.push({ stay, wanted: w });
  }
  return out;
}

async function decide(
  deps: ReservationDeps,
  tenant: TenantContext,
  row: ChannelBookingRevision,
): Promise<Result> {
  const parsed = Revision.safeParse(row.payload);
  if (!parsed.success) {
    return held('INVALID', 'The booking could not be read; see it on the channel manager');
  }
  const r = parsed.data;
  const db = deps.tenantDb;
  const existing = await db.reservation.findFirst({
    where: { source: 'OTA_CHANNEL', channelRef: row.externalBookingId },
    include: { stays: { include: { nights: true } } },
  });
  const label = [clean(r.ota_name), clean(r.ota_reservation_code)].filter(Boolean).join(' ');

  if (r.status === 'cancelled') {
    if (!existing) return applied(null, 'Cancelled before it was taken in: nothing to cancel');
    if (existing.status === 'CANCELLED') return applied(existing.id, 'Already cancelled');
    if (!MODIFIABLE_STATUSES.includes(existing.status)) {
      return held(
        'IN_HOUSE',
        'Cancelled on the OTA, but the guest has arrived: settle it by hand',
        existing.id,
      );
    }
    try {
      await cancelReservation(deps, tenant, existing.id, {
        reason: 'OTA_CANCELLED',
        note: label || null,
      });
    } catch (err) {
      return heldFrom(err, existing.id);
    }
    return applied(existing.id, 'Cancelled');
  }

  const property = await db.property.findUniqueOrThrow({ where: { id: row.propertyId } });
  const wanted = await wantedStays(db, row, r, property.baseCurrency);
  if (!Array.isArray(wanted)) return { ...wanted, reservationId: existing?.id ?? null };
  const now = deps.clock();

  if (!existing) {
    const customer = r.customer ?? {};
    const body: Body = {
      source: 'OTA_CHANNEL',
      guarantee: 'NONE',
      holdUntil: null,
      booker: {
        guestId: null,
        firstName: clean(customer.name) ?? 'Guest',
        lastName: clean(customer.surname) ?? (label || 'OTA'),
        phone: phoneOf(customer.phone),
        email: emailOf(customer.mail),
      },
      companyId: null,
      groupBlockId: null,
      stays: [],
      notes: notesOf(r),
    };
    try {
      const id = await db.$transaction(async (tx) => {
        const quotes = await quotesFor(tx, wanted, property.baseCurrency, now);
        body.stays = quotes.map((q, i) => ({
          quoteId: q.id,
          adults: wanted[i]?.adults,
          children: wanted[i]?.children,
          guest: { sameAsBooker: true, guestId: null, phone: null, email: null },
          roomId: null,
        }));
        return bookFromChannel(deps, tx, tenant, body, row.externalBookingId);
      });
      return applied(id, 'Booked');
    } catch (err) {
      if (err instanceof NotPriced) return NOT_PRICED;
      return heldFrom(err);
    }
  }

  if (existing.status === 'CANCELLED') {
    return held(
      'CANCELLED_HERE',
      'Changed on the OTA, but cancelled here: book it again or cancel it on the OTA',
      existing.id,
    );
  }
  const live = existing.stays.filter((s) => s.status !== 'CANCELLED');
  const pairs = pair(live, wanted);
  const changed = pairs.filter((p) => !sameStay(p.stay, p.wanted));
  if (live.length === wanted.length && changed.length === 0) {
    return applied(existing.id, 'No change');
  }
  if (!MODIFIABLE_STATUSES.includes(existing.status)) {
    return held(
      'IN_HOUSE',
      'Changed on the OTA, but the guest has arrived: change it by hand',
      existing.id,
    );
  }
  if (live.length !== wanted.length) {
    return held(
      'ROOMS_CHANGED',
      `The OTA now has ${wanted.length} room${wanted.length === 1 ? '' : 's'} on this booking (here ${live.length}): change it by hand`,
      existing.id,
    );
  }
  try {
    const quotes = await quotesFor(
      db,
      changed.map((c) => c.wanted),
      property.baseCurrency,
      now,
    );
    await updateReservation(deps, tenant, existing.id, `"${existing.version}"`, {
      stays: changed.map((c, i) => ({
        stayId: c.stay.id,
        quoteId: quotes[i]?.id,
        adults: c.wanted.adults,
        children: c.wanted.children,
      })),
    });
  } catch (err) {
    if (err instanceof NotPriced) return { ...NOT_PRICED, reservationId: existing.id };
    return heldFrom(err, existing.id);
  }
  return applied(existing.id, 'Changed');
}

// ── Staff: held bookings (S41) ─────────────────────────────────────────────────────────

type ItemOut = z.input<typeof ChannelBookingItem>;

function toItem(
  r: ChannelBookingRevision & { reservation: { confirmationNo: string } | null },
): ItemOut {
  return {
    id: r.id,
    externalBookingId: r.externalBookingId,
    kind: r.kind as ItemOut['kind'],
    otaName: r.otaName,
    otaCode: r.otaCode,
    guestName: r.guestName,
    arrival: r.arrival ? day(r.arrival) : null,
    departure: r.departure ? day(r.departure) : null,
    receivedAt: r.receivedAt.toISOString(),
    outcome: r.outcome,
    holdReason: r.holdReason as ItemOut['holdReason'],
    message: r.message,
    reservationId: r.reservationId,
    confirmationNo: r.reservation?.confirmationNo ?? null,
  };
}

export async function listChannelBookings(
  db: TenantDb,
  query: { held?: boolean | undefined },
): Promise<ItemOut[]> {
  const rows = await db.channelBookingRevision.findMany({
    where: query.held ? { outcome: 'HELD' } : {},
    include: { reservation: { select: { confirmationNo: true } } },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: query.held ? 200 : 50,
  });
  return rows.map(toItem);
}

async function heldRow(db: TenantDb, id: string) {
  const row = await db.channelBookingRevision.findUnique({ where: { id } });
  if (!row) throw new AppError('NOT_FOUND', 'Booking not found');
  if (row.outcome !== 'HELD') {
    throw new AppError('STATE_TRANSITION_INVALID', 'This booking is not waiting for staff', {
      outcome: row.outcome,
    });
  }
  return row;
}

/** Try again (after setting up the room or plan, making room…): applied or held again. */
export async function retryChannelBooking(
  deps: ChannelBookingDeps & { tenantDb: TenantDb },
  tenant: TenantContext,
  id: string,
): Promise<ItemOut> {
  const row = await heldRow(deps.tenantDb, id);
  const outcome = await applyRevision(deps, tenant, row.id);
  await recordAudit(deps.tenantDb, {
    action: 'channel.booking_retried',
    entityType: 'channel_booking_revision',
    entityId: row.id,
    after: { outcome },
  });
  return toItem(
    await deps.tenantDb.channelBookingRevision.findUniqueOrThrow({
      where: { id },
      include: { reservation: { select: { confirmationNo: true } } },
    }),
  );
}

/** Handled by hand (booked or turned down outside): it stops waiting. */
export async function dismissChannelBooking(
  deps: { tenantDb: TenantDb; clock: Clock },
  tenant: TenantContext,
  id: string,
  body: { note: string },
): Promise<ItemOut> {
  return deps.tenantDb.$transaction(async (tx) => {
    const row = await heldRow(tx as unknown as TenantDb, id);
    const updated = await tx.channelBookingRevision.update({
      where: { id: row.id },
      data: {
        outcome: 'DISMISSED',
        message: `${row.message ?? ''} · Handled by hand: ${body.note}`.replace(/^ · /, ''),
        resolvedById: tenant.userId,
        resolvedAt: deps.clock(),
      },
      include: { reservation: { select: { confirmationNo: true } } },
    });
    await recordAudit(tx, {
      action: 'channel.booking_dismissed',
      entityType: 'channel_booking_revision',
      entityId: row.id,
      reason: body.note,
      before: { outcome: 'HELD', holdReason: row.holdReason },
      after: { outcome: 'DISMISSED' },
    });
    return toItem(updated);
  });
}

// ── The webhook, the handler and the job ───────────────────────────────────────────────

/** Events that mean a booking revision is waiting in the feed. */
const BOOKING_EVENTS = new Set([
  'booking',
  'booking_new',
  'booking_modification',
  'booking_cancellation',
  'booking_unmapped_room',
  'booking_unmapped_rate',
  'non_acked_booking',
]);

export const BOOKINGS_WAITING = 'channel.bookings_waiting';

/**
 * Receives one Channex webhook call (tab 4 POST /webhooks/channel/{provider}; M4 rule 6):
 * signature checked on the raw body (401 and nothing stored otherwise), stored once, and for
 * a booking event the property's feed is read at once (through the outbox).
 */
export async function receiveChannelWebhook(
  deps: { db: Db; clock: Clock; secrets: readonly string[] },
  provider: string,
  raw: Buffer | undefined,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ received: true }> {
  if (provider !== 'channex') throw new AppError('NOT_FOUND', 'No such channel manager');
  const now = deps.clock();
  if (!raw || !channexSignatureOk(raw, headers, deps.secrets, Math.floor(now.getTime() / 1000))) {
    throw new AppError('UNAUTHENTICATED', 'The webhook signature does not match');
  }
  let body: { event?: unknown; property_id?: unknown } = {};
  try {
    body = JSON.parse(raw.toString('utf8')) as typeof body;
  } catch {
    // Signed but not JSON: kept by its hash, nothing to do.
  }
  const event = typeof body.event === 'string' ? body.event : null;
  const externalPropertyId = typeof body.property_id === 'string' ? body.property_id : null;
  await deps.db.$transaction(async (tx) => {
    const stored = await tx.webhookEvent.createMany({
      data: [
        {
          provider: PROVIDER,
          eventId: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
          signatureOk: true,
          payload: (body && typeof body === 'object' ? body : {}) as Prisma.InputJsonObject,
          receivedAt: now,
          // Nothing for the payment job: the feed is the booking, this only says when to read.
          processedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    if (stored.count !== 1 || !event || !BOOKING_EVENTS.has(event) || !externalPropertyId) return;
    const connection = await tx.channelConnection.findFirst({
      where: { provider: PROVIDER, externalPropertyId, status: 'ACTIVE' },
      include: { property: { select: { organisationId: true } } },
    });
    if (!connection) return;
    await recordEvent(tx, {
      type: BOOKINGS_WAITING,
      organisationId: connection.property.organisationId,
      propertyId: connection.propertyId,
      payload: { connectionId: connection.id },
    });
  });
  return { received: true };
}

/** Reads the feed as soon as Channex says a booking is waiting. */
export function channelBookingsHandler(deps: ChannelBookingDeps): EventHandler {
  return {
    name: 'channel-bookings-pull',
    events: [BOOKINGS_WAITING],
    async handle(event) {
      const connectionId = event.payload.connectionId;
      // Already being read: that run, or the next minute's, takes it.
      if (typeof connectionId === 'string') await pullBookings(deps, connectionId);
    },
  };
}

/** Every minute: each active connection's feed (the webhook only makes it sooner). */
export async function pullAllBookings(deps: ChannelBookingDeps): Promise<void> {
  if (deps.channel.name === 'OFF') return;
  const connections = await deps.db.channelConnection.findMany({
    where: { status: 'ACTIVE', externalPropertyId: { not: null } },
    select: { id: true, propertyId: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const c of connections) {
    try {
      await pullBookings(deps, c.id);
    } catch (err) {
      // One property's problem never stops the others.
      deps.logger?.error(
        { propertyId: c.propertyId, db: pgErrorInfo(err) },
        'Taking in channel bookings failed',
      );
    }
  }
}

export const channelBookingsJob = (deps: { channel: ChannelManager }) =>
  defineJob({
    name: 'channel-bookings',
    schedule: { cron: '* * * * *' },
    options: { expireInSeconds: 5 * 60, retryLimit: 0 },
    run: (_data, ctx) =>
      pullAllBookings({ db: ctx.db, clock: ctx.clock, channel: deps.channel, logger: ctx.logger }),
  });
