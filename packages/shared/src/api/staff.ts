import { z } from 'zod';
import { Email, Phone } from './auth.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';

// Staff profiles (PRD M7-01 "As HR or GM, I create staff profiles (department, role, manager,
// employment type, start date, pay basis, certifications with expiry, restricted emergency
// contact)", staff.manage; M7-10 "reminders 30 days before a certification expires"; tab 4
// /staff; S36 /staff "Directory, profile"; tab 3 names staff_profiles for V1.1 without columns;
// T-136). A profile may stand alone (no login) or belong to a user. The emergency contact is
// restricted: not in the list or the profile, only in its own route, and every read is audited.

/** M7 business rules. */
export const EMPLOYMENT_TYPES = ['MONTHLY_SALARY', 'DAILY_PAID', 'HOURLY', 'CONTRACTOR'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export const STAFF_STATUSES = ['ACTIVE', 'LEFT'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];
/** Days ahead a certification's expiry is reminded (M7-10). */
export const CERT_REMIND_DAYS = 30;

/** A certification's state on a date: none, fine, expiring within 30 days, or expired. */
export function certState(
  expiresOn: string | null,
  today: string,
): 'NO_EXPIRY' | 'VALID' | 'EXPIRING' | 'EXPIRED' {
  if (!expiresOn) return 'NO_EXPIRY';
  if (expiresOn < today) return 'EXPIRED';
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + CERT_REMIND_DAYS);
  return expiresOn <= limit.toISOString().slice(0, 10) ? 'EXPIRING' : 'VALID';
}

const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
const Optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();
const Person = z.object({ id: Uuid, name: z.string() });
const NonNegative = AmountMinor.refine((v) => !v.startsWith('-'), 'Must not be negative');

export const StaffCertificationItem = z
  .object({
    id: Uuid,
    name: z.string(),
    issuer: z.string().nullable(),
    reference: z.string().nullable(),
    issuedOn: IsoDate.nullable(),
    expiresOn: IsoDate.nullable(),
    state: z.enum(['NO_EXPIRY', 'VALID', 'EXPIRING', 'EXPIRED']),
  })
  .meta({ id: 'StaffCertification' });

export const StaffItem = z
  .object({
    id: Uuid,
    /** ST-<number>. */
    number: z.number().int(),
    name: z.string(),
    jobTitle: z.string(),
    department: z.object({ id: Uuid, name: z.string() }).nullable(),
    manager: Person.nullable(),
    /** Their login, if any. */
    user: z.object({ id: Uuid, email: z.string().nullable() }).nullable(),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    startDate: IsoDate,
    endDate: IsoDate.nullable(),
    status: z.enum(STAFF_STATUSES),
    /** Certifications expiring within 30 days or expired. */
    certsDue: z.number().int(),
    hasEmergencyContact: z.boolean(),
  })
  .meta({ id: 'Staff' });

export const StaffDetail = StaffItem.extend({
  phone: z.string().nullable(),
  email: z.string().nullable(),
  /** Per month, day, hour or contract, by employment type; null when not recorded. */
  payRateMinor: AmountMinor.nullable(),
  currency: z.string(),
  certifications: z.array(StaffCertificationItem),
  createdAt: Instant,
}).meta({ id: 'StaffDetail' });

export const EmergencyContact = z
  .object({
    name: z.string().nullable(),
    phone: z.string().nullable(),
    relation: z.string().nullable(),
  })
  .meta({ id: 'EmergencyContact' });

const EmergencyBody = z.object({
  name: Optional(120),
  phone: Phone.nullable(),
  relation: Optional(60),
});

export const StaffBody = z
  .object({
    name: Text(1, 120),
    userId: Uuid.nullable().default(null),
    phone: Phone.nullable().default(null),
    email: Email.nullable().default(null),
    departmentId: Uuid.nullable().default(null),
    jobTitle: Text(1, 80),
    managerId: Uuid.nullable().default(null),
    employmentType: z.enum(EMPLOYMENT_TYPES),
    startDate: IsoDate,
    payRateMinor: NonNegative.nullable().default(null),
    emergency: EmergencyBody.nullable().default(null),
  })
  .meta({ id: 'StaffBody' });

