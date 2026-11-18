import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';
import { EMPLOYMENT_TYPES } from './staff.ts';

// Attendance (PRD M7-04 "As staff, I clock in and out on the shared tablet (PIN + photo) or
// my phone (restricted to property network or location, if enabled)", attendance.clock; M7
// rules "attendance and rotas are optional per type", "location-based clock-in requires the
// staff member's consent and a privacy notice"; acceptance "clock-in outside the allowed
// network is rejected when the restriction is on"; tab 3 attendance_events; tab 4
// /attendance/clock; S36; T-138).
// - On the shared tablet, staff switch in with their PIN (T-011), and each clock takes a photo.
// - On their own phone, clocking can be turned off, or limited to the property's network
//   (its public IP addresses) and/or a radius around the property. With both limits on,
//   passing either is enough. Location is used only with the member's consent, after the
//   property's privacy notice.

export const ATTENDANCE_KINDS = ['IN', 'OUT'] as const;
export type AttendanceKind = (typeof ATTENDANCE_KINDS)[number];
export const ATTENDANCE_CHANNELS = ['TABLET', 'PHONE'] as const;
export type AttendanceChannel = (typeof ATTENDANCE_CHANNELS)[number];
export const MAX_ALLOWED_ADDRESSES = 20;

export const DEFAULT_PRIVACY_NOTICE =
  'When you clock in or out on your phone, we check your location against the hotel to confirm you are on site. Your location is taken only at that moment, kept with the clock record and seen only by managers who approve timesheets. You can withdraw your consent at any time; you can still clock in on the shared tablet.';

/** Metres between two points on the Earth (haversine). */
export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** An IPv4 or IPv6 address, optionally with a /prefix. The API checks it properly. */
const Address = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F:.]{2,45}(\/\d{1,3})?$/,
    'Use an IP address, e.g. 102.89.4.10 or 102.89.4.0/24',
  );
const Latitude = z.number().min(-90).max(90);
const Longitude = z.number().min(-180).max(180);

export const AttendanceSettings = z
  .object({
    /** Employment types that clock in; others work without attendance (M7 rule). */
    employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).max(4),
    /** False: clocking only on the shared tablet. */
    phoneAllowed: z.boolean(),
    network: z.object({
      enabled: z.boolean(),
      /** The property's public IP addresses (or ranges), as the API sees them. */
      addresses: z.array(Address).max(MAX_ALLOWED_ADDRESSES),
    }),
    location: z.object({
      enabled: z.boolean(),
      latitude: Latitude.nullable(),
      longitude: Longitude.nullable(),
      radiusMeters: z.number().int().min(25).max(5000),
    }),
    privacyNotice: z.string().trim().min(20).max(2000),
    /** Minutes a day before overtime starts on timesheets (M7-06; T-139). */
    overtimeAfterMinutes: z.number().int().min(60).max(1440).default(480),
  })
  .refine((v) => !v.network.enabled || v.network.addresses.length > 0, {
    path: ['network', 'addresses'],
    message: 'Add at least one address, or turn the network check off',
  })
  .refine(
    (v) => !v.location.enabled || (v.location.latitude !== null && v.location.longitude !== null),
    {
      path: ['location', 'latitude'],
      message: "Set the hotel's position, or turn the location check off",
    },
  )
  .meta({ id: 'AttendanceSettings' });
export type AttendanceSettings = z.output<typeof AttendanceSettings>;

export const DEFAULT_ATTENDANCE_SETTINGS: AttendanceSettings = {
  employmentTypes: [...EMPLOYMENT_TYPES],
  phoneAllowed: true,
  network: { enabled: false, addresses: [] },
  location: { enabled: false, latitude: null, longitude: null, radiusMeters: 200 },
  privacyNotice: DEFAULT_PRIVACY_NOTICE,
  overtimeAfterMinutes: 480,
};

/** The stored settings, or the defaults where they are missing or no longer valid. */
export function attendanceSettingsOf(stored: unknown): AttendanceSettings {
  const parsed = AttendanceSettings.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_ATTENDANCE_SETTINGS;
}

const StaffRef = z.object({ id: Uuid, number: z.number().int(), name: z.string() });

export const AttendanceEventItem = z
  .object({
    id: Uuid,
    staff: StaffRef,
    kind: z.enum(ATTENDANCE_KINDS),
    at: Instant,
    channel: z.enum(ATTENDANCE_CHANNELS),
    deviceLabel: z.string().nullable(),
    /** Shown only to managers (timesheet.approve). */
    ip: z.string().nullable(),
    located: z.boolean(),
    photoFileId: Uuid.nullable(),
  })
  .meta({ id: 'AttendanceEvent' });

