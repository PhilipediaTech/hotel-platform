import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { APP_ORIGIN, errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import type { FileStore } from '../../core/files.ts';
import { settleIntent } from '../payments/intents.ts';
import { idPurgeJob } from '../reservations/check-in.ts';

// Online check-in before arrival (PRD M3-20, M11-06; T-114).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

const ARRIVAL = '2026-11-20';
const SETTINGS = {
  slug: 'demo-lagos',
  enabled: true,
  headline: null,
  description: null,
  policies: null,
  photoFileIds: [],
  allowPayFull: true,
  allowDeposit: true,
  depositBps: 3000,
  allowPayAtHotel: true,
};
const DETAILS = {
  nationality: 'NG',
  purpose: 'LEISURE',
  idType: 'PASSPORT',
  idNumber: 'A12345678',
  arrivalTime: '15:30',
  consent: true,
};

type Info = {
  closedReason: string | null;
  requiredFields: string[];
  submittedAt: string | null;
  dueMinor: string;
};

async function hotel() {
  const h = await inHouse(db, clock);
  const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
  const bar = await db.ratePlan.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'BAR' } });
  await db.ratePlan.update({ where: { id: bar.id }, data: { isPublic: true } });
  await h.ok(h.gm.put('/booking-engine/settings', SETTINGS));
  const post = (path: string, body: object) =>
    request(h.app).post(`/public/v1${path}`).set('Origin', APP_ORIGIN).send(body);
  const get = (path: string) => request(h.app).get(`/public/v1${path}`).set('Origin', APP_ORIGIN);
  const book = async (over: object = {}) => {
    const res = await post('/bookings', {
      slug: 'demo-lagos',
      bookingKey: randomUUID(),
      roomTypeId: type.id,
      ratePlanId: bar.id,
      arrival: ARRIVAL,
      departure: '2026-11-22',
      adults: 1,
      firstName: 'Bisi',
      lastName: 'Adeyemi',
      email: 'bisi@guest.test',
      phone: '+2348031110000',
      payment: 'AT_HOTEL',
      ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { token, confirmationNo } = res.body as { token: string; confirmationNo: string };
    const reservation = await db.reservation.findFirstOrThrow({ where: { confirmationNo } });
    const stay = await db.stay.findFirstOrThrow({ where: { reservationId: reservation.id } });
    return { token, reservation, stay };
  };
  return { ...h, post, get, book, type };
}

describe('online check-in (M3-20)', () => {
  it('says what the hotel requires and keeps only that, the ID number encrypted', async () => {
    const h = await hotel();
    const { token, stay } = await h.book();
    const info = (await h.get(`/bookings/${token}/check-in`)).body as Info;
    expect(info).toMatchObject({ closedReason: null, submittedAt: null });
    expect(info.requiredFields).toEqual(['nationality', 'purpose', 'idType', 'idNumber']);

    const res = await h.post(`/bookings/${token}/check-in`, {
      ...DETAILS,
      address: 'Not required here',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as Info).submittedAt).toBeTruthy();

    const row = await db.onlineCheckIn.findUniqueOrThrow({ where: { stayId: stay.id } });
    expect(row.details).toEqual({ nationality: 'NG', purpose: 'LEISURE', idType: 'PASSPORT' });
    expect(row.arrivalTime).toBe('15:30');
    expect(Buffer.from(row.idNumberEnc as Uint8Array).toString('latin1')).not.toContain('A12345');
    expect(row.purgeAfter.toISOString().slice(0, 10)).toBe('2026-11-29');
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'stay.online_check_in' },
    });
    expect(JSON.stringify(audit.after)).not.toContain('A12345');
  });

  it('refuses a missing field, no consent, a wrong link', async () => {
    const h = await hotel();
    const { token } = await h.book();
    const short = await h.post(`/bookings/${token}/check-in`, { ...DETAILS, idNumber: undefined });
    expect(short.status).toBe(400);
    expect(errorOf(short).details).toMatchObject({
      issues: [expect.objectContaining({ path: 'body.idNumber' })],
    });
    expect(
      (await h.post(`/bookings/${token}/check-in`, { ...DETAILS, consent: false })).status,
    ).toBe(400);
    expect((await h.get(`/bookings/${'x'.repeat(43)}/check-in`)).status).toBe(404);
    expect(await db.onlineCheckIn.count()).toBe(0);
  });

  it('is closed until paid, once cancelled, and after arrival day', async () => {
    const h = await hotel();
    const held = await h.book({ payment: 'FULL' });
    expect(((await h.get(`/bookings/${held.token}/check-in`)).body as Info).closedReason).toBe(
      'PAY_FIRST',
    );
    expect((await h.post(`/bookings/${held.token}/check-in`, DETAILS)).status).toBe(409);
    await h.post(`/bookings/${held.token}/cancel`, {});
    expect(((await h.get(`/bookings/${held.token}/check-in`)).body as Info).closedReason).toBe(
      'NOT_ACTIVE',
    );
  });

  it('takes an ID upload held against the link; another link’s file is refused', async () => {
    const h = await hotel();
    const a = await h.book();
    const upload = await h.post(`/bookings/${a.token}/check-in/id-upload`, {
      contentType: 'image/jpeg',
      sizeBytes: 1000,
    });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const { fileId } = upload.body as { fileId: string };
    expect(await db.fileObject.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({
      entityType: 'IdDocument',
      uploadedById: null,
    });
    expect(
      (
        await h.post(`/bookings/${a.token}/check-in/id-upload`, {
          contentType: 'text/csv',
          sizeBytes: 10,
        })
      ).status,
    ).toBe(400);

    await db.stay.update({
      where: { id: a.stay.id },
      data: { departure: new Date(a.stay.departure) },
    });
    const other = await h.book({ arrival: '2026-11-24', departure: '2026-11-25' });
    const res = await h.post(`/bookings/${other.token}/check-in`, {
      ...DETAILS,
      idFileId: fileId,
    });
    expect(res.status).toBe(400);
    expect(
      (await h.post(`/bookings/${a.token}/check-in`, { ...DETAILS, idFileId: fileId })).status,
    ).toBe(200);
  });

  it('the guest pays the balance from the link, once per amount', async () => {
    const h = await hotel();
    const { token, reservation } = await h.book();
    const first = await h.post(`/bookings/${token}/pay`, {});
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await h.post(`/bookings/${token}/pay`, {});
    expect((again.body as { paymentUrl: string }).paymentUrl).toBe(
      (first.body as { paymentUrl: string }).paymentUrl,
    );
    expect(await db.paymentIntent.count({ where: { reservationId: reservation.id } })).toBe(1);
    const intent = await db.paymentIntent.findFirstOrThrow({
      where: { reservationId: reservation.id },
    });
    h.payments.complete(intent.providerRef, 'SUCCEEDED', now);
    await settleIntent({ db, clock, provider: h.payments }, intent.id);
    const info = (await h.get(`/bookings/${token}/check-in`)).body as Info;
    expect(info.dueMinor).toBe('0');
    expect((await h.post(`/bookings/${token}/pay`, {})).status).toBe(409);
  });
});

