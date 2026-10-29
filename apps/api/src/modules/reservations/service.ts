import {
  canTransition,
  cancellationFee,
  inventoryFieldOf,
  MODIFIABLE_STATUSES,
  type CalendarQuery,
  type CalendarStay,
  type CancelBody,
  type FeeRule,
  type ReservationBody,
  type ReservationItem,
  type ReservationPatchBody,
  type ReservationQuery,
  type ReservationStatus,
  type ReservationSummary,
} from '@hotel/shared';
import { z } from 'zod';
import type { Guest, Prisma, Quote } from '../../generated/prisma/client.ts';
import {
  needsApproval,
  performOrRequest,
  type ApprovalActionHandler,
} from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { propertyToday, releaseInventory, takeInventory } from '../availability/inventory.ts';
import type { QuoteNight } from '../availability/quotes.ts';
import { followRoom, releaseAllocations } from './rooms.ts';

// Reservations (PRD M3-01–M3-05, M3 rules 1 and 8; tab 4 row "Reservations"; T-042).
// A stay is booked from a quote, so it keeps the quoted nights and prices (M2 rule 4). Every
// change of status follows the fixed table in packages/shared and takes or gives back
// inventory in the same transaction: held while tentative, sold once confirmed.

export interface ReservationDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Body = z.output<typeof ReservationBody>;
type ItemOut = z.input<typeof ReservationItem>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

const notAllowed = (from: ReservationStatus, to: ReservationStatus, message?: string) =>
  new AppError(
    'STATE_TRANSITION_INVALID',
    message ??
      `A ${from.toLowerCase().replace('_', '-')} reservation cannot become ${to.toLowerCase().replace('_', '-')}`,
    { from, to },
  );

