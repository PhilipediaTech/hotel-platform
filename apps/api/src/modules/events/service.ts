import {
  EVENT_MAX_DAYS,
  type EventBookingItem,
  type EventEnquiryBody,
  type EventEnquiryItem,
  type EventEnquiryUpdateBody,
  type EventHoldBody,
  type SpaceAvailabilityItem,
  type SpaceBody,
  type SpaceItem,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { bookingHasMoney, voidUnpaidContract } from './allocation.ts';

// Events and spaces, first part (PRD M9-01–M9-03, M9 rules: "no two bookings may overlap on a
// space, including buffers; holds expire automatically"; T-119). The database's exclusion
// constraint is what guarantees no overlap; the checks here only make the refusal readable.

export interface EventDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Space = z.input<typeof SpaceItem>;
type Booking = z.input<typeof EventBookingItem>;
type Enquiry = z.input<typeof EventEnquiryItem>;
type Availability = z.input<typeof SpaceAvailabilityItem>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const MINUTE = 60_000;
const ACTIVE = ['HOLD', 'CONFIRMED'] as const;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

/** The space cannot be given back while the client's money is held against it. */
const moneyHeld = () =>
  new AppError(
    'STATE_TRANSITION_INVALID',
    'The client has paid towards this booking, so its space cannot be given back',
  );

// ── Shapes ──────────────────────────────────────────────────────────────────────────────

const SPACE_INCLUDE = {
  layouts: { where: { active: true }, orderBy: { name: 'asc' } },
  rateRules: { orderBy: [{ unit: 'asc' }, { name: 'asc' }] },
} satisfies Prisma.SpaceInclude;
type SpaceRow = Prisma.SpaceGetPayload<{ include: typeof SPACE_INCLUDE }>;

function spaceOf(s: SpaceRow): Space {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    description: s.description,
    setupMinutes: s.setupMinutes,
    cleanupMinutes: s.cleanupMinutes,
    minimumHireMinor: s.minimumHireMinor.toString(),
    active: s.active,
    layouts: s.layouts.map((l) => ({ id: l.id, name: l.name, capacity: l.capacity })),
    rateRules: s.rateRules.map((r) => ({
      id: r.id,
      name: r.name,
      unit: r.unit as Space['rateRules'][number]['unit'],
      dayType: r.dayType as Space['rateRules'][number]['dayType'],
      seasonFrom: r.seasonFrom ? day(r.seasonFrom) : null,
      seasonTo: r.seasonTo ? day(r.seasonTo) : null,
      amountMinor: r.amountMinor.toString(),
    })),
  };
}

export const BOOKING_INCLUDE = {
  space: { select: { id: true, name: true } },
  layout: { select: { id: true, name: true } },
} satisfies Prisma.EventBookingInclude;
type BookingRow = Prisma.EventBookingGetPayload<{ include: typeof BOOKING_INCLUDE }>;

export function bookingOf(b: BookingRow): Booking {
  return {
    id: b.id,
    title: b.title,
    status: b.status as Booking['status'],
    space: b.space,
    layout: b.layout,
    enquiryId: b.enquiryId,
    startsAt: iso(b.startsAt),
    endsAt: iso(b.endsAt),
    blockedFrom: iso(b.blockedFrom),
    blockedUntil: iso(b.blockedUntil),
    expectedGuests: b.expectedGuests,
    holdExpiresAt: b.holdExpiresAt ? iso(b.holdExpiresAt) : null,
    confirmedByOverride: b.confirmedByOverride,
  };
}

const ENQUIRY_INCLUDE = {
  bookings: { include: BOOKING_INCLUDE, orderBy: { startsAt: 'asc' } },
} satisfies Prisma.EventEnquiryInclude;
type EnquiryRow = Prisma.EventEnquiryGetPayload<{ include: typeof ENQUIRY_INCLUDE }>;

