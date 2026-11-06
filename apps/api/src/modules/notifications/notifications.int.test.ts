import { messageTemplateDef } from '@hotel/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { issueApprovalOtp } from '../../core/approvals.ts';
import { createFakeEmailProvider } from '../../core/email.ts';
import { createLogger } from '../../core/logger.ts';
import {
  createFakeMessageProvider,
  FAKE_WHATSAPP_SECRET,
  FAKE_WHATSAPP_VERIFY_TOKEN,
  signBody,
} from '../../core/messaging.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { APP_ORIGIN, errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';
import {
  MAX_SEND_ATTEMPTS,
  queueMessage,
  sendDelivery,
  whatsappOtpChannel,
  type SendDeps,
} from './delivery.ts';
import { TEST_MESSAGES_PER_HOUR } from './service.ts';

// Notification adapters and templates (T-024; PRD M11-05, M11 rules; tab 2 "Integrations";
// tab 3 `message_templates`, `notification_deliveries`; tab 4 rows "Messaging", "Webhooks").

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const logger = createLogger({ ...TEST_CONFIG, logLevel: 'silent' });

beforeEach(async () => {
  await resetDb(db);
  now = new Date();
});

const BOOKING_VARS = {
  guest_name: 'Ada Okafor',
  property_name: 'Obi Lagos',
  confirmation_no: 'P1-1001',
  arrival: '12 Dec 2026',
  departure: '15 Dec 2026',
  room_type: 'Deluxe King',
  total: '₦135,000.00',
};

async function setup() {
  const h = await makeHotel(db, now);
  const messages = createFakeMessageProvider();
  const email = createFakeEmailProvider();
  const deps: SendDeps = { db, messages, email, clock, logger };
  const queue = (input: Partial<Parameters<typeof queueMessage>[1]> = {}) =>
    queueMessage(db, {
      organisationId: h.org.id,
      propertyId: h.p1.id,
      channel: 'WHATSAPP',
      templateCode: 'BOOKING_CONFIRMED',
      recipient: '+2348031234567',
      vars: BOOKING_VARS,
      ...input,
    });
  const delivery = (id: string) => db.notificationDelivery.findUniqueOrThrow({ where: { id } });
  return { h, messages, email, deps, queue, delivery };
}

