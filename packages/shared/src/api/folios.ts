import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';
import { REVENUE_GROUPS } from './tax.ts';

// Folios (PRD M4-01–M4-05, M4 rules 1–3; tab 4 row "Folios" and the POST /folios/{id}/lines
// and /folio-lines/{id}/reverse examples; S11; T-060). A guest folio opens at check-in, one per
// stay. Lines are append-only: a charge carries its tax lines (versions in force on the
// business date), a discount is its own line with its share of the taxes, and a correction is
// a reversal of the whole charge. Windows split who pays; routing rules send revenue there.

export const FOLIO_KINDS = ['GUEST', 'HOUSE', 'PAYMASTER', 'EVENT', 'POS'] as const;
export const FOLIO_STATUSES = ['OPEN', 'SETTLED', 'TRANSFERRED', 'CLOSED'] as const;
export const LINE_KINDS = [
  'CHARGE',
  'TAX',
  'DISCOUNT',
  'REVERSAL',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'DEPOSIT_APPLY',
  'WRITE_OFF',
] as const;
/** Windows per folio (window 1 is the guest's). */
export const MAX_FOLIO_WINDOWS = 8;

export const FolioLineItem = z
  .object({
    id: Uuid,
    windowNumber: z.number().int(),
    businessDate: IsoDate,
    postedAt: Instant,
    kind: z.enum(LINE_KINDS),
    revenueCode: z.string(),
    revenueCodeName: z.string(),
    description: z.string(),
    quantity: z.number().int(),
    unitAmountMinor: AmountMinor,
    /** Signed: discounts and reversals are negative. */
    amountMinor: AmountMinor,
    /** A tax line's charge (or discount); a discount's charge. */
    parentLineId: Uuid.nullable(),
    reversesLineId: Uuid.nullable(),
    /** Set when this line has been reversed. */
    reversedByLineId: Uuid.nullable(),
    postedBy: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .meta({ id: 'FolioLine' });

export const FolioWindowItem = z
  .object({
    number: z.number().int(),
    payerType: z.enum(['GUEST', 'COMPANY']),
    payerName: z.string(),
    /** Lines minus payments (payments arrive with T-062). */
    balanceMinor: AmountMinor,
    lines: z.array(FolioLineItem),
  })
  .meta({ id: 'FolioWindow' });

export const FolioItem = z
  .object({
    id: Uuid,
    number: z.string(),
    kind: z.enum(FOLIO_KINDS),
    status: z.enum(FOLIO_STATUSES),
    name: z.string(),
    currency: z.string(),
    reservationId: Uuid.nullable(),
    confirmationNo: z.string().nullable(),
    stay: z
      .object({
        id: Uuid,
        status: z.string(),
        roomNumber: z.string().nullable(),
        arrival: IsoDate,
        departure: IsoDate,
      })
      .nullable(),
    /** The booking's company, for a company window. */
    company: z.object({ id: Uuid, name: z.string() }).nullable(),
    windows: z.array(FolioWindowItem),
    routingRules: z.array(
      z.object({
        id: Uuid,
        revenueGroup: z.enum(REVENUE_GROUPS).nullable(),
        revenueCode: z.string().nullable(),
        windowNumber: z.number().int(),
      }),
    ),
    /** Codes a charge can be posted to (not tax codes). */
    revenueCodes: z.array(
      z.object({ code: z.string(), name: z.string(), group: z.enum(REVENUE_GROUPS) }),
    ),
    balanceMinor: AmountMinor,
    version: z.number().int(),
  })
  .meta({ id: 'Folio' });

const FolioParams = z.object({ folioId: Uuid });

export const FolioQuery = z.object({
  status: z.enum(FOLIO_STATUSES).default('OPEN'),
  /** Folio number, guest or room number. */
  q: z.string().trim().max(100).optional(),
});

export const FolioSummary = z
  .object({
    id: Uuid,
    number: z.string(),
    name: z.string(),
    status: z.enum(FOLIO_STATUSES),
    roomNumber: z.string().nullable(),
    confirmationNo: z.string().nullable(),
    balanceMinor: AmountMinor,
  })
  .meta({ id: 'FolioSummary' });

export const listFolios = defineRoute({
  operationId: 'listFolios',
  method: 'get',
  path: '/folios',
  summary: 'Folios with their balance (open ones by default)',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.read',
  query: FolioQuery,
  response: z.object({ data: z.array(FolioSummary) }),
});

export const getFolio = defineRoute({
  operationId: 'getFolio',
  method: 'get',
  path: '/folios/{folioId}',
  summary: 'A folio: windows with their lines and balances, routing rules',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.read',
  params: FolioParams,
  response: FolioItem,
});

export const openStayFolio = defineRoute({
  operationId: 'openStayFolio',
  method: 'post',
  path: '/stays/{stayId}/folio',
  summary: 'Open the folio of a checked-in stay that has none yet',
  description:
    'Check-in opens the folio; this is for guests checked in before folios existed. Answers the folio the stay already has, if any.',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.charge',
  params: z.object({ stayId: Uuid }),
  response: FolioItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const ChargeBody = z.object({
  /** Leave out to let the routing rules choose (window 1 otherwise). */
  windowNumber: z.number().int().min(1).max(MAX_FOLIO_WINDOWS).optional(),
  revenueCode: z.string().trim().min(1).max(20),
  description: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(999).default(1),
  /** Price of one, as charged (taxes added, or included when the tax is inclusive). */
  unitAmountMinor: AmountMinor,
  note: z.string().trim().max(500).nullable().default(null),
});

export const PostedLines = z
  .object({ lines: z.array(FolioLineItem), balanceMinor: AmountMinor })
  .meta({ id: 'PostedLines' });

export const postCharge = defineRoute({
  operationId: 'postCharge',
  method: 'post',
  path: '/folios/{folioId}/lines',
  summary: 'Post a charge with its taxes',
  description:
    'Taxes come from the revenue code’s tax rules, the versions in force on the business date, in their configured order, rounded per line (M4 rules 2–3), and are stored as their own lines. 409 BUSINESS_DAY_CLOSED on a closed day; 409 STATE_TRANSITION_INVALID when the folio is not open.',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.charge',
  idempotent: true,
  params: FolioParams,
  body: ChargeBody,
  status: 201,
  response: PostedLines,
  errors: ['BUSINESS_DAY_CLOSED', 'STATE_TRANSITION_INVALID'],
});

export const ReverseBody = z.object({ reason: z.string().trim().min(1).max(500) });

export const reverseLine = defineRoute({
  operationId: 'reverseLine',
  method: 'post',
  path: '/folio-lines/{lineId}/reverse',
  summary: 'Reverse a posted charge (or discount) with its taxes',
  description:
    'Adds reversal lines for the charge, its tax lines and any discount on it; nothing is deleted (M4 rule 1). Above the caller’s limit the answer is 202 and a manager approves.',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.reverse',
  idempotent: true,
  approval: true,
  params: z.object({ lineId: Uuid }),
  body: ReverseBody,
  status: 201,
  response: z
    .object({ reversalLineIds: z.array(Uuid), balanceMinor: AmountMinor })
    .meta({ id: 'ReversalResult' }),
  errors: ['BUSINESS_DAY_CLOSED', 'STATE_TRANSITION_INVALID'],
});

export const DiscountBody = z
  .object({
    /** The charge to discount. */
    lineId: Uuid,
    /** Percent of the charge with its taxes, e.g. 10 or 12.5. */
    percent: z.number().gt(0).max(100).optional(),
    /** Or an amount off the charge with its taxes. */
    amountMinor: AmountMinor.optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .refine((b) => (b.percent === undefined) !== (b.amountMinor === undefined), {
    message: 'Give a percent or an amount',
    path: ['percent'],
  });

export const addDiscount = defineRoute({
  operationId: 'addDiscount',
  method: 'post',
  path: '/folios/{folioId}/discounts',
  summary: 'Discount a charge: a separate adjustment line with a reason',
  description:
    'The discount line takes its share off the charge and off each of its taxes. Above 15% of the charge (or the caller’s limit) the answer is 202 and a manager approves (M4-04).',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.discount',
  idempotent: true,
  approval: true,
  params: FolioParams,
  body: DiscountBody,
  status: 201,
  response: PostedLines,
  errors: ['BUSINESS_DAY_CLOSED', 'STATE_TRANSITION_INVALID'],
});

export const WindowBody = z.object({
  payerType: z.enum(['GUEST', 'COMPANY']),
  /** For a company window. */
  companyId: Uuid.optional(),
});

export const addWindow = defineRoute({
  operationId: 'addWindow',
  method: 'post',
  path: '/folios/{folioId}/windows',
  summary: 'Add a window: another payer for part of the folio',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.route',
  params: FolioParams,
  body: WindowBody,
  status: 201,
  response: FolioItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const RoutingBody = z
  .object({
    revenueGroup: z.enum(REVENUE_GROUPS).optional(),
    revenueCode: z.string().trim().min(1).max(20).optional(),
    windowNumber: z.number().int().min(1).max(MAX_FOLIO_WINDOWS),
  })
  .refine((b) => (b.revenueGroup === undefined) !== (b.revenueCode === undefined), {
    message: 'Route a revenue group or one revenue code',
    path: ['revenueGroup'],
  });

export const addRoutingRule = defineRoute({
  operationId: 'addRoutingRule',
  method: 'post',
  path: '/folios/{folioId}/routing-rules',
  summary: 'Route a revenue group or code to a window (e.g. room and tax to the company)',
  description:
    'New charges of that group or code post to the window; their taxes go with them. A rule for the same group or code replaces the earlier one. Lines already posted stay where they are.',
  tags: ['Folios'],
  propertyScoped: true,
  permission: 'folio.route',
  params: FolioParams,
  body: RoutingBody,
  status: 201,
  response: FolioItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const FOLIO_ROUTES = {
  listFolios,
  getFolio,
  openStayFolio,
  postCharge,
  reverseLine,
  addDiscount,
  addWindow,
  addRoutingRule,
} as const;
