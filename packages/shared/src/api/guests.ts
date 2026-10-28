import { z } from 'zod';
import { Email, Phone } from './auth.ts';
import { defineRoute } from './contract.ts';
import { Instant, page, PageQuery, Uuid } from './primitives.ts';

// Guests and companies (tab 4 row "Guests"; PRD M3-15, M3-18, M3-16 basic; S13; T-043).
// Both belong to the organisation, so every property sees the same profiles. Stay history
// arrives with reservations (T-042).

const GUEST = 'guest.manage';
const FLAG = 'guest.flag';
const COMPANY = 'company.manage';

const Name = z.string().trim().min(1).max(80);
const Country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Two-letter country code, e.g. NG');

export const GuestPreferences = z
  .object({
    /** Free text the desk should know: pillow, floor, dietary needs. */
    notes: z.string().trim().max(1000).nullable().default(null),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  })
  .meta({ id: 'GuestPreferences' });

export const GuestFlags = z
  .object({
    vip: z.boolean(),
    doNotRent: z.boolean(),
    reason: z.string().nullable(),
  })
  .meta({ id: 'GuestFlags' });

export const GuestItem = z
  .object({
    id: Uuid,
    firstName: z.string(),
    lastName: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    nationality: z.string().nullable(),
    preferences: z.object({ notes: z.string().nullable(), tags: z.array(z.string()) }),
    marketingConsent: z.boolean(),
    consentAt: Instant.nullable(),
    /** VIP and do-not-rent; null for roles without guest.flag (M3-18). */
    flags: GuestFlags.nullable(),
    /** Set on a duplicate merged away: open this profile instead. */
    mergedIntoId: Uuid.nullable(),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .meta({ id: 'Guest' });

const GuestFields = z.object({
  firstName: Name,
  lastName: Name,
  email: Email.nullable(),
  phone: Phone.nullable(),
  nationality: Country.nullable(),
  preferences: GuestPreferences,
  /** Agreed to marketing messages; the time is recorded (NDPA). */
  marketingConsent: z.boolean(),
});

export const GuestBody = GuestFields.extend({
  email: Email.nullable().default(null),
  phone: Phone.nullable().default(null),
  nationality: Country.nullable().default(null),
  preferences: GuestPreferences.default({ notes: null, tags: [] }),
  marketingConsent: z.boolean().default(false),
});

export const GuestPatchBody = GuestFields.partial();

export const listGuests = defineRoute({
  operationId: 'listGuests',
  method: 'get',
  path: '/guests',
  summary: 'Find guests by name, phone or email (newest first without a search)',
  description:
    'Names match from the start of the first or last name ("ada ob" finds Ada Obi); digits match anywhere in the phone number; text with @ matches the start of the email. Merged duplicates are left out.',
  tags: ['Guests'],
  propertyScoped: true,
  permission: GUEST,
  query: PageQuery.extend({ q: z.string().trim().max(100).optional() }),
  response: page(GuestItem),
});

export const createGuest = defineRoute({
  operationId: 'createGuest',
  method: 'post',
  path: '/guests',
  summary: 'Add a guest profile',
  tags: ['Guests'],
  propertyScoped: true,
  permission: GUEST,
  body: GuestBody,
  status: 201,
  response: GuestItem,
});

const GuestParams = z.object({ guestId: Uuid });

export const getGuest = defineRoute({
  operationId: 'getGuest',
  method: 'get',
  path: '/guests/{guestId}',
  summary: 'A guest profile',
  tags: ['Guests'],
  propertyScoped: true,
  permission: GUEST,
  params: GuestParams,
  response: GuestItem,
});

export const updateGuest = defineRoute({
  operationId: 'updateGuest',
  method: 'patch',
  path: '/guests/{guestId}',
  summary: 'Change a guest profile',
  tags: ['Guests'],
  propertyScoped: true,
  permission: GUEST,
  params: GuestParams,
  body: GuestPatchBody,
  response: GuestItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const mergeGuests = defineRoute({
  operationId: 'mergeGuests',
  method: 'post',
  path: '/guests/{guestId}/merge',
  summary: 'Merge a duplicate into this guest; the older profile is kept',
  description:
    'The older of the two profiles is kept whichever is named in the path (PRD M3 rule); its empty fields are filled from the other, flags are combined, and the other is marked merged. Both IDs are audited.',
  tags: ['Guests'],
  propertyScoped: true,
  permission: GUEST,
  params: GuestParams,
  body: z.object({ otherGuestId: Uuid }),
  response: GuestItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const GuestFlagsBody = z
  .object({
    vip: z.boolean(),
    doNotRent: z.boolean(),
    /** Required while a flag is set. */
    reason: z.string().trim().max(500).nullable().default(null),
  })
  .refine((f) => !(f.vip || f.doNotRent) || (f.reason ?? '') !== '', {
    message: 'Give a reason',
    path: ['reason'],
  });

export const flagGuest = defineRoute({
  operationId: 'flagGuest',
  method: 'post',
  path: '/guests/{guestId}/flags',
  summary: 'Set or clear VIP and do-not-rent, with a reason',
  tags: ['Guests'],
  propertyScoped: true,
  permission: FLAG,
  params: GuestParams,
  body: GuestFlagsBody,
  response: GuestItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

// ── Companies ──────────────────────────────────────────────────────────────────────────

export const COMPANY_KINDS = ['COMPANY', 'TRAVEL_AGENT', 'EVENT_CLIENT'] as const;

export const CompanyContact = z.object({
  name: Name,
  role: z.string().trim().max(80).nullable().default(null),
  phone: Phone.nullable().default(null),
  email: Email.nullable().default(null),
});

export const CompanyItem = z
  .object({
    id: Uuid,
    kind: z.enum(COMPANY_KINDS),
    name: z.string(),
    contacts: z.array(
      z.object({
        name: z.string(),
        role: z.string().nullable(),
        phone: z.string().nullable(),
        email: z.string().nullable(),
      }),
    ),
    taxId: z.string().nullable(),
    active: z.boolean(),
  })
  .meta({ id: 'Company' });

const CompanyFields = z.object({
  kind: z.enum(COMPANY_KINDS),
  name: z.string().trim().min(1).max(160),
  contacts: z.array(CompanyContact).max(20),
  taxId: z.string().trim().max(30).nullable(),
});

export const CompanyBody = CompanyFields.extend({
  contacts: z.array(CompanyContact).max(20).default([]),
  taxId: z.string().trim().max(30).nullable().default(null),
});

export const CompanyPatchBody = CompanyFields.extend({ active: z.boolean() }).partial();

export const listCompanies = defineRoute({
  operationId: 'listCompanies',
  method: 'get',
  path: '/companies',
  summary: 'Companies, travel agents and event clients (by name)',
  tags: ['Guests'],
  propertyScoped: true,
  query: z.object({
    q: z.string().trim().max(100).optional(),
    kind: z.enum(COMPANY_KINDS).optional(),
  }),
  response: z.object({ data: z.array(CompanyItem) }),
});

export const createCompany = defineRoute({
  operationId: 'createCompany',
  method: 'post',
  path: '/companies',
  summary: 'Add a company, travel agent or event client',
  tags: ['Guests'],
  propertyScoped: true,
  permission: COMPANY,
  body: CompanyBody,
  status: 201,
  response: CompanyItem,
});

const CompanyParams = z.object({ companyId: Uuid });

export const getCompany = defineRoute({
  operationId: 'getCompany',
  method: 'get',
  path: '/companies/{companyId}',
  summary: 'A company profile',
  tags: ['Guests'],
  propertyScoped: true,
  params: CompanyParams,
  response: CompanyItem,
});

export const updateCompany = defineRoute({
  operationId: 'updateCompany',
  method: 'patch',
  path: '/companies/{companyId}',
  summary: 'Change a company profile',
  tags: ['Guests'],
  propertyScoped: true,
  permission: COMPANY,
  params: CompanyParams,
  body: CompanyPatchBody,
  response: CompanyItem,
});

export const GUEST_ROUTES = {
  listGuests,
  createGuest,
  getGuest,
  updateGuest,
  mergeGuests,
  flagGuest,
  listCompanies,
  createCompany,
  getCompany,
  updateCompany,
} as const;