function enquiryOf(e: EnquiryRow): Enquiry {
  return {
    id: e.id,
    status: e.status as Enquiry['status'],
    contactName: e.contactName,
    contactPhone: e.contactPhone,
    contactEmail: e.contactEmail,
    eventType: e.eventType,
    eventDate: e.eventDate ? day(e.eventDate) : null,
    expectedGuests: e.expectedGuests,
    notes: e.notes,
    lostReason: e.lostReason,
    createdAt: iso(e.createdAt),
    bookings: e.bookings.map(bookingOf),
  };
}

/** Holds and bookings still taking up a space: a hold past its time no longer counts. */
const stillBlocking = (now: Date) =>
  ({
    OR: [{ status: 'CONFIRMED' }, { status: 'HOLD', holdExpiresAt: { gt: now } }],
  }) satisfies Prisma.EventBookingWhereInput;

// ── Spaces (M9-01) ──────────────────────────────────────────────────────────────────────

export async function listSpaces(deps: EventDeps) {
  const rows = await deps.tenantDb.space.findMany({
    include: SPACE_INCLUDE,
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  });
  return { data: rows.map(spaceOf) };
}

const duplicateCode = (err: unknown) =>
  pgErrorInfo(err)?.sqlState === '23505' &&
  pgErrorInfo(err)?.constraint === 'spaces_property_id_code_key';

const rateRows = (body: z.output<typeof SpaceBody>, spaceId: string) =>
  body.rateRules.map((r) => ({
    spaceId,
    name: r.name,
    unit: r.unit,
    dayType: r.dayType,
    seasonFrom: r.seasonFrom ? dbDate(r.seasonFrom) : null,
    seasonTo: r.seasonTo ? dbDate(r.seasonTo) : null,
    amountMinor: BigInt(r.amountMinor),
  })) as Prisma.SpaceRateRuleUncheckedCreateInput[];

const spaceFields = (body: z.output<typeof SpaceBody>) => ({
  code: body.code,
  name: body.name,
  description: body.description,
  setupMinutes: body.setupMinutes,
  cleanupMinutes: body.cleanupMinutes,
  minimumHireMinor: BigInt(body.minimumHireMinor),
  active: body.active,
});

function codeTaken(err: unknown, code: string): unknown {
  return duplicateCode(err) ? invalid('code', `Another space already has the code ${code}`) : err;
}

export async function createSpace(
  deps: EventDeps,
  body: z.output<typeof SpaceBody>,
): Promise<Space> {
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const space = await tx.space.create({
        data: spaceFields(body) as Prisma.SpaceUncheckedCreateInput,
      });
      for (const l of body.layouts) {
        await tx.spaceLayout.create({
          data: { spaceId: space.id, ...l } as Prisma.SpaceLayoutUncheckedCreateInput,
        });
      }
      for (const data of rateRows(body, space.id)) await tx.spaceRateRule.create({ data });
      const row = await tx.space.findUniqueOrThrow({
        where: { id: space.id },
        include: SPACE_INCLUDE,
      });
      await recordAudit(tx, {
        action: 'space.created',
        entityType: 'space',
        entityId: space.id,
        after: spaceOf(row),
      });
      return spaceOf(row);
    });
  } catch (err) {
    throw codeTaken(err, body.code);
  }
}

export async function updateSpace(
  deps: EventDeps,
  spaceId: string,
  body: z.output<typeof SpaceBody>,
): Promise<Space> {
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const before = await tx.space.findFirst({
        where: { id: spaceId },
        include: SPACE_INCLUDE,
      });
      if (!before) throw new AppError('NOT_FOUND', 'Space not found');
      await tx.space.update({ where: { id: spaceId }, data: spaceFields(body) });
      // Layouts are matched by name and retired rather than deleted: bookings point at them.
      const names = body.layouts.map((l) => l.name);
      await tx.spaceLayout.updateMany({
        where: { spaceId, name: { notIn: names } },
        data: { active: false },
      });
      for (const l of body.layouts) {
        await tx.spaceLayout.upsert({
          where: { spaceId_name: { spaceId, name: l.name } },
          create: { spaceId, ...l } as Prisma.SpaceLayoutUncheckedCreateInput,
          update: { capacity: l.capacity, active: true },
        });
      }
      await tx.spaceRateRule.deleteMany({ where: { spaceId } });
      for (const data of rateRows(body, spaceId)) await tx.spaceRateRule.create({ data });
      const row = await tx.space.findUniqueOrThrow({
        where: { id: spaceId },
        include: SPACE_INCLUDE,
      });
      await recordAudit(tx, {
        action: 'space.updated',
        entityType: 'space',
        entityId: spaceId,
        before: spaceOf(before),
        after: spaceOf(row),
      });
      return spaceOf(row);
    });
  } catch (err) {
    throw codeTaken(err, body.code);
  }
}