const FULL = {
  booker: true,
  company: true,
  stays: {
    include: {
      guest: true,
      roomType: true,
      room: true,
      ratePlan: { include: { cancellationPolicy: true } },
      quote: true,
      nights: { orderBy: { date: 'asc' } },
    },
    orderBy: [{ arrival: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.ReservationInclude;

type Full = Prisma.ReservationGetPayload<{ include: typeof FULL }>;
type FullStay = Full['stays'][number];

const guestRef = (g: Guest) => ({
  id: g.id,
  firstName: g.firstName,
  lastName: g.lastName,
  phone: g.phone,
  email: g.email,
});

/** Stays that still count (a cancelled reservation shows the stays it had). */
const live = (r: Full) =>
  r.status === 'CANCELLED' ? r.stays : r.stays.filter((s) => s.status !== 'CANCELLED');

const stayTotal = (s: FullStay) => s.quote.totalMinor;
const totalOf = (r: Full) => live(r).reduce((sum, s) => sum + stayTotal(s), 0n);

/** First night of each stay when the guarantee is a deposit (tab 4 example). */
function depositDue(r: Full): bigint {
  if (r.guarantee !== 'DEPOSIT') return 0n;
  return live(r).reduce((sum, s) => sum + (s.nights[0]?.amountMinor ?? 0n), 0n);
}

function toItem(r: Full): ItemOut {
  return {
    id: r.id,
    confirmationNo: r.confirmationNo,
    status: r.status,
    source: r.source,
    guarantee: r.guarantee,
    holdExpiresAt: r.holdExpiresAt ? iso(r.holdExpiresAt) : null,
    booker: guestRef(r.booker),
    company: r.company ? { id: r.company.id, name: r.company.name } : null,
    notes: r.notes,
    cancelReason: r.cancelReason,
    cancelledAt: r.cancelledAt ? iso(r.cancelledAt) : null,
    currency: r.stays[0]?.quote.currency ?? 'NGN',
    totalMinor: totalOf(r).toString(),
    depositDueMinor: depositDue(r).toString(),
    stays: r.stays.map((s) => ({
      id: s.id,
      status: s.status,
      guest: guestRef(s.guest),
      roomTypeId: s.roomTypeId,
      roomTypeName: s.roomType.name,
      roomId: s.roomId,
      roomNumber: s.room?.number ?? null,
      ratePlanId: s.ratePlanId,
      ratePlanCode: s.ratePlan.code,
      arrival: day(s.arrival),
      departure: day(s.departure),
      adults: s.adults,
      children: s.children,
      folioId: s.folioId,
      nights: s.nights.map((n) => ({ date: day(n.date), amountMinor: n.amountMinor.toString() })),
      totalMinor: stayTotal(s).toString(),
      version: s.version,
    })),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    version: r.version,
  };
}

async function loadFull(db: TenantDb | Tx, reservationId: string): Promise<Full> {
  const r = await db.reservation.findUnique({ where: { id: reservationId }, include: FULL });
  if (!r) throw new AppError('NOT_FOUND', 'Reservation not found');
  return r;
}

export async function getReservation(deps: ReservationDeps, reservationId: string) {
  return toItem(await loadFull(deps.tenantDb, reservationId));
}

// ── Finding ─────────────────────────────────────────────────────────────────────────────

const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function searchFilter(q: string | undefined): Prisma.ReservationWhereInput {
  const text = (q ?? '').trim();
  if (!text) return {};
  const digits = text.replace(/\D/g, '').replace(/^0+/, '');
  const or: Prisma.ReservationWhereInput[] = [
    { confirmationNo: { contains: text, mode: 'insensitive' } },
    { booker: { lastName: { startsWith: text, mode: 'insensitive' } } },
    { booker: { firstName: { startsWith: text, mode: 'insensitive' } } },
  ];
  if (digits.length >= 4) or.push({ booker: { phone: { contains: digits } } });
  return { OR: or };
}

export async function listReservations(
  deps: ReservationDeps,
  query: z.output<typeof ReservationQuery>,
) {
  const offset = decodeCursor(query.cursor);
  const arrival =
    query.arrivalFrom || query.arrivalTo
      ? {
          stays: {
            some: {
              arrival: {
                ...(query.arrivalFrom ? { gte: dbDate(query.arrivalFrom) } : {}),
                ...(query.arrivalTo ? { lte: dbDate(query.arrivalTo) } : {}),
              },
            },
          },
        }
      : {};
  const rows = await deps.tenantDb.reservation.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...arrival,
      ...searchFilter(query.q),
    },
    include: FULL,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: offset,
    take: query.limit + 1,
  });
  const data: z.input<typeof ReservationSummary>[] = rows.slice(0, query.limit).map((r) => {
    const stays = live(r);
    const dates = stays.length > 0 ? stays : r.stays;
    return {
      id: r.id,
      confirmationNo: r.confirmationNo,
      status: r.status,
      source: r.source,
      bookerName: `${r.booker.firstName} ${r.booker.lastName}`,
      arrival: dates.map((s) => day(s.arrival)).sort()[0] ?? '',
      departure:
        dates
          .map((s) => day(s.departure))
          .sort()
          .at(-1) ?? '',
      rooms: stays.length,
      totalMinor: totalOf(r).toString(),
      holdExpiresAt: r.holdExpiresAt ? iso(r.holdExpiresAt) : null,
    };
  });
  return {
    data,
    nextCursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
  };
}

/** S07: stays in the hotel on any night of the window (cancelled and no-shows left out). */
export async function getCalendar(deps: ReservationDeps, query: z.output<typeof CalendarQuery>) {
  const stays = await deps.tenantDb.stay.findMany({
    where: {
      status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      arrival: { lt: dbDate(query.to) },
      departure: { gt: dbDate(query.from) },
    },
    include: {
      guest: true,
      reservation: { select: { confirmationNo: true } },
      allocations: { where: { active: true }, orderBy: { startDate: 'asc' } },
    },
    orderBy: [{ arrival: 'asc' }, { id: 'asc' }],
  });
  const data: z.input<typeof CalendarStay>[] = stays.map((s) => ({
    id: s.id,
    reservationId: s.reservationId,
    confirmationNo: s.reservation.confirmationNo,
    status: s.status,
    roomTypeId: s.roomTypeId,
    roomId: s.roomId,
    rooms: s.allocations.map((a) => ({
      roomId: a.roomId,
      startDate: day(a.startDate),
      endDate: day(a.endDate),
    })),
    arrival: day(s.arrival),
    departure: day(s.departure),
    guestName: `${s.guest.firstName} ${s.guest.lastName}`,
    adults: s.adults,
    children: s.children,
  }));
  return { data };
}

export async function getHistory(deps: ReservationDeps, reservationId: string) {
  const r = await deps.tenantDb.reservation.findUnique({
    where: { id: reservationId },
    include: { history: { orderBy: { id: 'asc' } } },
  });
  if (!r) throw new AppError('NOT_FOUND', 'Reservation not found');
  const userIds = [...new Set(r.history.flatMap((h) => (h.byUserId ? [h.byUserId] : [])))];
  const users = await deps.db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return {
    data: r.history.map((h) => ({
      at: iso(h.at),
      stayId: h.stayId,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      reason: h.reason,
      byName: h.byUserId ? (nameOf.get(h.byUserId) ?? null) : null,
    })),
  };
}

// ── Shared checks ───────────────────────────────────────────────────────────────────────

/** A guest of the organisation that can be booked (not a merged-away duplicate). */
async function bookableGuest(tx: Tx, guestId: string, path: string): Promise<Guest> {
  const guest = await tx.guest.findUnique({ where: { id: guestId } });
  if (!guest) throw invalid(path, 'Guest not found');
  if (guest.mergedIntoId) throw invalid(path, 'This profile was merged; choose the one kept');
  return guest;
}

async function newGuest(
  tx: Tx,
  g: {
    firstName?: string | undefined;
    lastName?: string | undefined;
    phone: string | null;
    email: string | null;
  },
): Promise<Guest> {
  const created = await tx.guest.create({
    data: {
      firstName: g.firstName ?? '',
      lastName: g.lastName ?? '',
      phone: g.phone,
      email: g.email,
    } as unknown as Prisma.GuestUncheckedCreateInput, // organisationId comes from the tenant client
  });
  await recordAudit(tx, {
    action: 'guest.created',
    entityType: 'guest',
    entityId: created.id,
    propertyId: null,
    after: { firstName: created.firstName, lastName: created.lastName },
  });
  return created;
}

const quotedNights = (q: Quote) => q.nights as unknown as QuoteNight[];
/** Guests the quote was priced for; null for quotes made before T-042. */
const quotedGuests = (q: Quote) => quotedNights(q)[0]?.guests ?? null;

/**
 * A quote that can still be booked: of this property, not booked yet, not expired (unless
 * an approved booking runs after its approver took a while: the price was promised).
 */
async function usableQuote(
  tx: Tx,
  quoteId: string,
  path: string,
  opts: { now: Date; today: string; ignoreExpiry: boolean; ownStayId?: string },
): Promise<Quote> {
  const quote = await tx.quote.findUnique({ where: { id: quoteId }, include: { stay: true } });
  if (!quote) throw invalid(path, 'Quote not found; price the stay first');
  if (quote.stay && quote.stay.id !== opts.ownStayId) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This quote is already booked', {
      reason: 'QUOTE_USED',
      quoteId,
    });
  }
  if (!opts.ignoreExpiry && quote.expiresAt <= opts.now) {
    throw new AppError('STATE_TRANSITION_INVALID', 'This quote has expired; price the stay again', {
      reason: 'QUOTE_EXPIRED',
      quoteId,
    });
  }
  if (day(quote.arrival) < opts.today) throw invalid(path, 'Arrival is today or later');
  return quote;
}

