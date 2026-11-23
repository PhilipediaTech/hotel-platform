import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, Uuid } from './primitives.ts';

// Accounting exports (PRD M10-07 "As finance, I export accounting files for a period",
// accounting.export; T-148). Strategy decision 9, chosen by Philip 2026-11-23: a general
// journal CSV that QuickBooks Online, Xero and Sage import. One balanced journal per closed
// business day, built from what the PMS already records:
// - folio lines: guest ledger against each revenue code (taxes and fees are revenue codes);
//   deposits applied post to advance deposits, folio transfers stay in the guest ledger
// - payments: the method's account against the guest ledger, or against advance deposits
//   when the payment is not on a folio; a city-ledger transfer debits the city ledger
// - city-ledger receipts: the method's account against the city ledger
// - expenses: the category's account against the account it was paid from
// The hotel maps each of these to its own account codes first; an export is refused while
// something used in the period has no account, or while a day in it is still open.

/** Ways money comes in or goes out, each mapped to one account (cash box, bank, POS bank). */
export const ACCOUNTING_PAY_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'POS_TERMINAL',
  'CARD_ONLINE',
  'VIRTUAL_ACCOUNT',
  'MOBILE_MONEY',
  'VOUCHER',
  'CHEQUE',
  'CARD',
  'PETTY_CASH',
  'COMMISSION_OFFSET',
] as const;

export const ACCOUNTING_CONTROLS = ['GUEST_LEDGER', 'ADVANCE_DEPOSITS', 'CITY_LEDGER'] as const;

export const AccountingMappingKind = z.enum([
  'REVENUE_CODE',
  'PAY_METHOD',
  'EXPENSE_CATEGORY',
  'CONTROL',
]);

const AccountCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ./:-]{0,29}$/, 'Up to 30 letters, digits, spaces or . / : -');

export const AccountingMappingRow = z
  .object({
    kind: AccountingMappingKind,
    key: z.string(),
    /** What it is: a revenue code, a payment method, a category or a control account. */
    label: z.string(),
    accountCode: z.string().nullable(),
    accountName: z.string().nullable(),
  })
  .meta({ id: 'AccountingMapping' });

const PERMISSION = {
  tags: ['Accounting'],
  propertyScoped: true as const,
  permission: 'accounting.export',
};
const ADDED = 'Tab 4 names /accounting-exports; the routes are designed in T-148.';

export const getAccountingMappings = defineRoute({
  ...PERMISSION,
  operationId: 'getAccountingMappings',
  method: 'get',
  path: '/accounting-mappings',
  summary: 'Every account the journal posts to, with the hotel’s account code if set (M10-07)',
  description: ADDED,
  response: z.object({ data: z.array(AccountingMappingRow) }),
});

export const updateAccountingMappings = defineRoute({
  ...PERMISSION,
  operationId: 'updateAccountingMappings',
  method: 'put',
  path: '/accounting-mappings',
  summary: 'Set or clear account codes (M10-07)',
  description: `${ADDED} Each row names what it maps; an empty account code clears it.`,
  body: z.object({
    mappings: z
      .array(
        z.object({
          kind: AccountingMappingKind,
          key: z.string().trim().min(1).max(60),
          accountCode: AccountCode.nullable(),
          accountName: z
            .string()
            .trim()
            .max(80)
            .transform((v) => (v === '' ? null : v))
            .nullable()
            .optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
  response: z.object({ data: z.array(AccountingMappingRow) }),
});

export const AccountingExportSummary = z
  .object({
    id: Uuid,
    number: z.number().int(),
    from: IsoDate,
    to: IsoDate,
    journalCount: z.number().int(),
    lineCount: z.number().int(),
    debitTotalMinor: AmountMinor,
    sha256: z.string(),
    createdBy: z.object({ id: Uuid, name: z.string() }),
    createdAt: Instant,
  })
  .meta({ id: 'AccountingExportSummary' });

export const JournalLine = z.object({
  date: IsoDate,
  journal: z.string(),
  accountCode: z.string(),
  accountName: z.string(),
  description: z.string(),
  debitMinor: AmountMinor,
  creditMinor: AmountMinor,
});

export const AccountingExportDetail = AccountingExportSummary.extend({
  lines: z.array(JournalLine),
}).meta({ id: 'AccountingExport' });

export const listAccountingExports = defineRoute({
  ...PERMISSION,
  operationId: 'listAccountingExports',
  method: 'get',
  path: '/accounting-exports',
  summary: 'Exports so far, newest first, and the last business day that can be exported',
  description: ADDED,
  response: z.object({
    data: z.array(AccountingExportSummary),
    /** The latest closed business day: exports end on or before it. */
    lastClosedDay: IsoDate.nullable(),
  }),
});

export const createAccountingExport = defineRoute({
  ...PERMISSION,
  operationId: 'createAccountingExport',
  method: 'post',
  path: '/accounting-exports',
  summary: 'Build the general journal for a period of closed business days (M10-07)',
  description: `${ADDED} At most 93 days. Refused (400) while a day in the period is still open, or while something used in it has no account code: details.missing lists those rows. Kept exactly as built; download it as CSV.`,
  idempotent: true,
  status: 201,
  body: z
    .object({ from: IsoDate, to: IsoDate })
    .refine((b) => b.to >= b.from, { path: ['to'], message: 'Ends before it starts' }),
  response: AccountingExportDetail,
});

export const getAccountingExport = defineRoute({
  ...PERMISSION,
  operationId: 'getAccountingExport',
  method: 'get',
  path: '/accounting-exports/{exportId}',
  summary: 'An export: its journal lines, or `?format=csv` for the file (M10-07)',
  description: `${ADDED} The CSV columns: Journal, Date, Account code, Account name, Description, Debit, Credit, Reference.`,
  exports: true,
  exportPermission: 'accounting.export',
  params: z.object({ exportId: Uuid }),
  query: z.object({ format: z.enum(['json', 'csv']).default('json') }),
  response: AccountingExportDetail,
});

export const ACCOUNTING_ROUTES = {
  getAccountingMappings,
  updateAccountingMappings,
  listAccountingExports,
  createAccountingExport,
  getAccountingExport,
} as const;