describe('at the desk (M3-20)', () => {
  it('shows what the guest gave, masked, only with the check-in permission', async () => {
    const h = await hotel();
    const { token, stay } = await h.book();
    expect(await h.ok(h.fd.get(`/stays/${stay.id}/online-check-in`))).toEqual({ submitted: null });
    await h.post(`/bookings/${token}/check-in`, DETAILS);
    const view = await h.ok<{ submitted: { idNumberMasked: string; arrivalTime: string } }>(
      h.fd.get(`/stays/${stay.id}/online-check-in`),
    );
    expect(view.submitted).toMatchObject({ idNumberMasked: '•••• 5678', arrivalTime: '15:30' });
    const hk = await h.person('hk-attendant', h.p1.id);
    const attendant = await h.as(hk.id);
    expect((await attendant.get(`/stays/${stay.id}/online-check-in`)).status).toBe(403);
  });

  it('check-in uses the online details and then clears them', async () => {
    const h = await hotel();
    const room = await h.ok<{ id: string }>(
      h.gm.post('/rooms', { number: '102', roomTypeId: h.type.id }),
    );
    await db.room.update({ where: { id: room.id }, data: { hkStatus: 'CLEAN' } });
    const fresh = await h.book({ arrival: '2026-11-10', departure: '2026-11-11' });
    await h.post(`/bookings/${fresh.token}/check-in`, DETAILS);

    const res = await h.fd
      .send(`/stays/${fresh.stay.id}/check-in`, { roomId: room.id, useOnlineCheckIn: true })
      .set('If-Match', `"${fresh.stay.version}"`);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await db.onlineCheckIn.count()).toBe(0);
    const doc = await db.idDocument.findFirstOrThrow({ where: { guestId: fresh.stay.guestId } });
    expect(doc.docType).toBe('PASSPORT');
    expect(doc.numberEnc).not.toBeNull();
  });

  it('emails a link for a booking made at the desk, and keeps the one link', async () => {
    const h = await hotel();
    await db.reservation.update({ where: { id: h.reservationId }, data: { status: 'CONFIRMED' } });
    const r = await db.reservation.findUniqueOrThrow({ where: { id: h.reservationId } });
    await db.guest.update({ where: { id: r.bookerGuestId }, data: { email: 'ada@guest.test' } });
    const sent = await h.ok<{ sentTo: string }>(
      h.fd.send(`/reservations/${h.reservationId}/guest-link`, {}),
    );
    expect(sent.sentTo).toBe('ada@guest.test');
    const text = h.email.lastTo('ada@guest.test')?.text ?? '';
    const token = /manage\?token=(\S+)/.exec(text)?.[1] ?? '';
    const opened = await h.get(`/bookings/${token}/check-in`);
    expect(opened.status, `${text} :: ${JSON.stringify(opened.body)}`).toBe(200);
    await h.ok(h.fd.send(`/reservations/${h.reservationId}/guest-link`, {}));
    expect(await db.guestLink.count({ where: { reservationId: h.reservationId } })).toBe(1);
  });

  it('a no-show’s details and ID are deleted a week after the stay', async () => {
    const h = await hotel();
    const { token, stay } = await h.book();
    const upload = await h.post(`/bookings/${token}/check-in/id-upload`, {
      contentType: 'image/jpeg',
      sizeBytes: 1000,
    });
    const { fileId } = upload.body as { fileId: string };
    await h.post(`/bookings/${token}/check-in`, { ...DETAILS, idFileId: fileId });
    const deleted: string[] = [];
    const store = {
      delete: (key: string) => {
        deleted.push(key);
        return Promise.resolve();
      },
    } as unknown as FileStore;
    const logger = { info: () => undefined } as unknown as Logger;
    const job = idPurgeJob({ store });
    now = new Date('2026-11-28T09:00:00Z');
    await job.run({}, { db, clock, logger });
    expect(await db.onlineCheckIn.count({ where: { stayId: stay.id } })).toBe(1);
    now = new Date('2026-11-29T09:00:00Z');
    await job.run({}, { db, clock, logger });
    expect(await db.onlineCheckIn.count({ where: { stayId: stay.id } })).toBe(0);
    expect(await db.fileObject.count({ where: { id: fileId } })).toBe(0);
    expect(deleted).toHaveLength(1);
  });
});
