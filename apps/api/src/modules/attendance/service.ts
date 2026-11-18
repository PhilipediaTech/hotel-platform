import {
  addDays,
  attendanceSettingsOf,
  distanceMeters,
  zonedInstant,
  type AttendanceChannel,
  type AttendanceEventItem,
  type AttendanceKind,
  type AttendanceSettings,
  type ClockBody,
  type EmploymentType,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { AuthContext } from '../../core/auth.ts';
import type { Clock } from '../../core/clock.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { propertyToday } from '../availability/inventory.ts';
import { addressMatches, isAddressEntry } from './ip.ts';

// Attendance (PRD M7-04, M7 rules and acceptance; T-138). Tab 3 names attendance_events for
// V1.1 without columns: they are designed here. The property's settings live in
// properties.settings.attendance: which employment types clock in, and the phone checks.
// - A PIN session on the shared tablet (T-011) clocks with a photo, uploaded first as an
//   AttendanceEvent file by the same person, and attached to the clock.
// - A phone (any other session) clocks when phones are allowed and, with checks on, from the
//   hotel network (the request's address) or within the radius (the position the phone sends,
//   used only with the member's consent). Passing either enabled check is enough. A refusal is
//   audited with the reason and the address, never the position.
// Clocks alternate IN, OUT per person; the time is the server's.

export interface AttendanceDeps {
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const PHOTO_MAX_AGE_MS = 15 * 60_000;
const RECENT_DAYS = 14;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
  });

const EVENT_INCLUDE = {
  staff: { select: { id: true, number: true, name: true } },
} as const satisfies Prisma.AttendanceEventInclude;
type EventRow = Prisma.AttendanceEventGetPayload<{ include: typeof EVENT_INCLUDE }>;

function eventItem(e: EventRow): z.input<typeof AttendanceEventItem> {
  return {
    id: e.id,
    staff: e.staff,
    kind: e.kind as AttendanceKind,
    at: iso(e.at),
    channel: e.channel as AttendanceChannel,
    deviceLabel: e.deviceLabel,
    ip: e.ip,
    located: e.latitude !== null,
    photoFileId: e.photoFileId,
  };
}

/** The tablet is a PIN session under a shared device, or the device session itself. */
export function channelOf(auth: AuthContext): AttendanceChannel {
  return auth.session.parentSessionId || auth.session.sharedDevice ? 'TABLET' : 'PHONE';
}

async function settingsOf(db: Client, propertyId: string) {
  const property = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  const settings = (property.settings ?? {}) as Record<string, unknown>;
  return { settings: attendanceSettingsOf(settings['attendance']), property };
}

async function ownProfile(db: Client, tenant: TenantContext) {
  return db.staffProfile.findFirst({ where: { userId: tenant.userId, status: 'ACTIVE' } });
}

async function lastEvent(db: Client, staffId: string) {
  return db.attendanceEvent.findFirst({
    where: { staffId },
    orderBy: [{ at: 'desc' }, { createdAt: 'desc' }],
  });
}

// ── My attendance ──────────────────────────────────────────────────────────────────────

export async function getMyAttendance(
  deps: AttendanceDeps,
  tenant: TenantContext,
  auth: AuthContext,
) {
  const db = deps.tenantDb;
  const { settings } = await settingsOf(db, tenant.propertyId);
  const channel = channelOf(auth);
  const phone = channel === 'PHONE';
  const me = await ownProfile(db, tenant);
  const base = {
    channel,
    needsPhoto: !phone,
    locationCheck: phone && settings.phoneAllowed && settings.location.enabled,
    networkCheck: phone && settings.phoneAllowed && settings.network.enabled,
    privacyNotice: settings.privacyNotice,
  };
  if (!me) {
    return {
      ...base,
      staff: null,
      inSince: null,
      blocked: 'NO_PROFILE' as const,
      consentGiven: false,
      recent: [],
    };
  }
  const since = new Date(deps.clock().getTime() - RECENT_DAYS * 86_400_000);
  const [last, recent] = await Promise.all([
    lastEvent(db, me.id),
    db.attendanceEvent.findMany({
      where: { staffId: me.id, at: { gte: since } },
      include: EVENT_INCLUDE,
      orderBy: { at: 'desc' },
      take: 100,
    }),
  ]);
  const blocked = !settings.employmentTypes.includes(me.employmentType as EmploymentType)
    ? ('NOT_FOR_THIS_TYPE' as const)
    : phone && !settings.phoneAllowed
      ? ('PHONE_OFF' as const)
      : null;
  return {
    ...base,
    staff: { id: me.id, number: me.number, name: me.name },
    inSince: last?.kind === 'IN' ? iso(last.at) : null,
    blocked,
    consentGiven: me.locationConsentAt !== null,
    recent: recent.map(eventItem),
  };
}

