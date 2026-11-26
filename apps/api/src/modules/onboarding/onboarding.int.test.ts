import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeUser } from '../../../test/factories.ts';
import { APP_ORIGIN, TEST_CONFIG } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

// Onboarding tracker (Versions V2 "enhanced onboarding"; Strategy "go-live within 2 working
// days", "remote training sessions per role"; T-171).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  // Monday 16 November 2026, 10:00 in Lagos.
  now = new Date('2026-11-16T09:00:00Z');
});

type Row = {
  property: { id: string; status: string };
  workingDays: number;
  onTarget: boolean;
  wentLiveAt: string | null;
  checklist: { done: number; required: number; todo: string[] };
  imports: Record<string, number>;
  staff: { members: number; invitations: number };
  contact: { name: string } | null;
  training: {
    needed: { id: string; name: string }[];
    held: number;
    next: { scheduledAt: string; role: string } | null;
  };
};
type Session = { id: string; heldAt: string | null; cancelledAt: string | null };

async function setup() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const admin = await makeUser(db, { email: TEST_CONFIG.platformAdminEmails[0] ?? '' });
  await db.user.update({
    where: { id: admin.id },
    data: {
      name: 'Chidi Support',
      status: 'ACTIVE',
      mfaEnabled: true,
      mfaSecretEnc: Buffer.alloc(32, 1),
    },
  });
  const adminCookie = await sessionCookie(db, admin.id, clock);
  const asAdmin = (method: 'get' | 'post', path: string, body?: object) => {
    const req = request(c.app)
      [method](`/api/v1${path}`)
      .set('Cookie', adminCookie)
      .set('Origin', APP_ORIGIN);
    return body ? req.send(body) : req;
  };
  const tracker = async () => {
    const res = await asAdmin('get', '/platform/onboarding');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { targetWorkingDays: number; data: Row[] };
  };
  const roleId = (slug: string) => h.role(slug);
  const roleName = async (slug: string) =>
    (await db.role.findUniqueOrThrow({ where: { id: h.role(slug) } })).name;
  return { ...h, c, admin, asAdmin, tracker, roleId, roleName };
}