/** Occupancy of a stay: within the room type, and the guests its quote was priced for. */
async function occupancy(
  tx: Tx,
  quote: Quote,
  path: string,
  wanted: { adults?: number | undefined; children?: number | undefined },
  current?: { adults: number; children: number },
): Promise<{ adults: number; children: number }> {
  const quoted = quotedGuests(quote);
  const children = wanted.children ?? current?.children ?? 0;
  const adults = wanted.adults ?? (quoted !== null ? quoted - children : (current?.adults ?? 1));
  if (adults < 1) throw invalid(`${path}.adults`, 'At least one adult');
  if (quoted !== null && adults + children !== quoted) {
    throw invalid(
      `${path}.adults`,
      `This price is for ${quoted} guest${quoted === 1 ? '' : 's'}; price the stay again for ${adults + children}`,
    );
  }
  const type = await tx.roomType.findUniqueOrThrow({ where: { id: quote.roomTypeId } });
  if (adults + children > type.maxOccupancy) {
    throw invalid(`${path}.adults`, `${type.name} takes at most ${type.maxOccupancy} guests`);
  }
  return { adults, children };
}

const nightRows = (quote: Quote) =>
  quotedNights(quote).map((n) => ({
    date: dbDate(n.date),
    amountMinor: BigInt(n.amountMinor),
    ratePlanId: n.pricedBy,
    ruleVersion: n.ruleVersion,
  }));

