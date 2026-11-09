import { createHmac, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { createFakeAiProvider } from '../../core/ai.ts';
import { issueApprovalOtp } from '../../core/approvals.ts';
import type { FileStore } from '../../core/files.ts';
import { FAKE_WHATSAPP_SECRET } from '../../core/messaging.ts';
import { createTenantDb } from '../../core/tenant-db.ts';
import { countAiUse, countWhatsappSent, monthlyUse } from '../../core/usage.ts';
import { runAssistant } from '../bookingengine/assistant.ts';
import {
  ALLOWANCE_USED_UP_ERROR,
  queueMessage,
  sendDelivery,
  whatsappOtpChannel,
} from '../notifications/delivery.ts';
import { sendMorningSummaries } from '../owner/ai.ts';

// AI and WhatsApp allowances per plan (M14 rules: "AI and WhatsApp use is counted per hotel
// (usage_counters) and limited by the plan's monthly allowance"; T-118).

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-11T06:10:00Z'); // 07:10 in Lagos
});

const PHONE = '+2348035550000';
const FLASH = {
  roomsAvailable: 10,
  roomsSold: 7,
  occupancyBps: 7000,
  roomRevenueMinor: '31500000',
  adrMinor: '4500000',
  revparMinor: '3150000',
  paymentsByMethod: [{ method: 'CASH', amountMinor: '20000000' }],
};
const VARS = {
  guest_name: 'Ada Okafor',
  property_name: 'Obi Lagos',
  confirmation_no: 'P1-1001',
  arrival: '12 Dec 2026',
  departure: '15 Dec 2026',
  room_type: 'Deluxe King',
  total: '₦135,000.00',
};

async function hotel(allowances: { ai?: number | null; whatsapp?: number | null } = {}) {
  const start = new Date(now);
  now = new Date('2026-11-10T09:00:00Z');
  const h = await inHouse(db, clock);
  now = start;
  await db.subscription.create({
    data: {
      organisationId: h.org.id,
      plan: 'ESSENTIALS',
      pricePerRoomMinor: 100n,
      minimumMinor: 0n,
      currency: 'NGN',
      status: 'ACTIVE',
      currentPeriodEnd: new Date('2026-11-30T00:00:00Z'),
      aiAllowance: allowances.ai ?? null,
      whatsappAllowance: allowances.whatsapp ?? null,
    },
  });
  const useAi = () =>
    countAiUse(db, {
      organisationId: h.org.id,
      metric: 'AI_QUESTION',
      at: now,
      inputTokens: 1,
      outputTokens: 1,
    });
  const manager = async () => h.as((await h.person('gm', h.p1.id)).id);
  const queue = (recipient = PHONE) =>
    queueMessage(db, {
      organisationId: h.org.id,
      propertyId: h.p1.id,
      channel: 'WHATSAPP',
      templateCode: 'BOOKING_CONFIRMED',
      recipient,
      vars: VARS,
    });
  const use = () => monthlyUse(db, h.org.id, now);
  const send = { db, messages: h.messages, email: h.email, clock, logger };
  return { ...h, useAi, manager, queue, use, send };
}

