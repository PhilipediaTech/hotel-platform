import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { catchUpBusinessDay } from '../../../test/business-day.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient } from '../../../test/hotel.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { sendStayAlerts, stayAlertJob } from './alert-jobs.ts';

// Stay alerts (PRD M14-01 and its AC "a checked-in guest 30 minutes past a 12:00 check-out
// shows on the front desk bell as a late check-out, and posting the fee needs folio.charge";
// T-055): GET /front-desk/alerts, POST /stays/{id}/late-check-out-fee, the property's alert
// settings and the WhatsApp job. Lagos is UTC+1: the 12:00 check-out is 11:00Z.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Alert = {
  kind: string;
  stayId: string;
  guestName: string;
  roomNumber: string | null;
  at: string | null;
  depositDueMinor: string;
  lateFeePosted: boolean;
};
type Alerts = { date: string; lateCheckOutFeeMinor: string | null; data: Alert[] };

const GM_PHONE = '+2348030000001';
const FD_PHONE = '+2348030000002';

/** Ada Obi in room 101 until 2026-11-12 (check-out 12:00 Lagos), as in check-out tests. */
async function hotel(options: Parameters<typeof inHouse>[2] = {}) {
  const h = await inHouse(db, clock, options);
  const gmId = (
    await db.membership.findFirstOrThrow({ where: { propertyId: h.p1.id, roleId: h.role('gm') } })
  ).userId;
  let fd = h.fd;
  let gm = h.gm;
  const at = async (instant: string) => {
    now = new Date(instant);
    await catchUpBusinessDay(db, h.p1.id, now);
    fd = await h.as(h.fdId);
    gm = await h.as(gmId);
  };
  const settings = (stayAlerts: object) =>
    h.ok(
      gm.patch(`/properties/${h.p1.id}`, {
        stayAlerts: {
          dueOutMinutes: 60,
          holdWarningMinutes: 120,
          lateCheckOutFeeMinor: null,
          whatsapp: [],
          ...stayAlerts,
        },
      }),
    );
  const alerts = () => h.ok<Alerts>(fd.get('/front-desk/alerts'));
  const fee = (as = fd) =>
    as.post(`/stays/${h.stayId}/late-check-out-fee`, {}).set('Idempotency-Key', randomUUID());
  return {
    ...h,
    gmId,
    get fd() {
      return fd;
    },
    get gm() {
      return gm;
    },
    at,
    settings,
    alerts,
    fee,
  };
}

/** A second booking for `arrival` (one night) with these options. */
async function book(
  h: Awaited<ReturnType<typeof hotel>>,
  arrival: string,
  extra: { guarantee?: string; holdUntil?: string; firstName: string },
) {
  const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
  const plan = await db.ratePlan.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'BAR' } });
  const departure = new Date(`${arrival}T00:00:00Z`);
  departure.setUTCDate(departure.getUTCDate() + 1);
  const quote = await h.ok<{ quoteId: string }>(
    h.fd.post('/quotes', {
      roomTypeId: type.id,
      ratePlanId: plan.id,
      arrival,
      departure: departure.toISOString().slice(0, 10),
      adults: 1,
    }),
  );
  return h.ok<{ id: string; stays: { id: string }[] }>(
    h.fd
      .post('/reservations', {
        source: 'PHONE',
        booker: { firstName: extra.firstName, lastName: 'Test' },
        ...(extra.guarantee ? { guarantee: extra.guarantee } : {}),
        ...(extra.holdUntil ? { holdUntil: extra.holdUntil } : {}),
        stays: [{ quoteId: quote.quoteId }],
      })
      .set('Idempotency-Key', randomUUID()),
  );
}

