import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { expireHolds } from './service.ts';

// Events and spaces, first part (PRD M9-01–M9-03; M9 rules "no two bookings may overlap on a
// space, including buffers; holds expire automatically"; M9 AC "overlapping booking including
// buffer is rejected with BOOKING_CONFLICT"; T-119).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

const SPACE = {
  code: 'HALL',
  name: 'Marina Hall',
  setupMinutes: 60,
  cleanupMinutes: 30,
  minimumHireMinor: '50000000',
  layouts: [
    { name: 'Theatre', capacity: 200 },
    { name: 'Banquet', capacity: 120 },
  ],
  rateRules: [
    { name: 'Weekend full day', unit: 'FULL_DAY', dayType: 'WEEKEND', amountMinor: '80000000' },
    {
      name: 'Festive hourly',
      unit: 'HOURLY',
      seasonFrom: '2026-12-15',
      seasonTo: '2027-01-05',
      amountMinor: '10000000',
    },
    { name: 'Projector', unit: 'EXTRA', amountMinor: '2500000' },
  ],
};

type SpaceOut = { id: string; layouts: { id: string; name: string; capacity: number }[] };
type BookingOut = {
  id: string;
  status: string;
  blockedFrom: string;
  blockedUntil: string;
  holdExpiresAt: string | null;
};

async function hotel() {
  const h = await inHouse(db, clock);
  const space = await h.ok<SpaceOut>(h.gm.post('/spaces', SPACE));
  const layout = space.layouts.find((l) => l.name === 'Banquet')?.id ?? '';
  const hold = (over: object = {}) =>
    h.gm.send('/event-bookings', {
      spaceId: space.id,
      layoutId: layout,
      title: 'Adaeze wedding',
      startsAt: '2026-12-05T10:00:00Z',
      endsAt: '2026-12-05T16:00:00Z',
      expectedGuests: 100,
      holdUntil: '2026-11-13T09:00:00Z',
      ...over,
    });
  const availability = (startsAt: string, endsAt: string, guests?: number) =>
    h.ok<{
      data: { available: boolean; layouts: unknown[]; conflicts: { title: string }[] }[];
    }>(
      h.gm.get(
        `/spaces/availability?startsAt=${startsAt}&endsAt=${endsAt}${guests ? `&guests=${guests}` : ''}`,
      ),
    );
  return { ...h, space, layout, hold, availability };
}

describe('spaces (M9-01)', () => {
  it('holds capacity per layout, buffers, minimum hire and every kind of price', async () => {
    const h = await hotel();
    const list = await h.ok<{ data: Record<string, unknown>[] }>(h.gm.get('/spaces'));
    expect(list.data[0]).toMatchObject({
      name: 'Marina Hall',
      setupMinutes: 60,
      cleanupMinutes: 30,
      minimumHireMinor: '50000000',
      layouts: [
        { name: 'Banquet', capacity: 120 },
        { name: 'Theatre', capacity: 200 },
      ],
    });
    expect(list.data[0]?.['rateRules']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: 'FULL_DAY', dayType: 'WEEKEND' }),
        expect.objectContaining({ seasonFrom: '2026-12-15', seasonTo: '2027-01-05' }),
        expect.objectContaining({ unit: 'EXTRA', amountMinor: '2500000' }),
      ]),
    );
    expect(await db.auditEvent.count({ where: { action: 'space.created' } })).toBe(1);
  });

  it('a duplicate code is refused; a season needs both ends', async () => {
    const h = await hotel();
    const dup = await h.gm.post('/spaces', SPACE);
    expect(dup.status).toBe(400);
    const bad = await h.gm.post('/spaces', {
      ...SPACE,
      code: 'X',
      rateRules: [{ name: 'N', unit: 'HOURLY', seasonFrom: '2026-12-15', amountMinor: '1' }],
    });
    expect(bad.status).toBe(400);
  });

  it('a layout taken off is retired, and the booking that used it keeps it', async () => {
    const h = await hotel();
    expect((await h.hold()).status).toBe(201);
    await h.ok(
      h.gm.put(`/spaces/${h.space.id}`, {
        ...SPACE,
        layouts: [{ name: 'Theatre', capacity: 250 }],
        rateRules: [],
      }),
    );
    const list = await h.ok<{ data: SpaceOut[] }>(h.gm.get('/spaces'));
    expect(list.data[0]?.layouts).toMatchObject([{ name: 'Theatre', capacity: 250 }]);
    expect((await db.eventBooking.findFirstOrThrow()).layoutId).toBe(h.layout);
    expect(await db.spaceRateRule.count()).toBe(0);
  });

  it('needs space.manage to change', async () => {
    const h = await hotel();
    expect((await h.fd.post('/spaces', { ...SPACE, code: 'F' })).status).toBe(403);
  });
});

