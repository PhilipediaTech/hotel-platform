import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeRoom, makeRoomType } from '../../../test/factories.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

// Spreadsheet imports (PRD M1-03 and acceptance; tab 4 row "Imports"; T-034): check a file,
// read the report, apply it all or nothing.

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const CSV = 'text/csv';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Job = {
  id: string;
  status: string;
  report: {
    total: number;
    errorCount: number;
    errors: { row: number | null; column: string | null; message: string }[];
    summary: Record<string, number>;
    preview: Record<string, unknown>[];
    applied: Record<string, number> | null;
  };
};

async function hotel() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId, clock));
  const gm = await as(h.gm.id);
  /** A clean uploaded file of kind ImportJob, as if it went through upload and scan. */
  const upload = async (
    body: Buffer | string,
    contentType = CSV,
    scan: 'CLEAN' | 'PENDING' = 'CLEAN',
  ) => {
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    const id = crypto.randomUUID();
    const storageKey = `org/${h.org.id}/property/${h.p1.id}/${id}`;
    await db.fileObject.create({
      data: {
        id,
        organisationId: h.org.id,
        propertyId: h.p1.id,
        storageKey,
        contentType,
        sizeBytes: bytes.length,
        scan,
        entityType: 'ImportJob',
        uploadedById: h.gm.id,
      },
    });
    await c.files.put(storageKey, bytes, contentType);
    return id;
  };
  const check = async (kind: string, body: Buffer | string, contentType = CSV) => {
    const res = await gm.post('/imports', { kind, fileId: await upload(body, contentType) });
    expect(res.status).toBe(201);
    return res.body as Job;
  };
  return { ...h, as, gm, upload, check };
}

const ROOM_HEADER =
  'room_number,room_type_code,room_type_name,base_occupancy,max_occupancy,floor,building,features';