export const MyAttendance = z
  .object({
    /** Null when this login has no staff profile at the property. */
    staff: StaffRef.nullable(),
    /** Where this session clocks from: a PIN session on the shared tablet, or a phone. */
    channel: z.enum(ATTENDANCE_CHANNELS),
    /** Clocked in since, or null. */
    inSince: Instant.nullable(),
    /** Why clocking is not possible here, or null. */
    blocked: z.enum(['NO_PROFILE', 'NOT_FOR_THIS_TYPE', 'PHONE_OFF']).nullable(),
    needsPhoto: z.boolean(),
    /** The phone must send its location (only check that could pass, or one of two). */
    locationCheck: z.boolean(),
    networkCheck: z.boolean(),
    consentGiven: z.boolean(),
    privacyNotice: z.string(),
    /** The last 14 days, newest first. */
    recent: z.array(AttendanceEventItem),
  })
  .meta({ id: 'MyAttendance' });

export const ClockBody = z
  .object({
    kind: z.enum(ATTENDANCE_KINDS),
    /** Required on the shared tablet: a photo uploaded as an AttendanceEvent file. */
    photoFileId: Uuid.nullable().default(null),
    /** The phone's position, when the location check is on and consent is given. */
    location: z
      .object({
        latitude: Latitude,
        longitude: Longitude,
        accuracyMeters: z.number().int().min(0).max(100_000).nullable().default(null),
      })
      .nullable()
      .default(null),
  })
  .meta({ id: 'ClockBody' });

export const AttendanceDay = z
  .object({
    date: IsoDate,
    events: z.array(AttendanceEventItem),
    /** Clocked in now (last event IN), oldest first. */
    inNow: z.array(StaffRef.extend({ since: Instant })),
  })
  .meta({ id: 'AttendanceDay' });

const ADDED = 'Tab 4 lists /attendance/clock; the request and response are designed in T-138.';
const CLOCK = { tags: ['Staff'], propertyScoped: true as const, permission: 'attendance.clock' };

export const getMyAttendance = defineRoute({
  ...CLOCK,
  operationId: 'getMyAttendance',
  method: 'get',
  path: '/attendance/me',
  summary: 'Whether I am clocked in, what this device needs to clock, and my recent clocks (M7-04)',
  description: ADDED,
  response: MyAttendance,
});

export const clockAttendance = defineRoute({
  ...CLOCK,
  operationId: 'clockAttendance',
  method: 'post',
  path: '/attendance/clock',
  summary: 'Clock in or out (M7-04)',
  description: `${ADDED} On the shared tablet a photo is required. On a phone, refused outside the allowed network or location when those checks are on (audited as attendance.clock_refused).`,
  idempotent: true,
  status: 201,
  body: ClockBody,
  response: AttendanceEventItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const setLocationConsent = defineRoute({
  ...CLOCK,
  operationId: 'setLocationConsent',
  method: 'post',
  path: '/attendance/consent',
  summary: 'Agree to, or withdraw from, location-based clock-in (M7 rule)',
  description: `${ADDED} Agreeing records the time; the privacy notice is shown first.`,
  body: z.object({ consent: z.boolean() }),
  response: MyAttendance,
});

export const listAttendance = defineRoute({
  tags: ['Staff'],
  propertyScoped: true,
  permission: 'timesheet.approve',
  operationId: 'listAttendance',
  method: 'get',
  path: '/attendance',
  summary: "A day's clocks and who is in now (M7-04)",
  description: `${ADDED} The day is the property's local date; today by default.`,
  query: z.object({ date: IsoDate.optional() }),
  response: AttendanceDay,
});

const SETTINGS = { tags: ['Staff'], propertyScoped: true as const, permission: 'staff.manage' };

export const getAttendanceSettings = defineRoute({
  ...SETTINGS,
  operationId: 'getAttendanceSettings',
  method: 'get',
  path: '/attendance/settings',
  summary: 'Who clocks in, and the phone checks (M7-04)',
  description: `${ADDED} Also the address this request came from, to add as the hotel network.`,
  response: z.object({ settings: AttendanceSettings, yourAddress: z.string().nullable() }),
});

export const updateAttendanceSettings = defineRoute({
  ...SETTINGS,
  operationId: 'updateAttendanceSettings',
  method: 'put',
  path: '/attendance/settings',
  summary: 'Change who clocks in and the phone checks (M7-04)',
  description: ADDED,
  body: AttendanceSettings,
  response: z.object({ settings: AttendanceSettings, yourAddress: z.string().nullable() }),
});

export const ATTENDANCE_ROUTES = {
  getMyAttendance,
  clockAttendance,
  setLocationConsent,
  listAttendance,
  getAttendanceSettings,
  updateAttendanceSettings,
} as const;
