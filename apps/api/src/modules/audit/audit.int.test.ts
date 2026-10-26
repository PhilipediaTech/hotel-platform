import type { AuditEvent } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { recordAudit } from '../../core/audit.ts';
import { runAsTenant } from '../../core/tenancy.ts';
import { authApi, PASSWORD, signIn, tokenFromEmail } from '../../../test/auth.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel as makeHotelIn } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

const db = testDb();

let now: Date;
const clock = () => new Date(now);
const makeHotel = () => makeHotelIn(db, now);
const client = (propertyId: string) => hotelClient(db, clock, propertyId);

type Event = z.output<typeof AuditEvent>;

/** Events of the organisation, oldest first. */
const eventsOf = (organisationId: string) =>
  db.auditEvent.findMany({ where: { organisationId }, orderBy: { id: 'asc' } });

beforeEach(async () => {
  await resetDb(db);
  now = new Date();
});

describe('audit_events table', () => {
  it('is append-only: updates and deletes are refused by the database', async () => {
    const h = await makeHotel();
    const event = await db.auditEvent.create({
      data: {
        organisationId: h.org.id,
        actorType: 'SYSTEM',
        action: 'test.done',
        entityType: 'test',
        entityId: '1',
      },
    });
    await expect(
      db.auditEvent.update({ where: { id: event.id }, data: { action: 'test.changed' } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/);
    await expect(db.$executeRaw`DELETE FROM audit_events`).rejects.toThrow(/append-only/);
    expect(await db.auditEvent.count()).toBe(1);
  });

  it('refuses a USER event without an actor', async () => {
    const h = await makeHotel();
    await expect(
      db.auditEvent.create({
        data: {
          organisationId: h.org.id,
          actorType: 'USER',
          action: 'test.done',
          entityType: 'test',
          entityId: '1',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('audit writer', () => {
  it('commits and rolls back with the change it describes', async () => {
    const h = await makeHotel();
    const tenant = {
      userId: h.owner.id,
      organisationId: h.org.id,
      propertyId: h.p1.id,
      roles: [],
      permissions: new Set<string>(),
    };
    await expect(
      runAsTenant(tenant, () =>
        db.$transaction(async (tx) => {
          await tx.role.create({ data: { organisationId: h.org.id, name: 'Doomed' } });
          await recordAudit(tx, { action: 'role.created', entityType: 'role', entityId: 'x' });
          throw new Error('change failed');
        }),
      ),
    ).rejects.toThrow('change failed');
    expect(await db.auditEvent.count()).toBe(0);
    expect(await db.role.count({ where: { name: 'Doomed' } })).toBe(0);

    await runAsTenant(tenant, () =>
      recordAudit(db, {
        action: 'test.done',
        entityType: 'test',
        entityId: '1',
        after: { name: 'x', pinHash: 'h', password: 'p', hasPin: true, at: now },
      }),
    );
    const [event] = await eventsOf(h.org.id);
    expect(event).toMatchObject({
      organisationId: h.org.id,
      propertyId: h.p1.id,
      actorUserId: h.owner.id,
      actorType: 'USER',
      after: { name: 'x', hasPin: true, at: now.toISOString() },
    });
  });
});

// ---------------------------------------------------------------------------------------

describe('access changes are audited (PRD M1 acceptance, issue 39)', () => {
  it('records role creation and edits with the actor and the before/after codes', async () => {
    const h = await makeHotel();
    const owner = client(h.p1.id).as(await sessionCookie(db, h.owner.id));
    const created = await owner
      .post('/roles', { name: 'Bar', permissions: ['pos.order'] })
      .set('User-Agent', 'audit-test/1.0');
    const roleId = (created.body as { id: string }).id;
    await owner.patch(`/roles/${roleId}`, { permissions: ['pos.order', 'pos.void'] }).expect(200);

    const events = await eventsOf(h.org.id);
    expect(events.map((e) => e.action)).toEqual(['role.created', 'role.updated']);
    expect(events[0]).toMatchObject({
      actorUserId: h.owner.id,
      actorType: 'USER',
      entityType: 'role',
      entityId: roleId,
      propertyId: null,
      after: { name: 'Bar', permissions: ['pos.order'] },
      userAgent: 'audit-test/1.0',
    });
    expect(events[0]?.requestId).toMatch(/^req_/);
    expect(events[0]?.ip).toBeTruthy();
    expect(events[1]).toMatchObject({
      before: { permissions: ['pos.order'] },
      after: { permissions: ['pos.order', 'pos.void'] },
    });
  });

  it('records role changes, disabling, enabling, MFA reset and reset links for a user', async () => {
    const h = await makeHotel();
    const gm = client(h.p1.id).as(await sessionCookie(db, h.gm.id));
    await gm
      .patch(`/users/${h.fd.id}`, { roleIds: [h.role('front-desk'), h.role('reservations')] })
      .expect(200);
    await gm.patch(`/users/${h.fd.id}`, { status: 'DISABLED' }).expect(200);
    await gm.patch(`/users/${h.fd.id}`, { status: 'ACTIVE' }).expect(200);
    await gm.patch(`/users/${h.fd.id}`, { resetMfa: true }).expect(200);
    await gm.post(`/users/${h.fd.id}/password-reset-link`).expect(201);

    const events = await eventsOf(h.org.id);
    expect(events.map((e) => e.action)).toEqual([
      'user.roles_changed',
      'user.disabled',
      'user.enabled',
      'user.mfa_reset',
      'user.password_reset_link_created',
    ]);
    for (const e of events) {
      expect(e).toMatchObject({ actorUserId: h.gm.id, entityType: 'user', entityId: h.fd.id });
    }
    const roles = (v: unknown) => (v as { roles: { role: string }[] }).roles.map((r) => r.role);
    expect(roles(events[0]?.before)).toEqual(['Front Desk / Cashier']);
    expect(roles(events[0]?.after)).toEqual(['Front Desk / Cashier', 'Reservations Agent']);
    expect(events[1]).toMatchObject({
      before: { status: 'ACTIVE' },
      after: { status: 'DISABLED' },
    });
    // No secret ever lands in the log.
    expect(JSON.stringify(events.map((e) => [e.before, e.after]))).not.toMatch(/token|Hash/);
  });

  it('records nothing when the change is refused', async () => {
    const h = await makeHotel();
    const gm = client(h.p1.id).as(await sessionCookie(db, h.gm.id));
    await gm.patch(`/users/${h.owner.id}`, { status: 'DISABLED' }).expect(403);
    expect(await db.auditEvent.count()).toBe(0);
  });

  it('records invitations created, withdrawn and accepted', async () => {
    const h = await makeHotel();
    const c = client(h.p1.id);
    const gm = c.as(await sessionCookie(db, h.gm.id));
    const first = await gm.post('/users/invitations', {
      phone: '+2348011112222',
      roleId: h.role('staff'),
    });
    const { invitation } = first.body as { invitation: { id: string } };
    await gm.post(`/users/invitations/${invitation.id}/revoke`).expect(204);
    const second = await gm.post('/users/invitations', {
      phone: '+2348011113333',
      roleId: h.role('staff'),
    });
    const { link, invitation: inv2 } = second.body as { link: string; invitation: { id: string } };
    const token = new URL(link).searchParams.get('token') ?? '';
    await c.anon
      .post('/auth/invitations/accept', { token, name: 'Bisi', password: PASSWORD })
      .expect(204);

    const events = await eventsOf(h.org.id);
    expect(events.map((e) => e.action)).toEqual([
      'invitation.created',
      'invitation.revoked',
      'invitation.created',
      'invitation.accepted',
    ]);
    expect(events[0]).toMatchObject({
      actorUserId: h.gm.id,
      propertyId: h.p1.id,
      after: { phone: '+2348011112222', role: 'Staff Member', scope: 'PROPERTY' },
    });
    const bisi = await db.user.findUniqueOrThrow({ where: { phone: '+2348011113333' } });
    expect(events[3]).toMatchObject({
      entityId: inv2.id,
      actorUserId: bisi.id,
      propertyId: h.p1.id,
      after: { userId: bisi.id, newAccount: true },
    });
  });
});

describe('sign-in and account events', () => {
  it('records sign-up, verification, sign-in, lockout and password reset', async () => {
    const api = authApi(db, clock);
    await api
      .post('/auth/sign-up', {
        name: 'Ada Obi',
        email: 'ada@example.test',
        password: PASSWORD,
        organisationName: 'Obi Hotels',
        country: 'NG',
        propertyName: 'Obi Lagos Suites',
      })
      .expect(201);
    await api
      .post('/auth/email/verify', { token: tokenFromEmail(api, 'ada@example.test') })
      .expect(204);
    // The owner role needs MFA, so the session waits for a code; the sign-in is still logged.
    await signIn(api, 'ada@example.test');
    for (let i = 0; i < 5; i++) {
      await api.post('/auth/sign-in', { login: 'ada@example.test', password: 'wrong password!' });
    }
    now = new Date(now.getTime() + 16 * 60_000);
    await api.post('/auth/password/reset-request', { email: 'ada@example.test' }).expect(202);
    await api
      .post('/auth/password/reset', {
        token: tokenFromEmail(api, 'ada@example.test'),
        password: 'a brand new passphrase',
      })
      .expect(204);

    const ada = await db.user.findUniqueOrThrow({ where: { email: 'ada@example.test' } });
    const org = await db.organisation.findFirstOrThrow();
    const events = await eventsOf(org.id);
    expect(events.map((e) => e.action)).toEqual([
      'organisation.created',
      'user.email_verified',
      'auth.signed_in',
      'auth.locked',
      'auth.password_reset',
    ]);
    expect(events[0]).toMatchObject({ actorUserId: ada.id, entityId: org.id });
    expect(events[2]).toMatchObject({
      actorUserId: ada.id,
      entityType: 'session',
      propertyId: null,
      after: { method: 'PASSWORD', mfaPending: true },
    });
    expect(events[3]).toMatchObject({ actorType: 'SYSTEM', actorUserId: null, entityId: ada.id });
  });

  it('records a security event in every organisation the user belongs to', async () => {
    const a = await makeHotel();
    const b = await makeHotel();
    await db.membership.create({
      data: {
        userId: a.fd.id,
        organisationId: b.org.id,
        propertyId: null,
        roleId: b.role('staff'),
      },
    });
    await signIn(authApi(db, clock), a.fd.email ?? '');
    expect((await eventsOf(a.org.id)).map((e) => e.action)).toEqual(['auth.signed_in']);
    expect((await eventsOf(b.org.id)).map((e) => e.action)).toEqual(['auth.signed_in']);
  });
});

// ---------------------------------------------------------------------------------------

describe('GET /audit-events (M1-11)', () => {
  async function seeded() {
    const h = await makeHotel();
    const event = (data: {
      action: string;
      entityType?: string;
      entityId?: string;
      propertyId?: string | null;
      actorUserId?: string | null;
      occurredAt?: Date;
    }) =>
      db.auditEvent.create({
        data: {
          organisationId: h.org.id,
          entityType: 'role',
          entityId: 'r1',
          propertyId: null,
          actorUserId: h.owner.id,
          actorType: data.actorUserId === null ? 'SYSTEM' : 'USER',
          ...data,
        },
      });
    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));
    await event({ action: 'role.created', occurredAt: day(1) });
    await event({ action: 'role.updated', occurredAt: day(2) });
    await event({
      action: 'user.disabled',
      entityType: 'user',
      entityId: h.fd.id,
      propertyId: h.p1.id,
      actorUserId: h.gm.id,
      occurredAt: day(3),
    });
    await event({ action: 'auth.locked', actorUserId: null, occurredAt: day(4) });
    await event({ action: 'user.disabled', propertyId: h.p2.id, occurredAt: day(5) });
    return { h, day, api: client(h.p1.id).as(await sessionCookie(db, h.owner.id)) };
  }
  const actions = (body: unknown) => (body as { data: Event[] }).data.map((e) => e.action);

  it('lists this property’s and organisation-level events, newest first, with the actor', async () => {
    const { h, api } = await seeded();
    const res = await api.get('/audit-events');
    expect(res.status).toBe(200);
    // The P2 event is not shown in P1.
    expect(actions(res.body)).toEqual([
      'auth.locked',
      'user.disabled',
      'role.updated',
      'role.created',
    ]);
    const [locked, disabled] = (res.body as { data: Event[] }).data;
    expect(locked).toMatchObject({ actorType: 'SYSTEM', actor: null, propertyId: null });
    expect(disabled).toMatchObject({
      actor: { id: h.gm.id, name: h.gm.name },
      propertyId: h.p1.id,
      entityType: 'user',
    });
    expect(disabled?.id).toMatch(/^\d+$/);
  });

  it('filters by user, record, action prefix and dates', async () => {
    const { h, day, api } = await seeded();
    const q = async (query: string) => actions((await api.get(`/audit-events?${query}`)).body);
    expect(await q(`actorUserId=${h.gm.id}`)).toEqual(['user.disabled']);
    expect(await q(`entityType=user&entityId=${h.fd.id}`)).toEqual(['user.disabled']);
    expect(await q('action=role')).toEqual(['role.updated', 'role.created']);
    expect(await q('action=role.created')).toEqual(['role.created']);
    // A prefix matches whole segments only.
    expect(await q('action=rol')).toEqual([]);
    const iso = (d: Date) => d.toISOString().replace('.000', '');
    expect(await q(`from=${iso(day(2))}&to=${iso(day(4))}`)).toEqual([
      'user.disabled',
      'role.updated',
    ]);
    expect((await api.get('/audit-events?from=yesterday')).status).toBe(400);
  });

  it('pages with a cursor', async () => {
    const { api } = await seeded();
    const first = await api.get('/audit-events?limit=3');
    const body = first.body as { data: Event[]; nextCursor: string | null };
    expect(actions(body)).toEqual(['auth.locked', 'user.disabled', 'role.updated']);
    expect(body.nextCursor).toBeTruthy();
    const second = await api.get(`/audit-events?limit=3&cursor=${body.nextCursor ?? ''}`);
    expect(second.body).toMatchObject({ nextCursor: null });
    expect(actions(second.body)).toEqual(['role.created']);
  });

  it('needs audit.read', async () => {
    const { h } = await seeded();
    const res = await client(h.p1.id)
      .as(await sessionCookie(db, h.fd.id))
      .get('/audit-events');
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ permission: 'audit.read' });
  });
});