describe('rooms and room types (M1-03)', () => {
  it('lists exactly the 3 bad rows of a 100-room file and imports nothing (PRD acceptance)', async () => {
    const h = await hotel();
    const lines = Array.from({ length: 100 }, (_, i) => {
      const n = 101 + i;
      return `${n},STD,Standard,2,2,${Math.floor(n / 100)},,`;
    });
    lines[9] = '110,STD,Standard,two,2,1,,'; // row 11
    lines[49] = ',STD,Standard,2,2,1,,'; // row 51
    lines[89] = '190,STD,Standard,3,2,1,,'; // row 91
    const job = await h.check('ROOMS', [ROOM_HEADER, ...lines].join('\n'));
    expect(job.status).toBe('FAILED');
    expect(job.report.total).toBe(100);
    expect(job.report.errors).toEqual([
      { row: 11, column: 'base_occupancy', message: 'Use a whole number' },
      { row: 51, column: 'room_number', message: 'Required' },
      { row: 91, column: 'max_occupancy', message: 'Must be at least the base occupancy' },
    ]);
    expect(await db.room.count()).toBe(0);
    expect(await db.roomType.count()).toBe(0);

    const apply = await h.gm.post(`/imports/${job.id}/apply`);
    expect(apply.status).toBe(409);
    expect(errorOf(apply)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { status: 'FAILED' },
    });
    expect(await db.room.count()).toBe(0);
  });

  it('previews, then on confirm creates types and rooms and updates existing ones', async () => {
    const h = await hotel();
    const std = await makeRoomType(db, h.p1, { code: 'STD', name: 'Standard' });
    await makeRoom(db, std, { number: '101' });
    const job = await h.check(
      'ROOMS',
      [
        ROOM_HEADER,
        '101,STD,,,,1,Main,Balcony',
        '102,STD,,,,1,,',
        '201,DLX,Deluxe,2,3,2,,Sea view; Balcony',
        '202,dlx,,,,2,,',
      ].join('\n'),
    );
    expect(job.status).toBe('VALIDATED');
    expect(job.report.summary).toEqual({
      roomTypesNew: 1,
      roomTypesUpdated: 0,
      roomsNew: 3,
      roomsUpdated: 1,
    });
    expect(job.report.preview[2]).toMatchObject({
      row: 4,
      roomNumber: '201',
      roomTypeCode: 'DLX',
      features: ['Sea view', 'Balcony'],
    });
    // Nothing written yet.
    expect(await db.room.count()).toBe(1);

    const res = await h.gm.post(`/imports/${job.id}/apply`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'APPLIED', report: { applied: { roomsWritten: 4 } } });
    const rooms = await db.room.findMany({
      include: { roomType: true },
      orderBy: { number: 'asc' },
    });
    expect(rooms.map((r) => [r.number, r.roomType.code, r.building, r.features])).toEqual([
      ['101', 'STD', 'Main', ['Balcony']],
      ['102', 'STD', null, []],
      ['201', 'DLX', null, ['Sea view', 'Balcony']],
      ['202', 'DLX', null, []],
    ]);
    expect(new Set(rooms.map((r) => r.qrToken)).size).toBe(4);
    expect(await db.roomType.findFirst({ where: { code: 'DLX' } })).toMatchObject({
      name: 'Deluxe',
      maxOccupancy: 3,
    });
    const [event] = await db.auditEvent.findMany({ where: { action: 'import.applied' } });
    expect(event).toMatchObject({
      entityId: job.id,
      after: { kind: 'ROOMS', rows: 4, roomsNew: 3, roomsWritten: 4 },
    });
    const file = await db.importJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { file: true },
    });
    expect(file.file.entityId).toBe(job.id);

    const again = await h.gm.post(`/imports/${job.id}/apply`);
    expect(errorOf(again).details).toEqual({ status: 'APPLIED' });
    expect((await h.gm.get(`/imports/${job.id}`)).body).toMatchObject({ status: 'APPLIED' });
  });

  it('reads an Excel file the same way', async () => {
    const h = await hotel();
    const job = await h.check(
      'ROOMS',
      readFileSync(new URL('../../../test/fixtures/rooms.xlsx', import.meta.url)),
      XLSX,
    );
    expect(job.report.errors).toEqual([]);
    expect(job.report.summary).toEqual({
      roomTypesNew: 2,
      roomTypesUpdated: 0,
      roomsNew: 3,
      roomsUpdated: 0,
    });
    expect(job.report.preview[1]).toMatchObject({
      roomNumber: '402',
      roomTypeCode: 'EXE',
      floor: '4',
    });
  });

  it('catches clashes only the property or the whole file can show', async () => {
    const h = await hotel();
    const job = await h.check(
      'ROOMS',
      [
        ROOM_HEADER,
        '101,STD,Standard,2,2,1,,',
        '101,STD,,,,1,,',
        '102,STD,Standard,2,3,1,,',
        '301,STE,,,,3,,',
      ].join('\n'),
    );
    expect(job.report.errors).toEqual([
      { row: 3, column: 'room_number', message: 'Room 101 is already on row 2' },
      {
        row: 4,
        column: 'room_type_code',
        message: 'Room type STD is described differently on row 2',
      },
      { row: 5, column: 'room_type_name', message: 'New room type STE needs a name' },
    ]);
  });

  it('says when the file is not scanned yet or is not a spreadsheet', async () => {
    const h = await hotel();
    const pending = await h.gm.post('/imports', {
      kind: 'ROOMS',
      fileId: await h.upload(ROOM_HEADER, CSV, 'PENDING'),
    });
    expect(pending.status).toBe(409);
    expect(errorOf(pending)).toMatchObject({
      code: 'FILE_NOT_READY',
      details: { scan: 'PENDING' },
    });

    const junk = await h.check('ROOMS', Buffer.from('PK\u0003\u0004 not really a workbook'), XLSX);
    expect(junk.report.errors).toEqual([
      { row: null, column: null, message: 'This file could not be read as a spreadsheet' },
    ]);
    const empty = await h.check('ROOMS', `${ROOM_HEADER}\n`);
    expect(empty.report.errors).toEqual([
      { row: null, column: null, message: 'The file has no rows under the header' },
    ]);
    const missing = await h.check('ROOMS', 'room_number,floor\n101,1\n');
    expect(missing.report.errors).toEqual([
      { row: 1, column: 'room_type_code', message: 'Missing column' },
    ]);
  });
});