export async function setLocationConsent(
  deps: AttendanceDeps,
  tenant: TenantContext,
  auth: AuthContext,
  consent: boolean,
) {
  await deps.tenantDb.$transaction(async (tx) => {
    const me = await ownProfile(tx, tenant);
    if (!me) {
      throw invalid('body', 'Your login is not linked to a staff profile here. Ask your manager.');
    }
    const given = me.locationConsentAt !== null;
    if (given === consent) return;
    await tx.staffProfile.update({
      where: { id: me.id },
      data: { locationConsentAt: consent ? deps.clock() : null },
    });
    await recordAudit(tx, {
      action: consent
        ? 'attendance.location_consent_given'
        : 'attendance.location_consent_withdrawn',
      entityType: 'staff_profile',
      entityId: me.id,
      after: { consent },
    });
  });
  return getMyAttendance(deps, tenant, auth);
}

// ── Clocking ───────────────────────────────────────────────────────────────────────────

type Refusal = { reason: string; message: string };

/** Null when the phone may clock; otherwise why not. */
function phoneRefusal(
  settings: AttendanceSettings,
  ip: string | null,
  location: z.output<typeof ClockBody>['location'],
  consented: boolean,
): Refusal | null {
  if (!settings.phoneAllowed) {
    return {
      reason: 'PHONE_OFF',
      message: 'Clocking in on a phone is off here. Use the shared tablet.',
    };
  }
  const { network, location: area } = settings;
  if (!network.enabled && !area.enabled) return null;
  const onNetwork =
    network.enabled && ip !== null && network.addresses.some((a) => addressMatches(ip, a));
  if (onNetwork) return null;
  if (area.enabled && consented && location && area.latitude !== null && area.longitude !== null) {
    const distance = distanceMeters(location, {
      latitude: area.latitude,
      longitude: area.longitude,
    });
    if (distance <= area.radiusMeters) return null;
  }
  if (!area.enabled) {
    return {
      reason: 'OUTSIDE_NETWORK',
      message:
        "You can clock in on your phone only on the hotel's network. Connect to it, or use the shared tablet.",
    };
  }
  if (!consented) {
    return {
      reason: 'LOCATION_CONSENT_NEEDED',
      message: 'Agree to the location check first, or use the shared tablet.',
    };
  }
  if (!location) {
    return {
      reason: 'LOCATION_NEEDED',
      message: 'Allow this app to read your location, or use the shared tablet.',
    };
  }
  return {
    reason: 'OUTSIDE_AREA',
    message: 'You are not at the hotel. Clock in when you arrive, or use the shared tablet.',
  };
}