export const StaffPatch = z
  .object({
    name: Text(1, 120).optional(),
    userId: Uuid.nullable().optional(),
    phone: Phone.nullable().optional(),
    email: Email.nullable().optional(),
    departmentId: Uuid.nullable().optional(),
    jobTitle: Text(1, 80).optional(),
    managerId: Uuid.nullable().optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    startDate: IsoDate.optional(),
    payRateMinor: NonNegative.nullable().optional(),
    emergency: EmergencyBody.nullable().optional(),
    /** A date marks them as having left (LEFT); null brings them back (ACTIVE). */
    endDate: IsoDate.nullable().optional(),
  })
  .meta({ id: 'StaffPatch' });

export const CertificationBody = z
  .object({
    name: Text(1, 120),
    issuer: Optional(120).default(null),
    reference: Optional(80).default(null),
    issuedOn: IsoDate.nullable().default(null),
    expiresOn: IsoDate.nullable().default(null),
  })
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn, {
    path: ['expiresOn'],
    message: 'Expires before it was issued',
  })
  .meta({ id: 'CertificationBody' });

const COMMON = { tags: ['Staff'], propertyScoped: true as const, permission: 'staff.manage' };
const ADDED = 'Tab 4 lists /staff; the request and response are designed in T-136.';
const StaffParams = z.object({ staffId: Uuid });
const CertParams = z.object({ staffId: Uuid, certificationId: Uuid });

export const listStaff = defineRoute({
  ...COMMON,
  operationId: 'listStaff',
  method: 'get',
  path: '/staff',
  summary: 'Staff directory (M7-01)',
  description: `${ADDED} Active staff by default, by name.`,
  query: z.object({
    status: z.enum(STAFF_STATUSES).optional(),
    q: z.string().trim().max(80).optional(),
  }),
  response: z.object({
    data: z.array(StaffItem),
    departments: z.array(z.object({ id: Uuid, name: z.string() })),
    /** Members of the property: logins to link and managers to choose. */
    people: z.array(Person.extend({ email: z.string().nullable(), linked: z.boolean() })),
    today: IsoDate,
  }),
});

export const createStaff = defineRoute({
  ...COMMON,
  operationId: 'createStaff',
  method: 'post',
  path: '/staff',
  summary: 'Create a staff profile (M7-01)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: StaffBody,
  response: StaffDetail,
});

export const getStaff = defineRoute({
  ...COMMON,
  operationId: 'getStaff',
  method: 'get',
  path: '/staff/{staffId}',
  summary: 'A staff profile with certifications (M7-01)',
  description: `${ADDED} Without the emergency contact.`,
  params: StaffParams,
  response: StaffDetail,
});

export const updateStaff = defineRoute({
  ...COMMON,
  operationId: 'updateStaff',
  method: 'patch',
  path: '/staff/{staffId}',
  summary: 'Change a staff profile, or mark them as having left (M7-01)',
  description: ADDED,
  params: StaffParams,
  body: StaffPatch,
  response: StaffDetail,
});

export const getEmergencyContact = defineRoute({
  ...COMMON,
  operationId: 'getEmergencyContact',
  method: 'get',
  path: '/staff/{staffId}/emergency-contact',
  summary: 'The restricted emergency contact; each read is audited (M7-01)',
  description: ADDED,
  params: StaffParams,
  response: EmergencyContact,
});

export const addCertification = defineRoute({
  ...COMMON,
  operationId: 'addCertification',
  method: 'post',
  path: '/staff/{staffId}/certifications',
  summary: 'Add a certification with its expiry (M7-01)',
  description: ADDED,
  idempotent: true,
  status: 201,
  params: StaffParams,
  body: CertificationBody,
  response: StaffDetail,
});

export const updateCertification = defineRoute({
  ...COMMON,
  operationId: 'updateCertification',
  method: 'put',
  path: '/staff/{staffId}/certifications/{certificationId}',
  summary: 'Renew or correct a certification (M7-01)',
  description: `${ADDED} A new expiry date is reminded again.`,
  params: CertParams,
  body: CertificationBody,
  response: StaffDetail,
});

export const removeCertification = defineRoute({
  ...COMMON,
  operationId: 'removeCertification',
  method: 'delete',
  path: '/staff/{staffId}/certifications/{certificationId}',
  summary: 'Remove a certification entered by mistake (M7-01)',
  description: `${ADDED} Audited with what was removed.`,
  params: CertParams,
  response: StaffDetail,
});

export const STAFF_ROUTES = {
  listStaff,
  createStaff,
  getStaff,
  updateStaff,
  getEmergencyContact,
  addCertification,
  updateCertification,
  removeCertification,
} as const;
