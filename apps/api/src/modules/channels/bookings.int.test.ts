import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelError } from '../../core/channel-manager.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { BOOKINGS_WAITING, channelBookingsHandler, pullBookings } from './bookings.ts';

// OTA bookings in from the channel manager (PRD M11-07, AC "an OTA booking imported twice
// creates one reservation"; T-153). The hotel has room type Standard (room 101, one room), with
// Ada Obi in house on 10 and 11 November, and the plan BAR at NGN 100,000 a night, connected.

const db = testDb();
let now = new Date('2026-11-10T09:00:00Z');
const clock = () => new Date(now);

beforeEach(async () => {
  now = new Date('2026-11-10T09:00:00Z');
  await resetDb(db);
});

type Booking = {
  id: string;
  kind: string;
  outcome: string;
  holdReason: string | null;
  message: string | null;
  guestName: string;
  confirmationNo: string | null;
  reservationId: string | null;
};

async function hotel() {
  const h = await inHouse(db, clock);
  const bar = await db.ratePlan.findFirstOrThrow({ where: { code: 'BAR' } });
  await h.ok(h.gm.send('/channel-connection', { ratePlanIds: [bar.id] }));
  const connection = await db.channelConnection.findFirstOrThrow();
  const mappings = await db.channelMapping.findMany();
  const ext = {
    property: connection.externalPropertyId ?? '',
    std: mappings.find((m) => m.kind === 'ROOM_TYPE')?.externalId ?? '',
    bar: mappings.find((m) => m.ratePlanId === bar.id)?.externalId ?? '',
  };
  const deps = { db, clock, channel: h.channel };
  const pull = () => pullBookings(deps, connection.id);
  let inserted = 0;
  /** Puts a revision in the feed, as Channex would (each later than the one before). */
  const offer = (
    bookingId: string,
    attributes: Record<string, unknown> = {},
    id = randomUUID(),
  ) => {
    inserted += 1;
    const revision = {
      id,
      attributes: {
        booking_id: bookingId,
        property_id: ext.property,
        status: 'new',
        ota_name: 'Booking.com',
        ota_reservation_code: '9996013801',
        currency: 'NGN',
        arrival_date: '2026-11-12',
        departure_date: '2026-11-14',
        payment_collect: 'ota',
        inserted_at: `2026-11-10T08:${String(inserted).padStart(2, '0')}:00.000000`,
        customer: {
          name: 'John',
          surname: 'Doe',
          mail: 'John.Doe@example.test',
          phone: '+234 801 234 5678',
        },
        guarantee: { card_number: '411111******1111', card_type: 'VI' },
        rooms: [room()],
        ...attributes,
      },
    };
    h.channel.feed.set(ext.property, [...(h.channel.feed.get(ext.property) ?? []), revision]);
    return revision;
  };
  const room = (over: Record<string, unknown> = {}) => ({
    room_type_id: ext.std,
    rate_plan_id: ext.bar,
    checkin_date: '2026-11-12',
    checkout_date: '2026-11-14',
    occupancy: { adults: 2, children: 0, infants: 0 },
    days: { '2026-11-12': '90000.00', '2026-11-13': '95000.00' },
    amount: '185000.00',
    ...over,
  });
  const otaBookings = () => db.reservation.findMany({ where: { source: 'OTA_CHANNEL' } });
  const sold = async (date: string) =>
    (
      await db.roomTypeInventory.findFirstOrThrow({
        where: { date: new Date(`${date}T00:00:00Z`) },
      })
    ).sold;
  const list = (held = false) =>
    h.ok<Booking[]>(h.gm.get(`/channel-bookings${held ? '?held=true' : ''}`));
  return { ...h, bar, connection, ext, pull, offer, room, otaBookings, sold, list, deps };
}