describe('queue and send (tab 2 "Integrations")', () => {
  it('queues a delivery with its event; the sender fills the numbered WhatsApp template once', async () => {
    const { h, messages, deps, queue, delivery } = await setup();
    const id = await queue();
    expect(await delivery(id)).toMatchObject({ status: 'QUEUED', attempts: 0 });
    const event = await db.domainEvent.findFirstOrThrow({ where: { type: 'notification.queued' } });
    expect(event).toMatchObject({ propertyId: h.p1.id, payload: { deliveryId: id } });

    expect(await sendDelivery(deps, id, h.org.id)).toBe('SENT');
    expect(messages.sent).toEqual([
      expect.objectContaining({
        to: '+2348031234567',
        templateName: 'booking_confirmed',
        language: 'en',
        category: 'UTILITY',
        // {{1}} guest, {{2}} hotel, {{3}} confirmation, {{4}} arrival, {{5}} departure.
        params: ['Ada Okafor', 'Obi Lagos', 'P1-1001', '12 Dec 2026', '15 Dec 2026'],
      }),
    ]);
    const sent = await delivery(id);
    expect(sent).toMatchObject({ status: 'SENT', attempts: 1, lastError: null });
    expect(sent.providerRef).toBe(messages.sent[0]?.providerRef);
    expect(sent.sentAt).toEqual(now);

    // At-least-once delivery of the event: a repeat sends nothing more.
    expect(await sendDelivery(deps, id, h.org.id)).toBe('SENT');
    expect(messages.sent).toHaveLength(1);
  });

  it('refuses to queue a message with a variable missing, or a one-time code', async () => {
    const { queue } = await setup();
    await expect(queue({ vars: { guest_name: 'Ada' } })).rejects.toThrow(/missing property_name/);
    await expect(queue({ templateCode: 'APPROVAL_OTP', vars: { code: '1' } })).rejects.toThrow(
      /one-time code/,
    );
    expect(await db.notificationDelivery.count()).toBe(0);
  });

  it('emails in the organisation’s wording for the language, else English, else the default', async () => {
    const { h, email, deps, queue } = await setup();
    const send = async (language: string) => {
      const id = await queue({ channel: 'EMAIL', recipient: 'ada@example.test', language });
      await sendDelivery(deps, id, h.org.id);
      return email.sent.at(-1);
    };
    expect(await send('fr')).toMatchObject({
      to: 'ada@example.test',
      subject: 'Your booking at Obi Lagos: P1-1001',
      tag: 'booking-confirmed',
    });
    await db.messageTemplate.create({
      data: {
        organisationId: h.org.id,
        code: 'BOOKING_CONFIRMED',
        channel: 'EMAIL',
        language: 'en',
        subject: 'Booked: {{confirmation_no}}',
        body: 'Hi {{guest_name}}, see you on {{arrival}}.',
      },
    });
    expect(await send('fr')).toMatchObject({
      subject: 'Booked: P1-1001',
      text: 'Hi Ada Okafor, see you on 12 Dec 2026.',
    });
    await db.messageTemplate.create({
      data: {
        organisationId: h.org.id,
        code: 'BOOKING_CONFIRMED',
        channel: 'EMAIL',
        language: 'fr',
        subject: 'Réservation {{confirmation_no}}',
        body: 'Bonjour {{guest_name}}, à bientôt le {{arrival}}.',
      },
    });
    expect(await send('fr')).toMatchObject({
      subject: 'Réservation P1-1001',
      text: 'Bonjour Ada Okafor, à bientôt le 12 Dec 2026.',
    });
  });

  it('retries a passing fault; fails at once on a permanent one; gives up after the last attempt', async () => {
    const { h, messages, deps, queue, delivery } = await setup();
    const id = await queue();
    messages.failNext(1);
    await expect(sendDelivery(deps, id, h.org.id)).rejects.toThrow('Fake send failure');
    expect(await delivery(id)).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
      lastError: 'Fake send failure',
    });
    expect(await sendDelivery(deps, id, h.org.id)).toBe('SENT');
    expect(await delivery(id)).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });

    const permanent = await queue();
    messages.failNext(1, true);
    expect(await sendDelivery(deps, permanent, h.org.id)).toBe('FAILED');
    expect(await delivery(permanent)).toMatchObject({ status: 'FAILED', attempts: 1 });

    const stubborn = await queue();
    messages.failNext(MAX_SEND_ATTEMPTS);
    for (let i = 1; i < MAX_SEND_ATTEMPTS; i++) {
      await expect(sendDelivery(deps, stubborn, h.org.id)).rejects.toThrow();
    }
    expect(await sendDelivery(deps, stubborn, h.org.id)).toBe('FAILED');
    expect(await delivery(stubborn)).toMatchObject({
      status: 'FAILED',
      attempts: MAX_SEND_ATTEMPTS,
      lastError: 'Fake send failure',
    });
    expect(messages.sent).toHaveLength(1);
  });
});

/** Meta's status callback shape. */
const statuses = (...s: { id: string; status: string; errors?: object[] }[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { statuses: s } }] }],
});

describe('WhatsApp webhook (tab 4 "Webhooks": signature)', () => {
  async function webhook() {
    const s = await setup();
    const c = hotelClient(db, clock, s.h.p1.id);
    const id = await s.queue();
    await sendDelivery(s.deps, id, s.h.org.id);
    const ref = (await s.delivery(id)).providerRef ?? '';
    const post = (body: object, secret = FAKE_WHATSAPP_SECRET) => {
      const raw = JSON.stringify(body);
      return request(c.app)
        .post('/api/v1/webhooks/whatsapp/fake')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', signBody(secret, raw))
        .send(raw);
    };
    return { ...s, c, id, ref, post };
  }

  it('moves a message forward only: delivered, read; a late callback changes nothing', async () => {
    const { id, ref, post, delivery } = await webhook();
    await post(statuses({ id: ref, status: 'delivered' })).expect(200, { received: true });
    expect((await delivery(id)).status).toBe('DELIVERED');
    await post(statuses({ id: ref, status: 'read' })).expect(200);
    await post(statuses({ id: ref, status: 'delivered' }, { id: ref, status: 'sent' })).expect(200);
    expect((await delivery(id)).status).toBe('READ');
  });

  it('records a failure with the provider’s reason', async () => {
    const { id, ref, post, delivery } = await webhook();
    await post(
      statuses({
        id: ref,
        status: 'failed',
        errors: [{ code: 131026, title: 'Message undeliverable' }],
      }),
    ).expect(200);
    expect(await delivery(id)).toMatchObject({
      status: 'FAILED',
      lastError: '131026: Message undeliverable',
    });
  });

  it('a bad signature answers 401 and changes nothing; another provider name is 404', async () => {
    const { c, id, ref, post, delivery } = await webhook();
    const bad = await post(statuses({ id: ref, status: 'read' }), 'not-the-app-secret');
    expect(bad.status).toBe(401);
    expect(errorOf(bad).code).toBe('UNAUTHENTICATED');
    const unsigned = await request(c.app)
      .post('/api/v1/webhooks/whatsapp/fake')
      .send(statuses({ id: ref, status: 'read' }));
    expect(unsigned.status).toBe(401);
    expect((await delivery(id)).status).toBe('SENT');
    const other = await request(c.app).post('/api/v1/webhooks/whatsapp/twilio').send({});
    expect(other.status).toBe(404);
  });

  it('answers Meta’s webhook check with the challenge as text, only with the verify token', async () => {
    const { c } = await webhook();
    const ok = await request(c.app).get('/api/v1/webhooks/whatsapp/fake').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': FAKE_WHATSAPP_VERIFY_TOKEN,
      'hub.challenge': '1158201444',
    });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/plain/);
    expect(ok.text).toBe('1158201444');
    const wrong = await request(c.app).get('/api/v1/webhooks/whatsapp/fake').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'guess',
      'hub.challenge': '1',
    });
    expect(wrong.status).toBe(403);
  });
});

