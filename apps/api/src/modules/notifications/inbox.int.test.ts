import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { FAKE_WHATSAPP_SECRET, signBody } from '../../core/messaging.ts';
import { randomUUID } from 'node:crypto';

// The two-way WhatsApp inbox (PRD M11-04; M11 rules: "WhatsApp sends only approved templates
// outside the 24-hour window"; "guests can opt out of marketing messages"; T-115).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

const PHONE = '+2348031234567';

type Thread = {
  id: string;
  phone: string;
  guest: { name: string } | null;
  reservation: { confirmationNo: string } | null;
  unreadCount: number;
  windowOpen: boolean;
  lastPreview: string;
};
type Msg = { direction: string; kind: string; body: string; status: string; sentBy: string | null };
type Detail = Thread & { messages: Msg[] };

async function hotel() {
  const h = await inHouse(db, clock);
  const res = await db.reservation.findUniqueOrThrow({ where: { id: h.reservationId } });
  await db.guest.update({ where: { id: res.bookerGuestId }, data: { phone: PHONE } });
  const webhook = (messages: object[], statuses: object[] = []) => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages, statuses } }] }] });
    return request(h.app)
      .post('/api/v1/webhooks/whatsapp/fake')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signBody(FAKE_WHATSAPP_SECRET, body))
      .send(body);
  };
  const say = (text: string, id: string = randomUUID(), from = PHONE.slice(1)) =>
    webhook([{ id, from, type: 'text', text: { body: text } }]);
  const threads = () => h.ok<{ data: Thread[] }>(h.fd.get('/message-threads'));
  const open = (id: string) => h.ok<Detail>(h.fd.get(`/message-threads/${id}`));
  const reply = (id: string, body = 'Your room is ready') =>
    h.fd.send(`/message-threads/${id}/messages`, { body });
  return { ...h, webhook, say, threads, open, reply, res };
}

describe('incoming messages (M11-04)', () => {
  it('opens a conversation linked to the guest and their booking', async () => {
    const h = await hotel();
    const res = await h.say('Hello, can I check out late?');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [t] = (await h.threads()).data;
    expect(t).toMatchObject({
      phone: PHONE,
      guest: { name: 'Ada Obi' },
      reservation: { confirmationNo: h.res.confirmationNo },
      unreadCount: 1,
      windowOpen: true,
      lastPreview: 'Hello, can I check out late?',
    });
    const detail = await h.open(t?.id ?? '');
    expect(detail.messages).toMatchObject([
      { direction: 'IN', kind: 'TEXT', body: 'Hello, can I check out late?', status: 'RECEIVED' },
    ]);
  });

  it('holds a message once, however often it is delivered', async () => {
    const h = await hotel();
    const id = randomUUID();
    await h.say('Once', id);
    await h.say('Once', id);
    const [t] = (await h.threads()).data;
    expect(t?.unreadCount).toBe(1);
    expect(await db.message.count()).toBe(1);
  });

  it('a photo shows as a placeholder; a phone no hotel knows is dropped', async () => {
    const h = await hotel();
    await h.webhook([{ id: randomUUID(), from: PHONE.slice(1), type: 'image', image: {} }]);
    const [t] = (await h.threads()).data;
    expect((await h.open(t?.id ?? '')).messages[0]).toMatchObject({
      kind: 'OTHER',
      body: '[Photo]',
    });
    await h.say('Who are you?', randomUUID(), '2348099999999');
    expect(await db.messageThread.count()).toBe(1);
  });

  it('a bad signature changes nothing', async () => {
    const h = await hotel();
    const res = await request(h.app)
      .post('/api/v1/webhooks/whatsapp/fake')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', 'sha256=bad')
      .send(JSON.stringify({ entry: [] }));
    expect(res.status).toBe(401);
  });

  it('goes to the hotel that was last in touch with the phone', async () => {
    const h = await hotel();
    await h.say('First');
    now = new Date(now.getTime() + 60_000);
    await db.notificationDelivery.create({
      data: {
        propertyId: h.p2.id,
        channel: 'WHATSAPP',
        templateCode: 'STAY_ALERT',
        recipient: PHONE,
        payload: {},
        createdAt: now,
      },
    });
    now = new Date(now.getTime() + 60_000);
    await h.say('Second');
    expect((await db.messageThread.findMany()).map((t) => t.propertyId).sort()).toEqual(
      [h.p1.id, h.p2.id].sort(),
    );
  });

  it('STOP takes the guest off marketing', async () => {
    const h = await hotel();
    await db.guest.update({
      where: { id: h.res.bookerGuestId },
      data: { marketingConsent: true, consentAt: now },
    });
    await h.say('stop');
    expect(await db.guest.findUniqueOrThrow({ where: { id: h.res.bookerGuestId } })).toMatchObject({
      marketingConsent: false,
      consentAt: null,
    });
  });
});