describe('front desk alerts (M14-01)', () => {
  it('a departure shows as due out within the warning time, then as a late check-out', async () => {
    const h = await hotel();
    await h.at('2026-11-12T09:30:00Z'); // 10:30 in Lagos: 90 minutes to go
    expect((await h.alerts()).data).toEqual([]);

    await h.at('2026-11-12T10:15:00Z'); // 11:15: within the hour
    expect((await h.alerts()).data).toEqual([
      expect.objectContaining({
        kind: 'DUE_OUT_SOON',
        stayId: h.stayId,
        guestName: 'Ada Obi',
        roomNumber: '101',
        at: '2026-11-12T11:00:00Z',
      }),
    ]);

    // The AC: 30 minutes past a 12:00 check-out, a late check-out on the bell.
    await h.at('2026-11-12T11:30:00Z');
    const late = await h.alerts();
    expect(late.data).toEqual([
      expect.objectContaining({
        kind: 'LATE_CHECK_OUT',
        at: '2026-11-12T11:00:00Z',
        lateFeePosted: false,
      }),
    ]);
    expect(late.lateCheckOutFeeMinor).toBeNull();

    // A longer warning time is the property's choice.
    await h.at('2026-11-12T09:30:00Z');
    await h.settings({ dueOutMinutes: 120 });
    expect((await h.alerts()).data.map((a) => a.kind)).toEqual(['DUE_OUT_SOON']);
  });

  it('a guest still in from an earlier departure date is late too; a checked-out guest is not', async () => {
    const h = await hotel();
    await h.at('2026-11-13T08:00:00Z');
    expect((await h.alerts()).data.map((a) => [a.kind, a.at])).toEqual([
      ['LATE_CHECK_OUT', '2026-11-12T11:00:00Z'],
    ]);
    await db.stay.update({
      where: { id: h.stayId },
      data: { status: 'CHECKED_OUT', checkedOutAt: now },
    });
    expect((await h.alerts()).data).toEqual([]);
  });

  it('posts the late check-out fee once, only when late, only with folio.charge', async () => {
    const h = await hotel();
    await h.at('2026-11-12T11:30:00Z');
    // No fee set yet.
    let res = await h.fee();
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: 'NO_FEE_SET' });

    await h.settings({ lateCheckOutFeeMinor: '500000' });
    expect((await h.alerts()).lateCheckOutFeeMinor).toBe('500000');

    // Someone without folio.charge cannot post it.
    const hk = await h.person('hk-attendant', h.p1.id);
    const attendant = await h.as(hk.id);
    res = await h.fee(attendant);
    expect(res.status).toBe(403);

    res = await h.fee();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ folioId: h.folioId, amountMinor: '500000' });
    const folio = await h.folio(h.fd);
    const line = folio.windows[0]?.lines.find((l) => l.revenueCode === 'LATE');
    expect(line).toMatchObject({ description: 'Late check-out fee', amountMinor: '500000' });
    expect((await h.alerts()).data[0]).toMatchObject({
      kind: 'LATE_CHECK_OUT',
      lateFeePosted: true,
    });

    // A second one (a new request, not a retry) is refused.
    res = await h.fee();
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: 'ALREADY_POSTED' });
    const audit = await db.auditEvent.findMany({ where: { action: 'stay.late_fee_posted' } });
    expect(audit).toHaveLength(1);
  });

  it('the property keeps its alert settings: defaults first, checked, audited', async () => {
    const h = await hotel();
    const read = () =>
      h.ok<{ stayAlerts: object }>(h.gm.get(`/properties/${h.p1.id}`)).then((p) => p.stayAlerts);
    expect(await read()).toEqual({
      dueOutMinutes: 60,
      holdWarningMinutes: 120,
      lateCheckOutFeeMinor: null,
      whatsapp: [],
    });
    const bad = await h.gm.patch(`/properties/${h.p1.id}`, {
      stayAlerts: {
        dueOutMinutes: 5,
        holdWarningMinutes: 120,
        lateCheckOutFeeMinor: null,
        whatsapp: ['LATE_CHECK_OUT', 'LATE_CHECK_OUT'],
      },
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad).details).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: 'body.stayAlerts.dueOutMinutes' }),
        expect.objectContaining({ path: 'body.stayAlerts.whatsapp' }),
      ]) as unknown,
    });
    await h.settings({ lateCheckOutFeeMinor: '750000', whatsapp: ['DEPOSIT_MISSING'] });
    expect(await read()).toMatchObject({
      lateCheckOutFeeMinor: '750000',
      whatsapp: ['DEPOSIT_MISSING'],
    });
    // The front desk cannot change them.
    expect((await h.fd.patch(`/properties/${h.p1.id}`, { stayAlerts: {} })).status).toBe(403);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'property.updated' } });
    expect(audit.after).toMatchObject({ stayAlerts: { lateCheckOutFeeMinor: '750000' } });
  });

  it('refuses the fee before the check-out time', async () => {
    const h = await hotel();
    await h.settings({ lateCheckOutFeeMinor: '500000' });
    await h.at('2026-11-12T10:30:00Z');
    const res = await h.fee();
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: 'NOT_LATE', status: 'CHECKED_IN' });
  });

  it('a tentative hold shows within its warning time; tomorrow’s deposit arrivals until paid', async () => {
    const h = await hotel();
    const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
    for (const number of ['102', '103', '104']) {
      await h.ok(h.gm.post('/rooms', { number, roomTypeId: type.id }));
    }
    // Bola's hold ends at 10:30Z; Chi arrives tomorrow on a deposit guarantee.
    await book(h, TODAY, { firstName: 'Bola', holdUntil: '2026-11-10T10:30:00Z' });
    const chi = await book(h, '2026-11-11', { firstName: 'Chi', guarantee: 'DEPOSIT' });
    // A confirmed booking with no deposit asked for gives no alert.
    await book(h, '2026-11-11', { firstName: 'Dayo' });

    const all = (await h.alerts()).data;
    expect(all.map((a) => [a.kind, a.guestName, a.at])).toEqual([
      ['HOLD_EXPIRING', 'Bola Test', '2026-11-10T10:30:00Z'],
      ['DEPOSIT_MISSING', 'Chi Test', null],
    ]);
    const due = all[1]?.depositDueMinor ?? '0';
    expect(BigInt(due)).toBeGreaterThan(0n);

    // A shorter hold warning hides Bola; the deposit coming in clears Chi.
    await db.property.update({
      where: { id: h.p1.id },
      data: { settings: { paymentMethods: ['CASH'], stayAlerts: { holdWarningMinutes: 60 } } },
    });
    await h.ok(h.fd.send('/shifts', { floatMinor: '0' }));
    await h.ok(h.fd.send('/payments', { reservationId: chi.id, method: 'CASH', amountMinor: due }));
    expect((await h.alerts()).data).toEqual([]);
  });

  it('another property’s stays never show, and its fee route answers 404', async () => {
    const h = await hotel();
    await h.settings({ lateCheckOutFeeMinor: '500000' });
    await h.at('2026-11-12T11:30:00Z');
    await db.membership.create({
      data: { userId: h.gmId, organisationId: h.org.id, propertyId: h.p2.id, roleId: h.role('gm') },
    });
    const there = hotelClient(db, clock, h.p2.id).as(await sessionCookie(db, h.gmId, clock));
    const list = await there.get('/front-desk/alerts');
    expect(list.status).toBe(200);
    expect((list.body as Alerts).data).toEqual([]);
    const res = await there
      .post(`/stays/${h.stayId}/late-check-out-fee`, {})
      .set('Idempotency-Key', randomUUID());
    expect(res.status).toBe(404);
  });
});