describe('rates (M1-03)', () => {
  async function withPlans(h: Awaited<ReturnType<typeof hotel>>) {
    const std = await makeRoomType(db, h.p1, { code: 'STD', name: 'Standard' });
    const dlx = await makeRoomType(db, h.p1, { code: 'DLX', name: 'Deluxe' });
    const policy = await db.cancellationPolicy.create({
      data: {
        propertyId: h.p1.id,
        name: 'Flexible',
        rules: [],
        noShowFee: { feeType: 'NIGHTS', value: 1 },
      },
    });
    const plan = (code: string, kind: 'BAR' | 'DERIVED', parentRatePlanId: string | null = null) =>
      db.ratePlan.create({
        data: {
          organisationId: h.org.id,
          propertyId: h.p1.id,
          code,
          name: code,
          kind,
          parentRatePlanId,
          derivationBps: kind === 'DERIVED' ? -1000 : null,
          cancellationPolicyId: policy.id,
          currency: 'NGN',
        },
      });
    const bar = await plan('BAR', 'BAR');
    const corp = await plan('CORP', 'DERIVED', bar.id);
    return { std, dlx, bar, corp };
  }
  const HEADER =
    'rate_plan_code,room_type_code,from,to,price,min_stay,max_stay,closed_to_arrival,closed_to_departure,stop_sell';

  it('writes prices and restrictions for each row’s date range on confirm', async () => {
    const h = await hotel();
    const { std, dlx, bar, corp } = await withPlans(h);
    const job = await h.check(
      'RATES',
      [
        HEADER,
        'BAR,STD,2026-12-01,2026-12-31,"45,000",,,,,',
        'BAR,DLX,01/12/2026,03/12/2026,65000,2,,yes,,',
        'CORP,STD,2026-12-24,2026-12-26,,3,,,,',
      ].join('\n'),
    );
    expect(job.status).toBe('VALIDATED');
    expect(job.report.summary).toEqual({ rateLines: 3, days: 31 + 3 + 3 });
    expect(await db.rateDay.count()).toBe(0);

    const res = await h.gm.post(`/imports/${job.id}/apply`);
    expect(res.body).toMatchObject({ status: 'APPLIED', report: { applied: { daysChanged: 37 } } });
    const day = (ratePlanId: string, roomTypeId: string, date: string) =>
      db.rateDay.findUniqueOrThrow({
        where: { ratePlanId_roomTypeId_date: { ratePlanId, roomTypeId, date: new Date(date) } },
      });
    expect(await day(bar.id, std.id, '2026-12-31')).toMatchObject({
      amountMinor: 4_500_000n,
      ruleVersion: 1,
    });
    expect(await day(bar.id, dlx.id, '2026-12-02')).toMatchObject({
      amountMinor: 6_500_000n,
      minStay: 2,
      closedToArrival: true,
    });
    expect(await day(corp.id, std.id, '2026-12-25')).toMatchObject({
      amountMinor: null,
      minStay: 3,
    });
  });

  it('refuses unknown plans, prices on derived plans, past dates and overlapping rows', async () => {
    const h = await hotel();
    await withPlans(h);
    const job = await h.check(
      'RATES',
      [
        HEADER,
        'XYZ,STD,2026-12-01,2026-12-02,1000,,,,,',
        'CORP,STD,2026-12-01,2026-12-02,1000,,,,,',
        'BAR,STD,2026-11-01,2026-11-30,1000,,,,,',
        'BAR,DLX,2026-12-01,2026-12-10,1000,,,,,',
        'BAR,DLX,2026-12-10,2026-12-12,2000,,,,,',
        'BAR,STE,2026-12-01,2026-12-02,1000,,,,,',
      ].join('\n'),
    );
    expect(job.report.errors.map((e) => [e.row, e.column, e.message])).toEqual([
      [2, 'rate_plan_code', 'No active rate plan XYZ'],
      [3, 'price', 'CORP follows its parent’s prices; leave the price empty'],
      [4, 'from', 'Prices and restrictions change from today on'],
      [6, 'from', 'Overlaps row 5 for BAR DLX'],
      [7, 'room_type_code', 'No active room type STE'],
    ]);
  });

  it('checks again on confirm: a plan switched off since the check stops the whole import', async () => {
    const h = await hotel();
    const { bar } = await withPlans(h);
    const job = await h.check(
      'RATES',
      [HEADER, 'BAR,STD,2026-12-01,2026-12-02,1000,,,,,'].join('\n'),
    );
    await db.ratePlan.update({ where: { id: bar.id }, data: { active: false } });
    const res = await h.gm.post(`/imports/${job.id}/apply`);
    expect(res.status).toBe(409);
    expect(errorOf(res).details?.['errors']).toEqual([
      { row: 2, column: 'rate_plan_code', message: 'No active rate plan BAR' },
    ]);
    expect(await db.rateDay.count()).toBe(0);
    expect((await db.importJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
      'VALIDATED',
    );
  });
});

describe('permissions', () => {
  it('needs import.run and an uploaded import file', async () => {
    const h = await hotel();
    const fd = await h.as(h.fd.id);
    const refused = await fd.post('/imports', { kind: 'ROOMS', fileId: crypto.randomUUID() });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).details).toEqual({ permission: 'import.run' });
    const unknown = await h.gm.post('/imports', { kind: 'ROOMS', fileId: crypto.randomUUID() });
    expect(unknown.status).toBe(400);
    const later = await h.gm.post('/imports', { kind: 'GUESTS', fileId: crypto.randomUUID() });
    expect((errorOf(later).details?.['issues'] as { path: string }[])[0]?.path).toBe('body.kind');
  });
});
