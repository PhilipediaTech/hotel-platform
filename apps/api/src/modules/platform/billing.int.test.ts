import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeRoom, makeRoomType, makeUser } from '../../../test/factories.ts';
import { APP_ORIGIN, errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { FAKE_WEBHOOK_KEY } from '../../core/payments.ts';
import { PAYSTACK_SIGNATURE_HEADER, signPaystack } from '../../core/paystack-events.ts';
import { createTenantDb } from '../../core/tenant-db.ts';
import { createPublicBooking } from '../bookingengine/service.ts';
import { processWebhookEvents } from '../payments/webhooks.ts';
import { runBilling } from './billing.ts';

// Automated hotel billing and suspension (PRD M13-03 "automated with payment link from V1.2";
// M13-06 "suspend a tenant for non-payment after a grace period; data stays read-only and
// exportable"; M13 rules "suspension never deletes data; owners can export their data at any
// time"; T-124). Invoices are due 14 days after issue; suspension is allowed 14 days past due.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-12-01T07:00:00Z');
});

const ADMIN_EMAIL = TEST_CONFIG.platformAdminEmails[0] ?? '';

type Invoice = { id: string; status: string; dueOn: string | null; paidAt: string | null };

async function setup(startStatus = 'ACTIVE') {
  const h = await makeHotel(db, now);
  await db.organisation.update({
    where: { id: h.org.id },
    data: { createdAt: new Date('2026-01-01T00:00:00Z') },
  });
  await db.property.update({ where: { id: h.p1.id }, data: { status: 'LIVE' } });
  const type = await makeRoomType(db, { id: h.p1.id, organisationId: h.org.id });
  for (const n of ['101', '102', '103']) await makeRoom(db, type, { number: n });
  await db.subscription.create({
    data: {
      organisationId: h.org.id,
      plan: 'PROFESSIONAL',
      pricePerRoomMinor: 500000n,
      minimumMinor: 1000000n,
      currency: 'NGN',
      status: startStatus,
      currentPeriodEnd: new Date('2026-11-30'),
    },
  });
  const c = hotelClient(db, clock, h.p1.id);
  const admin = await makeUser(db, { email: ADMIN_EMAIL });
  await db.user.update({
    where: { id: admin.id },
    data: { status: 'ACTIVE', mfaEnabled: true, mfaSecretEnc: Buffer.alloc(32, 1) },
  });
  const deps = { db, clock, provider: c.payments, email: c.email, config: TEST_CONFIG };
  const asAdmin = async (method: 'get' | 'post' | 'patch', path: string, body?: object) => {
    const req = request(c.app)
      [method](`/api/v1${path}`)
      .set('Cookie', await sessionCookie(db, admin.id, clock))
      .set('Origin', APP_ORIGIN);
    if (method !== 'get') req.set('Idempotency-Key', crypto.randomUUID());
    return body ? req.send(body) : req;
  };
  /** The owner, signed in now (sessions run on the test clock). */
  const owner = async () => c.as(await sessionCookie(db, h.owner.id, clock));
  const invoices = () =>
    db.platformInvoice.findMany({
      where: { organisationId: h.org.id },
      orderBy: { issuedAt: 'asc' },
    });
  const status = async () =>
    (await db.subscription.findUniqueOrThrow({ where: { organisationId: h.org.id } })).status;
  return { ...h, ownerUserId: h.owner.id, c, deps, asAdmin, owner, invoices, status };
}