// ── Availability (M9-02) ────────────────────────────────────────────────────────────────

export async function spaceAvailability(
  deps: EventDeps,
  query: { startsAt: string; endsAt: string; guests?: number | undefined },
): Promise<{ data: Availability[] }> {
  const now = deps.clock();
  const startsAt = new Date(query.startsAt);
  const endsAt = new Date(query.endsAt);
  const spaces = await deps.tenantDb.space.findMany({
    where: { active: true },
    include: SPACE_INCLUDE,
    orderBy: { name: 'asc' },
  });
  const data: Availability[] = [];
  for (const s of spaces) {
    const blockedFrom = new Date(startsAt.getTime() - s.setupMinutes * MINUTE);
    const blockedUntil = new Date(endsAt.getTime() + s.cleanupMinutes * MINUTE);
    const conflicts = await deps.tenantDb.eventBooking.findMany({
      where: {
        spaceId: s.id,
        blockedFrom: { lt: blockedUntil },
        blockedUntil: { gt: blockedFrom },
        ...stillBlocking(now),
      },
      orderBy: { blockedFrom: 'asc' },
    });
    const guests = query.guests;
    data.push({
      space: { id: s.id, name: s.name },
      available: conflicts.length === 0,
      blockedFrom: iso(blockedFrom),
      blockedUntil: iso(blockedUntil),
      minimumHireMinor: s.minimumHireMinor.toString(),
      layouts: s.layouts
        .filter((l) => guests === undefined || l.capacity >= guests)
        .map((l) => ({ id: l.id, name: l.name, capacity: l.capacity })),
      conflicts: conflicts.map((c) => ({
        title: c.title,
        status: c.status as 'HOLD' | 'CONFIRMED',
        blockedFrom: iso(c.blockedFrom),
        blockedUntil: iso(c.blockedUntil),
      })),
    });
  }
  return { data };
}

// ── Enquiries (M9-02) ───────────────────────────────────────────────────────────────────

export async function listEnquiries(deps: EventDeps, query: { status?: string | undefined }) {
  const rows = await deps.tenantDb.eventEnquiry.findMany({
    where: query.status ? { status: query.status } : {},
    include: ENQUIRY_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return { data: rows.map(enquiryOf) };
}

const enquiryFields = (body: z.output<typeof EventEnquiryBody>) => ({
  contactName: body.contactName,
  contactPhone: body.contactPhone,
  contactEmail: body.contactEmail,
  eventType: body.eventType,
  eventDate: body.eventDate ? dbDate(body.eventDate) : null,
  expectedGuests: body.expectedGuests,
  notes: body.notes,
});

export async function createEnquiry(
  deps: EventDeps,
  tenant: TenantContext,
  body: z.output<typeof EventEnquiryBody>,
): Promise<Enquiry> {
  return deps.tenantDb.$transaction(async (tx) => {
    const row = await tx.eventEnquiry.create({
      data: {
        ...enquiryFields(body),
        createdById: tenant.userId,
        createdAt: deps.clock(),
      } as Prisma.EventEnquiryUncheckedCreateInput,
      include: ENQUIRY_INCLUDE,
    });
    await recordAudit(tx, {
      action: 'event_enquiry.created',
      entityType: 'event_enquiry',
      entityId: row.id,
      after: { eventType: row.eventType },
    });
    return enquiryOf(row);
  });
}

export async function updateEnquiry(
  deps: EventDeps,
  enquiryId: string,
  body: z.output<typeof EventEnquiryUpdateBody>,
): Promise<Enquiry> {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.eventEnquiry.findFirst({ where: { id: enquiryId } });
    if (!before) throw new AppError('NOT_FOUND', 'Enquiry not found');
    if (before.status === 'WON') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This enquiry has become a booking');
    }
    if (body.status === 'LOST') {
      const holds = await tx.eventBooking.findMany({ where: { enquiryId, status: 'HOLD' } });
      for (const hold of holds) {
        if (await bookingHasMoney(tx as never, hold.id)) throw moneyHeld();
        await voidUnpaidContract(tx as never, hold.id);
      }
      await tx.eventBooking.updateMany({
        where: { enquiryId, status: 'HOLD' },
        data: { status: 'RELEASED', holdExpiresAt: null, version: { increment: 1 } },
      });
    }
    await tx.eventEnquiry.update({
      where: { id: enquiryId },
      data: {
        ...enquiryFields(body),
        status: body.status,
        lostReason: body.status === 'LOST' ? body.lostReason : null,
        updatedAt: now,
      },
    });
    await recordAudit(tx, {
      action: 'event_enquiry.updated',
      entityType: 'event_enquiry',
      entityId: enquiryId,
      before: { status: before.status },
      after: { status: body.status },
      ...(body.status === 'LOST' && body.lostReason ? { reason: body.lostReason } : {}),
    });
    const row = await tx.eventEnquiry.findUniqueOrThrow({
      where: { id: enquiryId },
      include: ENQUIRY_INCLUDE,
    });
    return enquiryOf(row);
  });
}