describe('the onboarding tracker', () => {
  it('shows each property’s way to go-live against the 2-working-day target', async () => {
    const s = await setup();
    // P1 was created last Monday and went live on Wednesday: 2 working days.
    await db.property.update({
      where: { id: s.p1.id },
      data: { createdAt: new Date('2026-11-09T08:00:00Z'), status: 'LIVE' },
    });
    await db.auditEvent.create({
      data: {
        organisationId: s.org.id,
        propertyId: s.p1.id,
        actorType: 'USER',
        actorUserId: s.gm.id,
        action: 'property.went_live',
        entityType: 'property',
        entityId: s.p1.id,
        occurredAt: new Date('2026-11-11T15:00:00Z'),
      },
    });
    // P2 was created last Monday too and is still in setup a week later: 5 working days.
    await db.property.update({
      where: { id: s.p2.id },
      data: { createdAt: new Date('2026-11-09T08:00:00Z') },
    });
    // An applied rooms import at P1.
    const file = await db.fileObject.create({
      data: {
        organisationId: s.org.id,
        propertyId: s.p1.id,
        storageKey: `org/${s.org.id}/property/${s.p1.id}/rooms`,
        contentType: 'text/csv',
        sizeBytes: 10,
        scan: 'CLEAN',
        entityType: 'ImportJob',
        uploadedById: s.gm.id,
      },
    });
    await db.importJob.create({
      data: {
        propertyId: s.p1.id,
        kind: 'ROOMS',
        fileId: file.id,
        status: 'APPLIED',
        report: {},
        createdById: s.gm.id,
      },
    });
    await db.organisation.update({
      where: { id: s.org.id },
      data: { onboardingContactId: s.admin.id },
    });

    const t = await s.tracker();
    expect(t.targetWorkingDays).toBe(2);
    const [first, second] = t.data;
    // Still in setup comes first.
    expect(first?.property).toMatchObject({ id: s.p2.id, status: 'SETUP' });
    expect(first).toMatchObject({ workingDays: 5, onTarget: false, wentLiveAt: null });
    expect(first?.checklist.todo.length).toBeGreaterThan(0);
    expect(second).toMatchObject({
      property: { id: s.p1.id, status: 'LIVE' },
      workingDays: 2,
      onTarget: true,
      wentLiveAt: '2026-11-11T15:00:00Z',
      imports: { ROOMS: 1 },
      contact: { name: 'Chidi Support' },
    });
    // The owner (group-wide), the GM and the front desk work at P1; none trained yet.
    expect(second?.staff.members).toBe(3);
    expect(second?.training.needed.map((r) => r.name).sort()).toEqual(
      [await s.roleName('owner'), await s.roleName('gm'), await s.roleName('front-desk')].sort(),
    );

    // A held front-desk session takes the role off the list; a booked one is next.
    const booked = await s.asAdmin('post', `/platform/tenants/${s.org.id}/training`, {
      roleId: s.roleId('front-desk'),
      propertyId: s.p1.id,
      scheduledAt: '2026-11-16T10:00:00Z',
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    now = new Date('2026-11-16T11:00:00Z');
    const held = await s.asAdmin('post', `/platform/training/${(booked.body as Session).id}/held`);
    expect(held.body).toMatchObject({ heldAt: '2026-11-16T11:00:00Z' });
    await s.asAdmin('post', `/platform/tenants/${s.org.id}/training`, {
      roleId: s.roleId('gm'),
      propertyId: null,
      scheduledAt: '2026-11-17T09:00:00Z',
      note: 'Rates and night audit',
    });
    const after = (await s.tracker()).data.find((r) => r.property.id === s.p1.id);
    expect(after?.training.held).toBe(1);
    expect(after?.training.needed.map((r) => r.name)).not.toContain(await s.roleName('front-desk'));
    expect(after?.training.next).toEqual({
      scheduledAt: '2026-11-17T09:00:00Z',
      role: await s.roleName('gm'),
    });
  });

  it('books, holds and cancels sessions once; the hotel sees its own under Help', async () => {
    const s = await setup();
    const book = (body: object) =>
      s.asAdmin('post', `/platform/tenants/${s.org.id}/training`, {
        roleId: s.role('front-desk'),
        scheduledAt: '2026-11-18T09:00:00Z',
        ...body,
      });
    const otherOrg = await makeHotel(db, now);
    expect((await book({ roleId: otherOrg.role('gm') })).status).toBe(400);
    expect((await book({ propertyId: otherOrg.p1.id })).status).toBe(400);

    const a = (await book({})).body as Session;
    const b = (await book({ scheduledAt: '2026-11-19T09:00:00Z' })).body as Session;
    expect((await s.asAdmin('post', `/platform/training/${a.id}/held`)).status).toBe(200);
    expect((await s.asAdmin('post', `/platform/training/${a.id}/held`)).status).toBe(409);
    expect((await s.asAdmin('post', `/platform/training/${a.id}/cancel`)).status).toBe(409);
    const cancelled = await s.asAdmin('post', `/platform/training/${b.id}/cancel`);
    expect(cancelled.body).toMatchObject({ cancelledAt: expect.any(String) as string });

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'training.booked' } });
    expect(audit).toMatchObject({ actorType: 'SUPPORT', organisationId: s.org.id });

    // The hotel sees the session that took place, not the cancelled one.
    const fd = s.c.as(await sessionCookie(db, s.fd.id, clock));
    const mine = await fd.get('/support/training');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect((mine.body as { data: Session[] }).data.map((x) => x.id)).toEqual([a.id]);
    const theirs = hotelClient(db, clock, otherOrg.p1.id).as(
      await sessionCookie(db, otherOrg.gm.id, clock),
    );
    expect(((await theirs.get('/support/training')).body as { data: Session[] }).data).toEqual([]);

    // The tracker is the platform team's.
    expect((await fd.get('/platform/onboarding')).status).toBe(403);
    const list = await s.asAdmin('get', `/platform/tenants/${s.org.id}/training`);
    expect((list.body as { data: Session[]; roles: unknown[] }).data).toHaveLength(2);
  });
});