const stayRange = (s: {
  roomTypeId: string;
  arrival: Date | string;
  departure: Date | string;
}) => ({
  roomTypeId: s.roomTypeId,
  arrival: typeof s.arrival === 'string' ? s.arrival : day(s.arrival),
  departure: typeof s.departure === 'string' ? s.departure : day(s.departure),
});

// ── Booking (M3-01, M3-02, M3-05) ───────────────────────────────────────────────────────

/** Books in `tx`; returns the new reservation's ID. Re-checks everything (approval reruns it). */
async function book(
  deps: ReservationDeps,
  tx: Tx,
  tenant: TenantContext,
  body: Body,
  approvalRequestId: string | null,
): Promise<string> {
  const property = await tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
  if (property.status !== 'LIVE') {
    throw new AppError('PROPERTY_NOT_LIVE', 'Bookings open once the property goes live');
  }
  const now = deps.clock();
  const today = await propertyToday(tx, tenant.propertyId, deps.clock);
  if (body.holdUntil && Date.parse(body.holdUntil) <= now.getTime()) {
    throw invalid('body.holdUntil', 'The hold must end in the future');
  }
  const status: ReservationStatus = body.holdUntil ? 'TENTATIVE' : 'CONFIRMED';
  if (body.companyId) {
    const company = await tx.company.findUnique({ where: { id: body.companyId } });
    if (!company?.active) throw invalid('body.companyId', 'Choose an active company');
  }
  const quoteIds = body.stays.map((s) => s.quoteId);
  if (new Set(quoteIds).size !== quoteIds.length) {
    throw invalid('body.stays', 'Each room needs its own quote');
  }

  const booker = body.booker.guestId
    ? await bookableGuest(tx, body.booker.guestId, 'body.booker.guestId')
    : await newGuest(tx, body.booker);

  const stays = [];
  for (const [i, s] of body.stays.entries()) {
    const path = `body.stays.${i}`;
    if (s.roomId !== null) {
      throw invalid(`${path}.roomId`, 'Rooms are assigned after booking; leave the room empty');
    }
    const quote = await usableQuote(tx, s.quoteId, `${path}.quoteId`, {
      now,
      today,
      ignoreExpiry: approvalRequestId !== null,
    });
    const guests = await occupancy(tx, quote, path, s);
    const guest = s.guest.sameAsBooker
      ? booker
      : s.guest.guestId
        ? await bookableGuest(tx, s.guest.guestId, `${path}.guest.guestId`)
        : await newGuest(tx, s.guest);
    stays.push({ quote, guest, ...guests });
  }

  const n = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.CONFIRMATION);
  const confirmationNo = `${property.code}-${String(n).padStart(5, '0')}`;
  const reservation = await tx.reservation.create({
    data: {
      confirmationNo,
      bookerGuestId: booker.id,
      companyId: body.companyId,
      source: body.source,
      status,
      guarantee: body.guarantee,
      holdExpiresAt: body.holdUntil ? new Date(body.holdUntil) : null,
      notes: body.notes,
      createdById: tenant.userId,
      createdAt: now,
      history: { create: { toStatus: status, byUserId: tenant.userId, at: now } },
    } as unknown as Prisma.ReservationUncheckedCreateInput, // tenant IDs come from the client
  });
  for (const s of stays) {
    await tx.stay.create({
      data: {
        reservationId: reservation.id,
        guestId: s.guest.id,
        roomTypeId: s.quote.roomTypeId,
        ratePlanId: s.quote.ratePlanId,
        quoteId: s.quote.id,
        arrival: s.quote.arrival,
        departure: s.quote.departure,
        adults: s.adults,
        children: s.children,
        status,
        nights: { create: nightRows(s.quote) },
      } as unknown as Prisma.StayUncheckedCreateInput,
    });
  }
  // Same order everywhere, so two bookings never wait on each other's nights.
  const field = inventoryFieldOf(status);
  for (const s of [...stays].sort((a, b) => a.quote.roomTypeId.localeCompare(b.quote.roomTypeId))) {
    if (field) {
      await takeInventory(tx, { propertyId: tenant.propertyId, ...stayRange(s.quote), field });
    }
  }
  await recordAudit(tx, {
    action: 'reservation.created',
    entityType: 'reservation',
    entityId: reservation.id,
    approvalRequestId: approvalRequestId ?? undefined,
    after: {
      confirmationNo,
      status,
      source: body.source,
      bookerGuestId: booker.id,
      stays: stays.map((s) => ({
        quoteId: s.quote.id,
        guestId: s.guest.id,
        arrival: day(s.quote.arrival),
        departure: day(s.quote.departure),
      })),
    },
  });
  await recordEvent(tx, {
    type: 'reservation.created',
    payload: { reservationId: reservation.id, confirmationNo, status },
  });
  return reservation.id;
}

