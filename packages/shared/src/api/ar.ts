import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, PdfDocument, Uuid } from './primitives.ts';

// City ledger (PRD M4-21 "AR accounts, transfer folios to AR, record AR payments, allocate them
// to invoices, issue statements and see ageing", ar.manage; M4 rule "AR transfer allowed only if
// the account is active and (balance + transfer) ≤ credit limit, or approval is given"; tab 3
// ar_accounts, ar_invoices, ar_payments, ar_allocations; tab 4 /ar-accounts, /ar-payments,
// /reports/ar-ageing; S "City ledger" /ar; T-126).

export const AR_ACCOUNT_STATUSES = ['ACTIVE', 'ON_HOLD', 'CLOSED'] as const;
/** How a company pays its account. Not cashier money: it is not on a shift. */
export const AR_PAY_METHODS = ['BANK_TRANSFER', 'CASH', 'POS_TERMINAL', 'CHEQUE'] as const;
/** How a payment on the account came: a method, or a commission set off against it (T-127). */
export const AR_PAYMENT_KINDS = [...AR_PAY_METHODS, 'COMMISSION_OFFSET'] as const;
export const AGEING_BUCKETS = ['current', 'd1to30', 'd31to60', 'd61to90', 'over90'] as const;

const Positive = AmountMinor.refine((v) => BigInt(v) > 0n, 'Must be more than nothing');
const NonNegative = AmountMinor.refine((v) => !v.startsWith('-'), 'Must not be negative');

export const ArAccountItem = z
  .object({
    id: Uuid,
    company: z.object({ id: Uuid, name: z.string(), kind: z.string() }),
    creditLimitMinor: AmountMinor,
    termsDays: z.number().int(),
    status: z.enum(AR_ACCOUNT_STATUSES),
    /** Invoices not yet paid, less payments not yet allocated. */
    balanceMinor: AmountMinor,
    /** The part of the open invoices past their due date. */
    overdueMinor: AmountMinor,
  })
  .meta({ id: 'ArAccount' });

export const ArInvoiceItem = z
  .object({
    id: Uuid,
    number: z.string(),
    folio: z.object({ id: Uuid, number: z.string(), name: z.string() }).nullable(),
    amountMinor: AmountMinor,
    /** What is still owed on it. */
    openMinor: AmountMinor,
    issuedOn: IsoDate,
    dueOn: IsoDate,
    status: z.enum(['OPEN', 'PAID']),
  })
  .meta({ id: 'ArInvoice' });

export const ArPaymentItem = z
  .object({
    id: Uuid,
    method: z.enum(AR_PAYMENT_KINDS),
    amountMinor: AmountMinor,
    unallocatedMinor: AmountMinor,
    reference: z.string().nullable(),
    receivedOn: IsoDate,
    note: z.string().nullable(),
    allocations: z.array(z.object({ invoiceNumber: z.string(), amountMinor: AmountMinor })),
  })
  .meta({ id: 'ArPayment' });

export const ArAccountDetail = ArAccountItem.extend({
  invoices: z.array(ArInvoiceItem),
  payments: z.array(ArPaymentItem),
}).meta({ id: 'ArAccountDetail' });

export const ArAccountBody = z.object({
  companyId: Uuid,
  /** What the company may owe at once; above it a transfer needs approval. */
  creditLimitMinor: NonNegative,
  termsDays: z.number().int().min(0).max(365).default(30),
});

export const ArAccountUpdateBody = z.object({
  creditLimitMinor: NonNegative,
  termsDays: z.number().int().min(0).max(365),
  status: z.enum(AR_ACCOUNT_STATUSES),
});

export const ArTransferBody = z.object({
  folioId: Uuid,
  windowNumber: z.number().int().min(1).max(9).default(1),
  /** Defaults to everything the window owes. */
  amountMinor: Positive.optional(),
  /** Needed when the transfer takes the account over its limit (it then goes to a manager). */
  reason: z.string().trim().max(500).default(''),
});

export const ArTransferResult = z
  .object({ invoice: ArInvoiceItem, account: ArAccountItem })
  .meta({ id: 'ArTransferResult' });

export const ArPaymentBody = z.object({
  method: z.enum(AR_PAY_METHODS),
  amountMinor: Positive,
  reference: z.string().trim().max(80).nullable().default(null),
  receivedOn: IsoDate,
  note: z.string().trim().max(500).nullable().default(null),
  /** Allocate to the oldest open invoices at once (the usual case). */
  allocate: z.boolean().default(true),
});

export const ArAllocateBody = z.object({
  /** Leave out to allocate to the oldest open invoices first. */
  allocations: z
    .array(z.object({ invoiceId: Uuid, amountMinor: Positive }))
    .min(1)
    .max(100)
    .optional(),
});

export const ArStatementQuery = z
  .object({ from: IsoDate, to: IsoDate })
  .refine((q) => q.to >= q.from, { path: ['to'], message: 'The end is on or after the start' });

export const ArStatement = z
  .object({
    account: ArAccountItem,
    from: IsoDate,
    to: IsoDate,
    openingMinor: AmountMinor,
    lines: z.array(
      z.object({
        date: IsoDate,
        kind: z.enum(['INVOICE', 'PAYMENT']),
        reference: z.string(),
        description: z.string(),
        amountMinor: AmountMinor,
        balanceMinor: AmountMinor,
      }),
    ),
    closingMinor: AmountMinor,
  })
  .meta({ id: 'ArStatement' });