describe('availability (M9-02)', () => {
  it('counts setup and cleanup on both sides', async () => {
    const h = await hotel();
    await h.ok(h.hold()); // Blocked 09:00 to 16:30.
    expect(
      (await h.availability('2026-12-05T10:00:00Z', '2026-12-05T12:00:00Z')).data[0],
    ).toMatchObject({ available: false, conflicts: [{ title: 'Adaeze wedding' }] });
    // Its own setup (an hour) from 17:00 reaches back to 16:00, into the cleanup.
    expect(
      (await h.availability('2026-12-05T17:00:00Z', '2026-12-05T18:00:00Z')).data[0]?.available,
    ).toBe(false);
    // 17:30 with an hour's setup starts at 16:30, just as the cleanup ends.
    expect(
      (await h.availability('2026-12-05T17:30:00Z', '2026-12-05T18:00:00Z')).data[0]?.available,
    ).toBe(true);
  });

  it('offers only layouts that seat the party', async () => {
    const h = await hotel();
    const res = await h.availability('2026-12-06T10:00:00Z', '2026-12-06T12:00:00Z', 150);
    expect(res.data[0]?.layouts).toMatchObject([{ name: 'Theatre' }]);
  });
});

describe('enquiries (M9-02)', () => {
  const ENQUIRY = {
    contactName: 'Adaeze Obi',
    contactPhone: '+2348030000002',
    eventType: 'Wedding',
    eventDate: '2026-12-05',
    expectedGuests: 100,
  };

  it('are logged, and a lost one gives back what it was holding', async () => {
    const h = await hotel();
    const e = await h.ok<{ id: string; status: string }>(h.gm.post('/event-enquiries', ENQUIRY));
    expect(e.status).toBe('OPEN');
    await h.ok(h.hold({ enquiryId: e.id }));

    const open = await h.ok<{ data: { bookings: BookingOut[] }[] }>(
      h.gm.get('/event-enquiries?status=OPEN'),
    );
    expect(open.data[0]?.bookings).toMatchObject([{ status: 'HOLD' }]);

    const noReason = await h.gm.put(`/event-enquiries/${e.id}`, { ...ENQUIRY, status: 'LOST' });
    expect(noReason.status).toBe(400);
    await h.ok(
      h.gm.put(`/event-enquiries/${e.id}`, {
        ...ENQUIRY,
        status: 'LOST',
        lostReason: 'Chose another venue',
      }),
    );
    expect(await db.eventBooking.findFirstOrThrow()).toMatchObject({ status: 'RELEASED' });
    expect((await h.hold()).status).toBe(201);
  });

  it('a lost enquiry can’t take a hold', async () => {
    const h = await hotel();
    const e = await h.ok<{ id: string }>(h.gm.post('/event-enquiries', ENQUIRY));
    await h.ok(
      h.gm.put(`/event-enquiries/${e.id}`, { ...ENQUIRY, status: 'LOST', lostReason: 'Price' }),
    );
    expect((await h.hold({ enquiryId: e.id })).status).toBe(400);
  });
});

