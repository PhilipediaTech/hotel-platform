import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultTaxes } from '../tax/defaults.ts';

// Future reservations from the old system (Versions V2 "stronger migration"; T-169): each
// booking gets a new confirmation number and keeps the old one, every night costs the old
// system's nightly rate, and a booking that doesn't fit is refused.

const db = testDb();
const TODAY = '2026-11-10';
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Job = {
  id: string;
  status: string;
  report: {
    errors: { row: number | null; column: string | null; message: string }[];
    summary: Record<string, number>;
    applied: Record<string, number> | null;
  };
};

const HEAD =
  'old_confirmation_no,arrival,departure,room_type_code,nightly_rate,first_name,last_name,email,phone,adults,children,rate_plan_code,company_name,source,notes';

/** A property still being set up (not live): two Standard rooms, one Deluxe, a BAR plan. */
async function hotel() {
  const h = await makeHotel(db, now);
  await createDefaultTaxes(db, { id: h.p1.id, country: 'NG', settings: {} }, TODAY);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId, clock));
  const gm = await as(h.gm.id);
  const ok = async <T>(res: Promise<{ status: number; body: unknown }>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body as T;
  };
  const std = await ok<{ id: string }>(gm.post('/room-types', { code: 'STD', name: 'Standard' }));
  const dlx = await ok<{ id: string }>(
    gm.post('/room-types', { code: 'DLX', name: 'Deluxe', maxOccupancy: 3 }),
  );
  await ok(gm.post('/rooms', { number: '101', roomTypeId: std.id }));
  await ok(gm.post('/rooms', { number: '102', roomTypeId: std.id }));
  await ok(gm.post('/rooms', { number: '201', roomTypeId: dlx.id }));
  const policy = await ok<{ id: string }>(
    gm.post('/cancellation-policies', {
      name: 'Two days',
      rules: [{ daysBefore: 2, feeType: 'NIGHTS', value: 1 }],
      noShowFee: { feeType: 'NIGHTS', value: 1 },
    }),
  );
  const bar = await ok<{ id: string }>(
    gm.post('/rate-plans', {
      cancellationPolicyId: policy.id,
      code: 'BAR',
      name: 'Best available',
      kind: 'BAR',
    }),
  );
  await ok(
    gm.put('/rate-calendar', {
      ratePlanId: bar.id,
      roomTypeIds: [std.id, dlx.id],
      from: TODAY,
      to: '2026-12-31',
      set: { amountMinor: '4500000' },
    }),
  );
  const upload = async (body: string, by = h.gm.id) => {
    const bytes = Buffer.from(body);
    const id = crypto.randomUUID();
    const storageKey = `org/${h.org.id}/property/${h.p1.id}/${id}`;
    await db.fileObject.create({
      data: {
        id,
        organisationId: h.org.id,
        propertyId: h.p1.id,
        storageKey,
        contentType: 'text/csv',
        sizeBytes: bytes.length,
        scan: 'CLEAN',
        entityType: 'ImportJob',
        uploadedById: by,
      },
    });
    await c.files.put(storageKey, bytes, 'text/csv');
    return id;
  };
  const check = async (lines: string[]) => {
    const res = await gm.post('/imports', {
      kind: 'RESERVATIONS',
      fileId: await upload([HEAD, ...lines].join('\n')),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Job;
  };
  const apply = async (job: Job) => {
    const res = await gm.post(`/imports/${job.id}/apply`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Job;
  };
  return { ...h, as, gm, std, dlx, bar, upload, check, apply };
}

const sold = async (roomTypeId: string, date: string) =>
  (
    await db.roomTypeInventory.findFirstOrThrow({
      where: { roomTypeId, date: new Date(`${date}T00:00:00Z`) },
    })
  ).sold;

describe('future reservations', () => {
  it('books them at the old price, with new numbers that keep the old ones', async () => {
    const h = await hotel();
    const ada = await db.guest.create({
      data: { organisationId: h.org.id, firstName: 'Ada', lastName: 'Obi', email: 'ada@x.test' },
    });
    const dangote = await db.company.create({
      data: { organisationId: h.org.id, kind: 'COMPANY', name: 'Dangote Group' },
    });
    const job = await h.check([
      'R-1,2026-12-20,2026-12-23,STD,40000,Ada,Obi,ADA@x.test,,2,,,,phone,Late arrival',
      'R-1,20/12/2026,2026-12-22,DLX,"60,000",Tunde,Bakare,,0803 123 4567,1,1,,,phone,',
      'R-2,2026-12-21,2026-12-22,std,45000,Kemi,Ojo,,,,,BAR,dangote group,,',
    ]);
    expect(job.report.errors).toEqual([]);
    expect(job.report.summary).toEqual({
      reservationsNew: 2,
      staysNew: 3,
      nights: 6,
      guestsNew: 2,
    });
    expect(await db.reservation.count()).toBe(0);

    const applied = await h.apply(job);
    expect(applied.report.applied).toEqual({
      reservationsWritten: 2,
      staysWritten: 3,
      guestsWritten: 2,
    });

    const r1 = await db.reservation.findFirstOrThrow({
      where: { channelRef: 'R-1' },
      include: { stays: { include: { nights: true, guest: true }, orderBy: { arrival: 'asc' } } },
    });
    expect(r1).toMatchObject({
      confirmationNo: 'P1-00001',
      source: 'PHONE',
      status: 'CONFIRMED',
      guarantee: 'NONE',
      bookerGuestId: ada.id,
      companyId: null,
      notes: 'Imported from the old system (R-1). Late arrival',
    });
    const std = r1.stays.find((s) => s.roomTypeId === h.std.id);
    const dlx = r1.stays.find((s) => s.roomTypeId === h.dlx.id);
    expect(std?.guestId).toBe(ada.id);
    expect(std?.nights.map((n) => n.amountMinor)).toEqual([4000000n, 4000000n, 4000000n]);
    expect(dlx).toMatchObject({ adults: 1, children: 1, status: 'CONFIRMED' });
    expect(dlx?.guest).toMatchObject({ firstName: 'Tunde', phone: '+2348031234567' });
    expect(dlx?.nights.map((n) => n.amountMinor)).toEqual([6000000n, 6000000n]);
    // Taxes and posting lines are worked out as for any booking.
    const quote = await db.quote.findUniqueOrThrow({ where: { id: dlx?.quoteId ?? '' } });
    expect(quote.totalMinor).toBeGreaterThanOrEqual(12000000n);

    const r2 = await db.reservation.findFirstOrThrow({ where: { channelRef: 'R-2' } });
    expect(r2).toMatchObject({
      confirmationNo: 'P1-00002',
      source: 'CORPORATE',
      companyId: dangote.id,
      guarantee: 'COMPANY',
    });
    expect(await sold(h.std.id, '2026-12-21')).toBe(2);
    expect(await sold(h.dlx.id, '2026-12-20')).toBe(1);
    expect(await sold(h.dlx.id, '2026-12-22')).toBe(0);

    // The desk finds a booking by its old number.
    const found = await h.gm.get('/reservations').query({ q: 'r-1' });
    expect(found.status).toBe(200);
    expect(
      (found.body as { data: { confirmationNo: string }[] }).data.map((i) => i.confirmationNo),
    ).toEqual(['P1-00001']);

    // The same file again is refused: nothing is booked twice.
    const twice = await h.check([
      'R-1,2026-12-20,2026-12-23,STD,40000,Ada,Obi,ADA@x.test,,2,,,,phone,',
    ]);
    expect(twice.status).toBe('FAILED');
    expect(twice.report.errors).toEqual([
      { row: 2, column: 'old_confirmation_no', message: 'R-1 was imported before (P1-00001)' },
    ]);
  });

  it('refuses bookings that are past, full, too many guests or otherwise unknown', async () => {
    const h = await hotel();
    await db.guest.create({
      data: {
        organisationId: h.org.id,
        firstName: 'Bad',
        lastName: 'Guest',
        phone: '+2348099999999',
        doNotRent: true,
        flagReason: 'Damaged a room',
      },
    });
    const job = await h.check([
      'A-1,2026-11-09,2026-11-12,STD,40000,Ada,Obi,,,,,,,,',
      'A-2,2026-12-20,2026-12-22,DLX,60000,Tunde,Bakare,,,,,,,,',
      'A-3,2026-12-21,2026-12-23,DLX,60000,Kemi,Ojo,,,,,,,,',
      'A-4,2026-12-20,2026-12-22,STD,40000,Bola,Ade,,,3,,,,,',
      'A-5,2026-12-20,2026-12-22,SUITE,40000,Bola,Ade,,,,,,,,',
      'A-6,2026-12-20,2026-12-22,STD,40000,Bola,Ade,,,,,CORP,,,',
      'A-7,2026-12-20,2026-12-22,STD,40000,Bola,Ade,,,,,,Nobody Ltd,,',
      'A-8,2026-12-20,2026-12-22,STD,40000,Bad,Guest,,08099999999,,,,,,',
      'A-9,2026-12-20,2026-12-22,STD,40000,Bola,Ade,,,,,,,phone,',
      'A-9,2026-12-20,2026-12-22,STD,40000,Bola,Ade,,,,,,,email,',
      'A-10,2026-12-20,2026-12-20,STD,40000,Bola,Ade,,,,,,,fax,',
    ]);
    expect(job.status).toBe('FAILED');
    expect(job.report.errors).toEqual([
      { row: 2, column: 'arrival', message: 'Only bookings still to come: arrival today or later' },
      { row: 4, column: 'arrival', message: 'No DLX room is left on 2026-12-21' },
      { row: 5, column: 'adults', message: 'Standard takes at most 2 guests' },
      { row: 6, column: 'room_type_code', message: 'No active room type SUITE' },
      { row: 7, column: 'rate_plan_code', message: 'No active rate plan CORP' },
      { row: 8, column: 'company_name', message: 'No company or travel agent called Nobody Ltd' },
      {
        row: 9,
        column: 'phone',
        message: 'This guest is flagged do-not-rent: book them at the desk, with a manager',
      },
      { row: 11, column: 'source', message: 'Rows of one booking share its source (row 10)' },
      expect.objectContaining({ row: 12, column: 'source' }),
      { row: 12, column: 'departure', message: 'Leave at least one night after the arrival' },
    ]);
    expect(await db.reservation.count()).toBe(0);
  });

  it('needs the permission to make bookings', async () => {
    const h = await hotel();
    const role = await db.role.create({
      data: { organisationId: h.org.id, name: 'Importer', permissions: ['import.run'] },
    });
    const clerk = await h.person('front-desk', h.p1.id);
    await db.membership.updateMany({ where: { userId: clerk.id }, data: { roleId: role.id } });
    const as = await h.as(clerk.id);
    const res = await as.post('/imports', {
      kind: 'RESERVATIONS',
      fileId: await h.upload(
        [HEAD, 'R-1,2026-12-20,2026-12-23,STD,40000,Ada,Obi,,,,,,,,'].join('\n'),
        clerk.id,
      ),
    });
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ permission: 'reservation.create' });
  });
});
