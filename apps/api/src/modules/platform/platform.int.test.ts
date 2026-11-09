import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeRoom, makeRoomType, makeUser } from '../../../test/factories.ts';
import { APP_ORIGIN, errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { countWhatsappSent } from '../../core/usage.ts';

// Platform administration (PRD M13-01–M13-05; M13 rules "active rooms = rooms not archived";
// M13 AC "a support session expires on time and every record viewed is logged"; tab 4
// "Platform"; S30, S31; T-100).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date();
});

const ADMIN_EMAIL = TEST_CONFIG.platformAdminEmails[0] ?? '';

async function setup() {
  const h = await makeHotel(db, now);
  const type = await makeRoomType(db, { id: h.p1.id, organisationId: h.org.id });
  for (const n of ['101', '102', '103']) await makeRoom(db, type, { number: n });
  const archived = await makeRoom(db, type, { number: '104' });
  await db.room.update({ where: { id: archived.id }, data: { active: false } });

  const c = hotelClient(db, clock, h.p1.id);
  const admin = await makeUser(db, { email: ADMIN_EMAIL });
  await db.user.update({
    where: { id: admin.id },
    data: { status: 'ACTIVE', mfaEnabled: true, mfaSecretEnc: Buffer.alloc(32, 1) },
  });
  const cookie = async (userId: string) => sessionCookie(db, userId, clock);
  const adminCookie = await cookie(admin.id);
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
  const asAdmin = (method: 'get' | 'post' | 'put' | 'patch', path: string, body?: object) =>
    send(method, path, adminCookie, body);
  const ownerCookie = await cookie(h.owner.id);
  const owner = c.as(ownerCookie);
  const subscription = {
    plan: 'PROFESSIONAL',
    pricePerRoomMinor: '500000',
    minimumMinor: '2000000',
    currency: 'NGN',
    status: 'ACTIVE',
    currentPeriodEnd: '2026-11-30',
    aiAllowance: null,
    whatsappAllowance: null,
  };
  return { ...h, c, admin, adminCookie, cookie, send, asAdmin, ownerCookie, owner, subscription };
}

describe('platform staff only (PLATFORM_ADMIN_EMAILS with MFA on)', () => {
  it('lists hotel groups with plan, status and usage; nobody else gets in', async () => {
    const s = await setup();
    await countWhatsappSent(db, s.org.id, now);
    const list = await s.asAdmin('get', '/platform/tenants');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const mine = (
      list.body as { data: { id: string; usage: object; subscription: unknown }[] }
    ).data.find((t) => t.id === s.org.id);
    // Active rooms leave out archived ones (M13 rule).
    expect(mine).toMatchObject({
      usage: { activeRooms: 3, whatsappMessages: 1 },
      subscription: null,
    });

    expect((await s.send('get', '/platform/tenants', s.ownerCookie)).status).toBe(403);
    await db.user.update({
      where: { id: s.admin.id },
      data: { mfaEnabled: false, mfaSecretEnc: null },
    });
    expect((await s.asAdmin('get', '/platform/tenants')).status).toBe(403);
    expect((await request(s.c.app).get('/api/v1/platform/tenants')).status).toBe(401);
  });
});

