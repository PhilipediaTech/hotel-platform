import { z } from 'zod';
import {
  MODULE_CODES,
  PLANS,
  PLATFORM_INVOICE_STATUSES,
  SUBSCRIPTION_STATUSES,
  SUPPORT_SESSION_DEFAULT_MINUTES,
  SUPPORT_SESSION_MAX_MINUTES,
} from '../platform.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, PdfDocument, Uuid } from './primitives.ts';

// Platform administration (PRD M13-01–M13-05; tab 4 row "Platform": GET /platform/tenants,
// POST /platform/support-sessions, POST /platform/invoices, PATCH /platform/tenants/{id}/flags;
// S30 /settings/billing, S31 /platform; T-100). Platform routes are for platform staff only
// (PLATFORM_ADMIN_EMAILS, with MFA on); the owner's billing page is property-scoped.

const Currency = z.string().regex(/^[A-Z]{3}$/);

export const SubscriptionItem = z
  .object({
    plan: z.enum(PLANS),
    pricePerRoomMinor: AmountMinor,
    minimumMinor: AmountMinor,
    currency: Currency,
    status: z.enum(SUBSCRIPTION_STATUSES),
    currentPeriodEnd: IsoDate,
  })
  .meta({ id: 'Subscription' });

export const PlatformInvoiceItem = z
  .object({
    id: Uuid,
    number: z.string(),
    organisationId: Uuid,
    periodStart: IsoDate,
    periodEnd: IsoDate,
    activeRooms: z.number().int(),
    lines: z.array(
      z.object({ description: z.string(), quantity: z.number().int(), amountMinor: AmountMinor }),
    ),
    totalMinor: AmountMinor,
    currency: Currency,
    status: z.enum(PLATFORM_INVOICE_STATUSES),
    issuedAt: Instant,
  })
  .meta({ id: 'PlatformInvoice' });

export const SupportSessionItem = z
  .object({
    id: Uuid,
    organisationId: Uuid,
    admin: z.object({ id: Uuid, name: z.string(), email: z.string().nullable() }),
    reason: z.string(),
    startedAt: Instant,
    expiresAt: Instant,
    endedAt: Instant.nullable(),
    active: z.boolean(),
    /** Records opened during the session (each is in the hotel's audit log as SUPPORT). */
    views: z.number().int(),
  })
  .meta({ id: 'SupportSession' });

const Usage = z.object({
  /** The month so far (YYYY-MM). */
  month: z.string(),
  /** Rooms not archived (active), the billing measure (M13 rule). */
  activeRooms: z.number().int(),
  whatsappMessages: z.number().int(),
});

export const PlatformTenantItem = z
  .object({
    id: Uuid,
    name: z.string(),
    legalName: z.string().nullable(),
    country: z.string(),
    createdAt: Instant,
    properties: z.number().int(),
    subscription: SubscriptionItem.nullable(),
    usage: Usage,
    activeSupportSession: SupportSessionItem.nullable(),
  })
  .meta({ id: 'PlatformTenant' });

const PLATFORM = {
  tags: ['Platform'],
  platform: true as const,
};

export const listPlatformTenants = defineRoute({
  ...PLATFORM,
  operationId: 'listPlatformTenants',
  method: 'get',
  path: '/platform/tenants',
  summary: 'Hotel groups with plan, status and usage (M13-01)',
  response: z.object({ data: z.array(PlatformTenantItem) }),
});

export const PlatformTenantDetail = PlatformTenantItem.extend({
  flags: z.array(
    z.object({ module: z.enum(MODULE_CODES), label: z.string(), enabled: z.boolean() }),
  ),
  invoices: z.array(PlatformInvoiceItem),
  /** Every support session, newest first: the reasons are the support notes. */
  supportSessions: z.array(SupportSessionItem),
}).meta({ id: 'PlatformTenantDetail' });

export const getPlatformTenant = defineRoute({
  ...PLATFORM,
  operationId: 'getPlatformTenant',
  method: 'get',
  path: '/platform/tenants/{organisationId}',
  summary: 'A hotel group: subscription, flags, invoices, support sessions',
  params: z.object({ organisationId: Uuid }),
  response: PlatformTenantDetail,
});

export const SubscriptionBody = z.object({
  plan: z.enum(PLANS),
  pricePerRoomMinor: AmountMinor,
  minimumMinor: AmountMinor,
  currency: Currency,
  status: z.enum(SUBSCRIPTION_STATUSES),
  currentPeriodEnd: IsoDate,
});

export const setTenantSubscription = defineRoute({
  ...PLATFORM,
  operationId: 'setTenantSubscription',
  method: 'put',
  path: '/platform/tenants/{organisationId}/subscription',
  summary: 'Set a hotel group’s plan and prices (added beyond tab 4)',
  description:
    'Prices are typed per hotel group (Philip, 2026-11-14: nothing priced in code while ADR-019 is Proposed).',
  params: z.object({ organisationId: Uuid }),
  body: SubscriptionBody,
  response: SubscriptionItem,
});