describe('message templates (M11-05: GM manages templates per language)', () => {
  async function screen() {
    const s = await setup();
    const c = hotelClient(db, clock, s.h.p1.id);
    const gmCookie = await sessionCookie(db, s.h.gm.id);
    const gm = c.as(gmCookie);
    const send = (path: string, body: object, cookie = gmCookie) =>
      request(c.app)
        .post(`/api/v1${path}`)
        .set('Cookie', cookie)
        .set('X-Property-Id', s.h.p1.id)
        .set('Origin', APP_ORIGIN)
        .set('Idempotency-Key', crypto.randomUUID())
        .send(body);
    const reset = (path: string) =>
      request(c.app)
        .delete(`/api/v1/message-templates/${path}`)
        .set('Cookie', gmCookie)
        .set('X-Property-Id', s.h.p1.id)
        .set('Origin', APP_ORIGIN);
    return { ...s, c, gm, gmCookie, send, reset };
  }

  type Listed = {
    code: string;
    channel: string;
    language: string;
    subject: string | null;
    body: string;
    editable: boolean;
    customised: boolean;
    providerTemplateName: string | null;
  };
  const listed = async (gm: { get: (p: string) => request.Test }) =>
    ((await gm.get('/message-templates').expect(200)).body as { templates: Listed[] }).templates;

  it('lists every template in English; WhatsApp wording is Meta-approved and read-only', async () => {
    const { gm } = await screen();
    const templates = await listed(gm);
    const booking = templates.filter((t) => t.code === 'BOOKING_CONFIRMED');
    expect(booking.map((t) => [t.channel, t.language, t.editable, t.customised])).toEqual([
      ['EMAIL', 'en', true, false],
      ['WHATSAPP', 'en', false, false],
    ]);
    expect(booking[1]?.providerTemplateName).toBe('booking_confirmed');
    // Codes go only by WhatsApp; the five guest messages of M11-05 go both ways.
    expect(templates.filter((t) => t.code === 'APPROVAL_OTP').map((t) => t.channel)).toEqual([
      'WHATSAPP',
    ]);
    for (const code of [
      'BOOKING_CONFIRMED',
      'PRE_ARRIVAL',
      'PAYMENT_REQUEST',
      'FOLIO',
      'FEEDBACK',
    ]) {
      expect(templates.filter((t) => t.code === code).map((t) => t.channel)).toEqual([
        'EMAIL',
        'WHATSAPP',
      ]);
    }
  });

  it('saves the organisation’s email wording per language, audits it, and resets it', async () => {
    const { h, gm, send, reset } = await screen();
    const saved = await send('/message-templates', {
      code: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      language: 'fr',
      subject: 'Réservation {{confirmation_no}}',
      body: 'Bonjour {{guest_name}}',
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ language: 'fr', customised: true, editable: true });
    const fr = (await listed(gm)).find(
      (t) => t.code === 'BOOKING_CONFIRMED' && t.language === 'fr',
    );
    expect(fr).toMatchObject({ subject: 'Réservation {{confirmation_no}}', customised: true });
    // Saving again changes the same row.
    await send('/message-templates', {
      code: 'BOOKING_CONFIRMED',
      channel: 'EMAIL',
      language: 'fr',
      subject: 'Réservation',
      body: 'Bonjour',
    }).expect(200);
    expect(await db.messageTemplate.count({ where: { organisationId: h.org.id } })).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { organisationId: h.org.id, action: 'message_template.saved' },
      }),
    ).toBe(2);

    await reset('BOOKING_CONFIRMED/EMAIL/fr').expect(204);
    expect(await db.messageTemplate.count({ where: { organisationId: h.org.id } })).toBe(0);
    expect((await listed(gm)).some((t) => t.language === 'fr')).toBe(false);
    expect(await db.auditEvent.count({ where: { action: 'message_template.reset' } })).toBe(1);
  });

  it('refuses unknown variables, a missing subject, WhatsApp edits and SMS', async () => {
    const { send } = await screen();
    const base = { code: 'PAYMENT_REQUEST', channel: 'EMAIL', language: 'en', subject: 'Pay' };
    const unknown = await send('/message-templates', {
      ...base,
      body: 'Pay {{amount}} by {{due}}',
    });
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown).message).toBe('Not a variable of this template: {{due}}');
    const noSubject = await send('/message-templates', { ...base, subject: null, body: 'Pay' });
    expect(errorOf(noSubject).message).toBe('An email needs a subject');
    const wa = await send('/message-templates', { ...base, channel: 'WHATSAPP', body: 'Pay' });
    expect(errorOf(wa).message).toMatch(/approved by Meta/);
    const sms = await send('/message-templates', { ...base, channel: 'SMS', body: 'Pay' });
    expect(errorOf(sms).message).toBe('There is no SMS provider yet');
    expect(await db.messageTemplate.count()).toBe(0);
  });

  it('needs template.manage (front desk is refused)', async () => {
    const { h, c, send } = await screen();
    const fdCookie = await sessionCookie(db, h.fd.id);
    expect((await c.as(fdCookie).get('/message-templates')).status).toBe(403);
    const res = await send(
      '/message-templates',
      { code: 'FOLIO', channel: 'EMAIL', language: 'en', subject: 'Bill', body: 'Bill' },
      fdCookie,
    );
    expect(res.status).toBe(403);
    expect((await c.as(fdCookie).get('/message-deliveries')).status).toBe(403);
  });

  it('a test message is queued with the sample values and listed; 20 an hour at most', async () => {
    const { h, gm, send, deps } = await screen();
    const res = await send('/message-templates/test', {
      code: 'PAYMENT_REQUEST',
      channel: 'WHATSAPP',
      to: '+2348031234567',
    });
    expect(res.status).toBe(201);
    const { deliveryId } = res.body as { deliveryId: string };
    expect(res.body).toMatchObject({ status: 'QUEUED' });
    await sendDelivery(deps, deliveryId, h.org.id);
    const def = messageTemplateDef('PAYMENT_REQUEST');
    expect((deps.messages as ReturnType<typeof createFakeMessageProvider>).sent[0]?.params).toEqual(
      def?.variables.map((v) => v.example),
    );
    const list = (await gm.get('/message-deliveries').expect(200)).body as {
      data: { id: string; status: string; test: boolean; recipient: string }[];
    };
    expect(list.data).toEqual([
      expect.objectContaining({
        id: deliveryId,
        status: 'SENT',
        test: true,
        recipient: '+2348031234567',
      }),
    ]);

    const badPhone = await send('/message-templates/test', {
      code: 'PAYMENT_REQUEST',
      channel: 'WHATSAPP',
      to: '08031234567',
    });
    expect(badPhone.status).toBe(400);
    const code = await send('/message-templates/test', {
      code: 'APPROVAL_OTP',
      channel: 'WHATSAPP',
      to: '+2348031234567',
    });
    expect(errorOf(code).message).toMatch(/real approval request/);

    for (let i = 1; i < TEST_MESSAGES_PER_HOUR; i++) {
      await send('/message-templates/test', {
        code: 'FOLIO',
        channel: 'EMAIL',
        to: 'gm@example.test',
      }).expect(201);
    }
    const over = await send('/message-templates/test', {
      code: 'FOLIO',
      channel: 'EMAIL',
      to: 'gm@example.test',
    });
    expect(over.status).toBe(429);
    expect(errorOf(over).code).toBe('RATE_LIMITED');
  });
});