/** The do-not-rent approval (M3 rule 8): the booking runs when a manager approves it. */
export function doNotRentHandler(deps: ReservationDeps): ApprovalActionHandler<Body> {
  return {
    action: 'reservation.do_not_rent',
    payload: ReservationBodyStored,
    measure: () => ({}),
    execute: ({ tx, tenant, approvalRequestId }, payload) =>
      book(deps, tx, tenant, payload, approvalRequestId),
  };
}

/** The stored payload is the parsed body; parsing it again must not change it. */
const ReservationBodyStored = z.custom<Body>((v) => typeof v === 'object' && v !== null);

export async function createReservation(deps: ReservationDeps, tenant: TenantContext, body: Body) {
  const guestIds = [
    body.booker.guestId,
    ...body.stays.map((s) => (s.guest.sameAsBooker ? null : s.guest.guestId)),
  ].filter((id): id is string => id !== null);
  const flagged =
    guestIds.length > 0 &&
    (await deps.tenantDb.guest.count({ where: { id: { in: guestIds }, doNotRent: true } })) > 0;

  if (!flagged) {
    const id = await deps.tenantDb.$transaction((tx) => book(deps, tx, tenant, body, null));
    return getReservation(deps, id);
  }
  // A do-not-rent guest: warn and ask for a manager (or book, when the caller is one).
  const reason = body.approvalReason?.trim() ?? '';
  if (!reason && (await needsApproval(deps.tenantDb, tenant, 'reservation.do_not_rent', {}))) {
    throw new AppError(
      'VALIDATION_ERROR',
      'A guest on this booking is flagged do-not-rent. A manager must approve: give a reason.',
      {
        doNotRent: true,
        issues: [
          {
            path: 'body.approvalReason',
            code: 'custom',
            message: 'Flagged do-not-rent: give a reason for the manager',
          },
        ],
      },
    );
  }
  const result = await performOrRequest(
    { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
    tenant,
    doNotRentHandler(deps),
    body,
    reason,
  );
  if (!('resultRef' in result)) return result;
  return getReservation(deps, result.resultRef);
}

// ── Changes (M3-03) ─────────────────────────────────────────────────────────────────────

/** `If-Match: "3"` (or `W/"3"`) → 3. */
function versionFrom(ifMatch: string): number | null {
  const m = /^(?:W\/)?"(\d+)"$/.exec(ifMatch.trim());
  return m ? Number(m[1]) : null;
}

async function history(
  tx: Tx,
  reservationId: string,
  entry: {
    from: ReservationStatus | null;
    to: ReservationStatus;
    reason?: string | null;
    by: string | null;
    at: Date;
  },
) {
  await tx.reservation.update({
    where: { id: reservationId },
    data: {
      history: {
        create: {
          fromStatus: entry.from,
          toStatus: entry.to,
          reason: entry.reason ?? null,
          byUserId: entry.by,
          at: entry.at,
        },
      },
    },
  });
}

export async function updateReservation(
  deps: ReservationDeps,
  tenant: TenantContext,
  reservationId: string,
  ifMatch: string,
  body: z.output<typeof ReservationPatchBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await loadFull(tx, reservationId);
    if (versionFrom(ifMatch) !== before.version) {
      throw new AppError(
        'VERSION_CONFLICT',
        'Someone changed this reservation; reload and try again',
        {
          version: before.version,
        },
      );
    }
    const now = deps.clock();
    const today = await propertyToday(tx, tenant.propertyId, deps.clock);
    const changing = body.stays !== undefined || body.confirm || body.holdUntil !== undefined;
    if (changing && !MODIFIABLE_STATUSES.includes(before.status)) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `A ${before.status.toLowerCase().replace('_', '-')} reservation cannot be changed`,
        { status: before.status },
      );
    }
    if (body.holdUntil !== undefined) {
      if (before.status !== 'TENTATIVE') {
        throw invalid('body.holdUntil', 'Only a tentative hold has an end time');
      }
      if (body.confirm) throw invalid('body.holdUntil', 'Confirm or move the hold, not both');
      if (Date.parse(body.holdUntil) <= now.getTime()) {
        throw invalid('body.holdUntil', 'The hold must end in the future');
      }
    }
    if (body.companyId) {
      const company = await tx.company.findUnique({ where: { id: body.companyId } });
      if (!company?.active) throw invalid('body.companyId', 'Choose an active company');
    }

    // Stays: a new quote gives back the old nights and takes the new ones.
    for (const [i, change] of (body.stays ?? []).entries()) {
      const path = `body.stays.${i}`;
      const stay = before.stays.find((s) => s.id === change.stayId);
      if (!stay || stay.status === 'CANCELLED') {
        throw invalid(`${path}.stayId`, 'Not a stay of this reservation');
      }
      const field = inventoryFieldOf(stay.status);
      const data: Prisma.StayUncheckedUpdateInput = { version: { increment: 1 } };
      let quote = stay.quote;
      if (change.quoteId && change.quoteId !== stay.quoteId) {
        quote = await usableQuote(tx, change.quoteId, `${path}.quoteId`, {
          now,
          today,
          ignoreExpiry: false,
        });
        if (field) {
          await releaseInventory(tx, { propertyId: tenant.propertyId, ...stayRange(stay), field });
          await takeInventory(tx, { propertyId: tenant.propertyId, ...stayRange(quote), field });
        }
        Object.assign(data, {
          quoteId: quote.id,
          roomTypeId: quote.roomTypeId,
          ratePlanId: quote.ratePlanId,
          arrival: quote.arrival,
          departure: quote.departure,
          nights: { deleteMany: {}, create: nightRows(quote) },
          // The room stays with the booking when it is still free on the new nights.
          roomId: await followRoom(tx, stay, {
            roomTypeId: quote.roomTypeId,
            arrival: day(quote.arrival),
            departure: day(quote.departure),
          }),
        });
      }
      if (change.quoteId || change.adults !== undefined || change.children !== undefined) {
        Object.assign(data, await occupancy(tx, quote, path, change, stay));
      }
      if (change.guestId) {
        const guest = await bookableGuest(tx, change.guestId, `${path}.guestId`);
        if (guest.doNotRent) {
          throw new AppError(
            'FORBIDDEN',
            'This guest is flagged do-not-rent; book them on a new reservation with a manager’s approval',
            { reason: 'DO_NOT_RENT' },
          );
        }
        data.guestId = guest.id;
      }
      await tx.stay.update({ where: { id: stay.id }, data });
    }

    let status = before.status;
    if (body.confirm) {
      if (!canTransition(before.status, 'CONFIRMED')) {
        throw notAllowed(before.status, 'CONFIRMED');
      }
      const current = await loadFull(tx, reservationId);
      for (const stay of live(current)) {
        const field = inventoryFieldOf(stay.status);
        if (field === 'sold') continue;
        if (field) {
          await releaseInventory(tx, { propertyId: tenant.propertyId, ...stayRange(stay), field });
        }
        await takeInventory(tx, {
          propertyId: tenant.propertyId,
          ...stayRange(stay),
          field: 'sold',
        });
      }
      await tx.stay.updateMany({
        where: { reservationId, status: before.status },
        data: { status: 'CONFIRMED', version: { increment: 1 } },
      });
      status = 'CONFIRMED';
      await history(tx, reservationId, {
        from: before.status,
        to: 'CONFIRMED',
        by: tenant.userId,
        at: now,
      });
    }

    await tx.reservation.update({
      where: { id: reservationId },
      data: {
        status,
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.guarantee !== undefined ? { guarantee: body.guarantee } : {}),
        ...(body.companyId !== undefined ? { companyId: body.companyId } : {}),
        ...(body.holdUntil !== undefined ? { holdExpiresAt: new Date(body.holdUntil) } : {}),
        ...(status !== 'TENTATIVE' ? { holdExpiresAt: null } : {}),
        version: { increment: 1 },
      },
    });
    const after = await loadFull(tx, reservationId);
    const differenceMinor = totalOf(after) - totalOf(before);
    await recordAudit(tx, {
      action: 'reservation.modified',
      entityType: 'reservation',
      entityId: reservationId,
      before: summary(before),
      after: summary(after),
    });
    await recordEvent(tx, {
      type: 'reservation.modified',
      payload: { reservationId, differenceMinor: differenceMinor.toString() },
    });
    return { ...toItem(after), differenceMinor: differenceMinor.toString() };
  });
}