// ── Holds (M9-03) ───────────────────────────────────────────────────────────────────────

export async function listBookings(deps: EventDeps, query: { from: string; to: string }) {
  const rows = await deps.tenantDb.eventBooking.findMany({
    where: {
      blockedFrom: { lt: new Date(query.to) },
      blockedUntil: { gt: new Date(query.from) },
      // A closed event no longer takes the space, but stays on the calendar as a record.
      OR: [...stillBlocking(deps.clock()).OR, { status: { in: ['CLOSED', 'CANCELLED'] } }],
    },
    include: BOOKING_INCLUDE,
    orderBy: { startsAt: 'asc' },
    take: 500,
  });
  return { data: rows.map(bookingOf) };
}

const overlap = (err: unknown) =>
  pgErrorInfo(err)?.sqlState === '23P01' &&
  pgErrorInfo(err)?.constraint === 'event_bookings_no_overlap';

const conflict = (title?: string) =>
  new AppError(
    'BOOKING_CONFLICT',
    title
      ? `That time overlaps “${title}” on this space, once setup and cleanup are counted`
      : 'That time overlaps another booking on this space, once setup and cleanup are counted',
    {},
  );

export async function createHold(
  deps: EventDeps,
  tenant: TenantContext,
  body: z.output<typeof EventHoldBody>,
): Promise<Booking> {
  const now = deps.clock();
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  const holdUntil = new Date(body.holdUntil);
  if (startsAt <= now) throw invalid('startsAt', 'The event must be in the future');
  if (endsAt.getTime() - startsAt.getTime() > EVENT_MAX_DAYS * 24 * 60 * MINUTE) {
    throw invalid('endsAt', `One booking lasts at most ${EVENT_MAX_DAYS} days`);
  }
  if (holdUntil <= now) throw invalid('holdUntil', 'The hold must end in the future');
  if (holdUntil > startsAt) throw invalid('holdUntil', 'The hold must end before the event');

  // A hold past its time still occupies its row until the job runs: free it first.
  await expireHolds(deps.db, deps.clock, body.spaceId);
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const space = await tx.space.findFirst({
        where: { id: body.spaceId, active: true },
      });
      if (!space) throw invalid('spaceId', 'Choose an active space of this property');
      const layout = await tx.spaceLayout.findFirst({
        where: { id: body.layoutId, spaceId: space.id, active: true },
      });
      if (!layout) throw invalid('layoutId', 'Choose a layout of this space');
      if (body.expectedGuests > layout.capacity) {
        throw invalid(
          'expectedGuests',
          `${layout.name} seats ${layout.capacity}: choose another layout or space`,
        );
      }
      if (body.enquiryId) {
        const enquiry = await tx.eventEnquiry.findFirst({ where: { id: body.enquiryId } });
        if (enquiry?.status !== 'OPEN') throw invalid('enquiryId', 'Choose an open enquiry');
      }
      const blockedFrom = new Date(startsAt.getTime() - space.setupMinutes * MINUTE);
      const blockedUntil = new Date(endsAt.getTime() + space.cleanupMinutes * MINUTE);
      const clash = await tx.eventBooking.findFirst({
        where: {
          spaceId: space.id,
          status: { in: [...ACTIVE] },
          blockedFrom: { lt: blockedUntil },
          blockedUntil: { gt: blockedFrom },
        },
      });
      if (clash) throw conflict(clash.title);
      const row = await tx.eventBooking.create({
        data: {
          enquiryId: body.enquiryId,
          spaceId: space.id,
          layoutId: layout.id,
          title: body.title,
          status: 'HOLD',
          startsAt,
          endsAt,
          blockedFrom,
          blockedUntil,
          expectedGuests: body.expectedGuests,
          holdExpiresAt: holdUntil,
          createdById: tenant.userId,
          createdAt: now,
        } as Prisma.EventBookingUncheckedCreateInput,
        include: BOOKING_INCLUDE,
      });
      await recordAudit(tx, {
        action: 'event_booking.held',
        entityType: 'event_booking',
        entityId: row.id,
        after: { spaceId: space.id, startsAt: body.startsAt, holdUntil: body.holdUntil },
      });
      return bookingOf(row);
    });
  } catch (err) {
    throw overlap(err) ? conflict() : err;
  }
}