describe('holds (M9-03; M9 rules and AC)', () => {
  it('blocks the event with its buffers, and writes the audit', async () => {
    const h = await hotel();
    const b = await h.ok<BookingOut>(h.hold());
    expect(b).toMatchObject({
      status: 'HOLD',
      blockedFrom: '2026-12-05T09:00:00Z',
      blockedUntil: '2026-12-05T16:30:00Z',
      holdExpiresAt: '2026-11-13T09:00:00Z',
    });
    expect(await db.auditEvent.count({ where: { action: 'event_booking.held' } })).toBe(1);
  });

  it('an overlap including a buffer is refused with BOOKING_CONFLICT', async () => {
    const h = await hotel();
    await h.ok(h.hold());
    // The event times don't touch; the setup and cleanup do.
    const clash = await h.hold({
      startsAt: '2026-12-05T17:00:00Z',
      endsAt: '2026-12-05T18:00:00Z',
    });
    expect(clash.status).toBe(409);
    expect(errorOf(clash).code).toBe('BOOKING_CONFLICT');
    expect(
      (await h.hold({ startsAt: '2026-12-05T17:30:00Z', endsAt: '2026-12-05T18:00:00Z' })).status,
    ).toBe(201);
  });

  it('the database itself refuses an overlap, whatever the code does', async () => {
    const h = await hotel();
    await h.ok(h.hold());
    const row = await db.eventBooking.findFirstOrThrow();
    const { id: _id, version: _v, ...copy } = row;
    await expect(db.eventBooking.create({ data: copy })).rejects.toThrow();
  });

  it('two holds at once: one wins, one gets BOOKING_CONFLICT', async () => {
    const h = await hotel();
    const results = await Promise.all([h.hold(), h.hold({ title: 'Second' })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.eventBooking.count({ where: { status: 'HOLD' } })).toBe(1);
  });

  it('expires by itself and gives the space back', async () => {
    const h = await hotel();
    await h.ok(h.hold());
    now = new Date('2026-11-13T09:00:30Z');
    expect(await expireHolds(db, clock)).toBe(1);
    expect(await db.eventBooking.findFirstOrThrow()).toMatchObject({ status: 'EXPIRED' });
    expect(await expireHolds(db, clock)).toBe(0);
    expect(await db.auditEvent.count({ where: { action: 'event_booking.hold_expired' } })).toBe(1);
  });

  it('a hold past its time stops counting even before the job has run', async () => {
    const h = await hotel();
    await h.ok(h.hold());
    now = new Date('2026-11-13T09:00:30Z');
    const fresh = await h.as(h.gmId);
    const cal = await h.ok<{ data: unknown[] }>(
      fresh.get('/event-bookings?from=2026-12-01T00:00:00Z&to=2026-12-31T00:00:00Z'),
    );
    expect(cal.data).toEqual([]);
    const again = await fresh.send('/event-bookings', {
      spaceId: h.space.id,
      layoutId: h.layout,
      title: 'Next in line',
      startsAt: '2026-12-05T10:00:00Z',
      endsAt: '2026-12-05T16:00:00Z',
      expectedGuests: 100,
      holdUntil: '2026-11-20T09:00:00Z',
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it('can be released once, and the space is free again', async () => {
    const h = await hotel();
    const b = await h.ok<BookingOut>(h.hold());
    await h.ok(h.gm.post(`/event-bookings/${b.id}/release`, {}));
    const twice = await h.gm.post(`/event-bookings/${b.id}/release`, {});
    expect(twice.status).toBe(409);
    expect((await h.hold()).status).toBe(201);
  });

  it('refuses a party too big, a past event, or a hold ending after the event', async () => {
    const h = await hotel();
    const tooBig = await h.hold({ expectedGuests: 121 });
    expect(tooBig.status).toBe(400);
    expect(JSON.stringify(tooBig.body)).toContain('seats 120');
    expect(
      (await h.hold({ startsAt: '2026-11-01T10:00:00Z', endsAt: '2026-11-01T12:00:00Z' })).status,
    ).toBe(400);
    expect((await h.hold({ holdUntil: '2026-12-06T09:00:00Z' })).status).toBe(400);
    expect((await h.hold({ holdUntil: '2026-11-09T09:00:00Z' })).status).toBe(400);
  });

  it('needs event.hold; another space’s layout won’t do', async () => {
    const h = await hotel();
    const other = await h.ok<SpaceOut>(h.gm.post('/spaces', { ...SPACE, code: 'B', name: 'B' }));
    expect((await h.hold({ layoutId: other.layouts[0]?.id })).status).toBe(400);
    const res = await h.fd.send('/event-bookings', {
      spaceId: h.space.id,
      layoutId: h.layout,
      title: 'X',
      startsAt: '2026-12-07T10:00:00Z',
      endsAt: '2026-12-07T16:00:00Z',
      expectedGuests: 10,
      holdUntil: '2026-11-13T09:00:00Z',
    });
    expect(res.status).toBe(403);
  });

  it('is off when the module is switched off for the group', async () => {
    const h = await hotel();
    await db.featureFlag.create({
      data: { organisationId: h.org.id, module: 'events', enabled: false },
    });
    const off = await h.gm.get('/spaces');
    expect(off.status).toBe(403);
    expect(errorOf(off).code).toBe('MODULE_DISABLED');
  });
});
