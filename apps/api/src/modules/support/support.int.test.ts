import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeUser } from '../../../test/factories.ts';
import { APP_ORIGIN, TEST_CONFIG } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import type { DomainEventRecord } from '../../core/outbox.ts';
import { supportAlertHandler } from './service.ts';

// In-app support (Versions V2 "enhanced onboarding, support tooling"; Strategy "Support";
// T-170): hotel staff ask from Help, the platform team answers from S31, and each hotel group
// has a named onboarding contact.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

const ADMIN_EMAIL = TEST_CONFIG.platformAdminEmails[0] ?? '';

type Ticket = {
  id: string;
  status: string;
  urgency: string;
  unread: boolean;
  page: string | null;
  propertyName: string | null;
  firstResponseAt: string | null;
  assignedAdmin?: { id: string; name: string } | null;
  organisation?: { id: string; name: string };
  messages: { fromPlatform: boolean; body: string; author: { name: string } }[];
};

async function setup() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId, clock));
  const admin = await makeUser(db, { email: ADMIN_EMAIL });
  await db.user.update({
    where: { id: admin.id },
    data: {
      name: 'Chidi Support',
      status: 'ACTIVE',
      mfaEnabled: true,
      mfaSecretEnc: Buffer.alloc(32, 1),
      phone: '+2348000000001',
    },
  });
  const adminCookie = await sessionCookie(db, admin.id, clock);
  const asAdmin = (method: 'get' | 'post' | 'put', path: string, body?: object) => {
    const req = request(c.app)
      [method](`/api/v1${path}`)
      .set('Cookie', adminCookie)
      .set('Origin', APP_ORIGIN);
    return body ? req.send(body) : req;
  };
  const fd = await as(h.fd.id);
  const gm = await as(h.gm.id);
  const handler = supportAlertHandler({ db, config: TEST_CONFIG });
  /** Runs the worker's alert for every support message posted so far (twice: at least once). */
  const alert = async () => {
    const events = await db.domainEvent.findMany({ where: { type: 'support.message_posted' } });
    for (const e of events) {
      const record = { ...e, payload: e.payload } as unknown as DomainEventRecord;
      await handler.handle(record);
      await handler.handle(record);
    }
  };
  const deliveries = () =>
    db.notificationDelivery.findMany({
      where: { templateCode: { in: ['SUPPORT_REQUEST', 'SUPPORT_REPLY'] } },
      orderBy: [{ createdAt: 'asc' }, { channel: 'asc' }],
      select: { channel: true, templateCode: true, recipient: true, propertyId: true },
    });
  return { ...h, c, as, admin, asAdmin, desk: fd, manager: gm, alert, deliveries };
}

