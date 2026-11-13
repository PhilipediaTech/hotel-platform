import { describe, expect, it } from 'vitest';
import {
  findHeaderRow,
  guessStatementColumns,
  parseStatementAmount,
  parseStatementDate,
  readStatement,
  readStatementCsv,
} from './bank-statements.ts';

describe('statement dates (M4-23)', () => {
  it('reads the layouts Nigerian banks export', () => {
    expect(parseStatementDate('2026-11-05')).toBe('2026-11-05');
    expect(parseStatementDate('05/11/2026')).toBe('2026-11-05');
    expect(parseStatementDate('5-11-26')).toBe('2026-11-05');
    expect(parseStatementDate('05-Nov-2026')).toBe('2026-11-05');
    expect(parseStatementDate('05 NOV 26')).toBe('2026-11-05');
    expect(parseStatementDate('Nov 5, 2026')).toBe('2026-11-05');
    expect(parseStatementDate('05/11/2026 14:32:10')).toBe('2026-11-05');
    expect(parseStatementDate('2026-11-05T09:00:00')).toBe('2026-11-05');
  });

  it('reads numbers in the order asked, and refuses what is not a date', () => {
    expect(parseStatementDate('11/05/2026', 'MDY')).toBe('2026-11-05');
    expect(parseStatementDate('11/05/2026', 'YMD')).toBeNull();
    expect(parseStatementDate('31/04/2026')).toBeNull();
    expect(parseStatementDate('Opening balance')).toBeNull();
    expect(parseStatementDate('')).toBeNull();
  });
});

describe('statement amounts (M4-23)', () => {
  it('reads naira as kobo with its sign', () => {
    expect(parseStatementAmount('1,250,000.00')).toBe(125000000n);
    expect(parseStatementAmount('₦5,000')).toBe(500000n);
    expect(parseStatementAmount('NGN 300.5')).toBe(30050n);
    expect(parseStatementAmount('(2,000.50)')).toBe(-200050n);
    expect(parseStatementAmount('2,000.50 DR')).toBe(-200050n);
    expect(parseStatementAmount('2,000.50CR')).toBe(200050n);
    expect(parseStatementAmount('-75')).toBe(-7500n);
    expect(parseStatementAmount('')).toBeNull();
    expect(parseStatementAmount('-')).toBeNull();
    expect(parseStatementAmount('12.345')).toBeUndefined();
    expect(parseStatementAmount('abc')).toBeUndefined();
  });
});

describe('statement columns (M4-23)', () => {
  it('finds the header under the bank’s preamble and names its columns', () => {
    const table = [
      ['Account name', 'Lagoon Hotel Ltd'],
      ['Account number', '0123456789'],
      [],
      ['Trans Date', 'Value Date', 'Narration', 'Reference', 'Debit', 'Credit', 'Balance'],
    ];
    expect(findHeaderRow(table)).toBe(3);
    expect(guessStatementColumns(table[3] ?? [])).toEqual({
      date: 0,
      description: 2,
      reference: 3,
      debit: 4,
      credit: 5,
      amount: null,
      balance: 6,
    });
    expect(findHeaderRow([['Name', 'Phone']])).toBeNull();
  });
});

describe('reading a statement (M4-23)', () => {
  const csv = [
    'Lagoon Hotel Ltd,,,,,',
    'Date,Narration,Reference,Debit,Credit,Balance',
    ',Opening balance,,,,"1,000,000.00"',
    '05/11/2026,TRF FROM ADA OBI,FT2611050001,,"150,000.00","1,150,000.00"',
    '06/11/2026,POS SETTLEMENT 2026-11-05,,,"98,500.00","1,248,500.00"',
    '06/11/2026,SMS ALERT CHARGES,,4.00,,"1,248,496.00"',
    '07/11/2026,Zero line,,,,"1,248,496.00"',
    '08/11/2026,Broken,,,abc,',
    ',Total,,4.00,"248,500.00",',
  ].join('\n');

  it('takes each transaction once, money in positive and money out negative', () => {
    const read = readStatementCsv(csv);
    expect(read?.headerRow).toBe(1);
    expect(read?.lines).toEqual([
      {
        postedOn: '2026-11-05',
        description: 'TRF FROM ADA OBI',
        reference: 'FT2611050001',
        amountMinor: '15000000',
        balanceMinor: '115000000',
      },
      {
        postedOn: '2026-11-06',
        description: 'POS SETTLEMENT 2026-11-05',
        reference: null,
        amountMinor: '9850000',
        balanceMinor: '124850000',
      },
      {
        postedOn: '2026-11-06',
        description: 'SMS ALERT CHARGES',
        reference: null,
        amountMinor: '-400',
        balanceMinor: '124849600',
      },
    ]);
    expect(read?.errors).toEqual([{ row: 8, message: 'The credit cannot be read as an amount' }]);
  });

  it('reads one signed amount column, and flags money on a row with no readable date', () => {
    const table = [
      ['Posting Date', 'Description', 'Amount'],
      ['2026-11-05', 'Inflow', '5000'],
      ['2026-11-06', 'Outflow', '(1200)'],
      ['next week', 'Odd', '700'],
    ];
    const { lines, errors } = readStatement(table, {
      headerRow: 0,
      columns: guessStatementColumns(table[0] ?? []),
      dateOrder: 'DMY',
    });
    expect(lines.map((l) => l.amountMinor)).toEqual(['500000', '-120000']);
    expect(errors).toEqual([{ row: 4, message: '“next week” is not a date' }]);
  });

  it('answers null for a file with no statement header', () => {
    expect(readStatementCsv('a,b\n1,2')).toBeNull();
  });
});