/** What audit events keep of a reservation. */
const summary = (r: Full) => ({
  status: r.status,
  guarantee: r.guarantee,
  companyId: r.companyId,
  notes: r.notes,
  holdExpiresAt: r.holdExpiresAt,
  totalMinor: totalOf(r).toString(),
  stays: r.stays.map((s) => ({
    id: s.id,
    status: s.status,
    guestId: s.guestId,
    quoteId: s.quoteId,
    roomTypeId: s.roomTypeId,
    ratePlanId: s.ratePlanId,
    arrival: day(s.arrival),
    departure: day(s.departure),
    adults: s.adults,
    children: s.children,
  })),
});

// ── Cancel and reinstate (M3-04) ────────────────────────────────────────────────────────

/** Reasons where the hotel, not the guest, ends the booking: no fee. */
const NO_FEE_REASONS = new Set(['DUPLICATE', 'HOTEL_REQUEST']);

export async function cancelReservation(
  deps: ReservationDeps,
  tenant: TenantContext,
  reservationId: string,
  body: z.output<typeof CancelBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await loadFull(tx, reservationId);
    if (!canTransition(before.status, 'CANCELLED')) throw notAllowed(before.status, 'CANCELLED');
    const now = deps.clock();
    const today = await propertyToday(tx, tenant.propertyId, deps.clock);
    let feeMinor = 0n;
    const stays = live(before);
    for (const stay of stays) {
      const field = inventoryFieldOf(stay.status);
      if (field) {
        await releaseInventory(tx, { propertyId: tenant.propertyId, ...stayRange(stay), field });
      }
      // Only a confirmed booking owes a fee; a hold never does.
      if (stay.status === 'CONFIRMED' && !NO_FEE_REASONS.has(body.reason)) {
        feeMinor += cancellationFee(
          stay.ratePlan.cancellationPolicy.rules as unknown as FeeRule[],
          stay.nights.map((n) => n.amountMinor),
          today,
          day(stay.arrival),
        ).feeMinor;
      }
    }
    await releaseAllocations(
      tx,
      before.stays.map((s) => s.id),
    );
    await tx.stay.updateMany({
      where: { reservationId, status: { not: 'CANCELLED' } },
      data: { status: 'CANCELLED', roomId: null, version: { increment: 1 } },
    });
    const reason = body.note ? `${body.reason}: ${body.note}` : body.reason;
    await tx.reservation.update({
      where: { id: reservationId },
      data: {
        status: 'CANCELLED',
        cancelReason: body.reason,
        cancelledAt: now,
        holdExpiresAt: null,
        version: { increment: 1 },
        history: {
          create: {
            fromStatus: before.status,
            toStatus: 'CANCELLED',
            reason,
            byUserId: tenant.userId,
            at: now,
          },
        },
      },
    });
    await recordAudit(tx, {
      action: 'reservation.cancelled',
      entityType: 'reservation',
      entityId: reservationId,
      reason,
      before: { status: before.status },
      after: { status: 'CANCELLED', cancelReason: body.reason, feeMinor: feeMinor.toString() },
    });
    await recordEvent(tx, {
      type: 'reservation.cancelled',
      payload: { reservationId, reason: body.reason, feeMinor: feeMinor.toString() },
    });
    return { ...toItem(await loadFull(tx, reservationId)), feeMinor: feeMinor.toString() };
  });
}