describe('the AI allowance', () => {
  it('stops questions once used up, without calling the AI', async () => {
    const h = await hotel({ ai: 2 });
    h.ai.respond = () => 'An answer.';
    const gm = await h.manager();
    const ask = () => gm.post('/reports/ask', { question: 'How was last night?' });
    expect((await ask()).status).toBe(200);
    await h.useAi();
    const refused = await ask();
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe('ALLOWANCE_USED_UP');
    expect(h.ai.requests).toHaveLength(1);
  });

  it('adds every kind of AI use together, and starts again next month', async () => {
    const h = await hotel({ ai: 2 });
    await countAiUse(db, {
      organisationId: h.org.id,
      metric: 'AI_SUMMARY',
      at: now,
      inputTokens: 1,
      outputTokens: 1,
    });
    await h.useAi();
    h.ai.respond = () => 'An answer.';
    const ask = async () =>
      (await h.manager()).post('/reports/ask', { question: 'How was last night?' });
    expect((await ask()).status).toBe(403);
    expect(await h.use()).toMatchObject({ month: '2026-11', aiUses: 2 });

    now = new Date('2026-12-01T06:10:00Z');
    expect(await h.use()).toMatchObject({ month: '2026-12', aiUses: 0 });
    expect((await ask()).status).toBe(200);
  });

  it('an allowance of zero allows none; blank is no limit', async () => {
    const none = await hotel({ ai: 0 });
    const ask = async () =>
      (await none.manager()).post('/reports/ask', { question: 'How was last night?' });
    expect((await ask()).status).toBe(403);

    await db.subscription.update({
      where: { organisationId: none.org.id },
      data: { aiAllowance: null },
    });
    for (let i = 0; i < 5; i++) await none.useAi();
    none.ai.respond = () => 'An answer.';
    expect((await ask()).status).toBe(200);
  });

  it('the morning summary still goes, as plain figures', async () => {
    const h = await hotel({ ai: 1 });
    await h.useAi();
    await db.user.update({ where: { id: h.owner.id }, data: { phone: '+2348030000001' } });
    await db.nightAuditRun.create({
      data: {
        propertyId: h.p1.id,
        businessDate: new Date('2026-11-10T00:00:00Z'),
        status: 'COMPLETED',
        finishedAt: now,
        startedById: h.owner.id,
        summary: { reports: { flash: FLASH } },
      } as never,
    });
    const ai = createFakeAiProvider();
    expect(await sendMorningSummaries(db, ai, clock, logger)).toBe(1);
    expect(ai.requests).toEqual([]);
    const sent = await db.notificationDelivery.findFirstOrThrow({
      where: { templateCode: 'OWNER_SUMMARY' },
    });
    expect((sent.payload as { vars: { summary: string } }).vars.summary).toMatch(/^Occupancy 70%/);
  });

  it('the WhatsApp assistant hands the guest to staff, without calling the AI', async () => {
    const h = await hotel({ ai: 1 });
    const bar = await db.ratePlan.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'BAR' } });
    await db.ratePlan.update({ where: { id: bar.id }, data: { isPublic: true } });
    await h.ok(
      (await h.as(h.gmId)).put('/booking-engine/settings', {
        slug: 'demo-lagos',
        enabled: true,
        headline: null,
        description: 'Calm hotel.',
        policies: null,
        photoFileIds: [],
        allowPayFull: true,
        allowDeposit: false,
        depositBps: 3000,
        allowPayAtHotel: true,
        assistantEnabled: true,
        assistantNotes: null,
      }),
    );
    await h.useAi();
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: randomUUID(),
                    from: PHONE.slice(1),
                    type: 'text',
                    text: { body: 'Hello #demo-lagos' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = createHmac('sha256', FAKE_WHATSAPP_SECRET).update(body).digest('hex');
    await request(h.app)
      .post('/api/v1/webhooks/whatsapp/fake')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', `sha256=${signature}`)
      .send(body);
    const thread = await db.messageThread.findFirstOrThrow({ where: { phone: PHONE } });
    await runAssistant(
      {
        db,
        tenantDb: createTenantDb(db),
        clock,
        config: TEST_CONFIG,
        provider: h.payments,
        email: h.email,
        store: {} as FileStore,
        ai: h.ai,
        messages: h.messages,
        logger,
      },
      thread.id,
    );
    expect(h.ai.requests).toEqual([]);
    expect(h.messages.sentTexts[0]?.body).toContain('member of our team');
    expect(await db.messageThread.findUniqueOrThrow({ where: { id: thread.id } })).toMatchObject({
      needsStaff: true,
    });
  });
});