describe('approval codes by WhatsApp (M1-10; replaces the T-022 stub)', () => {
  async function approval() {
    const s = await setup();
    await createDefaultApprovalPolicies(db, s.h.org.id, s.h.p1.id);
    await db.user.update({ where: { id: s.h.owner.id }, data: { phone: '+2348030000001' } });
    const request = await db.approvalRequest.create({
      data: {
        organisationId: s.h.org.id,
        propertyId: s.h.p1.id,
        action: 'folio.discount',
        payload: { folioId: 'F-1', bps: 2000 },
        payloadHash: 'x',
        reason: 'Loyal guest',
        requestedById: s.h.fd.id,
        expiresAt: new Date(now.getTime() + 30 * 60_000),
      },
    });
    const channel = whatsappOtpChannel(s.deps);
    return { ...s, requestId: request.id, channel };
  }

  it('sends the code to each approver with a phone, never the requester; stores no code', async () => {
    const { h, messages, requestId, channel } = await approval();
    // The GM approves too, and has a phone; the requester has one but is not an approver.
    await db.user.update({ where: { id: h.gm.id }, data: { phone: '+2348030000002' } });
    await db.user.update({ where: { id: h.fd.id }, data: { phone: '+2348030000003' } });
    await issueApprovalOtp(db, { otpSecret: TEST_CONFIG.sessionSecret, channel }, requestId);

    expect(messages.sent.map((m) => m.to).sort()).toEqual(['+2348030000001', '+2348030000002']);
    const [first, second] = messages.sent;
    expect(first).toMatchObject({
      templateName: 'approval_code',
      category: 'AUTHENTICATION',
      params: [expect.stringMatching(/^\d{6}$/)],
    });
    // One code per request: both approvers get the same one.
    expect(second?.params).toEqual(first?.params);
    const rows = await db.notificationDelivery.findMany({
      where: { templateCode: 'APPROVAL_OTP' },
    });
    expect(rows.map((r) => r.status)).toEqual(['SENT', 'SENT']);
    for (const r of rows) {
      expect(r.payload).toMatchObject({ approvalRequestId: requestId });
      expect(JSON.stringify(r.payload)).not.toContain(first?.params[0] ?? 'none');
    }
  });

  it('the code from WhatsApp approves the request and records the channel', async () => {
    const { h, messages, requestId, channel } = await approval();
    await issueApprovalOtp(db, { otpSecret: TEST_CONFIG.sessionSecret, channel }, requestId);
    const code = messages.sent[0]?.params[0] ?? '';
    // The test action is not registered here, so the request fails after the code is
    // accepted; the decision channel is recorded either way.
    const c = hotelClient(db, clock, h.p1.id);
    const owner = c.as(await sessionCookie(db, h.owner.id));
    const res = await owner.post(`/approvals/${requestId}/approve`, { otp: code });
    expect(res.status).not.toBe(400);
    expect(
      (await db.approvalRequest.findUniqueOrThrow({ where: { id: requestId } })).decisionChannel,
    ).toBe('WHATSAPP_OTP');
  });

  it('throws so the handler runs again when every send failed for a passing reason', async () => {
    const { messages, requestId, channel } = await approval();
    messages.failNext(1);
    await expect(
      issueApprovalOtp(db, { otpSecret: TEST_CONFIG.sessionSecret, channel }, requestId),
    ).rejects.toThrow('Fake send failure');
    expect(
      (await db.notificationDelivery.findMany({ where: { templateCode: 'APPROVAL_OTP' } })).map(
        (r) => [r.status, r.lastError],
      ),
    ).toEqual([['FAILED', 'Fake send failure']]);
    // A permanent refusal (e.g. not a WhatsApp number) is recorded, not retried.
    messages.failNext(1, true);
    await expect(
      issueApprovalOtp(db, { otpSecret: TEST_CONFIG.sessionSecret, channel }, requestId),
    ).resolves.toBe(true);
  });

  it('sends nothing when no approver has a phone', async () => {
    const { h, messages, requestId, channel } = await approval();
    await db.user.update({ where: { id: h.owner.id }, data: { phone: null } });
    await issueApprovalOtp(db, { otpSecret: TEST_CONFIG.sessionSecret, channel }, requestId);
    expect(messages.sent).toEqual([]);
    expect(await db.notificationDelivery.count()).toBe(0);
  });
});
