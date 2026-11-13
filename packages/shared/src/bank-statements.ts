import { parseCsv } from './imports.ts';

// Bank statement files (PRD M4-23 "As finance, I import a bank statement CSV and match lines to
// transfers, POS settlements and expenses"; S37; T-128). Banks export statements in their own
// layouts: a few lines about the account, then a header, then one row per transaction with a
// date, a narration, maybe a reference, and either credit and debit columns or one signed
// amount. The web app reads the file in the browser with these helpers, shows finance which
// column it took for what, and sends the lines; the API checks each line again.

export const STATEMENT_FIELDS = [
  'date',
  'description',
  'reference',
  'credit',
  'debit',
  'amount',
  'balance',
] as const;
export type StatementField = (typeof STATEMENT_FIELDS)[number];

/** Column index of each field in the header row; null when the file has no such column. */
export type StatementColumns = Record<StatementField, number | null>;

export const DATE_ORDERS = ['DMY', 'MDY', 'YMD'] as const;
export type DateOrder = (typeof DATE_ORDERS)[number];

/** Most lines one import takes. */
export const MAX_STATEMENT_LINES = 2000;

export interface StatementLineInput {
  postedOn: string;
  description: string;
  reference: string | null;
  /** Kobo, signed: money in is positive, money out negative. */
  amountMinor: string;
  balanceMinor: string | null;
}

export interface StatementRowError {
  /** Row in the file, the first row being 1. */
  row: number;
  message: string;
}

