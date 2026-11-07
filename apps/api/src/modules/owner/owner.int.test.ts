import { beforeEach, describe, expect, it } from 'vitest';
import { issueApprovalOtp } from '../../core/approvals.ts';
import { createFakeEmailProvider } from '../../core/email.ts';
import { createLogger } from '../../core/logger.ts';
import { createFakeMessageProvider } from '../../core/messaging.ts';
import type { DomainEventRecord } from '../../core/outbox.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { TEST_CONFIG } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { makeProperty } from '../../../test/factories.ts';
import { hotelClient } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { raiseAlert } from '../leakage/engine.ts';
import { sendDelivery, whatsappOtpChannel } from '../notifications/delivery.ts';
import { flashReportHandler, instantAlertHandler } from './notify.ts';

// Owner home, flash report, instant WhatsApp alerts and approvals by code (PRD M6-09–M6-11,
// M4-15; M6 AC "an alert configured as instant reaches the owner's WhatsApp", "an owner
// approval by WhatsApp code executes the action and records the channel used"; M10 AC "the
// flash report's room revenue equals the sum of room-revenue lines posted for that business
// date; ADR = room revenue ÷ rooms sold"; tab 4 row "Owner"; S04; T-091).

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const logger = createLogger({ ...TEST_CONFIG, logLevel: 'silent' });

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Card = {
  id: string;
  code: string;
  businessDate: string;
  roomsAvailable: number;
  roomsOccupied: number;
  occupancyBps: number;
  revenueTodayMinor: string;
  revenueMonthMinor: string;
  cashTodayMinor: string;
  transfersTodayMinor: string;
  openAlerts: number;
  pendingApprovals: number;
  lastFlash: {
    businessDate: string;
    roomsSold: number;
    occupancyBps: number;
    roomRevenueMinor: string;
    adrMinor: string;
    revparMinor: string;
    paymentsMinor: string;
  } | null;
};

const OWNER_PHONE = '+2348030000001';
const GM_PHONE = '+2348030000002';

/** Ada Obi in house in 101 (₦100,000 a night), cash and transfers on, the desk's shift open. */
async function hotel() {
  const h = await inHouse(db, clock);
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'BANK_TRANSFER'] } },
  });
  const gmId = (await db.membership.findFirstOrThrow({ where: { roleId: h.role('gm') } })).userId;
  await db.user.update({ where: { id: h.owner.id }, data: { phone: OWNER_PHONE } });
  await db.user.update({ where: { id: gmId }, data: { phone: GM_PHONE } });
  const auditorId = (await h.person('night-auditor', h.p1.id)).id;
  const at = (instant: string) => {
    now = new Date(instant);
  };
  const ownerClient = () => h.as(h.owner.id);
  const home = async () =>
    (await h.ok<{ properties: Card[] }>((await ownerClient()).get('/owner/home'))).properties;
  const messages = createFakeMessageProvider();
  const send = { db, messages, email: createFakeEmailProvider(), clock, logger };
  const notify = { db, logger };
  const lastEvent = async (type: string): Promise<DomainEventRecord> => {
    const e = await db.domainEvent.findFirstOrThrow({
      where: { type },
      orderBy: { id: 'desc' },
    });
    return {
      id: e.id.toString(),
      organisationId: e.organisationId,
      propertyId: e.propertyId,
      type: e.type,
      payload: e.payload as Record<string, unknown>,
      occurredAt: e.occurredAt,
    };
  };
  const deliveries = (templateCode: string) =>
    db.notificationDelivery.findMany({ where: { templateCode }, orderBy: { recipient: 'asc' } });
  return {
    ...h,
    gmId,
    auditorId,
    at,
    ownerClient,
    home,
    messages,
    send,
    notify,
    lastEvent,
    deliveries,
  };
}