describe('the WhatsApp allowance', () => {
  it('counts what is sent and holds back what is over, saying why', async () => {
    const h = await hotel({ whatsapp: 1 });
    expect(await sendDelivery(h.send, await h.queue(), h.org.id)).toBe('SENT');
    expect(await h.use()).toMatchObject({ whatsappMessages: 1 });

    const over = await h.queue('+2348035550001');
    expect(await sendDelivery(h.send, over, h.org.id)).toBe('FAILED');
    expect(h.messages.sent).toHaveLength(1);
    expect(await db.notificationDelivery.findUniqueOrThrow({ where: { id: over } })).toMatchObject({
      status: 'FAILED',
      lastError: ALLOWANCE_USED_UP_ERROR,
    });
    expect(await h.use()).toMatchObject({ whatsappMessages: 1 });
  });

  it('never holds back email', async () => {
    const h = await hotel({ whatsapp: 0 });
    const id = await queueMessage(db, {
      organisationId: h.org.id,
      propertyId: h.p1.id,
      channel: 'EMAIL',
      templateCode: 'BOOKING_CONFIRMED',
      recipient: 'ada@guest.test',
      vars: VARS,
    });
    expect(await sendDelivery(h.send, id, h.org.id)).toBe('SENT');
    expect(await h.use()).toMatchObject({ whatsappMessages: 0 });
  });

  it('never holds back a staff reply in a live conversation', async () => {
    const h = await hotel({ whatsapp: 0 });
    const thread = await db.messageThread.create({
      data: {
        organisationId: h.org.id,
        propertyId: h.p1.id,
        phone: PHONE,
        lastMessageAt: now,
        lastInboundAt: now,
        lastPreview: 'Hello',
      },
    });
    const fd = await h.as(h.fdId);
    const sent = await fd.send(`/message-threads/${thread.id}/messages`, { body: 'Mary here' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(h.messages.sentTexts).toHaveLength(1);
  });

  it('never holds back an approval code, and counts it', async () => {
    const h = await hotel({ whatsapp: 1 });
    await countWhatsappSent(db, h.org.id, now);
    await db.user.update({ where: { id: h.owner.id }, data: { phone: '+2348030000001' } });
    const role = await db.role.findFirstOrThrow({
      where: { organisationId: h.org.id, name: 'Owner' },
    });
    await db.approvalPolicy.upsert({
      where: { propertyId_action: { propertyId: h.p1.id, action: 'test.action' } },
      create: {
        organisationId: h.org.id,
        propertyId: h.p1.id,
        action: 'test.action',
        approverRoleIds: [role.id],
      },
      update: {},
    });
    const approval = await db.approvalRequest.create({
      data: {
        organisationId: h.org.id,
        propertyId: h.p1.id,
        action: 'test.action',
        payload: {},
        payloadHash: 'x',
        reason: 'Test',
        requestedById: h.gmId,
        expiresAt: new Date(now.getTime() + 30 * 60_000),
      },
    });
    await issueApprovalOtp(
      db,
      { otpSecret: TEST_CONFIG.sessionSecret, channel: whatsappOtpChannel(h.send) },
      approval.id,
    );
    expect(h.messages.sent.map((m) => m.templateName)).toEqual(['approval_code']);
    expect(await h.use()).toMatchObject({ whatsappMessages: 2 });
  });

  it('no plan, or one hotel group’s use, never limits another', async () => {
    const h = await hotel({ whatsapp: 1 });
    await db.subscription.delete({ where: { organisationId: h.org.id } });
    await countWhatsappSent(db, h.org.id, now);
    expect(await sendDelivery(h.send, await h.queue(), h.org.id)).toBe('SENT');

    const other = await db.organisation.create({ data: { name: 'Other', country: 'NG' } });
    expect(await monthlyUse(db, other.id, now)).toMatchObject({ whatsappMessages: 0, aiUses: 0 });
  });
});