describe('support conversations', () => {
  it('a blocker reaches the team at once, is answered, and comes back with a reply', async () => {
    const s = await setup();
    const opened = await s.desk.post('/support/tickets', {
      subject: 'Cannot check guests in',
      message: 'The check-in button does nothing since this morning.',
      urgency: 'BLOCKER',
      page: '/front-desk',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const ticket = opened.body as Ticket;
    expect(ticket).toMatchObject({
      status: 'OPEN',
      urgency: 'BLOCKER',
      page: '/front-desk',
      propertyName: s.p1.name,
      unread: false,
      messages: [
        { fromPlatform: false, body: expect.stringContaining('check-in button') as string },
      ],
    });

    // Every admin by email, and the blocker by WhatsApp; kept out of the hotel's list.
    await s.alert();
    expect(await s.deliveries()).toEqual([
      expect.objectContaining({ channel: 'EMAIL', recipient: ADMIN_EMAIL, propertyId: null }),
      expect.objectContaining({ channel: 'WHATSAPP', recipient: '+2348000000001' }),
    ]);

    // The queue: the group, waiting on the team.
    const queue = await s.asAdmin('get', '/platform/support/tickets');
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    expect((queue.body as { data: Ticket[] }).data).toEqual([
      expect.objectContaining({
        id: ticket.id,
        unread: true,
        organisation: { id: s.org.id, name: s.org.name },
        assignedAdmin: null,
      }),
    ]);
    now = new Date('2026-11-10T09:07:00Z');
    const answered = await s.asAdmin('post', `/platform/support/tickets/${ticket.id}/messages`, {
      message: 'Fixed: please refresh the page and try again.',
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body).toMatchObject({
      status: 'ANSWERED',
      firstResponseAt: '2026-11-10T09:07:00Z',
      assignedAdmin: { id: s.admin.id, name: 'Chidi Support' },
    });
    const fdUser = await db.user.findUniqueOrThrow({ where: { id: s.fd.id } });
    expect((await s.deliveries()).at(-1)).toEqual({
      channel: 'EMAIL',
      templateCode: 'SUPPORT_REPLY',
      recipient: fdUser.email,
      propertyId: s.p1.id,
    });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'support.ticket_answered' },
    });
    expect(audit).toMatchObject({ actorType: 'SUPPORT', organisationId: s.org.id });

    // The asker sees the answer as new until they open it.
    const mine = await s.desk.get('/support/tickets');
    expect((mine.body as { data: Ticket[] }).data[0]).toMatchObject({ unread: true });
    const read = await s.desk.get(`/support/tickets/${ticket.id}`);
    expect((read.body as Ticket).messages.map((m) => m.author.name)).toEqual([
      expect.any(String),
      'Chidi Support',
    ]);
    expect((await s.desk.get('/support/tickets')).body).toMatchObject({
      data: [{ unread: false }],
    });

    // A reply goes back to the team's queue (email only: WhatsApp is for new blockers).
    const again = await s.desk.post(`/support/tickets/${ticket.id}/messages`, {
      message: 'Still stuck on room 204.',
    });
    expect(again.body).toMatchObject({ status: 'OPEN' });
    await s.alert();
    expect((await s.deliveries()).filter((d) => d.channel === 'WHATSAPP')).toHaveLength(1);
    expect((await s.deliveries()).filter((d) => d.templateCode === 'SUPPORT_REQUEST')).toHaveLength(
      3,
    );

    const done = await s.desk.post(`/support/tickets/${ticket.id}/resolve`);
    expect(done.body).toMatchObject({ status: 'RESOLVED' });
    const active = await s.asAdmin('get', '/platform/support/tickets');
    expect((active.body as { data: Ticket[] }).data).toEqual([]);
    const resolved = await s.asAdmin('get', '/platform/support/tickets?status=RESOLVED');
    expect((resolved.body as { data: Ticket[] }).data).toHaveLength(1);
  });

  it('staff see their own conversations; support.manage sees the whole group’s', async () => {
    const s = await setup();
    const opened = await s.desk.post('/support/tickets', {
      subject: 'Printer',
      message: 'How do I print a registration card?',
    });
    const id = (opened.body as Ticket).id;
    const other = await s.as((await s.person('front-desk', s.p1.id)).id);
    expect((await other.get('/support/tickets')).body).toMatchObject({ seesAll: false, data: [] });
    expect((await other.get(`/support/tickets/${id}`)).status).toBe(404);
    expect(
      (await other.post(`/support/tickets/${id}/messages`, { message: 'Me too' })).status,
    ).toBe(404);
    const all = await s.manager.get('/support/tickets');
    expect(all.body).toMatchObject({ seesAll: true, data: [{ id, urgency: 'NORMAL' }] });
    // Hotel staff can't reach the queue.
    expect((await s.manager.get('/platform/support/tickets')).status).toBe(403);
    // The team's own alert is not one of the hotel's templates; the reply to the asker is.
    const templates = await s.manager.get('/message-templates');
    expect(templates.status).toBe(200);
    const codes = (templates.body as { templates: { code: string }[] }).templates.map(
      (t) => t.code,
    );
    expect(codes).toContain('SUPPORT_REPLY');
    expect(codes).not.toContain('SUPPORT_REQUEST');
  });

  it('names an onboarding contact the hotel can see; only platform staff qualify', async () => {
    const s = await setup();
    const set = await s.asAdmin('put', `/platform/tenants/${s.org.id}/onboarding-contact`, {
      adminUserId: s.admin.id,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toEqual({ contact: { id: s.admin.id, name: 'Chidi Support' } });
    expect((await s.desk.get('/support/tickets')).body).toMatchObject({
      contact: { name: 'Chidi Support', email: ADMIN_EMAIL },
    });
    const detail = await s.asAdmin('get', `/platform/tenants/${s.org.id}`);
    expect(detail.body).toMatchObject({ onboardingContact: { id: s.admin.id } });

    const notStaff = await s.asAdmin('put', `/platform/tenants/${s.org.id}/onboarding-contact`, {
      adminUserId: s.gm.id,
    });
    expect(notStaff.status).toBe(400);
    const admins = await s.asAdmin('get', '/platform/admins');
    expect(admins.body).toEqual({
      data: [
        { id: s.admin.id, name: 'Chidi Support', email: ADMIN_EMAIL, phone: '+2348000000001' },
      ],
    });
  });
});
