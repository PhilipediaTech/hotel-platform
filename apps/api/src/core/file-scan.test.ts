import { describe, expect, it } from 'vitest';
import { createFakeFileScanner, EICAR, matchesContentType } from './file-scan.ts';

const bytes = (...values: number[]) => Buffer.from(values);
const text = (value: string) => Buffer.from(value, 'utf8');

describe('matchesContentType', () => {
  const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
  const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
  const WEBP = Buffer.concat([text('RIFF'), bytes(0, 0, 0, 0), text('WEBPVP8 ')]);
  const PDF = text('%PDF-1.7\n');
  const XLSX = bytes(0x50, 0x4b, 0x03, 0x04, 20, 0);
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/webp', WEBP],
    ['application/pdf', PDF],
    [XLSX_TYPE, XLSX],
    ['text/csv', text('room,type\n101,Deluxe — sea view\n')],
  ])('accepts a real %s', (type, body) => {
    expect(matchesContentType(body, type)).toBe(true);
  });

  it.each([
    ['image/png', JPEG],
    ['image/jpeg', PNG],
    ['image/webp', Buffer.concat([text('RIFF'), bytes(0, 0, 0, 0), text('AVI ')])],
    ['application/pdf', text('<html><script>alert(1)</script>')],
    [XLSX_TYPE, PDF],
    ['text/csv', PNG],
    ['text/csv', bytes(0xc3, 0x28)],
    ['text/html', text('<html>')],
  ])('refuses something else declared as %s', (type, body) => {
    expect(matchesContentType(body, type)).toBe(false);
  });
});

describe('fake scanner', () => {
  const scanner = createFakeFileScanner();

  it('flags the EICAR test file anywhere in the content', async () => {
    expect(await scanner.scan(text(`col\n${EICAR}\n`))).toEqual({
      infected: true,
      signature: 'EICAR-Test-File',
    });
  });

  it('passes anything else', async () => {
    expect(await scanner.scan(text('room,type\n'))).toEqual({ infected: false });
  });
});