// Header words banks use, lower case, compared after stripping punctuation.
const HEADER_WORDS: Record<StatementField, readonly string[]> = {
  date: [
    'date',
    'trans date',
    'transaction date',
    'txn date',
    'posting date',
    'posted date',
    'tran date',
    'value date',
    'book date',
  ],
  description: [
    'description',
    'narration',
    'narrative',
    'details',
    'transaction details',
    'remarks',
    'particulars',
    'memo',
  ],
  reference: [
    'reference',
    'ref',
    'ref no',
    'reference no',
    'reference number',
    'transaction reference',
    'cheque no',
    'chq no',
    'session id',
  ],
  credit: [
    'credit',
    'credits',
    'credit amount',
    'deposit',
    'deposits',
    'money in',
    'lodgement',
    'cr',
  ],
  debit: ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'money out', 'dr'],
  amount: ['amount', 'transaction amount', 'amount ngn'],
  balance: ['balance', 'running balance', 'closing balance', 'available balance', 'ledger balance'],
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)|[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Which column holds what, by the header's words. The first value date loses to a trans date. */
export function guessStatementColumns(header: readonly string[]): StatementColumns {
  const out = Object.fromEntries(STATEMENT_FIELDS.map((f) => [f, null])) as StatementColumns;
  const cells = header.map(norm);
  for (const field of STATEMENT_FIELDS) {
    const words = HEADER_WORDS[field];
    // Earlier words in the list are better names: "trans date" before "value date".
    for (const word of words) {
      const at = cells.findIndex((c, i) => c === word && !Object.values(out).includes(i));
      if (at >= 0) {
        out[field] = at;
        break;
      }
    }
  }
  return out;
}

const usable = (c: StatementColumns) =>
  c.date !== null && (c.amount !== null || c.credit !== null || c.debit !== null);

/** The header row: the first of the first 30 with a date column and an amount column. */
export function findHeaderRow(table: readonly (readonly string[])[]): number | null {
  for (let i = 0; i < Math.min(table.length, 30); i++) {
    if (usable(guessStatementColumns(table[i] ?? []))) return i;
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoOf(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null; // 31 April
  return date.toISOString().slice(0, 10);
}

/**
 * A statement date as YYYY-MM-DD: 2026-11-05, 05/11/2026, 5-11-26, 05-Nov-2026, 05 Nov 2026,
 * Nov 5, 2026; a time after it is dropped. Numbers alone are read in `order`.
 */
export function parseStatementDate(text: string, order: DateOrder = 'DMY'): string | null {
  const s =
    text
      .trim()
      .split(/[T ](?=\d{1,2}:\d{2})/)[0]
      ?.trim() ?? '';
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/., ]+(\d{2,4})$/.exec(s);
  if (m) {
    const month = MONTHS.indexOf((m[2] ?? '').slice(0, 3).toLowerCase()) + 1;
    return month ? isoOf(Number(m[3]), month, Number(m[1])) : null;
  }
  m = /^([A-Za-z]{3,9})[-/. ](\d{1,2}),?[-/. ]+(\d{2,4})$/.exec(s);
  if (m) {
    const month = MONTHS.indexOf((m[1] ?? '').slice(0, 3).toLowerCase()) + 1;
    return month ? isoOf(Number(m[3]), month, Number(m[2])) : null;
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (order === 'MDY') return isoOf(y, a, b);
    if (order === 'DMY') return isoOf(y, b, a);
    return null;
  }
  return null;
}

/**
 * An amount in naira as kobo: "1,250,000.00", "₦5,000", "NGN 300", "(2,000.50)" and
 * "2,000.50 DR" are negative-aware. Blank is null; anything else is undefined.
 */
export function parseStatementAmount(text: string): bigint | null | undefined {
  let s = text.trim();
  if (s === '' || s === '-') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  const suffix = /\s*(cr|dr)\.?$/i.exec(s);
  if (suffix) {
    if (suffix[1]?.toLowerCase() === 'dr') negative = !negative;
    s = s.slice(0, suffix.index);
  }
  s = s.replace(/₦|ngn|n(?=\d)|[\s,]/gi, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  const m = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return undefined;
  const kobo = BigInt(m[1] ?? '0') * 100n + BigInt((m[2] ?? '0').padEnd(2, '0'));
  return negative ? -kobo : kobo;
}

export interface ReadStatementOptions {
  headerRow: number;
  columns: StatementColumns;
  dateOrder: DateOrder;
}

/**
 * The transactions in a statement table. Rows with no date (balance brought forward, totals,
 * the bank's footer) and rows with nothing in or out are skipped; a row with a date and an
 * amount that cannot be read is an error.
 */
export function readStatement(
  table: readonly (readonly string[])[],
  { headerRow, columns, dateOrder }: ReadStatementOptions,
): { lines: StatementLineInput[]; errors: StatementRowError[] } {
  const lines: StatementLineInput[] = [];
  const errors: StatementRowError[] = [];
  const cell = (row: readonly string[], field: StatementField) => {
    const at = columns[field];
    return at === null ? '' : (row[at] ?? '').trim();
  };
  for (let i = headerRow + 1; i < table.length; i++) {
    const row = table[i] ?? [];
    const rowNo = i + 1;
    const dateText = cell(row, 'date');
    if (dateText === '') continue;
    const postedOn = parseStatementDate(dateText, dateOrder);
    let amount: bigint | null = null;
    const bad: string[] = [];
    if (columns.amount !== null) {
      const a = parseStatementAmount(cell(row, 'amount'));
      if (a === undefined) bad.push('amount');
      else amount = a;
    } else {
      const credit = parseStatementAmount(cell(row, 'credit'));
      const debit = parseStatementAmount(cell(row, 'debit'));
      if (credit === undefined) bad.push('credit');
      if (debit === undefined) bad.push('debit');
      if (credit !== undefined && debit !== undefined) {
        // Debits are written positive in their own column; a sign there is kept as written.
        const out = debit === null ? 0n : debit < 0n ? -debit : debit;
        const inn = credit ?? 0n;
        amount = credit === null && debit === null ? null : inn - out;
      }
    }
    if (!postedOn) {
      // A row whose first cell is not a date is the bank's own text, unless it has money on it.
      if (amount !== null && amount !== 0n && bad.length === 0) {
        errors.push({ row: rowNo, message: `“${dateText}” is not a date` });
      }
      continue;
    }
    if (bad.length > 0) {
      errors.push({ row: rowNo, message: `The ${bad.join(' and ')} cannot be read as an amount` });
      continue;
    }
    if (amount === null || amount === 0n) continue;
    const balance = parseStatementAmount(cell(row, 'balance'));
    const description = cell(row, 'description').replace(/\s+/g, ' ').slice(0, 500);
    const reference = cell(row, 'reference').slice(0, 120);
    lines.push({
      postedOn,
      description,
      reference: reference === '' ? null : reference,
      amountMinor: amount.toString(),
      balanceMinor: balance === null || balance === undefined ? null : balance.toString(),
    });
  }
  if (lines.length > MAX_STATEMENT_LINES) {
    errors.push({
      row: headerRow + 1 + MAX_STATEMENT_LINES,
      message: `A statement can have up to ${MAX_STATEMENT_LINES} lines; split the period`,
    });
  }
  return { lines: lines.slice(0, MAX_STATEMENT_LINES), errors };
}

/** A CSV statement read in one go, with the columns guessed. Null when no header is found. */
export function readStatementCsv(text: string, dateOrder: DateOrder = 'DMY') {
  const table = parseCsv(text);
  const headerRow = findHeaderRow(table);
  if (headerRow === null) return null;
  const columns = guessStatementColumns(table[headerRow] ?? []);
  return { table, headerRow, columns, ...readStatement(table, { headerRow, columns, dateOrder }) };
}