export async function reinstateReservation(
  deps: ReservationDeps,
  tenant: TenantContext,
  reservationId: string,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await loadFull(tx, reservationId);
    if (
      !canTransition(before.status, 'CONFIRMED') ||
      !['CANCELLED', 'NO_SHOW'].includes(before.status)
    ) {
      throw notAllowed(
        before.status,
        'CONFIRMED',
        'Only a cancelled reservation can be reinstated',
      );
    }
    const now = deps.clock();
    const today = await propertyToday(tx, tenant.propertyId, deps.clock);
    if (before.stays.some((s) => day(s.arrival) < today)) {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'The arrival date has passed; make a new booking instead',
        { reason: 'ARRIVAL_PASSED' },
      );
    }
    for (const stay of [...before.stays].sort((a, b) => a.roomTypeId.localeCompare(b.roomTypeId))) {
      await takeInventory(tx, { propertyId: tenant.propertyId, ...stayRange(stay), field: 'sold' });
    }
    await tx.stay.updateMany({
      where: { reservationId },
      data: { status: 'CONFIRMED', version: { increment: 1 } },
    });
    await tx.reservation.update({
      where: { id: reservationId },
      data: {
        status: 'CONFIRMED',
        cancelReason: null,
        cancelledAt: null,
        version: { increment: 1 },
        history: {
          create: {
            fromStatus: before.status,
            toStatus: 'CONFIRMED',
            reason: 'REINSTATED',
            byUserId: tenant.userId,
            at: now,
          },
        },
      },
    });
    await recordAudit(tx, {
      action: 'reservation.reinstated',
      entityType: 'reservation',
      entityId: reservationId,
      before: { status: before.status, cancelReason: before.cancelReason },
      after: { status: 'CONFIRMED' },
    });
    await recordEvent(tx, { type: 'reservation.reinstated', payload: { reservationId } });
    return toItem(await loadFull(tx, reservationId));
  });
}

