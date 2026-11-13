import { z } from 'zod';
import { MAX_STATEMENT_LINES } from '../bank-statements.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, IsoDate, Uuid } from './primitives.ts';

// Bank reconciliation (PRD M4-23 "As finance, I import a bank statement CSV and match lines to
// transfers, POS settlements and expenses", recon.manage; S37 /reconciliation "Import CSV,
// auto-match, manual match"; tab 3 bank_statement_lines, reconciliation_matches; T-128). Tab 4
// lists no routes for it. The browser reads the CSV (@hotel/shared bank-statements.ts) and sends
// the lines. A line is matched to payments in the books (transfers, POS and card settlements,
// city-ledger receipts), with any difference given a reason (bank charges, say), or explained
// by a reason alone: an expense or a charge with no payment behind it.

export const STATEMENT_LINE_STATUSES = ['UNMATCHED', 'MATCHED'] as const;
export const RECON_MATCH_KINDS = ['PAYMENT', 'AR_PAYMENT', 'DIFFERENCE', 'EXPLAINED'] as const;

/** Payments the bank sees: not cash, vouchers or transfers to the city ledger. */
export const RECON_PAY_METHODS = [
  'BANK_TRANSFER',
  'VIRTUAL_ACCOUNT',
  'MOBILE_MONEY',
  'POS_TERMINAL',
  'CARD_ONLINE',
] as const;
/** City-ledger receipts the bank sees. */
export const RECON_AR_METHODS = ['BANK_TRANSFER', 'POS_TERMINAL', 'CHEQUE'] as const;

const NonZero = AmountMinor.refine((a) => a !== '0' && a !== '-0', 'An amount cannot be zero');
const Note = z.string().trim().min(3).max(200);

/** A payment in the books not yet found on a statement. */
export const BookEntryItem = z
  .object({
    kind: z.enum(['PAYMENT', 'AR_PAYMENT']),
    id: Uuid,
    /** Business date of a payment; received date of a city-ledger receipt. */
    date: IsoDate,
    method: z.string(),
    /** Naira, signed: refunds negative. */
    amountMinor: AmountMinor,
    reference: z.string().nullable(),
    /** The folio, booking or company it was paid by. */
    payer: z.string(),
  })
  .meta({ id: 'BookEntry' });

export const ReconciliationMatchItem = z
  .object({
    id: Uuid,
    kind: z.enum(RECON_MATCH_KINDS),
    amountMinor: AmountMinor,
    auto: z.boolean(),
    note: z.string().nullable(),
    entry: BookEntryItem.nullable(),
  })
  .meta({ id: 'ReconciliationMatch' });

export const StatementLineItem = z
  .object({
    id: Uuid,
    importId: Uuid,
    bankAccount: z.string(),
    postedOn: IsoDate,
    description: z.string(),
    reference: z.string().nullable(),
    /** Money in positive, money out negative. */
    amountMinor: AmountMinor,
    balanceMinor: AmountMinor.nullable(),
    status: z.enum(STATEMENT_LINE_STATUSES),
    matches: z.array(ReconciliationMatchItem),
  })
  .meta({ id: 'BankStatementLine' });

export const StatementLineBody = z.object({
  postedOn: IsoDate,
  description: z.string().trim().max(500).default(''),
  reference: z.string().trim().max(120).nullable().default(null),
  amountMinor: NonZero,
  balanceMinor: AmountMinor.nullable().default(null),
});

export const StatementImportBody = z.object({
  /** The hotel's own name for the account, e.g. "GTBank 0123456789". */
  bankAccount: z.string().trim().min(2).max(80),
  fileName: z.string().trim().max(200).nullable().default(null),
  lines: z.array(StatementLineBody).min(1).max(MAX_STATEMENT_LINES),
});

export const StatementImportResult = z
  .object({
    importId: Uuid,
    /** New lines. */
    imported: z.number().int(),
    /** Lines already imported from an earlier file. */
    skipped: z.number().int(),
    /** Lines auto-match then matched, old ones included. */
    autoMatched: z.number().int(),
  })
  .meta({ id: 'BankStatementImport' });

const Period = z
  .object({ from: IsoDate, to: IsoDate })
  .refine((q) => q.to >= q.from, { path: ['to'], message: 'The end is on or after the start' });

export const StatementLineQuery = z
  .object({
    from: IsoDate,
    to: IsoDate,
    status: z.enum(STATEMENT_LINE_STATUSES).optional(),
    bankAccount: z.string().trim().min(1).max(80).optional(),
  })
  .refine((q) => q.to >= q.from, { path: ['to'], message: 'The end is on or after the start' });

