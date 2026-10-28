import { isUtf8 } from 'node:buffer';

// FileScanner interface (tab 2 "Files"; spec issue 9; T-023). The engine is not chosen yet
// (ClamAV needs a Docker-based worker, decided with hosting); the fake recognises the EICAR
// test file so the INFECTED path can be exercised end to end.

export interface ScanResult {
  infected: boolean;
  /** Name of what was found, for the audit trail. */
  signature?: string;
}

export interface FileScanner {
  scan(body: Buffer): Promise<ScanResult>;
}

/** The standard anti-virus test string (eicar.org); harmless, flagged by every engine. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export function createFakeFileScanner(): FileScanner {
  return {
    scan(body) {
      const infected = body.includes(EICAR);
      return Promise.resolve(infected ? { infected, signature: 'EICAR-Test-File' } : { infected });
    },
  };
}

const startsWith = (body: Buffer, bytes: readonly number[], offset = 0) =>
  bytes.every((b, i) => body[offset + i] === b);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/**
 * Whether the bytes are what the uploader declared, by their leading "magic" bytes. Run
 * whatever the scanner says: a file that lies about its type is never served.
 */
export function matchesContentType(body: Buffer, contentType: string): boolean {
  switch (contentType) {
    case 'image/jpeg':
      return startsWith(body, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return startsWith(body, ascii('RIFF')) && startsWith(body, ascii('WEBP'), 8);
    case 'application/pdf':
      return startsWith(body, ascii('%PDF-'));
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      // Office Open XML files are ZIP archives.
      return startsWith(body, [0x50, 0x4b, 0x03, 0x04]);
    case 'text/csv':
      // Text: valid UTF-8 without NUL bytes.
      return !body.includes(0) && isUtf8(body);
    default:
      return false;
  }
}
