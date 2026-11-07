// Report exports (PRD M12-06 "I export any report to CSV or PDF if I hold the export
// permission"; tab 4 Reports `?format=csv|pdf`; T-092). A report handler answers its JSON, or
// an ExportFile when asked for csv or pdf; mountRoute checks report.export and sends the file.

export const EXPORT_PERMISSION = 'report.export';

const MARK = Symbol('exportFile');

export interface ExportFile {
  [MARK]: true;
  filename: string;
  contentType: 'text/csv' | 'application/pdf';
  content: Uint8Array;
}

export function isExportFile(value: unknown): value is ExportFile {
  return typeof value === 'object' && value !== null && MARK in value;
}

export function exportFile(
  filename: string,
  contentType: ExportFile['contentType'],
  content: Uint8Array,
): ExportFile {
  return { [MARK]: true, filename, contentType, content };
}

function cell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  // Quotes when needed; a leading =, +, - or @ is defused so spreadsheets never run it.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const BOM = String.fromCharCode(0xfeff);

/** CSV (RFC 4180, CRLF) with a UTF-8 byte-order mark so spreadsheets read ₦ correctly. */
export function csv(rows: readonly (readonly (string | number | null)[])[]): Uint8Array {
  const text = rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
  return new TextEncoder().encode(BOM + text);
}

/** Minor units as a plain decimal for CSV (no currency sign, no thousands separator). */
export function decimal(minor: bigint | string): string {
  const n = BigInt(minor);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