// ── Hold expiry (M3-02; job every minute) ───────────────────────────────────────────────

/**
 * Cancels tentative holds whose time is up and gives back their rooms (PRD M3 acceptance:
 * within one minute of expiry). Each hold in its own transaction, claimed by status and
 * version so a hold confirmed meanwhile is left alone. Returns how many expired.
 */
export async function expireHolds(db: Db, clock: Clock): Promise<number> {
  const now = clock();
  const due = await db.reservation.findMany({
    where: { status: 'TENTATIVE', holdExpiresAt: { lte: now } },
    include: { stays: true },
    orderBy: { holdExpiresAt: 'asc' },
    take: 200,
  });
  let expired = 0;
  for (const r of due) {
    await db.$transaction(async (tx) => {
      const claimed = await tx.reservation.updateMany({
        where: { id: r.id, status: 'TENTATIVE', version: r.version },
        data: {
          status: 'CANCELLED',
          cancelReason: 'HOLD_EXPIRED',
          cancelledAt: now,
          holdExpiresAt: null,
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1) return;
      for (const stay of r.stays.filter((s) => s.status === 'TENTATIVE')) {
        await releaseInventory(tx, { propertyId: r.propertyId, ...stayRange(stay), field: 'held' });
      }
      await releaseAllocations(
        tx,
        r.stays.map((s) => s.id),
      );
      await tx.stay.updateMany({
        where: { reservationId: r.id, status: 'TENTATIVE' },
        data: { status: 'CANCELLED', roomId: null, version: { increment: 1 } },
      });
      await tx.reservationStatusHistory.create({
        data: {
          reservationId: r.id,
          fromStatus: 'TENTATIVE',
          toStatus: 'CANCELLED',
          reason: 'HOLD_EXPIRED',
          at: now,
        },
      });
      const where = { organisationId: r.organisationId, propertyId: r.propertyId };
      await recordAudit(tx, {
        ...where,
        action: 'reservation.hold_expired',
        entityType: 'reservation',
        entityId: r.id,
        actorType: 'SYSTEM',
        actorUserId: null,
        before: { status: 'TENTATIVE', holdExpiresAt: r.holdExpiresAt },
        after: { status: 'CANCELLED', cancelReason: 'HOLD_EXPIRED' },
      });
      await recordEvent(tx, {
        ...where,
        type: 'reservation.cancelled',
        payload: { reservationId: r.id, reason: 'HOLD_EXPIRED', feeMinor: '0' },
      });
      expired += 1;
    });
  }
  return expired;
}