describe('invoices (M13-03, manual in V1)', () => {
  it('bills active rooms × price, or the minimum; once a month; paid or voided, never changed', async () => {
    const s = await setup();
    const noPlan = await s.asAdmin('post', '/platform/invoices', {
      organisationId: s.org.id,
      month: '2026-10',
    });
    expect(errorOf(noPlan).message).toMatch(/plan and prices first/);
    await s
      .asAdmin('put', `/platform/tenants/${s.org.id}/subscription`, s.subscription)
      .expect(200);

    // 3 rooms × ₦5,000 = ₦15,000 is under the ₦20,000 minimum: topped up.
    const first = await s.asAdmin('post', '/platform/invoices', {
      organisationId: s.org.id,
      month: '2026-10',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      activeRooms: 3,
      totalMinor: '2000000',
      status: 'ISSUED',
      number: expect.stringMatching(/^INV-202610-[0-9A-F]{8}$/) as string,
      lines: [
        { quantity: 3, amountMinor: '1500000' },
        { quantity: 1, amountMinor: '500000' },
      ],
    });
    const again = await s.asAdmin('post', '/platform/invoices', {
      organisationId: s.org.id,
      month: '2026-10',
    });
    expect(errorOf(again).message).toMatch(/already invoiced/);

    const id = (first.body as { id: string }).id;
    await s.asAdmin('patch', `/platform/invoices/${id}`, { status: 'VOID' }).expect(200);
    // Above the minimum once more rooms are active.
    const type = await db.roomType.findFirstOrThrow({ where: { propertyId: s.p1.id } });
    for (const n of ['105', '106']) await makeRoom(db, type, { number: n });
    const reissued = await s.asAdmin('post', '/platform/invoices', {
      organisationId: s.org.id,
      month: '2026-10',
    });
    expect(reissued.body).toMatchObject({
      activeRooms: 5,
      totalMinor: '2500000',
      lines: [{ quantity: 5 }],
    });
    const paid = await s.asAdmin(
      'patch',
      `/platform/invoices/${(reissued.body as { id: string }).id}`,
      { status: 'PAID' },
    );
    expect(paid.body).toMatchObject({ status: 'PAID' });
    const late = await s.asAdmin(
      'patch',
      `/platform/invoices/${(reissued.body as { id: string }).id}`,
      { status: 'VOID' },
    );
    expect(late.status).toBe(409);
    await expect(
      db.platformInvoice.update({ where: { id }, data: { totalMinor: 1n } }),
    ).rejects.toThrow();

    // Every platform change is in the group's own audit log, as SUPPORT.
    const audit = await db.auditEvent.findMany({
      where: { organisationId: s.org.id, actorType: 'SUPPORT' },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'platform.subscription_set',
      'platform.invoice_issued',
      'platform.invoice_voided',
      'platform.invoice_issued',
      'platform.invoice_paid',
    ]);
  });
});

describe('feature flags (M13-05)', () => {
  it('a module switched off answers MODULE_DISABLED for that group, and /me says so', async () => {
    const s = await setup();
    expect((await s.owner.get('/leakage/alerts')).status).toBe(200);
    const off = await s.asAdmin('patch', `/platform/tenants/${s.org.id}/flags`, {
      flags: [{ module: 'leakage', enabled: false }],
    });
    expect(off.body).toEqual({
      flags: [
        { module: 'leakage', label: 'Revenue Leakage Guard', enabled: false },
        { module: 'owner', label: 'Owner Remote Control', enabled: true },
      ],
    });
    const refused = await s.owner.get('/leakage/alerts');
    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toMatchObject({
      code: 'MODULE_DISABLED',
      details: { module: 'leakage' },
    });
    expect((await s.owner.get('/owner/home')).status).toBe(200);
    const me = (await s.owner.get('/me')).body as {
      organisations: { disabledModules: string[] }[];
    };
    expect(me.organisations[0]?.disabledModules).toEqual(['leakage']);
    await s.asAdmin('patch', `/platform/tenants/${s.org.id}/flags`, {
      flags: [{ module: 'leakage', enabled: true }],
    });
    expect((await s.owner.get('/leakage/alerts')).status).toBe(200);
  });
});