describe('taking OTA bookings in (M11-07)', () => {
  it('saves a booking before acknowledging it, books it at the OTA’s prices, and only once', async () => {
    const h = await hotel();
    // The revision must already be saved, guest details and all, when Channex is told.
    const ack = h.channel.ackBookingRevision.bind(h.channel);
    const savedAtAck: (string | null)[] = [];
    h.channel.ackBookingRevision = async (id) => {
      const row = await db.channelBookingRevision.findFirst({ where: { externalId: id } });
      savedAtAck.push(row?.guestName ?? null);
      return ack(id);
    };
    const rev = h.offer('bk-1');
    expect(await h.pull()).toBe('DONE');
    expect(savedAtAck).toEqual(['John Doe']);
    expect(h.channel.acked).toEqual([rev.id]);
    expect(h.channel.feed.get(h.ext.property)).toEqual([]);

    const [booking] = await h.otaBookings();
    expect(booking).toMatchObject({ channelRef: 'bk-1', status: 'CONFIRMED', guarantee: 'NONE' });
    expect(booking?.notes).toBe('Booking.com 9996013801 · Paid to the OTA');
    const r = await h.ok<{
      booker: { firstName: string; lastName: string; email: string; phone: string };
      stays: { arrival: string; departure: string; adults: number; nights: unknown[] }[];
    }>(h.fd.get(`/reservations/${booking?.id}`));
    expect(r.booker).toMatchObject({
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.test',
      phone: '+2348012345678',
    });
    expect(r.stays).toEqual([
      expect.objectContaining({
        arrival: '2026-11-12',
        departure: '2026-11-14',
        adults: 2,
        nights: [
          { date: '2026-11-12', amountMinor: '9000000' },
          { date: '2026-11-13', amountMinor: '9500000' },
        ],
      }),
    ]);
    expect([await h.sold('2026-11-12'), await h.sold('2026-11-13')]).toEqual([1, 1]);

    // Kept as sent, without the card.
    const row = await db.channelBookingRevision.findFirstOrThrow();
    expect(row).toMatchObject({ outcome: 'APPLIED', kind: 'NEW', reservationId: booking?.id });
    expect(row.ackedAt).not.toBeNull();
    expect(row.payload).not.toHaveProperty('guarantee');
    expect(row.payload).toHaveProperty('customer.mail', 'John.Doe@example.test');

    // Sent again (not acknowledged in time, or a second revision with the same picture).
    h.offer('bk-1', {}, rev.id);
    h.offer('bk-1');
    expect(await h.pull()).toBe('DONE');
    expect(await h.otaBookings()).toHaveLength(1);
    expect(await h.sold('2026-11-12')).toBe(1);
    const all = await h.list();
    expect(all.map((b) => [b.outcome, b.message])).toEqual([
      ['APPLIED', 'No change'],
      // Applied stays applied: only revisions still waiting or held are superseded.
      ['APPLIED', 'Booked'],
    ]);
    expect(all[0]?.confirmationNo).toBe(booking?.confirmationNo);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'reservation.created', entityId: booking?.id },
    });
    expect(audit.actorType).toBe('SYSTEM');
  });

  it('applies a change and a cancellation (no fee here), and only the latest picture', async () => {
    const h = await hotel();
    h.offer('bk-2');
    await h.pull();
    // Moved a night later, at a new price.
    h.offer('bk-2', {
      status: 'modified',
      arrival_date: '2026-11-13',
      departure_date: '2026-11-15',
      rooms: [
        h.room({
          checkin_date: '2026-11-13',
          checkout_date: '2026-11-15',
          days: { '2026-11-13': '100000.00', '2026-11-14': '100000.00' },
        }),
      ],
    });
    await h.pull();
    const [moved] = await db.stay.findMany({
      where: { reservation: { channelRef: 'bk-2' } },
      include: { nights: true },
    });
    expect(moved?.arrival.toISOString().slice(0, 10)).toBe('2026-11-13');
    expect(moved?.nights.map((n) => n.amountMinor)).toEqual([10000000n, 10000000n]);
    expect([
      await h.sold('2026-11-12'),
      await h.sold('2026-11-13'),
      await h.sold('2026-11-14'),
    ]).toEqual([0, 1, 1]);

    h.offer('bk-2', { status: 'cancelled' });
    await h.pull();
    const [cancelled] = await h.otaBookings();
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'OTA_CANCELLED' });
    expect(await h.sold('2026-11-13')).toBe(0);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'reservation.cancelled', entityId: cancelled?.id },
    });
    expect(audit.after).toMatchObject({ feeMinor: '0', feePosted: false });

    // A booking made and changed before we read the feed: only the change is booked.
    h.offer('bk-3', { rooms: [h.room({ occupancy: { adults: 1 } })] });
    h.offer('bk-3', { status: 'modified', rooms: [h.room({ occupancy: { adults: 2 } })] });
    await h.pull();
    const three = await db.stay.findFirstOrThrow({
      where: { reservation: { channelRef: 'bk-3' } },
    });
    expect(three.adults).toBe(2);
    const kinds = await db.channelBookingRevision.findMany({
      where: { externalBookingId: 'bk-3' },
      orderBy: { receivedAt: 'asc' },
    });
    expect(kinds.map((k) => [k.kind, k.outcome])).toEqual([
      ['NEW', 'SUPERSEDED'],
      ['MODIFIED', 'APPLIED'],
    ]);
    // A cancellation for a booking never taken in has nothing to cancel.
    h.offer('bk-4', { status: 'cancelled' });
    await h.pull();
    const four = await db.channelBookingRevision.findFirstOrThrow({
      where: { externalBookingId: 'bk-4' },
    });
    expect(four).toMatchObject({ outcome: 'APPLIED', reservationId: null });
  });

  it('holds what cannot be booked safely; staff try again or mark it handled', async () => {
    const h = await hotel();
    h.offer('bk-room', { rooms: [h.room({ room_type_id: 'not-ours' })] });
    h.offer('bk-rate', { rooms: [h.room({ rate_plan_id: 'not-ours' })] });
    h.offer('bk-usd', { currency: 'USD' });
    // 10–11 November: room 101 is taken by Ada Obi.
    h.offer('bk-full', {
      arrival_date: TODAY,
      departure_date: '2026-11-11',
      rooms: [
        h.room({
          checkin_date: TODAY,
          checkout_date: '2026-11-11',
          days: { [TODAY]: '100000.00' },
        }),
      ],
    });
    h.offer('bk-big', { rooms: [h.room({ occupancy: { adults: 3 } })] });
    expect(await h.pull()).toBe('DONE');
    expect(await h.otaBookings()).toHaveLength(0);
    const held = await h.list(true);
    expect(
      held
        .map((b) => [b.holdReason, b.message])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['CURRENCY', 'The booking is in USD; the hotel sells in NGN'],
      ['NO_ROOM', 'No room of this type is left on some nights'],
      ['REFUSED', 'Standard takes at most 2 guests'],
      ['UNMAPPED_RATE', 'The OTA sold a rate plan that is not set up here'],
      ['UNMAPPED_ROOM', 'The OTA sold a room type that is not set up here'],
    ]);
    expect(await h.sold(TODAY)).toBe(1);
    const view = await h.ok<{ connection: { heldBookings: number; bookingsError: null } }>(
      h.gm.get('/channel-connection'),
    );
    expect(view.connection.heldBookings).toBe(5);
    const log = await db.channelSyncLog.findFirstOrThrow({ where: { kind: 'BOOKING' } });
    expect(log).toMatchObject({ status: 'WARNING', items: 5 });

    // Made room: a manager raises the overbooking allowance, and tries again.
    await db.roomTypeInventory.updateMany({
      where: { date: new Date(`${TODAY}T00:00:00Z`) },
      data: { overbookLimit: 1 },
    });
    const full = held.find((b) => b.holdReason === 'NO_ROOM');
    const retried = await h.ok<Booking>(h.gm.send(`/channel-bookings/${full?.id}/retry`));
    expect(retried).toMatchObject({ outcome: 'APPLIED', holdReason: null });
    expect(retried.confirmationNo).toMatch(/-\d{5}$/);
    // Still the wrong currency: held again, with its reason.
    const usd = held.find((b) => b.holdReason === 'CURRENCY');
    expect(await h.ok<Booking>(h.gm.send(`/channel-bookings/${usd?.id}/retry`))).toMatchObject({
      outcome: 'HELD',
      holdReason: 'CURRENCY',
    });
    // Handled by hand.
    const dismissed = await h.ok<Booking>(
      h.gm.send(`/channel-bookings/${usd?.id}/dismiss`, { note: 'Rebooked by phone in NGN' }),
    );
    expect(dismissed.outcome).toBe('DISMISSED');
    expect(dismissed.message).toContain('Handled by hand: Rebooked by phone in NGN');
    const again = await h.gm.send(`/channel-bookings/${usd?.id}/retry`);
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('STATE_TRANSITION_INVALID');
    expect(await db.auditEvent.count({ where: { action: 'channel.booking_dismissed' } })).toBe(1);
    // Front desk without channel.manage cannot see or act on them.
    expect((await h.fd.get('/channel-bookings')).status).toBe(403);
    expect((await h.fd.send(`/channel-bookings/${full?.id}/retry`)).status).toBe(403);
  });

  it('holds a change to the number of rooms, and a change to a booking cancelled here', async () => {
    const h = await hotel();
    h.offer('bk-5');
    await h.pull();
    const [booking] = await h.otaBookings();
    h.offer('bk-5', { status: 'modified', rooms: [h.room(), h.room()] });
    await h.pull();
    const rooms = await h.list(true);
    expect(rooms[0]).toMatchObject({
      holdReason: 'ROOMS_CHANGED',
      reservationId: booking?.id,
      message: 'The OTA now has 2 rooms on this booking (here 1): change it by hand',
    });
    await h.ok(h.fd.send(`/reservations/${booking?.id}/cancel`, { reason: 'HOTEL_REQUEST' }));
    h.offer('bk-5', { status: 'modified' });
    await h.pull();
    const after = await h.list(true);
    expect(after.map((b) => b.holdReason)).toEqual(['CANCELLED_HERE']);
  });

  it('keeps what it took when Channex fails, and carries on next time; nothing while paused', async () => {
    const h = await hotel();
    const rev = h.offer('bk-6');
    h.channel.failNext = {
      method: 'ackBookingRevision',
      error: new ChannelError('Channex could not be reached', null),
    };
    expect(await h.pull()).toBe('FAILED');
    const saved = await db.channelBookingRevision.findFirstOrThrow();
    expect(saved.ackedAt).toBeNull();
    // Saved, so it is booked all the same; the feed still holds it.
    expect(await h.otaBookings()).toHaveLength(1);
    const view = await h.ok<{ connection: { bookingsError: string | null } }>(
      h.gm.get('/channel-connection'),
    );
    expect(view.connection.bookingsError).toBe('Channex could not be reached');
    expect(await h.pull()).toBe('DONE');
    expect(h.channel.acked).toEqual([rev.id]);
    expect(await db.channelBookingRevision.count()).toBe(1);
    expect(await h.otaBookings()).toHaveLength(1);

    await h.ok(h.gm.patch('/channel-connection', { paused: true }));
    h.offer('bk-7');
    expect(await h.pull()).toBe('SKIPPED');
    expect(await h.otaBookings()).toHaveLength(1);
  });
});

