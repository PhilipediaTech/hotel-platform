import type { FrontDeskFlag, FrontDeskQuery, FrontDeskRow } from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { businessDate } from '../../core/business-day.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { folioBalances } from '../folios/service.ts';
import { dayUseOf, type ReservationDeps } from './service.ts';

// Front desk lists (PRD M3-06; tab 4 GET /front-desk/arrivals · /departures · /in-house; S06;
// T-053). One row per stay, with what the desk should notice (flags). Lists default to the
// property's business date (T-054); until night audit marks no-shows
// and folios exist, today's lists also carry earlier guests not arrived or not gone (OVERDUE)
// and the balance is null.

type Row = z.input<typeof FrontDeskRow>;

const ROW = {
  guest: true,
  room: true,
  roomType: true,
  ratePlan: true,
  quote: true,
  reservation: true,
  nights: { orderBy: { date: 'asc' }, take: 1 },
} satisfies Prisma.StayInclude;

type StayRow = Prisma.StayGetPayload<{ include: typeof ROW }>;

const READY = new Set(['CLEAN', 'INSPECTED']);
const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const nightsOf = (s: StayRow) =>
  Math.round((s.departure.getTime() - s.arrival.getTime()) / 86_400_000);

interface Seen {
  /** The business date the list is for, and today at the property. */
  date: string;
  today: string;
  now: Date;
  /** Rooms with a checked-in guest in them: room → stay. */
  occupied: Map<string, string>;
  /** Folio balances (T-060). */
  balances: Map<string, bigint>;
}

function flagsOf(s: StayRow, seen: Seen): FrontDeskFlag[] {
  const flags: FrontDeskFlag[] = [];
  const expected = s.status === 'CONFIRMED' || s.status === 'TENTATIVE';
  if (s.guest.vip) flags.push('VIP');
  if (s.guest.doNotRent) flags.push('DO_NOT_RENT');
  if (s.status === 'TENTATIVE') flags.push('TENTATIVE');
  if (expected && !s.roomId) flags.push('NO_ROOM');
  if (expected && s.room) {
    const other = seen.occupied.get(s.room.id);
    if (!READY.has(s.room.hkStatus) || (other && other !== s.id)) flags.push('ROOM_NOT_READY');
  }
  if (expected && s.reservation.guarantee === 'DEPOSIT') flags.push('DEPOSIT_DUE');
  if (s.isDayUse) flags.push('DAY_USE');
  const late =
    seen.date === seen.today &&
    ((expected && day(s.arrival) < seen.today) ||
      (s.status === 'CHECKED_IN' &&
        (s.isDayUse
          ? (s.dayUseEnd ?? seen.now) < seen.now || day(s.arrival) < seen.today
          : day(s.departure) < seen.today)));
  if (late) flags.push('OVERDUE');
  if (s.reservation.notes) flags.push('NOTES');
  return flags;
}

function toRow(s: StayRow, seen: Seen): Row {
  return {
    stayId: s.id,
    reservationId: s.reservationId,
    confirmationNo: s.reservation.confirmationNo,
    status: s.status,
    source: s.reservation.source,
    guarantee: s.reservation.guarantee,
    guest: {
      id: s.guest.id,
      firstName: s.guest.firstName,
      lastName: s.guest.lastName,
      phone: s.guest.phone,
    },
    roomTypeName: s.roomType.name,
    roomId: s.roomId,
    roomNumber: s.room?.number ?? null,
    hkStatus: s.room?.hkStatus ?? null,
    ratePlanCode: s.ratePlan.code,
    arrival: day(s.arrival),
    departure: day(s.departure),
    nights: nightsOf(s),
    adults: s.adults,
    children: s.children,
    dayUse: dayUseOf(s),
    checkedInAt: s.checkedInAt ? iso(s.checkedInAt) : null,
    checkedOutAt: s.checkedOutAt ? iso(s.checkedOutAt) : null,
    totalMinor: s.quote.totalMinor.toString(),
    depositDueMinor:
      s.reservation.guarantee === 'DEPOSIT' ? (s.nights[0]?.amountMinor ?? 0n).toString() : '0',
    balanceMinor: s.folioId ? (seen.balances.get(s.folioId) ?? 0n).toString() : null,
    flags: flagsOf(s, seen),
    notes: s.reservation.notes,
    version: s.version,
  };
}

/** Still to do first (by day-use start, then guest), then what is done. */
function ordered(rows: StayRow[], done: (s: StayRow) => boolean): StayRow[] {
  const key = (s: StayRow) =>
    [
      done(s) ? '1' : '0',
      s.dayUseStart ? iso(s.dayUseStart) : '',
      s.guest.lastName.toLowerCase(),
      s.guest.firstName.toLowerCase(),
      s.id,
    ].join('|');
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}

async function list(
  deps: ReservationDeps,
  tenant: TenantContext,
  date: string | undefined,
  where: (seen: Seen) => Prisma.StayWhereInput,
  done: (s: StayRow) => boolean,
) {
  const today = await businessDate(deps.tenantDb, tenant.propertyId, deps.clock);
  const inRooms = await deps.tenantDb.stay.findMany({
    where: { status: 'CHECKED_IN', roomId: { not: null } },
    select: { id: true, roomId: true },
  });
  const seen: Seen = {
    date: date ?? today,
    today,
    now: deps.clock(),
    occupied: new Map(inRooms.map((s) => [s.roomId ?? '', s.id])),
    balances: new Map(),
  };
  const stays = await deps.tenantDb.stay.findMany({ where: where(seen), include: ROW });
  seen.balances = await folioBalances(
    deps.tenantDb,
    stays.flatMap((s) => (s.folioId ? [s.folioId] : [])),
  );
  return { date: seen.date, data: ordered(stays, done).map((s) => toRow(s, seen)) };
}

export function listArrivals(
  deps: ReservationDeps,
  tenant: TenantContext,
  query: z.output<typeof FrontDeskQuery>,
) {
  return list(
    deps,
    tenant,
    query.date,
    ({ date, today }) => ({
      OR: [
        { arrival: dbDate(date), status: { in: ['TENTATIVE', 'CONFIRMED', 'CHECKED_IN'] } },
        // Not arrived yet from an earlier day, still in their dates (no night audit yet).
        ...(date === today
          ? [
              {
                arrival: { lt: dbDate(today) },
                departure: { gt: dbDate(today) },
                isDayUse: false,
                status: { in: ['TENTATIVE', 'CONFIRMED'] },
              } satisfies Prisma.StayWhereInput,
            ]
          : []),
      ],
    }),
    (s) => s.status === 'CHECKED_IN',
  );
}

export function listDepartures(
  deps: ReservationDeps,
  tenant: TenantContext,
  query: z.output<typeof FrontDeskQuery>,
) {
  return list(
    deps,
    tenant,
    query.date,
    ({ date, today }) => ({
      OR: [
        // A day-use stay departs on its date (departure = arrival).
        { departure: dbDate(date), status: { in: ['CHECKED_IN', 'CHECKED_OUT'] } },
        // Past their departure and still in (no night audit yet).
        ...(date === today
          ? [
              {
                departure: { lt: dbDate(today) },
                status: 'CHECKED_IN',
              } satisfies Prisma.StayWhereInput,
            ]
          : []),
      ],
    }),
    (s) => s.status === 'CHECKED_OUT',
  );
}

export function listInHouse(deps: ReservationDeps, tenant: TenantContext) {
  return list(
    deps,
    tenant,
    undefined,
    () => ({ status: 'CHECKED_IN' }),
    () => false,
  );
}