export const StatementLineList = z
  .object({
    data: z.array(StatementLineItem),
    summary: z.object({
      moneyInMinor: AmountMinor,
      moneyOutMinor: AmountMinor,
      unmatchedCount: z.number().int(),
      /** Signed total of the unmatched lines. */
      unmatchedMinor: AmountMinor,
    }),
    /** Accounts statements have been imported for, for the filter. */
    bankAccounts: z.array(z.string()),
  })
  .meta({ id: 'BankStatementLineList' });

export const BookEntryList = z
  .object({ data: z.array(BookEntryItem), totalMinor: AmountMinor })
  .meta({ id: 'BookEntryList' });

export const StatementLineMatchBody = z
  .object({
    paymentIds: z.array(Uuid).max(500).default([]),
    arPaymentIds: z.array(Uuid).max(100).default([]),
    /** Needed when the payments do not add up to the line: bank charges, say. */
    differenceNote: Note.nullable().default(null),
  })
  .refine((b) => b.paymentIds.length + b.arPaymentIds.length > 0, {
    path: ['paymentIds'],
    message: 'Choose at least one payment, or explain the line instead',
  });

export const StatementLineExplainBody = z.object({ note: Note });
export const StatementLineUnmatchBody = z.object({ reason: Note });

const COMMON = {
  tags: ['Reconciliation'],
  propertyScoped: true as const,
  permission: 'recon.manage',
};
const LineParams = z.object({ lineId: Uuid });

export const importBankStatement = defineRoute({
  ...COMMON,
  operationId: 'importBankStatement',
  method: 'post',
  path: '/bank-statements',
  summary: 'Import the lines of a bank statement, then auto-match (M4-23)',
  description:
    'Lines already imported (same account, date, amount, reference and narration) are skipped, so overlapping statements can be imported. Auto-match then runs on every unmatched line.',
  idempotent: true,
  body: StatementImportBody,
  status: 201,
  response: StatementImportResult,
});

export const listBankStatementLines = defineRoute({
  ...COMMON,
  operationId: 'listBankStatementLines',
  method: 'get',
  path: '/bank-statement-lines',
  summary: 'Statement lines in a period, with what matched them (M4-23)',
  query: StatementLineQuery,
  response: StatementLineList,
});

export const listBookEntries = defineRoute({
  ...COMMON,
  operationId: 'listBookEntries',
  method: 'get',
  path: '/reconciliation/book-entries',
  summary: 'Payments in the books not yet matched to a statement line (M4-23)',
  query: Period,
  response: BookEntryList,
});

export const autoMatchBankLines = defineRoute({
  ...COMMON,
  operationId: 'autoMatchBankLines',
  method: 'post',
  path: '/reconciliation/auto-match',
  summary: 'Match unmatched lines where only one answer fits (M4-23)',
  description:
    'A line matches a transfer, refund or city-ledger receipt of the same amount dated from three days before to one day after it, when only one fits (a reference on the line settles a tie); or, for money in, one day’s POS or card payments that add up to it exactly.',
  idempotent: true,
  body: z.object({}),
  response: z.object({ matched: z.number().int() }).meta({ id: 'AutoMatchResult' }),
});

export const matchBankLine = defineRoute({
  ...COMMON,
  operationId: 'matchBankLine',
  method: 'post',
  path: '/bank-statement-lines/{lineId}/match',
  summary: 'Match a line to payments in the books (M4-23)',
  description:
    'Any difference between the line and the payments needs a note and is kept as its own part of the match.',
  idempotent: true,
  params: LineParams,
  body: StatementLineMatchBody,
  response: StatementLineItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const explainBankLine = defineRoute({
  ...COMMON,
  operationId: 'explainBankLine',
  method: 'post',
  path: '/bank-statement-lines/{lineId}/explain',
  summary: 'Explain a line with no payment behind it: an expense, a bank charge (M4-23)',
  idempotent: true,
  params: LineParams,
  body: StatementLineExplainBody,
  response: StatementLineItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const unmatchBankLine = defineRoute({
  ...COMMON,
  operationId: 'unmatchBankLine',
  method: 'post',
  path: '/bank-statement-lines/{lineId}/unmatch',
  summary: 'Undo a match; the payments are free to match again (M4-23)',
  idempotent: true,
  params: LineParams,
  body: StatementLineUnmatchBody,
  response: StatementLineItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const RECONCILIATION_ROUTES = {
  importBankStatement,
  listBankStatementLines,
  listBookEntries,
  autoMatchBankLines,
  matchBankLine,
  explainBankLine,
  unmatchBankLine,
} as const;
