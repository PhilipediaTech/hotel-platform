// Spreadsheet imports (PRD M1-03; S03; T-034): the template columns of each kind and the
// cell checks shared by the API (which checks uploaded files) and the web app (which builds
// the templates). Checks that need the database (codes that exist, rooms already there) are
// in the API. Rows are numbered as in the spreadsheet: the header is row 1.

/**
 * Rooms and rates (T-034); guests, companies and their opening balances (T-168); future
 * reservations from the old system (T-169).
 */
export const IMPORT_KINDS = [
  'ROOMS',
  'RATES',
  'GUESTS',
  'COMPANIES',
  'BALANCES',
  'RESERVATIONS',
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** Longest file we check in one go. */
export const MAX_IMPORT_ROWS = 5000;
/** Errors listed in a report; the count is always complete. */
export const MAX_REPORTED_ERRORS = 200;

export interface ImportColumn {
  name: string;
  required: boolean;
  /** Two example values for the template. */
  examples: [string, string];
}

export const IMPORT_COLUMNS: Record<ImportKind, readonly ImportColumn[]> = {
  ROOMS: [
    { name: 'room_number', required: true, examples: ['101', '201'] },
    { name: 'room_type_code', required: true, examples: ['STD', 'DLX'] },
    { name: 'room_type_name', required: false, examples: ['Standard', 'Deluxe'] },
    { name: 'base_occupancy', required: false, examples: ['2', '2'] },
    { name: 'max_occupancy', required: false, examples: ['2', '3'] },
    { name: 'floor', required: false, examples: ['1', '2'] },
    { name: 'building', required: false, examples: ['', 'Garden wing'] },
    { name: 'features', required: false, examples: ['', 'Balcony; Sea view'] },
  ],
  RATES: [
    { name: 'rate_plan_code', required: true, examples: ['BAR', 'BAR'] },
    { name: 'room_type_code', required: true, examples: ['STD', 'DLX'] },
    { name: 'from', required: true, examples: ['2026-12-01', '2026-12-01'] },
    { name: 'to', required: true, examples: ['2026-12-31', '2026-12-31'] },
    { name: 'price', required: false, examples: ['45000', '65000'] },
    { name: 'min_stay', required: false, examples: ['', '2'] },
    { name: 'max_stay', required: false, examples: ['', ''] },
    { name: 'closed_to_arrival', required: false, examples: ['', 'no'] },
    { name: 'closed_to_departure', required: false, examples: ['', ''] },
    { name: 'stop_sell', required: false, examples: ['', ''] },
  ],
  GUESTS: [
    { name: 'first_name', required: true, examples: ['Ada', 'Tunde'] },
    { name: 'last_name', required: true, examples: ['Obi', 'Bakare'] },
    { name: 'email', required: false, examples: ['ada@example.com', ''] },
    { name: 'phone', required: false, examples: ['08031234567', '+2348098765432'] },
    { name: 'nationality', required: false, examples: ['NG', 'GH'] },
    { name: 'notes', required: false, examples: ['Prefers a high floor', ''] },
    { name: 'tags', required: false, examples: ['Repeat; Business', ''] },
    { name: 'marketing_consent', required: false, examples: ['yes', 'no'] },
    { name: 'vip', required: false, examples: ['', 'yes'] },
  ],
  COMPANIES: [
    { name: 'name', required: true, examples: ['Dangote Group', 'Wakanow'] },
    { name: 'kind', required: false, examples: ['company', 'travel agent'] },
    { name: 'tax_id', required: false, examples: ['12345678-0001', ''] },
    { name: 'contact_name', required: false, examples: ['Bola Ade', 'Kemi Ojo'] },
    { name: 'contact_phone', required: false, examples: ['08031234567', ''] },
    { name: 'contact_email', required: false, examples: ['bola@example.com', 'kemi@example.com'] },
    { name: 'invoice_email', required: false, examples: ['accounts@example.com', ''] },
    { name: 'credit_limit', required: false, examples: ['2000000', ''] },
    { name: 'payment_terms_days', required: false, examples: ['30', ''] },
    { name: 'commission_percent', required: false, examples: ['', '10'] },
  ],
  BALANCES: [
    { name: 'company_name', required: true, examples: ['Dangote Group', 'Dangote Group'] },
    { name: 'reference', required: true, examples: ['INV-2041', 'INV-2077'] },
    { name: 'amount', required: true, examples: ['450000', '1,250,000.50'] },
    { name: 'issued_on', required: false, examples: ['2026-10-15', '01/11/2026'] },
    { name: 'due_on', required: false, examples: ['2026-11-14', ''] },
  ],
  RESERVATIONS: [
    { name: 'old_confirmation_no', required: true, examples: ['R-4471', 'R-4471'] },
    { name: 'arrival', required: true, examples: ['2026-12-20', '2026-12-20'] },
    { name: 'departure', required: true, examples: ['2026-12-23', '2026-12-22'] },
    { name: 'room_type_code', required: true, examples: ['STD', 'DLX'] },
    { name: 'nightly_rate', required: true, examples: ['45000', '65000'] },
    { name: 'first_name', required: true, examples: ['Ada', 'Tunde'] },
    { name: 'last_name', required: true, examples: ['Obi', 'Bakare'] },
    { name: 'email', required: false, examples: ['ada@example.com', ''] },
    { name: 'phone', required: false, examples: ['08031234567', ''] },
    { name: 'adults', required: false, examples: ['2', '1'] },
    { name: 'children', required: false, examples: ['', ''] },
    { name: 'rate_plan_code', required: false, examples: ['', 'BAR'] },
    { name: 'company_name', required: false, examples: ['', ''] },
    { name: 'source', required: false, examples: ['phone', 'phone'] },
    { name: 'notes', required: false, examples: ['Late arrival', ''] },
  ],
};

export interface ImportError {
  /** Spreadsheet row (header = 1); null for problems with the whole file. */
  row: number | null;
  column: string | null;
  message: string;
}

export interface RoomRow {
  row: number;
  roomNumber: string;
  roomTypeCode: string;
  roomTypeName: string | null;
  baseOccupancy: number | null;
  maxOccupancy: number | null;
  floor: string | null;
  building: string | null;
  features: string[];
}

export interface RateRow {
  row: number;
  ratePlanCode: string;
  roomTypeCode: string;
  from: string;
  to: string;
  /** Kobo; undefined = leave the price; null never comes from a file. */
  amountMinor?: string;
  minStay?: number;
  maxStay?: number;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
}

export interface GuestRow {
  row: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  notes: string | null;
  tags: string[];
  marketingConsent: boolean;
  vip: boolean;
}

export interface CompanyRow {
  row: number;
  name: string;
  kind: 'COMPANY' | 'TRAVEL_AGENT';
  taxId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  invoiceEmail: string | null;
  creditLimitMinor: string | null;
  paymentTermsDays: number | null;
  commissionBps: number | null;
}

/** What a company owed at go-live: one open invoice from the old system. */
export interface BalanceRow {
  row: number;
  companyName: string;
  reference: string;
  amountMinor: string;
  /** Null: the day of the import. */
  issuedOn: string | null;
  /** Null: issued on plus the account's terms. */
  dueOn: string | null;
}

/**
 * One room of a booking still to come, from the old system (T-169). Rows with the same old
 * confirmation number are one booking with several rooms; its first row gives the booker,
 * company, source and notes.
 */
export interface ReservationRow {
  row: number;
  oldConfirmationNo: string;
  arrival: string;
  departure: string;
  roomTypeCode: string;
  /** Kobo, charged every night: the price the old system agreed. */
  nightlyRateMinor: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  adults: number;
  children: number;
  /** Null: the property's best available rate plan. */
  ratePlanCode: string | null;
  companyName: string | null;
  /** Null: corporate or travel agent with a company, else direct. */
  source:
    | 'WALK_IN'
    | 'PHONE'
    | 'EMAIL'
    | 'WHATSAPP'
    | 'DIRECT'
    | 'OTA_MANUAL'
    | 'CORPORATE'
    | 'TRAVEL_AGENT'
    | null;
  notes: string | null;
}

/** Longest stay a reservation row may describe. */
export const MAX_IMPORT_NIGHTS = 365;

export type ImportRow = RoomRow | RateRow | GuestRow | CompanyRow | BalanceRow | ReservationRow;
type AnyRow = ImportRow;

/** "Room Number " → "room_number". */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** The template as CSV (opens in Excel): header and two example rows. */
export function templateCsv(kind: ImportKind): string {
  const columns = IMPORT_COLUMNS[kind];
  const quote = (v: string) => (/[",\n;]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = [
    columns.map((c) => c.name),
    columns.map((c) => c.examples[0]),
    columns.map((c) => c.examples[1]),
  ];
  return `${lines.map((l) => l.map(quote).join(',')).join('\r\n')}\r\n`;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF; a leading BOM is dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ── Cell parsers ───────────────────────────────────────────────────────────────────────

type Cell = { ok: true; value: string | number | boolean | null } | { ok: false; message: string };

const ok = (value: string | number | boolean | null): Cell => ({ ok: true, value });
const bad = (message: string): Cell => ({ ok: false, message });

function intCell(text: string, min: number, max: number): Cell {
  if (text === '') return ok(null);
  if (!/^\d+$/.test(text)) return bad('Use a whole number');
  const n = Number(text);
  return n < min || n > max ? bad(`Use ${min} to ${max}`) : ok(n);
}

/** "₦45,000.50" → "4500050" kobo. */
function moneyCell(text: string): Cell {
  if (text === '') return ok(null);
  const clean = text.replace(/[₦,\s]/g, '').replace(/^NGN/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return bad('Use an amount like 45000 or 45,000.50');
  const [whole = '0', fraction = ''] = clean.split('.');
  return ok(String(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))));
}

/** YYYY-MM-DD, or DD/MM/YYYY as written in Nigeria (day first). */
function dateCell(text: string): Cell {
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const dmy = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else return bad('Use a date like 2026-12-01 or 01/12/2026');
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return bad('Not a real date');
  }
  return ok(date.toISOString().slice(0, 10));
}

function yesNoCell(text: string): Cell {
  const t = text.toLowerCase();
  if (t === '') return ok(null);
  if (['yes', 'y', 'true', '1', 'x'].includes(t)) return ok(true);
  if (['no', 'n', 'false', '0'].includes(t)) return ok(false);
  return bad('Use yes or no');
}

/** E.164; a Nigerian number written locally (0803 123 4567) is taken as +234 803 123 4567. */
function phoneCell(text: string): Cell {
  if (text === '') return ok(null);
  const digits = text.replace(/[\s().-]/g, '');
  const e164 = /^0\d{10}$/.test(digits)
    ? `+234${digits.slice(1)}`
    : /^234\d{10}$/.test(digits)
      ? `+${digits}`
      : digits;
  return /^\+[1-9]\d{6,14}$/.test(e164)
    ? ok(e164)
    : bad('Use a phone number like 08031234567 or +2348031234567');
}

function emailCell(text: string): Cell {
  if (text === '') return ok(null);
  const email = text.toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? ok(email)
    : bad('Not an email address');
}

/** "10" or "10%" → 1000 basis points. */
function percentCell(text: string, max: number): Cell {
  if (text === '') return ok(null);
  const clean = text.replace(/[%\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return bad('Use a percentage like 10 or 12.5');
  const bps = Math.round(Number(clean) * 100);
  return bps > max * 100 ? bad(`At most ${max}%`) : ok(bps);
}

const listOf = (text: string) =>
  text
    .split(/[;|]/)
    .map((f) => f.trim())
    .filter(Boolean);

const SOURCE_WORDS: Record<string, NonNullable<ReservationRow['source']>> = {
  'walk in': 'WALK_IN',
  walkin: 'WALK_IN',
  phone: 'PHONE',
  telephone: 'PHONE',
  call: 'PHONE',
  email: 'EMAIL',
  'e mail': 'EMAIL',
  whatsapp: 'WHATSAPP',
  direct: 'DIRECT',
  website: 'DIRECT',
  web: 'DIRECT',
  ota: 'OTA_MANUAL',
  'booking com': 'OTA_MANUAL',
  expedia: 'OTA_MANUAL',
  'hotels ng': 'OTA_MANUAL',
  jumia: 'OTA_MANUAL',
  corporate: 'CORPORATE',
  company: 'CORPORATE',
  'travel agent': 'TRAVEL_AGENT',
  agent: 'TRAVEL_AGENT',
};

function sourceCell(text: string): Cell {
  if (text === '') return ok(null);
  const word = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return word in SOURCE_WORDS
    ? ok(SOURCE_WORDS[word] as string)
    : bad('Use walk-in, phone, email, whatsapp, direct, ota, corporate or travel agent');
}

function codeCell(text: string, pattern: RegExp, hint: string): Cell {
  const code = text.toUpperCase();
  return pattern.test(code) ? ok(code) : bad(hint);
}

// ── Sheets ─────────────────────────────────────────────────────────────────────────────

export interface ParsedSheet<R> {
  rows: R[];
  errors: ImportError[];
  /** Data rows read (blank rows skipped). */
  total: number;
}

/**
 * Checks a sheet (header row first, cells already turned to text) against the kind's columns:
 * required columns present, each cell in the right format. Unknown columns are ignored.
 */
export function parseSheet(
  kind: 'ROOMS',
  table: readonly (readonly string[])[],
): ParsedSheet<RoomRow>;
export function parseSheet(
  kind: 'RATES',
  table: readonly (readonly string[])[],
): ParsedSheet<RateRow>;
export function parseSheet(
  kind: 'GUESTS',
  table: readonly (readonly string[])[],
): ParsedSheet<GuestRow>;
export function parseSheet(
  kind: 'COMPANIES',
  table: readonly (readonly string[])[],
): ParsedSheet<CompanyRow>;
export function parseSheet(
  kind: 'BALANCES',
  table: readonly (readonly string[])[],
): ParsedSheet<BalanceRow>;
export function parseSheet(
  kind: 'RESERVATIONS',
  table: readonly (readonly string[])[],
): ParsedSheet<ReservationRow>;
export function parseSheet(
  kind: ImportKind,
  table: readonly (readonly string[])[],
): ParsedSheet<AnyRow>;
export function parseSheet(
  kind: ImportKind,
  table: readonly (readonly string[])[],
): ParsedSheet<AnyRow> {
  const errors: ImportError[] = [];
  const [header = [], ...body] = table;
  const index = new Map(header.map((h, i) => [normalizeHeader(h), i]));
  const missing = IMPORT_COLUMNS[kind].filter((c) => c.required && !index.has(c.name));
  if (missing.length > 0) {
    return {
      rows: [],
      total: 0,
      errors: missing.map((c) => ({ row: 1, column: c.name, message: 'Missing column' })),
    };
  }
  const data = body
    .map((cells, i) => ({ row: i + 2, cells: cells.map((c) => c.trim()) }))
    .filter((r) => r.cells.some((c) => c !== ''));
  if (data.length > MAX_IMPORT_ROWS) {
    return {
      rows: [],
      total: data.length,
      errors: [{ row: null, column: null, message: `At most ${MAX_IMPORT_ROWS} rows per file` }],
    };
  }

  const rows: AnyRow[] = [];
  for (const { row, cells } of data) {
    const cell = (name: string) => cells[index.get(name) ?? -1] ?? '';
    const values = new Map<string, string | number | boolean | null>();
    let rowOk = true;
    const take = (name: string, result: Cell, required = false) => {
      if (!result.ok) {
        errors.push({ row, column: name, message: result.message });
        rowOk = false;
      } else if (required && (result.value === null || result.value === '')) {
        errors.push({ row, column: name, message: 'Required' });
        rowOk = false;
      } else values.set(name, result.value);
    };
    /** An empty required cell says "Required"; otherwise the parser decides. */
    const req = (name: string, parse: (text: string) => Cell) =>
      take(name, cell(name) === '' ? ok(null) : parse(cell(name)), true);
    const text = (name: string, max: number, required = false) => {
      const v = cell(name);
      take(
        name,
        v.length > max ? bad(`At most ${max} characters`) : ok(v === '' ? null : v),
        required,
      );
    };

    if (kind === 'ROOMS') {
      req('room_number', (t) =>
        codeCell(t, /^[A-Z0-9-]{1,10}$/, 'Letters, digits and dashes, e.g. 101'),
      );
      req('room_type_code', (t) =>
        codeCell(t, /^[A-Z0-9-]{2,10}$/, 'Two to ten letters, digits or dashes, e.g. DLX'),
      );
      text('room_type_name', 80);
      take('base_occupancy', intCell(cell('base_occupancy'), 1, 20));
      take('max_occupancy', intCell(cell('max_occupancy'), 1, 20));
      text('floor', 20);
      text('building', 60);
      const features = cell('features')
        .split(/[;|]/)
        .map((f) => f.trim())
        .filter(Boolean);
      if (features.some((f) => f.length > 60) || features.length > 40) {
        take('features', bad('At most 40 features of 60 characters'));
      }
      const base = values.get('base_occupancy') as number | null;
      const max = values.get('max_occupancy') as number | null;
      if (rowOk && base !== null && max !== null && base > max) {
        take('max_occupancy', bad('Must be at least the base occupancy'));
      }
      if (rowOk) {
        rows.push({
          row,
          roomNumber: values.get('room_number') as string,
          roomTypeCode: values.get('room_type_code') as string,
          roomTypeName: (values.get('room_type_name') as string | null) ?? null,
          baseOccupancy: base,
          maxOccupancy: max,
          floor: (values.get('floor') as string | null) ?? null,
          building: (values.get('building') as string | null) ?? null,
          features,
        });
      }
    } else if (kind === 'RATES') {
      req('rate_plan_code', (t) => codeCell(t, /^[A-Z0-9_-]{2,12}$/, 'A rate plan code, e.g. BAR'));
      req('room_type_code', (t) => codeCell(t, /^[A-Z0-9-]{2,10}$/, 'A room type code, e.g. DLX'));
      req('from', dateCell);
      req('to', dateCell);
      take('price', moneyCell(cell('price')));
      take('min_stay', intCell(cell('min_stay'), 1, 365));
      take('max_stay', intCell(cell('max_stay'), 1, 365));
      take('closed_to_arrival', yesNoCell(cell('closed_to_arrival')));
      take('closed_to_departure', yesNoCell(cell('closed_to_departure')));
      take('stop_sell', yesNoCell(cell('stop_sell')));
      const from = values.get('from') as string | undefined;
      const to = values.get('to') as string | undefined;
      if (rowOk && from && to && to < from) take('to', bad('End on or after the start'));
      const min = values.get('min_stay') as number | null;
      const max = values.get('max_stay') as number | null;
      if (rowOk && min !== null && max !== null && max < min) {
        take('max_stay', bad('Must be at least the minimum stay'));
      }
      const optional = <T>(name: string) => {
        const v = values.get(name);
        return v === null || v === undefined ? undefined : (v as T);
      };
      const rate: RateRow = {
        row,
        ratePlanCode: values.get('rate_plan_code') as string,
        roomTypeCode: values.get('room_type_code') as string,
        from: from ?? '',
        to: to ?? '',
      };
      const set = {
        amountMinor: optional<string>('price'),
        minStay: optional<number>('min_stay'),
        maxStay: optional<number>('max_stay'),
        closedToArrival: optional<boolean>('closed_to_arrival'),
        closedToDeparture: optional<boolean>('closed_to_departure'),
        stopSell: optional<boolean>('stop_sell'),
      };
      for (const [k, v] of Object.entries(set)) {
        if (v !== undefined) (rate as unknown as Record<string, unknown>)[k] = v;
      }
      if (rowOk && Object.keys(rate).length === 5) {
        take('price', bad('Give a price or at least one restriction'));
      }
      if (rowOk) rows.push(rate);
    } else if (kind === 'GUESTS') {
      text('first_name', 80, true);
      text('last_name', 80, true);
      take('email', emailCell(cell('email')));
      take('phone', phoneCell(cell('phone')));
      take(
        'nationality',
        cell('nationality') === ''
          ? ok(null)
          : codeCell(cell('nationality'), /^[A-Z]{2}$/, 'A two-letter country code, e.g. NG'),
      );
      text('notes', 1000);
      const tags = listOf(cell('tags'));
      if (tags.some((tag) => tag.length > 40) || tags.length > 20) {
        take('tags', bad('At most 20 tags of 40 characters'));
      }
      take('marketing_consent', yesNoCell(cell('marketing_consent')));
      take('vip', yesNoCell(cell('vip')));
      if (rowOk) {
        rows.push({
          row,
          firstName: values.get('first_name') as string,
          lastName: values.get('last_name') as string,
          email: values.get('email') as string | null,
          phone: values.get('phone') as string | null,
          nationality: values.get('nationality') as string | null,
          notes: values.get('notes') as string | null,
          tags,
          marketingConsent: values.get('marketing_consent') === true,
          vip: values.get('vip') === true,
        });
      }
    } else if (kind === 'COMPANIES') {
      text('name', 160, true);
      const kindText = cell('kind')
        .toLowerCase()
        .replace(/[\s_-]+/g, ' ');
      take(
        'kind',
        ['', 'company', 'corporate'].includes(kindText)
          ? ok('COMPANY')
          : ['travel agent', 'agent', 'agency', 'ta'].includes(kindText)
            ? ok('TRAVEL_AGENT')
            : bad('Use company or travel agent'),
      );
      text('tax_id', 30);
      text('contact_name', 80);
      take('contact_phone', phoneCell(cell('contact_phone')));
      take('contact_email', emailCell(cell('contact_email')));
      take('invoice_email', emailCell(cell('invoice_email')));
      take('credit_limit', moneyCell(cell('credit_limit')));
      take('payment_terms_days', intCell(cell('payment_terms_days'), 0, 365));
      take('commission_percent', percentCell(cell('commission_percent'), 50));
      const contact = ['contact_phone', 'contact_email'].some((c) => values.get(c));
      if (rowOk && contact && !values.get('contact_name')) {
        take('contact_name', bad('Give the contact’s name with their phone or email'));
      }
      if (rowOk) {
        rows.push({
          row,
          name: values.get('name') as string,
          kind: values.get('kind') as CompanyRow['kind'],
          taxId: values.get('tax_id') as string | null,
          contactName: values.get('contact_name') as string | null,
          contactPhone: values.get('contact_phone') as string | null,
          contactEmail: values.get('contact_email') as string | null,
          invoiceEmail: values.get('invoice_email') as string | null,
          creditLimitMinor: values.get('credit_limit') as string | null,
          paymentTermsDays: values.get('payment_terms_days') as number | null,
          commissionBps: values.get('commission_percent') as number | null,
        });
      }
    } else if (kind === 'RESERVATIONS') {
      text('old_confirmation_no', 40, true);
      req('arrival', dateCell);
      req('departure', dateCell);
      req('room_type_code', (t) => codeCell(t, /^[A-Z0-9-]{2,10}$/, 'A room type code, e.g. DLX'));
      req('nightly_rate', moneyCell);
      text('first_name', 80, true);
      text('last_name', 80, true);
      take('email', emailCell(cell('email')));
      take('phone', phoneCell(cell('phone')));
      take('adults', intCell(cell('adults'), 1, 20));
      take('children', intCell(cell('children'), 0, 20));
      take(
        'rate_plan_code',
        cell('rate_plan_code') === ''
          ? ok(null)
          : codeCell(cell('rate_plan_code'), /^[A-Z0-9_-]{2,12}$/, 'A rate plan code, e.g. BAR'),
      );
      text('company_name', 160);
      take('source', sourceCell(cell('source')));
      text('notes', 1000);
      const arrival = values.get('arrival') as string | undefined;
      const departure = values.get('departure') as string | undefined;
      if (arrival && departure) {
        const nights = Math.round(
          (Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86_400_000,
        );
        if (nights < 1) take('departure', bad('Leave at least one night after the arrival'));
        else if (nights > MAX_IMPORT_NIGHTS) {
          take('departure', bad(`At most ${MAX_IMPORT_NIGHTS} nights`));
        }
      }
      if (rowOk) {
        rows.push({
          row,
          oldConfirmationNo: values.get('old_confirmation_no') as string,
          arrival: arrival ?? '',
          departure: departure ?? '',
          roomTypeCode: values.get('room_type_code') as string,
          nightlyRateMinor: values.get('nightly_rate') as string,
          firstName: values.get('first_name') as string,
          lastName: values.get('last_name') as string,
          email: values.get('email') as string | null,
          phone: values.get('phone') as string | null,
          adults: (values.get('adults') as number | null) ?? 1,
          children: (values.get('children') as number | null) ?? 0,
          ratePlanCode: values.get('rate_plan_code') as string | null,
          companyName: values.get('company_name') as string | null,
          source: values.get('source') as ReservationRow['source'],
          notes: values.get('notes') as string | null,
        });
      }
    } else {
      text('company_name', 160, true);
      text('reference', 40, true);
      req('amount', moneyCell);
      take('issued_on', cell('issued_on') === '' ? ok(null) : dateCell(cell('issued_on')));
      take('due_on', cell('due_on') === '' ? ok(null) : dateCell(cell('due_on')));
      if (rowOk && values.get('amount') === '0') take('amount', bad('Must be more than zero'));
      const issued = values.get('issued_on') as string | null;
      const due = values.get('due_on') as string | null;
      if (rowOk && issued && due && due < issued) {
        take('due_on', bad('Due on or after the issue date'));
      }
      if (rowOk) {
        rows.push({
          row,
          companyName: values.get('company_name') as string,
          reference: values.get('reference') as string,
          amountMinor: values.get('amount') as string,
          issuedOn: issued,
          dueOn: due,
        });
      }
    }
  }
  return { rows, errors, total: data.length };
}