export async function clockAttendance(
  deps: AttendanceDeps,
  tenant: TenantContext,
  auth: AuthContext,
  ip: string | null,
  body: z.output<typeof ClockBody>,
) {
  const db = deps.tenantDb;
  const channel = channelOf(auth);
  const { settings } = await settingsOf(db, tenant.propertyId);
  const me = await ownProfile(db, tenant);
  if (!me) {
    throw invalid('body', 'Your login is not linked to a staff profile here. Ask your manager.');
  }
  if (!settings.employmentTypes.includes(me.employmentType as EmploymentType)) {
    throw invalid('body', 'Attendance is not used for your employment type here.');
  }
  const consented = me.locationConsentAt !== null;
  if (channel === 'PHONE') {
    const refusal = phoneRefusal(settings, ip, body.location, consented);
    if (refusal) {
      await recordAudit(db, {
        action: 'attendance.clock_refused',
        entityType: 'staff_profile',
        entityId: me.id,
        after: {
          kind: body.kind,
          reason: refusal.reason,
          ip,
          locationSent: body.location !== null,
        },
      });
      throw new AppError('FORBIDDEN', refusal.message, { reason: refusal.reason });
    }
  }
  // Keep the position only where the location check is on and they agreed to it.
  const keepLocation =
    channel === 'PHONE' && settings.location.enabled && consented && body.location !== null;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM staff_profiles WHERE id = ${me.id}::uuid FOR UPDATE`;
    const last = await lastEvent(tx, me.id);
    const isIn = last?.kind === 'IN';
    if (body.kind === 'IN' && isIn) {
      throw new AppError('STATE_TRANSITION_INVALID', 'You are already clocked in.', {
        since: last ? iso(last.at) : null,
      });
    }
    if (body.kind === 'OUT' && !isIn) {
      throw new AppError('STATE_TRANSITION_INVALID', 'You are not clocked in.', {});
    }
    let photoFileId: string | null = null;
    if (channel === 'TABLET') {
      if (!body.photoFileId)
        throw invalid('body.photoFileId', 'Take a photo to clock on the tablet');
      const file = await tx.fileObject.findUnique({ where: { id: body.photoFileId } });
      const fresh =
        file !== null && deps.clock().getTime() - file.createdAt.getTime() <= PHOTO_MAX_AGE_MS;
      if (
        !file ||
        file.entityType !== 'AttendanceEvent' ||
        file.uploadedById !== tenant.userId ||
        file.entityId !== null ||
        !fresh
      ) {
        throw invalid('body.photoFileId', 'Take a new photo and try again');
      }
      photoFileId = file.id;
    }
    const event = await tx.attendanceEvent.create({
      data: {
        staffId: me.id,
        kind: body.kind,
        at: deps.clock(),
        channel,
        ip,
        latitude: keepLocation ? body.location?.latitude : null,
        longitude: keepLocation ? body.location?.longitude : null,
        accuracyMeters: keepLocation ? body.location?.accuracyMeters : null,
        photoFileId,
        deviceLabel: channel === 'TABLET' ? auth.session.deviceLabel : null,
        recordedById: tenant.userId,
      } as unknown as Prisma.AttendanceEventUncheckedCreateInput, // tenant IDs come from the client
      include: EVENT_INCLUDE,
    });
    if (photoFileId) {
      await tx.fileObject.update({ where: { id: photoFileId }, data: { entityId: event.id } });
    }
    return eventItem(event);
  });
}

// ── Managers ───────────────────────────────────────────────────────────────────────────

export async function listAttendance(
  deps: AttendanceDeps,
  tenant: TenantContext,
  query: { date?: string | undefined },
) {
  const db = deps.tenantDb;
  const property = await db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } });
  const date = query.date ?? (await propertyToday(db, tenant.propertyId, deps.clock));
  const from = zonedInstant(date, '00:00', property.timeZone);
  const to = zonedInstant(addDays(date, 1), '00:00', property.timeZone);
  const [events, lastPerStaff] = await Promise.all([
    db.attendanceEvent.findMany({
      where: { at: { gte: from, lt: to } },
      include: EVENT_INCLUDE,
      orderBy: { at: 'asc' },
    }),
    db.attendanceEvent.findMany({
      distinct: ['staffId'],
      orderBy: [{ staffId: 'asc' }, { at: 'desc' }, { createdAt: 'desc' }],
      include: EVENT_INCLUDE,
    }),
  ]);
  return {
    date,
    events: events.map(eventItem),
    inNow: lastPerStaff
      .filter((e) => e.kind === 'IN')
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((e) => ({ ...e.staff, since: iso(e.at) })),
  };
}

export async function getAttendanceSettings(
  deps: AttendanceDeps,
  tenant: TenantContext,
  ip: string | null,
) {
  const { settings } = await settingsOf(deps.tenantDb, tenant.propertyId);
  return { settings, yourAddress: ip?.replace(/^::ffff:/i, '') ?? null };
}

export async function updateAttendanceSettings(
  deps: AttendanceDeps,
  tenant: TenantContext,
  ip: string | null,
  body: AttendanceSettings,
) {
  body.network.addresses.forEach((a, i) => {
    if (!isAddressEntry(a)) {
      throw invalid(`body.network.addresses.${i}`, `${a} is not an IP address or range`);
    }
  });
  await deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM properties WHERE id = ${tenant.propertyId}::uuid FOR UPDATE`;
    const { settings: before, property } = await settingsOf(tx, tenant.propertyId);
    const all = (property.settings ?? {}) as Record<string, unknown>;
    await tx.property.update({
      where: { id: tenant.propertyId },
      data: { settings: { ...all, attendance: body } as never },
    });
    await recordAudit(tx, {
      action: 'attendance_settings.updated',
      entityType: 'property',
      entityId: tenant.propertyId,
      before: { attendance: before },
      after: { attendance: body },
    });
  });
  return getAttendanceSettings(deps, tenant, ip);
}
