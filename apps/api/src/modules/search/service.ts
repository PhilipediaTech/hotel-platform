import type { HK_STATUSES, RESERVATION_STATUSES, TASK_STATUSES, TASK_TYPES } from '@hotel/shared';
import { SEARCH_PER_KIND, type SearchHit } from '@hotel/shared';
import type { z } from 'zod';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../core/db.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { listGuests } from '../guests/service.ts';
import { listReservations } from '../reservations/service.ts';
import { listRooms } from '../rooms/service.ts';
import { listTasks } from '../tasks/service.ts';

// Search from the top bar (tab 5 "Global search", spec issue 31; T-178). Every kind goes
// through the list its own screen uses, so the same permissions and visibility apply: guests
// with guest.manage, bookings with frontdesk.read, rooms for every member (as the room list),
// tasks as the task queue shows them to this caller.

export interface SearchDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

export type Hit = z.input<typeof SearchHit>;

const lower = (s: string) => s.toLowerCase().replace(/_/g, ' ');

export interface GuestFilter {
  text: string;
}
export interface BookingFilter {
  text?: string | null;
  status?: (typeof RESERVATION_STATUSES)[number] | null;
  arrivalFrom?: string | null;
  arrivalTo?: string | null;
}
export interface RoomFilter {
  number?: string | null;
  hkStatus?: (typeof HK_STATUSES)[number] | null;
}
export interface TaskFilter {
  text?: string | null;
  status?: 'open' | (typeof TASK_STATUSES)[number] | null;
  type?: (typeof TASK_TYPES)[number] | null;
  overdue?: boolean | null;
}

export const canFind = (tenant: TenantContext) => ({
  guests: tenant.permissions.has('guest.manage'),
  bookings: tenant.permissions.has('frontdesk.read'),
  rooms: true,
  tasks: true,
});

export async function findGuests(
  deps: SearchDeps,
  tenant: TenantContext,
  f: GuestFilter,
  limit: number,
): Promise<Hit[]> {
  const page = await listGuests(deps, tenant, { q: f.text, limit });
  return page.data.map((g) => ({
    kind: 'GUEST',
    id: g.id,
    label: `${g.firstName} ${g.lastName}`,
    detail: g.phone ?? g.email ?? null,
  }));
}

export async function findBookings(
  deps: SearchDeps,
  f: BookingFilter,
  limit: number,
): Promise<Hit[]> {
  const page = await listReservations(deps, {
    limit,
    ...(f.text ? { q: f.text } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.arrivalFrom ? { arrivalFrom: f.arrivalFrom } : {}),
    ...(f.arrivalTo ? { arrivalTo: f.arrivalTo } : {}),
  });
  return page.data.map((r) => ({
    kind: 'RESERVATION',
    id: r.id,
    label: `${r.confirmationNo} · ${r.bookerName}`,
    detail: `${r.arrival} to ${r.departure}, ${lower(r.status)}`,
  }));
}

export async function findRooms(
  deps: SearchDeps,
  tenant: TenantContext,
  f: RoomFilter,
  limit: number,
): Promise<Hit[]> {
  const number = f.number?.trim().toLowerCase();
  const rooms = (await listRooms(deps, tenant)).filter(
    (r) =>
      r.active &&
      (!number || r.number.toLowerCase().startsWith(number)) &&
      (!f.hkStatus || r.hkStatus === f.hkStatus),
  );
  return rooms.slice(0, limit).map((r) => ({
    kind: 'ROOM',
    id: r.id,
    label: `Room ${r.number}`,
    detail: lower(r.hkStatus),
  }));
}

export async function findTasks(
  deps: SearchDeps,
  tenant: TenantContext,
  f: TaskFilter,
  limit: number,
): Promise<Hit[]> {
  const page = await listTasks(deps, tenant, {
    limit,
    ...(f.text ? { q: f.text } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.type ? { type: f.type } : {}),
    ...(f.overdue ? { overdue: 'true' as const } : {}),
  });
  return page.data.map((t) => ({
    kind: 'TASK',
    id: t.id,
    label: `#${t.number} ${t.title}`,
    detail: [t.room && `room ${t.room.number}`, lower(t.status), t.overdue && 'overdue']
      .filter(Boolean)
      .join(', '),
  }));
}

/** Plain search: no AI, a few of each kind the caller may see. */
export async function search(deps: SearchDeps, tenant: TenantContext, q: string) {
  const can = canFind(tenant);
  const n = SEARCH_PER_KIND;
  // One after another: they share the request's database connection.
  const hits: Hit[] = [];
  if (can.guests) hits.push(...(await findGuests(deps, tenant, { text: q }, n)));
  if (can.bookings) hits.push(...(await findBookings(deps, { text: q }, n)));
  hits.push(...(await findRooms(deps, tenant, { number: q }, n)));
  hits.push(...(await findTasks(deps, tenant, { text: q }, n)));
  return { hits };
}