export const updateTenantFlags = defineRoute({
  ...PLATFORM,
  operationId: 'updateTenantFlags',
  method: 'patch',
  path: '/platform/tenants/{organisationId}/flags',
  summary: 'Switch modules on or off for a hotel group (M13-05)',
  description: 'A module switched off answers MODULE_DISABLED on its routes.',
  params: z.object({ organisationId: Uuid }),
  body: z.object({
    flags: z
      .array(z.object({ module: z.enum(MODULE_CODES), enabled: z.boolean() }))
      .min(1)
      .max(MODULE_CODES.length),
  }),
  response: z.object({
    flags: z.array(
      z.object({ module: z.enum(MODULE_CODES), label: z.string(), enabled: z.boolean() }),
    ),
  }),
});

export const issuePlatformInvoice = defineRoute({
  ...PLATFORM,
  operationId: 'issuePlatformInvoice',
  method: 'post',
  path: '/platform/invoices',
  summary: 'Issue a hotel group’s invoice for a month (M13-03, manual in V1)',
  description:
    'Active rooms × the price per room, or the monthly minimum if more. No tax yet (Philip, ' +
    '2026-11-14). One invoice per month unless the earlier one was voided.',
  idempotent: true,
  status: 201,
  body: z.object({ organisationId: Uuid, month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
  response: PlatformInvoiceItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const updatePlatformInvoice = defineRoute({
  ...PLATFORM,
  operationId: 'updatePlatformInvoice',
  method: 'patch',
  path: '/platform/invoices/{invoiceId}',
  summary: 'Mark an invoice paid or void it (added beyond tab 4)',
  params: z.object({ invoiceId: Uuid }),
  body: z.object({ status: z.enum(['PAID', 'VOID']) }),
  response: PlatformInvoiceItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const startSupportSession = defineRoute({
  ...PLATFORM,
  operationId: 'startSupportSession',
  method: 'post',
  path: '/platform/support-sessions',
  summary: 'Open a time-limited, reason-logged, read-only support session (M13-02)',
  description:
    'For the session, the hotel group’s properties appear in the admin’s app read-only: every ' +
    'change is refused, every record opened is audited as SUPPORT, and the owner sees the session.',
  idempotent: true,
  status: 201,
  body: z.object({
    organisationId: Uuid,
    reason: z.string().trim().min(10).max(500),
    minutes: z
      .number()
      .int()
      .min(5)
      .max(SUPPORT_SESSION_MAX_MINUTES)
      .default(SUPPORT_SESSION_DEFAULT_MINUTES),
  }),
  response: SupportSessionItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const endSupportSession = defineRoute({
  ...PLATFORM,
  operationId: 'endSupportSession',
  method: 'post',
  path: '/platform/support-sessions/{sessionId}/end',
  summary: 'End a support session before it runs out',
  params: z.object({ sessionId: Uuid }),
  response: SupportSessionItem,
});

// ── The owner's billing page (M13-04; S30) ──────────────────────────────────────────────

export const getSubscription = defineRoute({
  operationId: 'getSubscription',
  method: 'get',
  path: '/subscription',
  summary: 'My plan, usage, invoices and support sessions (M13-04; added beyond tab 4)',
  tags: ['Platform'],
  propertyScoped: true,
  permission: 'subscription.read',
  response: z.object({
    organisation: z.object({ id: Uuid, name: z.string(), legalName: z.string().nullable() }),
    subscription: SubscriptionItem.nullable(),
    usage: Usage.extend({
      /** What this month would cost at today's active rooms. */
      estimateMinor: AmountMinor.nullable(),
    }),
    invoices: z.array(PlatformInvoiceItem),
    supportSessions: z.array(SupportSessionItem),
  }),
});

export const updateBillingDetails = defineRoute({
  operationId: 'updateBillingDetails',
  method: 'patch',
  path: '/subscription/billing',
  summary: 'Update the legal name invoices are made out to (M13-04; added beyond tab 4)',
  tags: ['Platform'],
  propertyScoped: true,
  permission: 'subscription.read',
  body: z.object({ legalName: z.string().trim().min(2).max(200) }),
  response: z.object({ legalName: z.string() }),
});

export const getPlatformInvoicePdf = defineRoute({
  operationId: 'getPlatformInvoicePdf',
  method: 'get',
  path: '/subscription/invoices/{invoiceId}.pdf',
  summary: 'An invoice to my hotel group, as PDF (added beyond tab 4)',
  tags: ['Platform'],
  propertyScoped: true,
  permission: 'subscription.read',
  params: z.object({ invoiceId: Uuid }),
  produces: 'application/pdf',
  response: PdfDocument,
});

export const PLATFORM_ROUTES = {
  listPlatformTenants,
  getPlatformTenant,
  setTenantSubscription,
  updateTenantFlags,
  issuePlatformInvoice,
  updatePlatformInvoice,
  startSupportSession,
  endSupportSession,
  getSubscription,
  updateBillingDetails,
  getPlatformInvoicePdf,
} as const;
