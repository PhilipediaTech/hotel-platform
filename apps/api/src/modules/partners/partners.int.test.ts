import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeUser } from '../../../test/factories.ts';
import { APP_ORIGIN, errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { addCommission } from './service.ts';

// Referral partners (PRD M14-06–M14-08 and the M14 AC: "a paid ₦100,000 invoice for a hotel tied
// to a 20% partner adds ₦20,000 to that partner's ledger once, even when the payment webhook
// arrives twice"; "partners never see guest, folio or staff data"; T-110).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

const ADMIN_EMAIL = TEST_CONFIG.platformAdminEmails[0] ?? '';

type Partner = {
  id: string;
  code: string;
  signUpLink: string;
  payoutDetails: string | null;
  hotels: number;
  totals: { currency: string; earnedMinor: string; paidMinor: string; owedMinor: string }[];
  commissions: { amountMinor: string; commissionBps: number; paid: boolean }[];
  payouts: { amountMinor: string; reference: string }[];
};

async function setup() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const admin = await makeUser(db, { email: ADMIN_EMAIL });
  await db.user.update({
    where: { id: admin.id },
    data: { status: 'ACTIVE', mfaEnabled: true, mfaSecretEnc: Buffer.alloc(32, 1) },
  });
  const adminCookie = await sessionCookie(db, admin.id, clock);
  const send = (
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    ck: string,
    body?: object,
  ) => {
    const req = request(c.app)
      [method](`/api/v1${path}`)
      .set('Cookie', ck)
      .set('Origin', APP_ORIGIN);
    if (method !== 'get') req.set('Idempotency-Key', crypto.randomUUID());
    return body ? req.send(body) : req;
  };
  const makePartner = async (over: object = {}) => {
    const res = await send('post', '/platform/partners', adminCookie, {
      name: 'Nairobi Hospitality Ltd',
      country: 'KE',
      email: 'wanjiku@partner.test',
      payoutDetails: 'M-Pesa 254700000000',
      commissionBps: 2000,
      durationMonths: 12,
      ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Partner;
  };
  const invoice = async (totalMinor: bigint, month = '2026-10') =>
    db.platformInvoice.create({
      data: {
        organisationId: h.org.id,
        periodStart: new Date(`${month}-01T00:00:00Z`),
        periodEnd: new Date(`${month}-28T00:00:00Z`),
        activeRooms: 10,
        lines: [],
        totalMinor,
        currency: 'NGN',
        status: 'ISSUED',
        issuedAt: now,
      },
    });
  const tie = (partnerId: string | null, reason: string | null = null) =>
    send('put', `/platform/tenants/${h.org.id}/partner`, adminCookie, { partnerId, reason });
  const markPaid = async (id: string) =>
    send('patch', `/platform/invoices/${id}`, await sessionCookie(db, admin.id, clock), {
      status: 'PAID',
    });
  const partnerView = (id: string) => send('get', `/platform/partners/${id}`, adminCookie);
  return { ...h, c, send, adminCookie, makePartner, invoice, tie, markPaid, partnerView };
}

describe('creating a partner (M14-06)', () => {
  it('gives a code and link, encrypts payout details and emails a way in', async () => {
    const h = await setup();
    const sent = vi.spyOn(h.c.email, 'send');
    const p = await h.makePartner();
    expect(p.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect(p.signUpLink).toBe(`${TEST_CONFIG.appOrigin}/sign-up?ref=${p.code}`);
    expect(p.payoutDetails).toBe('M-Pesa 254700000000');

    const row = await db.referralPartner.findUniqueOrThrow({ where: { id: p.id } });
    expect(Buffer.from(row.payoutDetailsEnc as Uint8Array).toString('latin1')).not.toContain(
      'M-Pesa',
    );
    const log = await db.partnerChange.findFirstOrThrow({ where: { partnerId: p.id } });
    expect(JSON.stringify(log.after)).not.toContain('M-Pesa');
    expect(sent.mock.calls[0]?.[0]).toMatchObject({ to: 'wanjiku@partner.test' });
    expect(sent.mock.calls[0]?.[0].text).toContain('/reset-password');
  });

  it('is for platform staff only', async () => {
    const h = await setup();
    const owner = await sessionCookie(db, h.owner.id, clock);
    expect((await h.send('get', '/platform/partners', owner)).status).toBe(403);
  });
});

describe('tying a hotel to a partner (M14-07)', () => {
  it('ties the group that signs up with the code; a retired or unknown code is refused', async () => {
    const h = await setup();
    const p = await h.makePartner();
    const signUp = (over: object) =>
      request(h.c.app)
        .post('/api/v1/auth/sign-up')
        .set('Origin', APP_ORIGIN)
        .send({
          name: 'Ama Mensah',
          email: 'ama@newhotel.test',
          password: 'a-long-enough-pass-phrase',
          organisationName: 'New Hotel Group',
          country: 'KE',
          propertyName: 'New Hotel',
          ...over,
        });

    const wrong = await signUp({ referralCode: 'NOTACODE' });
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).details).toMatchObject({
      issues: [expect.objectContaining({ path: 'body.referralCode' })],
    });

    expect((await signUp({ referralCode: p.code.toLowerCase() })).status).toBe(201);
    const org = await db.organisation.findFirstOrThrow({ where: { name: 'New Hotel Group' } });
    expect(
      await db.partnerReferral.findUniqueOrThrow({ where: { organisationId: org.id } }),
    ).toMatchObject({ partnerId: p.id, source: 'SIGN_UP' });

    await h.send('patch', `/platform/partners/${p.id}`, h.adminCookie, { active: false });
    const retired = await signUp({ email: 'other@newhotel.test', referralCode: p.code });
    expect(retired.status).toBe(400);
  });

  it('after the first paid invoice a change needs a reason, and is in the group’s audit', async () => {
    const h = await setup();
    const a = await h.makePartner();
    const b = await h.makePartner({ name: 'Accra Partners', email: 'b@partner.test' });
    expect((await h.tie(a.id)).status).toBe(200);
    expect((await h.tie(b.id)).status).toBe(200); // Nothing paid yet: no reason needed.
    const inv = await h.invoice(10_000_000n);
    await h.markPaid(inv.id);

    const noReason = await h.tie(a.id);
    expect(noReason.status).toBe(400);
    expect(errorOf(noReason).details).toMatchObject({
      issues: [expect.objectContaining({ path: 'body.reason' })],
    });
    expect((await h.tie(a.id, 'Signed up through this partner, entered wrongly')).status).toBe(200);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { organisationId: h.org.id, action: 'platform.partner_changed' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit).toMatchObject({
      actorType: 'SUPPORT',
      reason: 'Signed up through this partner, entered wrongly',
    });
  });
});

describe('the commission ledger (M14-08)', () => {
  it('a paid ₦100,000 invoice adds ₦20,000 at 20%, once, however often payment is reported', async () => {
    const h = await setup();
    const p = await h.makePartner();
    await h.tie(p.id);
    const inv = await h.invoice(10_000_000n);
    expect((await h.markPaid(inv.id)).status).toBe(200);
    // The same payment reported again, by the UI or a webhook.
    expect((await h.markPaid(inv.id)).status).toBe(409);
    await db.$transaction((tx) => addCommission(tx, inv, now));

    const view = (await h.partnerView(p.id)).body as Partner;
    expect(view.commissions).toHaveLength(1);
    expect(view.commissions[0]).toMatchObject({ amountMinor: '2000000', commissionBps: 2000 });
    expect(view.totals).toEqual([
      { currency: 'NGN', earnedMinor: '2000000', paidMinor: '0', owedMinor: '2000000' },
    ]);
  });

  it('nothing for a voided invoice or a group with no partner', async () => {
    const h = await setup();
    const p = await h.makePartner();
    const unTied = await h.invoice(5_000_000n, '2026-08');
    await h.markPaid(unTied.id);
    await h.tie(p.id);
    const voided = await h.invoice(5_000_000n, '2026-09');
    await h.send('patch', `/platform/invoices/${voided.id}`, h.adminCookie, { status: 'VOID' });
    expect(await db.partnerCommission.count()).toBe(0);
  });

  it('the term runs from the first paid invoice; a new rate leaves earned lines alone', async () => {
    const h = await setup();
    const p = await h.makePartner({ durationMonths: 2 });
    await h.tie(p.id);
    const first = await h.invoice(1_000_000n, '2026-09');
    await h.markPaid(first.id);

    await h.send('patch', `/platform/partners/${p.id}`, h.adminCookie, { commissionBps: 1000 });
    now = new Date('2026-12-09T09:00:00Z'); // Just inside the two months.
    const second = await h.invoice(1_000_000n, '2026-10');
    await h.markPaid(second.id);

    now = new Date('2027-01-10T09:00:00Z'); // Past them.
    const third = await h.invoice(1_000_000n, '2026-11');
    await h.markPaid(third.id);

    const lines = await db.partnerCommission.findMany({ orderBy: { earnedAt: 'asc' } });
    expect(lines.map((l) => [l.commissionBps, l.amountMinor])).toEqual([
      [2000, 200_000n],
      [1000, 100_000n],
    ]);
  });

  it('marks what is owed as paid; a second payout finds nothing', async () => {
    const h = await setup();
    const p = await h.makePartner();
    await h.tie(p.id);
    await h.markPaid((await h.invoice(10_000_000n)).id);
    const pay = (reference: string) =>
      h.send('post', `/platform/partners/${p.id}/payouts`, h.adminCookie, {
        currency: 'NGN',
        reference,
      });
    const done = await pay('MPESA-1');
    expect(done.status).toBe(201);
    expect((done.body as Partner).totals[0]).toMatchObject({
      paidMinor: '2000000',
      owedMinor: '0',
    });
    expect((done.body as Partner).payouts[0]).toMatchObject({
      amountMinor: '2000000',
      reference: 'MPESA-1',
    });
    expect((done.body as Partner).commissions[0]?.paid).toBe(true);
    expect((await pay('MPESA-2')).status).toBe(409);
  });
});

describe('the partner’s own page (M14-08)', () => {
  it('shows name, plan and status only, and is refused to anyone else', async () => {
    const h = await setup();
    const p = await h.makePartner();
    await h.tie(p.id);
    await db.subscription.create({
      data: {
        organisationId: h.org.id,
        plan: 'PROFESSIONAL',
        pricePerRoomMinor: 500_000n,
        minimumMinor: 0n,
        currency: 'NGN',
        status: 'ACTIVE',
        currentPeriodEnd: new Date('2026-11-30T00:00:00Z'),
      },
    });
    await h.markPaid((await h.invoice(10_000_000n)).id);

    const row = await db.referralPartner.findUniqueOrThrow({ where: { id: p.id } });
    const cookie = await sessionCookie(db, row.userId, clock);
    const res = await h.send('get', '/partner/home', cookie);
    expect(res.status).toBe(200);
    const home = res.body as { hotels: unknown[]; totals: unknown[] };
    expect(home.hotels).toEqual([{ name: h.org.name, plan: 'PROFESSIONAL', status: 'ACTIVE' }]);
    expect(home.totals[0]).toMatchObject({ owedMinor: '2000000' });
    expect(JSON.stringify(res.body)).not.toContain('M-Pesa');
    expect(JSON.stringify(res.body)).not.toContain('totalMinor');

    // The partner's account opens nothing else.
    expect((await h.send('get', '/platform/partners', cookie)).status).toBe(403);
    const me = await h.send('get', '/me', cookie);
    const session = me.body as { partner: unknown; properties: unknown[] };
    expect(session.partner).toEqual({ id: p.id, name: 'Nairobi Hospitality Ltd' });
    expect(session.properties).toEqual([]);

    const owner = await sessionCookie(db, h.owner.id, clock);
    expect((await h.send('get', '/partner/home', owner)).status).toBe(403);
  });
});