describe('owner home (M6-11; S04)', () => {
  it('shows today’s numbers, cash and transfers, alerts and approvals for the property', async () => {
    const h = await hotel();
    await h.ok(h.fd.send('/shifts', { floatMinor: '0' }));
    await h.ok(
      h.charge({ revenueCode: 'MISC', description: 'Laundry', unitAmountMinor: '500000' }),
    );
    await h.ok(
      h.fd.send('/payments', { folioId: h.folioId, method: 'CASH', amountMinor: '200000' }),
    );
    await h.ok(
      h.fd.send('/payments', {
        folioId: h.folioId,
        method: 'BANK_TRANSFER',
        amountMinor: '300000',
        externalRef: 'GTB-1',
      }),
    );
    await raiseAlert(db, {
      propertyId: h.p1.id,
      organisationId: h.org.id,
      ruleCode: 'OCCUPIED_NO_FOLIO',
      businessDate: TODAY,
      severity: 'HIGH',
      entityType: 'room',
      entityId: h.p1.id,
      evidence: { roomNumber: '102', observed: 'OCCUPIED', frontOffice: 'VACANT' },
      dedupeKey: 'test:1',
    });

    const cards = await h.home();
    expect(cards.map((c) => c.code).sort()).toEqual(['P1', 'P2']);
    const card = cards.find((c) => c.id === h.p1.id);
    expect(card).toMatchObject({
      id: h.p1.id,
      businessDate: TODAY,
      roomsAvailable: 1,
      roomsOccupied: 1,
      occupancyBps: 10_000,
      // The laundry charge with its taxes: the revenue lines of the day.
      cashTodayMinor: '200000',
      transfersTodayMinor: '300000',
      openAlerts: 1,
      pendingApprovals: 0,
      lastFlash: null,
    });
    const lines = await db.folioLine.findMany({ where: { propertyId: h.p1.id } });
    const total = lines.reduce((a, l) => a + l.amountMinor, 0n).toString();
    expect(card?.revenueTodayMinor).toBe(total);
    expect(card?.revenueMonthMinor).toBe(total);
  });

  it('after night audit: the last flash report, and today is the next day', async () => {
    const h = await hotel();
    h.at('2026-11-10T21:00:00Z');
    const auditor = await h.as(h.auditorId);
    const run = await auditor.send('/night-audits', { businessDate: TODAY });
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);

    const card = (await h.home()).find((c) => c.id === h.p1.id);
    expect(card?.businessDate).toBe('2026-11-11');
    expect(card?.revenueTodayMinor).toBe('0');
    const roomLines = await db.folioLine.findMany({
      where: {
        propertyId: h.p1.id,
        businessDate: new Date(`${TODAY}T00:00:00Z`),
        revenueCode: { group: 'ROOM' },
      },
    });
    const roomRevenue = roomLines.reduce((a, l) => a + l.amountMinor, 0n);
    expect(roomRevenue).toBeGreaterThan(0n);
    // M10 AC: room revenue is the day's room lines; ADR = room revenue ÷ rooms sold.
    expect(card?.lastFlash).toMatchObject({
      businessDate: TODAY,
      roomsSold: 1,
      occupancyBps: 10_000,
      roomRevenueMinor: roomRevenue.toString(),
      adrMinor: roomRevenue.toString(),
      revparMinor: roomRevenue.toString(),
    });
    expect(card?.revenueMonthMinor).not.toBe('0');
  });

  it('a property owner sees only their property; without owner.read the home is refused', async () => {
    const h = await hotel();
    const p3 = await makeProperty(db, h.org.id, { code: 'P3' });
    const localOwner = await h.person('owner', p3.id);
    const c3 = hotelClient(db, clock, p3.id);
    const theirs = await c3.as(await sessionCookie(db, localOwner.id, clock)).get('/owner/home');
    expect(theirs.status).toBe(200);
    expect((theirs.body as { properties: Card[] }).properties.map((p) => p.code)).toEqual(['P3']);
    // The organisation-wide owner sees all three.
    expect((await h.home()).map((p) => p.code).sort()).toEqual(['P1', 'P2', 'P3']);
    const gm = await h.as(h.gmId);
    expect((await gm.get('/owner/home')).status).toBe(403);
  });

  it('counts approval requests still waiting, not expired ones', async () => {
    const h = await hotel();
    const request = (expiresAt: Date) =>
      db.approvalRequest.create({
        data: {
          organisationId: h.org.id,
          propertyId: h.p1.id,
          action: 'folio.discount',
          payload: {},
          payloadHash: 'x',
          reason: 'Test',
          requestedById: h.fdId,
          expiresAt,
        },
      });
    await request(new Date(now.getTime() + 60_000));
    await request(new Date(now.getTime() - 60_000));
    expect((await h.home()).find((c) => c.id === h.p1.id)?.pendingApprovals).toBe(1);
  });
});

describe('the flash report by WhatsApp when the day closes (M4-15)', () => {
  it('goes to every holder of report.flash with a phone, once, with the kept figures', async () => {
    const h = await hotel();
    // The night auditor holds report.flash too; without a phone they get nothing.
    h.at('2026-11-10T21:00:00Z');
    const run = await (await h.as(h.auditorId)).send('/night-audits', { businessDate: TODAY });
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
    const event = await h.lastEvent('business_day.closed');
    const handler = flashReportHandler(h.notify);
    await handler.handle(event);
    await handler.handle(event);

    const sent = await h.deliveries('FLASH_REPORT');
    expect(sent.map((d) => d.recipient)).toEqual([OWNER_PHONE, GM_PHONE].sort());
    const vars = (sent[0]?.payload as { vars: Record<string, string> }).vars;
    const flash = (await h.home()).find((c) => c.id === h.p1.id)?.lastFlash;
    expect(vars).toMatchObject({
      property_name: expect.any(String) as string,
      business_date: '10 Nov 2026',
      occupancy: '100%',
      rooms_sold: '1',
      open_alerts: '0',
    });
    expect(vars['room_revenue']).toMatch(/^NGN [\d,]+\.\d{2}$/);
    expect(vars['adr']).toBe(vars['room_revenue']);
    expect(flash?.roomsSold).toBe(1);

    // Sent through the T-024 sender as the platform's flash_report template.
    await sendDelivery(h.send, sent[0]?.id ?? '', h.org.id);
    expect(h.messages.sent[0]).toMatchObject({ templateName: 'flash_report', category: 'UTILITY' });
  });

  it('a day closed without a night audit has no flash report: nothing is sent', async () => {
    const h = await hotel();
    await flashReportHandler(h.notify).handle({
      id: '1',
      organisationId: h.org.id,
      propertyId: h.p1.id,
      type: 'business_day.closed',
      payload: { businessDate: TODAY, nextBusinessDate: '2026-11-11' },
      occurredAt: now,
    });
    expect(await h.deliveries('FLASH_REPORT')).toEqual([]);
  });
});