const Buckets = z.object(
  Object.fromEntries(AGEING_BUCKETS.map((b) => [b, AmountMinor])) as Record<
    (typeof AGEING_BUCKETS)[number],
    typeof AmountMinor
  >,
);

export const ArAgeing = z
  .object({
    asOf: IsoDate,
    totals: Buckets.extend({ totalMinor: AmountMinor }),
    accounts: z.array(
      z.object({
        accountId: Uuid,
        company: z.string(),
        buckets: Buckets,
        totalMinor: AmountMinor,
      }),
    ),
  })
  .meta({ id: 'ArAgeing' });

const COMMON = { tags: ['City ledger'], propertyScoped: true as const, permission: 'ar.manage' };
const Params = z.object({ accountId: Uuid });

export const listArAccounts = defineRoute({
  ...COMMON,
  operationId: 'listArAccounts',
  method: 'get',
  path: '/ar-accounts',
  summary: 'Company accounts with what each owes (M4-21)',
  response: z.object({ data: z.array(ArAccountItem) }),
});

export const createArAccount = defineRoute({
  ...COMMON,
  operationId: 'createArAccount',
  method: 'post',
  path: '/ar-accounts',
  summary: 'Open a company or travel agent account (M4-21)',
  status: 201,
  body: ArAccountBody,
  response: ArAccountItem,
});

export const getArAccount = defineRoute({
  ...COMMON,
  operationId: 'getArAccount',
  method: 'get',
  path: '/ar-accounts/{accountId}',
  summary: 'An account with its invoices and payments',
  params: Params,
  response: ArAccountDetail,
});

export const updateArAccount = defineRoute({
  ...COMMON,
  operationId: 'updateArAccount',
  method: 'put',
  path: '/ar-accounts/{accountId}',
  summary: 'Change an account’s credit limit, terms or status (added beyond tab 4)',
  params: Params,
  body: ArAccountUpdateBody,
  response: ArAccountItem,
});

export const transferToAr = defineRoute({
  ...COMMON,
  operationId: 'transferToAr',
  method: 'post',
  path: '/ar-accounts/{accountId}/transfers',
  summary: 'Move what a folio window owes to the company’s account (M4-21)',
  description:
    'Settles the window with an AR_TRANSFER payment and raises an invoice on the account, due after its terms. Over the credit limit (M4 rule) the answer is 202 and a manager approves (ar.over_limit). Added beyond tab 4’s list.',
  idempotent: true,
  approval: true,
  status: 201,
  params: Params,
  body: ArTransferBody,
  response: ArTransferResult,
  errors: ['STATE_TRANSITION_INVALID', 'BUSINESS_DAY_CLOSED', 'AUDIT_IN_PROGRESS'],
});

export const recordArPayment = defineRoute({
  ...COMMON,
  operationId: 'recordArPayment',
  method: 'post',
  path: '/ar-accounts/{accountId}/payments',
  summary: 'Record a payment from the company (M4-21)',
  idempotent: true,
  status: 201,
  params: Params,
  body: ArPaymentBody,
  response: ArAccountDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const allocateArPayment = defineRoute({
  ...COMMON,
  operationId: 'allocateArPayment',
  method: 'post',
  path: '/ar-payments/{paymentId}/allocate',
  summary: 'Allocate a payment to invoices, or to the oldest first (M4-21)',
  params: z.object({ paymentId: Uuid }),
  body: ArAllocateBody,
  response: ArAccountDetail,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const getArStatement = defineRoute({
  ...COMMON,
  operationId: 'getArStatement',
  method: 'get',
  path: '/ar-accounts/{accountId}/statement',
  summary: 'The account’s statement for a period (M4-21)',
  params: Params,
  query: ArStatementQuery,
  response: ArStatement,
});

export const getArStatementPdf = defineRoute({
  ...COMMON,
  operationId: 'getArStatementPdf',
  method: 'get',
  path: '/ar-accounts/{accountId}/statement.pdf',
  summary: 'The statement as PDF',
  produces: 'application/pdf',
  params: Params,
  query: ArStatementQuery,
  response: PdfDocument,
});

export const sendArStatement = defineRoute({
  ...COMMON,
  operationId: 'sendArStatement',
  method: 'post',
  path: '/ar-accounts/{accountId}/statement/send',
  summary: 'Email the statement to the company’s invoice address (added beyond tab 4)',
  params: Params,
  body: z.object({ from: IsoDate, to: IsoDate }),
  response: z.object({ sentTo: z.string(), sentAt: Instant }),
  errors: ['STATE_TRANSITION_INVALID'],
});

export const getArAgeing = defineRoute({
  ...COMMON,
  operationId: 'getArAgeing',
  method: 'get',
  path: '/reports/ar-ageing',
  summary: 'What each account owes, by how long it is overdue (M4-21, M12)',
  query: z.object({ asOf: IsoDate.optional() }),
  response: ArAgeing,
});

export const AR_ROUTES = {
  listArAccounts,
  createArAccount,
  getArAccount,
  updateArAccount,
  transferToAr,
  recordArPayment,
  allocateArPayment,
  getArStatement,
  getArStatementPdf,
  sendArStatement,
  getArAgeing,
} as const;