describe('the monthly invoice, with a payment link (M13-03 from V1.2)', () => {
  it('invoices last month once, due in 14 days, and emails the owner a link to pay', async () => {
    const s = await setup();
    expect(await runBilling(s.deps)).toEqual({ issued: 1, pastDue: 0 });
    const [invoice] = await s.invoices();
    expect(invoice).toMatchObject({ status: 'ISSUED', activeRooms: 3, totalMinor: 1500000n });
    expect(invoice?.periodStart.toISOString().slice(0, 10)).toBe('2026-11-01');
    expect(invoice?.dueOn?.toISOString().slice(0, 10)).toBe('2026-12-15');
    const checkout = await db.platformInvoiceCheckout.findFirstOrThrow();
    const mail = s.c.email.sent.find((m) => m.tag === 'subscription-invoice');
    expect(mail?.to).toBe(
      (await db.user.findUniqueOrThrow({ where: { id: s.ownerUserId } })).email,
    );
    expect(mail?.text).toContain(checkout.checkoutUrl);
    // Every day after: nothing more for November.
    now = new Date('2026-12-02T07:00:00Z');
    expect(await runBilling(s.deps)).toEqual({ issued: 0, pastDue: 0 });
  });

  it('leaves trial groups alone, and never re-issues a month staff voided', async () => {
    const trial = await setup('TRIAL');
    expect((await runBilling(trial.deps)).issued).toBe(0);
    await db.subscription.update({
      where: { organisationId: trial.org.id },
      data: { status: 'ACTIVE' },
    });
    await runBilling(trial.deps);
    const [invoice] = await trial.invoices();
    await db.platformInvoice.update({ where: { id: invoice?.id ?? '' }, data: { status: 'VOID' } });
    expect((await runBilling(trial.deps)).issued).toBe(0);
  });

  it('a paid link marks the invoice paid once, however often the webhook comes', async () => {
    const s = await setup();
    await runBilling(s.deps);
    const checkout = await db.platformInvoiceCheckout.findFirstOrThrow();
    const body = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 9001,
        status: 'success',
        reference: checkout.providerRef,
        amount: 1500000,
        currency: 'NGN',
        paid_at: '2026-12-03T10:00:00.000Z',
        channel: 'card',
        authorization: {},
      },
    });
    for (let i = 0; i < 3; i++) {
      await request(s.c.app)
        .post('/api/v1/webhooks/payments/fake')
        .set('Content-Type', 'application/json')
        .set(PAYSTACK_SIGNATURE_HEADER, signPaystack(body, FAKE_WEBHOOK_KEY))
        .send(body)
        .expect(200);
      await processWebhookEvents({ db, clock, provider: s.c.payments });
    }
    const [invoice] = await s.invoices();
    expect(invoice).toMatchObject({ status: 'PAID', paidRef: checkout.providerRef });
    expect(
      await db.auditEvent.count({
        where: { action: 'platform.invoice_paid', organisationId: s.org.id },
      }),
    ).toBe(1);
  });
});