describe('support sessions (M13-02; M13 AC)', () => {
  it('only through a session: read-only, every record viewed is logged, the owner sees it, it expires on time', async () => {
    const s = await setup();
    const asAdminIn = (path: string, method: 'get' | 'post' = 'get', body?: object) => {
      const req = request(s.c.app)
        [method](`/api/v1${path}`)
        .set('Cookie', s.adminCookie)
        .set('X-Property-Id', s.p1.id)
        .set('Origin', APP_ORIGIN);
      if (method === 'post') req.set('Idempotency-Key', crypto.randomUUID());
      return body ? req.send(body) : req;
    };
    // No session: the group's data is out of reach, as for anyone outside it.
    expect((await asAdminIn('/front-desk/arrivals')).status).toBe(404);

    const short = await s.asAdmin('post', '/platform/support-sessions', {
      organisationId: s.org.id,
      reason: 'Help',
    });
    expect(short.status).toBe(400);
    const started = await s.asAdmin('post', '/platform/support-sessions', {
      organisationId: s.org.id,
      reason: 'Owner reports the arrivals list is empty',
      minutes: 15,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const sessionId = (started.body as { id: string }).id;

    const arrivals = await asAdminIn('/front-desk/arrivals');
    expect(arrivals.status).toBe(200);
    const me = (await request(s.c.app).get('/api/v1/me').set('Cookie', s.adminCookie)).body as {
      platformAdmin: boolean;
      support: { sessionId: string }[];
      properties: { id: string }[];
    };
    expect(me.platformAdmin).toBe(true);
    expect(me.support.map((x) => x.sessionId)).toEqual([sessionId]);
    expect(me.properties.map((p) => p.id)).toContain(s.p1.id);

    // Read-only: nothing changes.
    const write = await asAdminIn('/guests', 'post', { firstName: 'Ada', lastName: 'Obi' });
    expect(write.status).toBe(403);
    expect(errorOf(write).message).toBe('A support session is read-only.');
    expect(await db.guest.count()).toBe(0);

    // Every record viewed is in the group's audit log as SUPPORT.
    await expect
      .poll(async () =>
        db.auditEvent.count({ where: { action: 'support.viewed', actorType: 'SUPPORT' } }),
      )
      .toBe(1);
    const viewed = await db.auditEvent.findFirstOrThrow({ where: { action: 'support.viewed' } });
    expect(viewed).toMatchObject({
      organisationId: s.org.id,
      propertyId: s.p1.id,
      actorUserId: s.admin.id,
      entityId: '/front-desk/arrivals',
      after: { sessionId },
    });

    // The owner sees the session, its reason and how much was opened.
    const billing = await s.owner.get('/subscription');
    expect(billing.body).toMatchObject({
      supportSessions: [
        {
          id: sessionId,
          reason: 'Owner reports the arrivals list is empty',
          active: true,
          views: 1,
          admin: { email: ADMIN_EMAIL },
        },
      ],
    });

    // Expires on time.
    now = new Date(now.getTime() + 15 * 60_000 + 1000);
    s.adminCookie = await s.cookie(s.admin.id);
    expect((await asAdminIn('/front-desk/arrivals')).status).toBe(404);
  });

  it('ends early when the admin says so; one open session per group and admin', async () => {
    const s = await setup();
    const body = { organisationId: s.org.id, reason: 'Checking a reported total' };
    const started = await s.asAdmin('post', '/platform/support-sessions', body);
    expect((await s.asAdmin('post', '/platform/support-sessions', body)).status).toBe(409);
    const id = (started.body as { id: string }).id;
    const ended = await s.asAdmin('post', `/platform/support-sessions/${id}/end`);
    expect(ended.body).toMatchObject({ active: false });
    const res = await request(s.c.app)
      .get('/api/v1/front-desk/arrivals')
      .set('Cookie', s.adminCookie)
      .set('X-Property-Id', s.p1.id);
    expect(res.status).toBe(404);
  });
});

describe('the owner’s billing page (M13-04)', () => {
  it('plan, usage with this month’s estimate, invoices as PDF, and the legal name', async () => {
    const s = await setup();
    await s
      .asAdmin('put', `/platform/tenants/${s.org.id}/subscription`, s.subscription)
      .expect(200);
    const inv = await s.asAdmin('post', '/platform/invoices', {
      organisationId: s.org.id,
      month: '2026-10',
    });
    const page = await s.owner.get('/subscription');
    expect(page.body).toMatchObject({
      subscription: { plan: 'PROFESSIONAL', pricePerRoomMinor: '500000' },
      usage: { activeRooms: 3, estimateMinor: '2000000' },
      invoices: [{ id: (inv.body as { id: string }).id }],
    });
    const pdf = await s.owner
      .get(`/subscription/invoices/${(inv.body as { id: string }).id}.pdf`)
      .buffer(true);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const named = await s.owner.patch('/subscription/billing', { legalName: 'Obi Hotels Limited' });
    expect(named.body).toEqual({ legalName: 'Obi Hotels Limited' });
    expect((await db.organisation.findUniqueOrThrow({ where: { id: s.org.id } })).legalName).toBe(
      'Obi Hotels Limited',
    );
    // Needs subscription.read: the front desk is refused.
    const fd = s.c.as(await s.cookie(s.fd.id));
    expect((await fd.get('/subscription')).status).toBe(403);
  });
});