describe('instant leakage alerts by WhatsApp (M6-09)', () => {
  const variance = (h: Awaited<ReturnType<typeof hotel>>, n: number, subject: string) =>
    raiseAlert(db, {
      propertyId: h.p1.id,
      organisationId: h.org.id,
      ruleCode: 'REVERSAL_PATTERN',
      businessDate: TODAY,
      severity: 'HIGH',
      entityType: 'user',
      entityId: subject,
      subjectUserId: subject,
      evidence: { reversals: 4, totalMinor: '6200000' },
      dedupeKey: `test:${n}`,
    });

  it('an instant rule reaches the leakage.notify holders’ WhatsApp, never the person it is about', async () => {
    const h = await hotel();
    await db.leakageRule.create({
      data: { propertyId: h.p1.id, code: 'REVERSAL_PATTERN', notifyInstant: true },
    });
    // The alert is about the GM: only the owner hears.
    await variance(h, 1, h.gmId);
    const event = await h.lastEvent('leakage.alert_raised');
    expect(event.payload['notify']).toBe('INSTANT');
    const handler = instantAlertHandler(h.notify);
    await handler.handle(event);
    await handler.handle(event);
    const queued = await h.deliveries('LEAKAGE_ALERT');
    expect(queued.map((d) => [d.recipient, d.status])).toEqual([[OWNER_PHONE, 'QUEUED']]);
    const gmName = (await db.user.findUniqueOrThrow({ where: { id: h.gmId } })).name;
    expect((queued[0]?.payload as { vars: Record<string, string> }).vars).toMatchObject({
      rule: 'Reversal pattern',
      detail: `4 reversals totalling NGN 62,000.00 by ${gmName}.`,
      // Stamped by the database clock, shown in the property's time zone.
      raised_at: expect.stringMatching(/^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}$/) as string,
    });
    // The worker sends it at once: the AC's two minutes are the outbox's poll and the send.
    const started = Date.now();
    await sendDelivery(h.send, queued[0]?.id ?? '', h.org.id);
    expect(h.messages.sent[0]).toMatchObject({ to: OWNER_PHONE, templateName: 'leakage_alert' });
    expect(Date.now() - started).toBeLessThan(120_000);

    // About the front desk: the owner and the GM both hear.
    await variance(h, 2, h.fdId);
    await handler.handle(await h.lastEvent('leakage.alert_raised'));
    expect((await h.deliveries('LEAKAGE_ALERT')).map((d) => d.recipient).sort()).toEqual(
      [OWNER_PHONE, OWNER_PHONE, GM_PHONE].sort(),
    );
  });

  it('an alert that waits for the flash report sends nothing now', async () => {
    const h = await hotel();
    await variance(h, 1, h.fdId);
    const event = await h.lastEvent('leakage.alert_raised');
    expect(event.payload['notify']).toBe('FLASH');
    await instantAlertHandler(h.notify).handle(event);
    expect(await h.deliveries('LEAKAGE_ALERT')).toEqual([]);
  });
});

describe('approval by WhatsApp code (M6-10; M6 AC)', () => {
  it('the owner approves a refund with the code from WhatsApp: it executes; the channel is recorded', async () => {
    const h = await hotel();
    await h.ok(
      h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
    );
    const fin = await h.as(h.finance.id);
    await h.ok(h.fd.send('/shifts', { floatMinor: '0' }));
    await h.ok(fin.send('/shifts', { floatMinor: '0' }));
    const paid = await h.ok<{ paymentId: string }>(
      h.fd.send('/payments', { folioId: h.folioId, method: 'CASH', amountMinor: '14325000' }),
    );
    const asked = await fin.send(`/payments/${paid.paymentId}/refund`, {
      amountMinor: '2000000',
      reason: 'Overpaid',
    });
    expect(asked.status).toBe(202);
    const requestId = (asked.body as { approvalRequestId: string }).approvalRequestId;

    await issueApprovalOtp(
      db,
      { otpSecret: TEST_CONFIG.sessionSecret, channel: whatsappOtpChannel(h.send) },
      requestId,
    );
    const toOwner = h.messages.sent.find((m) => m.to === OWNER_PHONE);
    expect(toOwner?.templateName).toBe('approval_code');
    const code = toOwner?.params[0] ?? '';

    const owner = await h.ownerClient();
    const res = await owner.post(`/approvals/${requestId}/approve`, { otp: code });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({
      status: 'EXECUTED',
      decisionChannel: 'WHATSAPP_OTP',
      decidedById: h.owner.id,
    });
    expect(await db.payment.count({ where: { refundsPaymentId: paid.paymentId } })).toBe(1);
  });
});
