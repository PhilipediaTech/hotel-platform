// Spreadsheet imports (PRD M1-03; S03; T-034): the template columns of each kind and the
// cell checks shared by the API (which checks uploaded files) and the web app (which builds
// the templates). Checks that need the database (codes that exist, rooms already there) are
// in the API. Rows are numbered as in the spreadsheet: the header is row 1.

/** Kinds built so far; GUESTS, COMPANIES and BALANCES arrive with T-043 and folios. */
export const IMPORT_KINDS = ['ROOMS', 'RATES'] as const;
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
  kind: ImportKind,
  table: readonly (readonly string[])[],
): ParsedSheet<RoomRow | RateRow> {
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

  const rows: (RoomRow | RateRow)[] = [];
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
    } else {
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
    }
  }
  return { rows, errors, total: data.length };
}