export async function releaseHold(deps: EventDeps, bookingId: string): Promise<Booking> {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.eventBooking.findFirst({ where: { id: bookingId } });
    if (!before) throw new AppError('NOT_FOUND', 'Booking not found');
    if (before.status !== 'HOLD') {
      throw new AppError('STATE_TRANSITION_INVALID', 'Only a hold can be released');
    }
    if (await bookingHasMoney(tx as never, bookingId)) throw moneyHeld();
    await voidUnpaidContract(tx as never, bookingId);
    await tx.eventBooking.update({
      where: { id: bookingId },
      data: { status: 'RELEASED', holdExpiresAt: null, version: { increment: 1 } },
    });
    await recordAudit(tx, {
      action: 'event_booking.released',
      entityType: 'event_booking',
      entityId: bookingId,
      before: { status: 'HOLD', holdExpiresAt: before.holdExpiresAt },
      after: { status: 'RELEASED' },
    });
    const row = await tx.eventBooking.findUniqueOrThrow({
      where: { id: bookingId },
      include: BOOKING_INCLUDE,
    });
    return bookingOf(row);
  });
}

/** Holds past their time give the space back (M9 rule). Returns how many expired. */
export async function expireHolds(db: Db, clock: Clock, spaceId?: string): Promise<number> {
  const now = clock();
  const due = await db.eventBooking.findMany({
    where: { status: 'HOLD', holdExpiresAt: { lte: now }, ...(spaceId ? { spaceId } : {}) },
    orderBy: { holdExpiresAt: 'asc' },
    take: 200,
  });
  let expired = 0;
  for (const b of due) {
    await db.$transaction(async (tx) => {
      // Claimed by version, so a hold confirmed or released meanwhile is left alone.
      const claimed = await tx.eventBooking.updateMany({
        where: { id: b.id, status: 'HOLD', version: b.version },
        data: { status: 'EXPIRED', version: { increment: 1 } },
      });
      if (claimed.count !== 1) return;
      await voidUnpaidContract(tx, b.id);
      await recordAudit(tx, {
        organisationId: b.organisationId,
        propertyId: b.propertyId,
        action: 'event_booking.hold_expired',
        entityType: 'event_booking',
        entityId: b.id,
        actorType: 'SYSTEM',
        actorUserId: null,
        before: { status: 'HOLD', holdExpiresAt: b.holdExpiresAt },
        after: { status: 'EXPIRED' },
      });
      expired += 1;
    });
  }
  return expired;
}