describe('past due, grace period and suspension (M13-06)', () => {
  it('an unpaid invoice past its due date makes the group past due and tells the owner', async () => {
    const s = await setup();
    await runBilling(s.deps);
    now = new Date('2026-12-16T07:00:00Z');
    expect((await runBilling(s.deps)).pastDue).toBe(1);
    expect(await s.status()).toBe('PAST_DUE');
    expect(s.c.email.sent.some((m) => m.tag === 'subscription-overdue')).toBe(true);
    const owner = await s.owner();
    const page = await owner.get('/subscription');
    expect((page.body as { invoices: Invoice[] }).invoices[0]?.dueOn).toBe('2026-12-15');
  });

  it('staff can suspend only after the grace period, with a reason', async () => {
    const s = await setup();
    await runBilling(s.deps);
    now = new Date('2026-12-20T07:00:00Z');
    const early = await s.asAdmin('post', `/platform/tenants/${s.org.id}/suspend`, {
      reason: 'Unpaid November',
    });
    expect(early.status).toBe(409);
    const tenant = await s.asAdmin('get', `/platform/tenants/${s.org.id}`);
    expect(tenant.body).toMatchObject({ overdueDays: 5, suspendable: false });

    now = new Date('2026-12-29T07:00:00Z');
    expect((await s.asAdmin('get', `/platform/tenants/${s.org.id}`)).body).toMatchObject({
      overdueDays: 14,
      suspendable: true,
    });
    const done = await s.asAdmin('post', `/platform/tenants/${s.org.id}/suspend`, {
      reason: 'Unpaid November',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await s.status()).toBe('SUSPENDED');
    expect(s.c.email.sent.some((m) => m.tag === 'subscription-suspended')).toBe(true);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'platform.subscription_suspended' },
    });
    expect(audit).toMatchObject({ reason: 'Unpaid November', actorType: 'SUPPORT' });
  });

  it('a suspended group can read, export and pay, but change nothing; nothing is deleted', async () => {
    const s = await setup();
    await runBilling(s.deps);
    const rooms = await db.room.count({ where: { organisationId: s.org.id } });
    now = new Date('2026-12-29T07:00:00Z');
    await s.asAdmin('post', `/platform/tenants/${s.org.id}/suspend`, { reason: 'Unpaid November' });

    const owner = await s.owner();
    const me = await owner.get('/me');
    expect(
      (me.body as { organisations: { suspended: boolean }[] }).organisations[0]?.suspended,
    ).toBe(true);
    expect((await owner.get('/rooms')).status).toBe(200);
    expect((await owner.get('/audit-events')).status).toBeLessThan(500);
    const write = await owner.post('/room-types', { code: 'DLX', name: 'Deluxe' });
    expect(write.status).toBe(403);
    expect(errorOf(write).code).toBe('SUBSCRIPTION_SUSPENDED');
    expect(
      (await owner.patch('/subscription/billing', { legalName: 'Obi Hotels Ltd' })).status,
    ).toBe(200);
    expect(await db.room.count({ where: { organisationId: s.org.id } })).toBe(rooms);

    // Paying online ends it.
    const [invoice] = await s.invoices();
    const link = await owner.post(`/subscription/invoices/${invoice?.id}/pay`, {});
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const ref = (
      await db.platformInvoiceCheckout.findFirstOrThrow({
        orderBy: { createdAt: 'desc' },
      })
    ).providerRef;
    s.c.payments.complete(ref);
    const checked = await owner.post(`/subscription/invoices/${invoice?.id}/check`, {});
    expect(checked.body).toEqual({ status: 'PAID' });
    expect(await s.status()).toBe('ACTIVE');
    expect((await owner.post('/room-types', { code: 'DLX', name: 'Deluxe' })).status).toBe(201);
  });

  it('marking the invoice paid by hand, or staff reactivating, lifts it too', async () => {
    const s = await setup();
    await runBilling(s.deps);
    now = new Date('2026-12-29T07:00:00Z');
    await s.asAdmin('post', `/platform/tenants/${s.org.id}/suspend`, { reason: 'Unpaid November' });
    const [invoice] = await s.invoices();
    await s.asAdmin('patch', `/platform/invoices/${invoice?.id}`, { status: 'PAID' });
    expect(await s.status()).toBe('ACTIVE');
    expect((await s.invoices())[0]?.paidAt).not.toBeNull();
  });

  it('staff can lift a suspension, once', async () => {
    const again = await setup();
    await db.subscription.update({
      where: { organisationId: again.org.id },
      data: { status: 'SUSPENDED' },
    });
    const lifted = await again.asAdmin('post', `/platform/tenants/${again.org.id}/reactivate`, {
      reason: 'Paid by cheque',
    });
    expect(lifted.status).toBe(200);
    expect(await again.status()).toBe('ACTIVE');
    expect(
      (
        await again.asAdmin('post', `/platform/tenants/${again.org.id}/reactivate`, {
          reason: 'Again',
        })
      ).status,
    ).toBe(409);
  });

  it('a suspended hotel takes no online bookings', async () => {
    const s = await setup();
    await db.bookingEngineSettings.create({
      data: { propertyId: s.p1.id, organisationId: s.org.id, slug: 'obi-hotel', enabled: true },
    });
    await db.subscription.update({
      where: { organisationId: s.org.id },
      data: { status: 'SUSPENDED' },
    });
    const refused = createPublicBooking(
      {
        db,
        tenantDb: createTenantDb(db),
        clock,
        config: TEST_CONFIG,
        provider: s.c.payments,
        email: s.c.email,
        store: s.c.files,
      },
      { slug: 'obi-hotel', bookingKey: crypto.randomUUID() } as never,
    );
    await expect(refused).rejects.toMatchObject({ code: 'SUBSCRIPTION_SUSPENDED' });
  });

  it('suspending and reactivating are for platform staff only', async () => {
    const s = await setup();
    const owner = await s.owner();
    const res = await owner.post(`/platform/tenants/${s.org.id}/suspend`, { reason: 'Myself!' });
    expect(res.status).toBe(403);
  });
});