describe('front desk alerts by WhatsApp (M14-01)', () => {
  it('the chosen kinds reach frontdesk.alerts.notify holders once per stay and day', async () => {
    const h = await hotel();
    await db.user.update({ where: { id: h.gmId }, data: { phone: GM_PHONE } });
    // The front desk has a phone but not the permission: it hears nothing.
    await db.user.update({ where: { id: h.fdId }, data: { phone: FD_PHONE } });
    await h.at('2026-11-12T11:30:00Z');

    // Nothing chosen: nothing sent.
    await sendStayAlerts(db, clock);
    expect(await db.notificationDelivery.count({ where: { templateCode: 'STAY_ALERT' } })).toBe(0);

    await h.settings({ whatsapp: ['LATE_CHECK_OUT'] });
    await sendStayAlerts(db, clock);
    await stayAlertJob.run({}, { db, clock, logger: silentLogger });
    const sent = await db.notificationDelivery.findMany({ where: { templateCode: 'STAY_ALERT' } });
    // The owner holds every permission but has no phone; the GM hears once.
    expect(sent.map((d) => d.recipient)).toEqual([GM_PHONE]);
    expect((sent[0]?.payload as { vars: Record<string, string> }).vars).toEqual({
      property_name: expect.any(String) as string,
      alert: 'Late check-out',
      detail:
        'Room 101, Ada Obi (' +
        (await confirmation(h.reservationId)) +
        '): check-out was due at 12:00.',
    });
  });

  it('a late check-out with its fee posted is not sent; a property in setup sends nothing', async () => {
    const h = await hotel();
    await db.user.update({ where: { id: h.gmId }, data: { phone: GM_PHONE } });
    await h.settings({ whatsapp: ['LATE_CHECK_OUT'], lateCheckOutFeeMinor: '500000' });
    await h.at('2026-11-12T11:30:00Z');
    await h.ok(h.fee());
    await sendStayAlerts(db, clock);
    expect(await db.notificationDelivery.count({ where: { templateCode: 'STAY_ALERT' } })).toBe(0);

    await db.property.update({ where: { id: h.p1.id }, data: { status: 'SETUP' } });
    expect(await sendStayAlerts(db, clock)).toBe(0);
  });
});

async function confirmation(reservationId: string) {
  return (await db.reservation.findUniqueOrThrow({ where: { id: reservationId } })).confirmationNo;
}

const silentLogger = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Parameters<typeof stayAlertJob.run>[1]['logger'];
