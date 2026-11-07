import { HOTEL_PERMISSION_CODES } from '@hotel/shared';
import type { DbClient } from './db.ts';

// Support sessions (PRD M13-02 "I access a tenant's data only through a time-limited,
// reason-logged support session that the owner can see"; M13 AC "a support session expires on
// time and every record viewed is logged"; T-100). While one is open, the admin sees the hotel
// group as a read-only member: every hotel permission, but no change goes through, and every
// record opened is written to the group's audit log as SUPPORT (core/tenancy.ts).

export const SUPPORT_ROLE_NAME = 'Support (read-only)';

/** What a support session lets the admin read (writes are refused regardless). */
export const SUPPORT_PERMISSIONS: readonly string[] = HOTEL_PERMISSION_CODES;

/** The admin's sessions still open at `now` (not ended, not expired). */
export function openSupportSessions(db: DbClient, adminUserId: string, now: Date) {
  return db.supportSession.findMany({
    where: { adminUserId, endedAt: null, expiresAt: { gt: now } },
    include: { organisation: { select: { id: true, name: true } } },
    orderBy: { startedAt: 'asc' },
  });
}
