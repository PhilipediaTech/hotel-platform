import { z } from 'zod';
import { MANUAL_PAY_METHODS, SETUP_STEP_IDS } from '../setup.ts';
import { RegistrationSettings } from '../registration.ts';
import { Phone } from './auth.ts';
import { defineRoute } from './contract.ts';
import { CurrencyCode, Uuid } from './primitives.ts';

// Organisation and properties (tab 4 row "Organisation"; PRD M1-02; S02 setup wizard;
// T-030). Every route acts in the property named by X-Property-Id: the organisation is that
// property's, and /properties/{propertyId} must name that same property (any other answers
// 404, like another tenant's record).

const SETUP = 'property.setup';

const PROPERTY_STATUSES = ['SETUP', 'LIVE', 'SUSPENDED', 'ARCHIVED'] as const;

const zones = new Set(Intl.supportedValuesOf('timeZone'));
const currencies = new Set(Intl.supportedValuesOf('currency'));

export const TimeZone = z
  .string()
  .refine((zone) => zones.has(zone), 'Choose a time zone from the list')
  .meta({ id: 'TimeZone', example: 'Africa/Lagos' });

const BaseCurrency = CurrencyCode.refine((code) => currencies.has(code), 'Unknown currency');

/** BCP 47 tag the browser can format with, e.g. en-NG. */
export const Locale = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Use a language and country, e.g. en-NG')
  .refine((tag) => Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0, 'Unknown locale');

/** Local time of day, 24-hour `HH:MM`. */
export const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, e.g. 14:00')
  .meta({ id: 'TimeOfDay', example: '14:00' });

const Text = (max: number) => z.string().trim().min(1).max(max);
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();

// ── Organisation ───────────────────────────────────────────────────────────────────────

export const OrganisationDetail = z
  .object({
    id: Uuid,
    name: z.string(),
    legalName: z.string().nullable(),
    /** ISO 3166 country, fixed at sign-up. */
    country: z.string(),
  })
  .meta({ id: 'Organisation' });

export const getOrganisation = defineRoute({
  operationId: 'getOrganisation',
  method: 'get',
  path: '/organisation',
  summary: 'The organisation of the current property',
  tags: ['Organisation'],
  propertyScoped: true,
  permission: SETUP,
  response: OrganisationDetail,
});

export const OrganisationPatchBody = z.object({
  name: Text(120).optional(),
  /** Registered company name for invoices; empty clears it. */
  legalName: OptionalText(200).optional(),
});

export const updateOrganisation = defineRoute({
  operationId: 'updateOrganisation',
  method: 'patch',
  path: '/organisation',
  summary: 'Change the organisation name or legal name',
  tags: ['Organisation'],
  propertyScoped: true,
  permission: SETUP,
  body: OrganisationPatchBody,
  response: OrganisationDetail,
});

// ── Properties ─────────────────────────────────────────────────────────────────────────

export const PropertyAddress = z
  .object({
    line1: z.string().nullable(),
    line2: z.string().nullable(),
    city: z.string().nullable(),
    /** State or region, e.g. Lagos. */
    state: z.string().nullable(),
    postalCode: z.string().nullable(),
    country: z.string(),
  })
  .meta({ id: 'PropertyAddress' });

export const PropertyAddressBody = z.object({
  line1: Text(200),
  line2: OptionalText(200).default(null),
  city: Text(100),
  state: Text(100),
  postalCode: OptionalText(20).default(null),
  country: z.string().regex(/^[A-Z]{2}$/, 'Two-letter country code'),
});

export const TaxRegistration = z
  .object({
    /** Tax identification number. */
    tin: z.string().nullable(),
    vatNumber: z.string().nullable(),
  })
  .meta({ id: 'TaxRegistration' });

export const TaxRegistrationBody = z.object({
  tin: OptionalText(30).default(null),
  vatNumber: OptionalText(30).default(null),
});

export const PayMethodManual = z.enum(MANUAL_PAY_METHODS).meta({ id: 'ManualPayMethod' });

export const SetupStep = z
  .object({
    id: z.enum(SETUP_STEP_IDS),
    /** LATER = its data arrives with `ticket`; it does not block go-live until then. */
    status: z.enum(['DONE', 'TODO', 'LATER']),
    required: z.boolean(),
    ticket: z.string().nullable(),
  })
  .meta({ id: 'SetupStep' });

export const SetupChecklist = z
  .object({
    steps: z.array(SetupStep),
    /** Every required step is done (or not built yet): go-live is allowed. */
    ready: z.boolean(),
  })
  .meta({ id: 'SetupChecklist' });