describe('the Channex webhook (M4 rule 6)', () => {
  const secret = TEST_CONFIG.channel.webhookSecrets[0] ?? '';
  const post = (
    h: Awaited<ReturnType<typeof hotel>>,
    body: string,
    opts: { key?: string; timestamp?: number; provider?: string } = {},
  ) => {
    const timestamp = String(opts.timestamp ?? Math.floor(now.getTime() / 1000));
    const signature = createHmac('sha256', opts.key ?? secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    return request(h.app)
      .post(`/api/v1/webhooks/channel/${opts.provider ?? 'channex'}`)
      .set('Content-Type', 'application/json')
      .set('x-hmac-timestamp', timestamp)
      .set('x-hmac-signature-256', signature)
      .send(body);
  };

  it('takes signed calls once, and a booking event reads the feed at once', async () => {
    const h = await hotel();
    const body = JSON.stringify({
      event: 'booking',
      payload: { booking_id: 'bk-8', property_id: h.ext.property, revision_id: 'r-8' },
      property_id: h.ext.property,
      user_id: null,
      timestamp: '2026-11-10T09:00:00.000Z',
    });
    const bad = await post(h, body, { key: 'not-the-secret-0000000' });
    expect(bad.status).toBe(401);
    const old = await post(h, body, { timestamp: Math.floor(now.getTime() / 1000) - 600 });
    expect(old.status).toBe(401);
    expect((await post(h, body, { provider: 'other' })).status).toBe(404);
    expect(await db.webhookEvent.count()).toBe(0);

    expect((await post(h, body)).status).toBe(200);
    expect((await post(h, body)).status).toBe(200);
    expect(await db.webhookEvent.count({ where: { provider: 'CHANNEX' } })).toBe(1);
    const events = await db.domainEvent.findMany({ where: { type: BOOKINGS_WAITING } });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ connectionId: h.connection.id });

    // The handler reads the feed (the webhook is only the signal; the booking comes from it).
    h.offer('bk-8');
    const event = events[0];
    await channelBookingsHandler(h.deps).handle({
      id: String(event?.id),
      organisationId: event?.organisationId ?? '',
      propertyId: event?.propertyId ?? null,
      type: BOOKINGS_WAITING,
      payload: event?.payload as Record<string, unknown>,
      occurredAt: now,
    });
    expect(await h.otaBookings()).toHaveLength(1);

    // Other events, and other properties, are stored but read nothing.
    const other = JSON.stringify({ event: 'ari', property_id: h.ext.property, timestamp: 'x' });
    const stranger = JSON.stringify({ event: 'booking', property_id: 'not-ours', timestamp: 'y' });
    expect((await post(h, other)).status).toBe(200);
    expect((await post(h, stranger)).status).toBe(200);
    expect(await db.domainEvent.count({ where: { type: BOOKINGS_WAITING } })).toBe(1);
  });
});
