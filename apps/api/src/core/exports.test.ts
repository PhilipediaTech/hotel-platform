import { describe, expect, it } from 'vitest';
import { csv, decimal, exportFile, isExportFile } from './exports.ts';

// Report exports (PRD M12-06; T-092).

// ignoreBOM keeps the byte-order mark in the decoded text (the default drops it).
const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

describe('csv', () => {
  it('quotes what needs it, ends lines with CRLF and starts with a byte-order mark', () => {
    const out = text(
      csv([
        ['Name', 'Note'],
        ['Ada, Obi', 'Said "hi"\nthen left'],
        [null, 3],
      ]),
    );
    expect(out.startsWith('﻿')).toBe(true);
    expect(out.slice(1)).toBe('Name,Note\r\n"Ada, Obi","Said ""hi""\nthen left"\r\n,3\r\n');
  });

  it('defuses cells a spreadsheet would run as a formula, but keeps negative numbers', () => {
    const out = text(csv([['=SUM(A1:A9)', '+1+1', '@cmd', '-2000.00', '-x']]));
    expect(out.slice(1)).toBe("'=SUM(A1:A9),'+1+1,'@cmd,-2000.00,'-x\r\n");
  });
});

describe('decimal', () => {
  it('writes minor units as plain decimals', () => {
    expect(decimal(123456n)).toBe('1234.56');
    expect(decimal('-5')).toBe('-0.05');
    expect(decimal(0n)).toBe('0.00');
  });
});

describe('exportFile', () => {
  it('is recognised as a file, a plain object is not', () => {
    expect(isExportFile(exportFile('a.csv', 'text/csv', new Uint8Array()))).toBe(true);
    expect(isExportFile({ filename: 'a.csv' })).toBe(false);
  });
});
