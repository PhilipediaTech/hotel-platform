import { z } from 'zod';
import { SIGN_UP_COUNTRY_CODES } from '../countries.ts';
import { PLANS, SUBSCRIPTION_STATUSES } from '../platform.ts';
import { Email, Phone } from './auth.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';

// Referral partners (PRD M14-06–M14-08; T-110). Platform staff create partners, tie hotel groups
// to them and mark payouts paid; a partner signs in to see their hotels (name, plan and status
// only) and earnings. Partners never see guest, folio or staff data.

const Currency = z.string().regex(/^[A-Z]{3}$/);

export const PartnerTotals = z.object({
  currency: Currency,
  earnedMinor: AmountMinor,
  paidMinor: AmountMinor,
  owedMinor: AmountMinor,
});

const PartnerBase = z.object({
  id: Uuid,
  name: z.string(),
  country: z.string(),
  contactName: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  commissionBps: z.number().int(),
  durationMonths: z.number().int(),
  code: z.string(),
  signUpLink: z.string(),
  active: z.boolean(),
  createdAt: Instant,
});

export const PartnerItem = PartnerBase.extend({
  hotels: z.number().int(),
  totals: z.array(PartnerTotals),
}).meta({ id: 'ReferralPartner' });

const CommissionLine = z.object({
  id: Uuid,
  hotel: z.string(),
  periodStart: IsoDate,
  commissionBps: z.number().int(),
  amountMinor: AmountMinor,
  currency: Currency,
  earnedAt: Instant,
  paid: z.boolean(),
});

const Payout = z.object({
  id: Uuid,
  amountMinor: AmountMinor,
  currency: Currency,
  reference: z.string(),
  paidAt: Instant,
});

const PartnerHotel = z.object({
  name: z.string(),
  plan: z.enum(PLANS).nullable(),
  status: z.enum(SUBSCRIPTION_STATUSES).nullable(),
});

export const PartnerDetail = PartnerItem.extend({
  /** Decrypted for platform staff only; never in a partner's own view. */
  payoutDetails: z.string().nullable(),
  hotelList: z.array(PartnerHotel.extend({ organisationId: Uuid })),
  commissions: z.array(CommissionLine),
  payouts: z.array(Payout),
}).meta({ id: 'ReferralPartnerDetail' });

export const PartnerBody = z.object({
  name: z.string().trim().min(2).max(120),
  country: z.enum(SIGN_UP_COUNTRY_CODES),
  contactName: z.string().trim().max(120).nullable().default(null),
  email: Email,
  phone: Phone.nullable().default(null),
  payoutDetails: z.string().trim().max(500).nullable().default(null),
  commissionBps: z.number().int().min(1).max(10_000),
  durationMonths: z.number().int().min(1).max(120),
});

export const PartnerPatch = z
  .object({
    name: z.string().trim().min(2).max(120),
    contactName: z.string().trim().max(120).nullable(),
    phone: Phone.nullable(),
    payoutDetails: z.string().trim().max(500).nullable(),
    commissionBps: z.number().int().min(1).max(10_000),
    durationMonths: z.number().int().min(1).max(120),
    /** Off: the code stops working; hotels already tied keep earning until their term ends. */
    active: z.boolean(),
  })
  .partial();

export const TenantPartnerBody = z.object({
  partnerId: Uuid.nullable(),
  /** Required once the hotel group has paid an invoice (M14-07). */
  reason: z.string().trim().min(5).max(500).nullable().default(null),
});

export const TenantPartner = z.object({
  partner: z.object({ id: Uuid, name: z.string() }).nullable(),
  firstPaidAt: Instant.nullable(),
});

const PLATFORM = { tags: ['Partners'], platform: true as const };
const PartnerParams = z.object({ partnerId: Uuid });

export const listPartners = defineRoute({
  ...PLATFORM,
  operationId: 'listPartners',
  method: 'get',
  path: '/platform/partners',
  summary: 'Referral partners with hotels and earnings (M14-06)',
  response: z.object({ data: z.array(PartnerItem) }),
});

export const createPartner = defineRoute({
  ...PLATFORM,
  operationId: 'createPartner',
  method: 'post',
  path: '/platform/partners',
  summary: 'Create a referral partner: code, sign-up link and sign-in (M14-06)',
  description: 'Emails the partner a link to choose a password.',
  idempotent: true,
  status: 201,
  body: PartnerBody,
  response: PartnerDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const getPartner = defineRoute({
  ...PLATFORM,
  operationId: 'getPartner',
  method: 'get',
  path: '/platform/partners/{partnerId}',
  summary: 'A referral partner: hotels, ledger and payouts',
  params: PartnerParams,
  response: PartnerDetail,
});

export const updatePartner = defineRoute({
  ...PLATFORM,
  operationId: 'updatePartner',
  method: 'patch',
  path: '/platform/partners/{partnerId}',
  summary: 'Change a partner’s details, rate or term, or retire their code',
  description: 'A new rate applies to invoices paid from now on; earned lines keep theirs.',
  params: PartnerParams,
  body: PartnerPatch,
  response: PartnerDetail,
});

export const recordPartnerPayout = defineRoute({
  ...PLATFORM,
  operationId: 'recordPartnerPayout',
  method: 'post',
  path: '/platform/partners/{partnerId}/payouts',
  summary: 'Mark everything owed in a currency as paid outside the app (M14-08)',
  description: '409 STATE_TRANSITION_INVALID when nothing is owed in that currency.',
  idempotent: true,
  status: 201,
  params: PartnerParams,
  body: z.object({ currency: Currency, reference: z.string().trim().min(2).max(120) }),
  response: PartnerDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const getTenantPartner = defineRoute({
  ...PLATFORM,
  operationId: 'getTenantPartner',
  method: 'get',
  path: '/platform/tenants/{organisationId}/partner',
  summary: 'The partner a hotel group is tied to',
  params: z.object({ organisationId: Uuid }),
  response: TenantPartner,
});

export const setTenantPartner = defineRoute({
  ...PLATFORM,
  operationId: 'setTenantPartner',
  method: 'put',
  path: '/platform/tenants/{organisationId}/partner',
  summary: 'Tie a hotel group to a partner, change it or remove it (M14-07)',
  description: 'After the first paid invoice a reason is required.',
  params: z.object({ organisationId: Uuid }),
  body: TenantPartnerBody,
  response: TenantPartner,
});

export const PartnerHome = z
  .object({
    name: z.string(),
    code: z.string(),
    signUpLink: z.string(),
    active: z.boolean(),
    commissionBps: z.number().int(),
    durationMonths: z.number().int(),
    hotels: z.array(PartnerHotel),
    totals: z.array(PartnerTotals),
    commissions: z.array(CommissionLine),
    payouts: z.array(Payout),
  })
  .meta({ id: 'PartnerHome' });

export const getPartnerHome = defineRoute({
  operationId: 'getPartnerHome',
  method: 'get',
  path: '/partner/home',
  summary: 'My hotels (name, plan, status) and earnings, for a signed-in partner (M14-08)',
  tags: ['Partners'],
  response: PartnerHome,
});

export const PARTNER_ROUTES = {
  listPartners,
  createPartner,
  getPartner,
  updatePartner,
  recordPartnerPayout,
  getTenantPartner,
  setTenantPartner,
  getPartnerHome,
} as const;