describe('replying (M11-04, M11 rule)', () => {
  it('sends free text within 24 hours, by the staff member, and follows its delivery', async () => {
    const h = await hotel();
    await h.say('Hi');
    const [t] = (await h.threads()).data;
    now = new Date(now.getTime() + 23 * 3_600_000);
    const fresh = await h.as(h.fdId); // The earlier sign-in has timed out by now.
    const res = await fresh.send(`/message-threads/${t?.id ?? ''}/messages`, {
      body: 'Your room is ready',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ direction: 'OUT', kind: 'TEXT', status: 'SENT' });
    expect(h.messages.sentTexts).toMatchObject([{ to: PHONE, body: 'Your room is ready' }]);

    const ref = h.messages.sentTexts[0]?.providerRef ?? '';
    await h.webhook([], [{ id: ref, status: 'read' }]);
    const row = await db.message.findUniqueOrThrow({ where: { providerRef: ref } });
    expect(row.status).toBe('READ');
    expect(row.sentById).toBe(h.fdId);
  });

  it('after 24 hours free text is refused and the template goes instead', async () => {
    const h = await hotel();
    await h.say('Hi');
    const [t] = (await h.threads()).data;
    now = new Date(now.getTime() + 24 * 3_600_000 + 1000);
    const fd = await h.as(h.fdId);
    const res = await fd.send(`/message-threads/${t?.id ?? ''}/messages`, { body: 'Late' });
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: 'WINDOW_CLOSED' });
    expect(h.messages.sentTexts).toEqual([]);

    const follow = await fd.send(`/message-threads/${t?.id ?? ''}/follow-up`, {});
    expect(follow.status, JSON.stringify(follow.body)).toBe(201);
    expect(follow.body).toMatchObject({ kind: 'TEMPLATE', status: 'QUEUED' });
    expect((follow.body as Msg).body).toContain('Ada');
    expect(
      await db.notificationDelivery.count({
        where: { templateCode: 'GUEST_FOLLOW_UP', recipient: PHONE, channel: 'WHATSAPP' },
      }),
    ).toBe(1);
  });

  it('a failed send is kept and shown as failed', async () => {
    const h = await hotel();
    await h.say('Hi');
    const [t] = (await h.threads()).data;
    h.messages.failNext(1, true);
    const res = await h.reply(t?.id ?? '');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'FAILED' });
  });

  it('marks as read, and needs message.send', async () => {
    const h = await hotel();
    await h.say('Hi');
    const [t] = (await h.threads()).data;
    await h.ok(h.fd.post(`/message-threads/${t?.id ?? ''}/read`, {}));
    expect((await h.threads()).data[0]?.unreadCount).toBe(0);
    expect((await h.ok<{ data: Thread[] }>(h.fd.get('/message-threads?unread=true'))).data).toEqual(
      [],
    );
    const hk = await h.person('hk-attendant', h.p1.id);
    const attendant = await h.as(hk.id);
    expect((await attendant.get('/message-threads')).status).toBe(403);
  });
});
