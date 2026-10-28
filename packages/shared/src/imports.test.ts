import { describe, expect, it } from 'vitest';
import {
  IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  normalizeHeader,
  parseCsv,
  parseSheet,
  templateCsv,
} from './imports.ts';

// Spreadsheet import cell checks (PRD M1-03; T-034).

const ROOM_HEADER = [
  'Room Number',
  'Room Type Code',
  'Room Type Name',
  'Base Occupancy',
  'Max Occupancy',
  'Floor',
  'Building',
  'Features',
];

describe('templates and CSV', () => {
  it('builds a template that parses back to its own examples', () => {
    for (const kind of ['ROOMS', 'RATES'] as const) {
      const table = parseCsv(templateCsv(kind));
      expect(table[0]).toEqual(IMPORT_COLUMNS[kind].map((c) => c.name));
      const sheet = kind === 'ROOMS' ? parseSheet('ROOMS', table) : parseSheet('RATES', table);
      expect(sheet.errors).toEqual([]);
      expect(sheet.rows).toHaveLength(2);
    }
  });

  it('reads quoted CSV with commas, quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      [''],
    ]);
    expect(normalizeHeader(' Room Type-Code ')).toBe('room_type_code');
  });
});

describe('ROOMS sheet', () => {
  it('reads rooms with their type, upper-casing codes and splitting features', () => {
    const { rows, errors, total } = parseSheet('ROOMS', [
      ROOM_HEADER,
      ['101', 'std', 'Standard', '2', '2', '1', '', ''],
      ['', '', '', '', '', '', '', ''], // blank rows are skipped
      ['b-12', 'DLX', 'Deluxe', '2', '3', '2', 'Garden wing', 'Balcony; Sea view'],
    ]);
    expect(errors).toEqual([]);
    expect(total).toBe(2);
    expect(rows).toEqual([
      {
        row: 2,
        roomNumber: '101',
        roomTypeCode: 'STD',
        roomTypeName: 'Standard',
        baseOccupancy: 2,
        maxOccupancy: 2,
        floor: '1',
        building: null,
        features: [],
      },
      {
        row: 4,
        roomNumber: 'B-12',
        roomTypeCode: 'DLX',
        roomTypeName: 'Deluxe',
        baseOccupancy: 2,
        maxOccupancy: 3,
        floor: '2',
        building: 'Garden wing',
        features: ['Balcony', 'Sea view'],
      },
    ]);
  });

  it('reports each bad cell with its row and column', () => {
    const { rows, errors } = parseSheet('ROOMS', [
      ROOM_HEADER,
      ['', 'STD', '', '', '', '', '', ''],
      ['102', 'S', '', 'two', '', '', '', ''],
      ['103', 'STD', '', '3', '2', '', '', ''],
      ['104', 'STD', '', '', '', '', '', ''],
    ]);
    expect(errors).toEqual([
      { row: 2, column: 'room_number', message: 'Required' },
      {
        row: 3,
        column: 'room_type_code',
        message: 'Two to ten letters, digits or dashes, e.g. DLX',
      },
      { row: 3, column: 'base_occupancy', message: 'Use a whole number' },
      { row: 4, column: 'max_occupancy', message: 'Must be at least the base occupancy' },
    ]);
    expect(rows.map((r) => r.roomNumber)).toEqual(['104']);
  });

  it('names missing columns and refuses very long files', () => {
    expect(parseSheet('ROOMS', [['room_number', 'floor']]).errors).toEqual([
      { row: 1, column: 'room_type_code', message: 'Missing column' },
    ]);
    const long = [
      ROOM_HEADER,
      ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => [`${i + 1}`, 'STD']),
    ];
    expect(parseSheet('ROOMS', long).errors).toEqual([
      { row: null, column: null, message: `At most ${MAX_IMPORT_ROWS} rows per file` },
    ]);
  });
});

describe('RATES sheet', () => {
  const HEADER = [
    'rate_plan_code',
    'room_type_code',
    'from',
    'to',
    'price',
    'min_stay',
    'max_stay',
    'closed_to_arrival',
    'closed_to_departure',
    'stop_sell',
  ];

  it('reads prices in naira as kobo, Nigerian dates and yes/no restrictions', () => {
    const { rows, errors } = parseSheet('RATES', [
      HEADER,
      ['bar', 'std', '2026-12-01', '31/12/2026', '₦45,000.50', '', '', '', '', ''],
      ['BAR', 'DLX', '24/12/2026', '26/12/2026', '', '3', '', 'yes', '', 'no'],
    ]);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        row: 2,
        ratePlanCode: 'BAR',
        roomTypeCode: 'STD',
        from: '2026-12-01',
        to: '2026-12-31',
        amountMinor: '4500050',
      },
      {
        row: 3,
        ratePlanCode: 'BAR',
        roomTypeCode: 'DLX',
        from: '2026-12-24',
        to: '2026-12-26',
        minStay: 3,
        closedToArrival: true,
        stopSell: false,
      },
    ]);
  });

  it('reports bad dates, prices, flags and rows that change nothing', () => {
    const { errors } = parseSheet('RATES', [
      HEADER,
      ['BAR', 'STD', '2026-02-30', '2026-03-01', '45000', '', '', '', '', ''],
      ['BAR', 'STD', '2026-12-10', '2026-12-01', 'free', '', '', 'maybe', '', ''],
      ['BAR', 'STD', '2026-12-01', '2026-12-02', '', '', '', '', '', ''],
    ]);
    expect(errors).toEqual([
      { row: 2, column: 'from', message: 'Not a real date' },
      { row: 3, column: 'price', message: 'Use an amount like 45000 or 45,000.50' },
      { row: 3, column: 'closed_to_arrival', message: 'Use yes or no' },
      { row: 4, column: 'price', message: 'Give a price or at least one restriction' },
    ]);
  });
});