export const PropertyDetail = z
  .object({
    id: Uuid,
    organisationId: Uuid,
    code: z.string(),
    name: z.string(),
    status: z.enum(PROPERTY_STATUSES),
    timeZone: z.string(),
    baseCurrency: z.string(),
    locale: z.string(),
    address: PropertyAddress,
    phone: z.string().nullable(),
    email: z.string().nullable(),
    taxRegistration: TaxRegistration,
    checkInTime: z.string(),
    checkOutTime: z.string(),
    nightAuditTime: z.string(),
    paymentMethods: z.array(PayMethodManual),
    /** What to collect at check-in and how long ID details are kept (T-051). */
    registration: RegistrationSettings,
    checklist: SetupChecklist,
  })
  .meta({ id: 'Property' });

export const PropertySummary = z
  .object({ id: Uuid, code: z.string(), name: z.string(), status: z.enum(PROPERTY_STATUSES) })
  .meta({ id: 'PropertySummary' });

export const listProperties = defineRoute({
  operationId: 'listProperties',
  method: 'get',
  path: '/properties',
  summary: 'Properties of the organisation the caller can open',
  tags: ['Organisation'],
  propertyScoped: true,
  permission: SETUP,
  response: z.object({ data: z.array(PropertySummary) }),
});

const PropertyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,6}$/, 'Two to six letters or digits, e.g. LAG');

export const PropertyCreateBody = z.object({
  name: Text(120),
  /** Short code used in confirmation numbers; made from the name when left out. */
  code: PropertyCode.optional(),
});

export const createProperty = defineRoute({
  operationId: 'createProperty',
  method: 'post',
  path: '/properties',
  summary: 'Add a property to the organisation (starts in setup)',
  description:
    'The new property starts in SETUP with the organisation country defaults, the department templates and the default approval policies. Organisation-wide roles reach it at once.',
  tags: ['Organisation'],
  propertyScoped: true,
  permission: 'property.create',
  idempotent: true,
  body: PropertyCreateBody,
  status: 201,
  response: PropertyDetail,
});

const PropertyParams = z.object({ propertyId: Uuid });

export const getProperty = defineRoute({
  operationId: 'getProperty',
  method: 'get',
  path: '/properties/{propertyId}',
  summary: 'A property with its settings and setup checklist',
  tags: ['Organisation'],
  propertyScoped: true,
  permission: SETUP,
  params: PropertyParams,
  response: PropertyDetail,
});

export const PropertyPatchBody = z.object({
  name: Text(120).optional(),
  code: PropertyCode.optional(),
  address: PropertyAddressBody.optional(),
  phone: Phone.nullable().optional(),
  email: z
    .string()
    .trim()
    .max(254)
    .pipe(z.email())
    .transform((v) => v.toLowerCase())
    .nullable()
    .optional(),
  taxRegistration: TaxRegistrationBody.optional(),
  /** Can't change once the property is live. */
  timeZone: TimeZone.optional(),
  /** Can't change once the property is live. */
  baseCurrency: BaseCurrency.optional(),
  locale: Locale.optional(),
  checkInTime: TimeOfDay.optional(),
  checkOutTime: TimeOfDay.optional(),
  nightAuditTime: TimeOfDay.optional(),
  paymentMethods: z
    .array(PayMethodManual)
    .refine((m) => new Set(m).size === m.length, 'Each method once')
    .optional(),
  registration: RegistrationSettings.optional(),
});

export const updateProperty = defineRoute({
  operationId: 'updateProperty',
  method: 'patch',
  path: '/properties/{propertyId}',
  summary: 'Change property details, region, times or payment methods',
  description:
    'Time zone and base currency are fixed once the property is live (409 STATE_TRANSITION_INVALID).',
  tags: ['Organisation'],
  propertyScoped: true,
  permission: SETUP,
  params: PropertyParams,
  body: PropertyPatchBody,
  response: PropertyDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const goLiveProperty = defineRoute({
  operationId: 'goLiveProperty',
  method: 'post',
  path: '/properties/{propertyId}/go-live',
  summary: 'Open the property for bookings once its setup checklist is complete',
  description:
    'Answers 409 STATE_TRANSITION_INVALID with `details.steps` (the required steps still to do) when the checklist is not ready, or `details.status` when the property is not in SETUP.',
  tags: ['Organisation'],
  propertyScoped: true,
  permission: SETUP,
  params: PropertyParams,
  response: PropertyDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const PROPERTY_ROUTES = {
  getOrganisation,
  updateOrganisation,
  listProperties,
  createProperty,
  getProperty,
  updateProperty,
  goLiveProperty,
} as const;
