import { HOTEL_PERMISSION_CODES } from '@hotel/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../core/passwords.ts';
import { PASSWORD } from '../../../test/auth.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeOrganisation, makeProperty, makeUser } from '../../../test/factories.ts';
import { APP_ORIGIN, buildTestApp, errorOf } from '../../../test/helpers.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { ROLE_TEMPLATES } from '../identity/role-templates.ts';
import { INVITATION_TTL_MS } from './service.ts';

const db = testDb();

let now: Date;
const clock = () => new Date(now);

/** An organisation like a fresh sign-up: the role templates, two properties, three people. */
async function makeHotel() {
  const org = await makeOrganisation(db, { name: 'Obi Hotels' });
  const p1 = await makeProperty(db, org.id, { code: 'P1' });
  const p2 = await makeProperty(db, org.id, { code: 'P2' });
  const roles: Record<string, string> = {};
  for (const t of ROLE_TEMPLATES) {
    const role = await db.role.create({
      data: {
        organisationId: org.id,
        name: t.name,
        isSystem: true,
        requiresMfa: t.requiresMfa,
        permissions: [...t.permissions],
      },
    });
    roles[t.slug] = role.id;
  }
  const person = async (
    slug: string,
    propertyId: string | null,
    data: { email?: string; phone?: string } = {},
  ) => {
    const user = await makeUser(db, data);
    await db.user.update({
      where: { id: user.id },
      data: {
        status: 'ACTIVE',
        passwordHash: await hashPassword(PASSWORD),
        ...(user.email ? { emailVerifiedAt: now } : {}),
      },
    });
    await db.membership.create({
      data: { userId: user.id, organisationId: org.id, propertyId, roleId: roles[slug] ?? '' },
    });
    return user;
  };
  const owner = await person('owner', null);
  const gm = await person('gm', p1.id);
  const fd = await person('front-desk', p1.id);
  const role = (slug: string) => roles[slug] ?? '';
  return { org, p1, p2, roles, role, owner, gm, fd, person };
}

function client(propertyId: string) {
  const { app, email } = buildTestApp(undefined, { db, clock });
  const as = (cookie: string) => {
    const withHeaders = (req: request.Test) =>
      req.set('Cookie', cookie).set('X-Property-Id', propertyId).set('Origin', APP_ORIGIN);
    return {
      get: (path: string) => withHeaders(request(app).get(`/api/v1${path}`)),
      post: (path: string, body?: object) =>
        withHeaders(request(app).post(`/api/v1${path}`)).send(body ?? {}),
      patch: (path: string, body: object) =>
        withHeaders(request(app).patch(`/api/v1${path}`)).send(body),
    };
  };
  const anon = {
    post: (path: string, body: object, cookie?: string) => {
      const req = request(app).post(`/api/v1${path}`).set('Origin', APP_ORIGIN);
      return (cookie ? req.set('Cookie', cookie) : req).send(body);
    },
  };
  return { app, email, as, anon };
}

const tokenFrom = (link: string) => new URL(link).searchParams.get('token') ?? '';

beforeEach(async () => {
  await resetDb(db);
  // Real time: test/tenancy.ts sessionCookie() stamps sessions with the system clock.
  now = new Date();
});

// ---------------------------------------------------------------------------------------

describe('permission catalogue', () => {
  it('lists every hotel permission, never platform ones, with their limit kinds', async () => {
    const h = await makeHotel();
    const api = client(h.p1.id).as(await sessionCookie(db, h.fd.id));
    const res = await api.get('/permissions');
    expect(res.status).toBe(200);
    const data = (res.body as { data: { code: string; limits: string[] }[] }).data;
    expect(data.map((d) => d.code)).toEqual(HOTEL_PERMISSION_CODES);
    expect(data.some((d) => d.code.startsWith('platform.'))).toBe(false);
    expect(data.find((d) => d.code === 'folio.discount')?.limits).toEqual(['percent', 'amount']);
  });
});

describe('roles (M1-05)', () => {
  it('lists the organisation’s roles with how many people hold each', async () => {
    const h = await makeHotel();
    const res = await client(h.p1.id)
      .as(await sessionCookie(db, h.gm.id))
      .get('/roles');
    expect(res.status).toBe(200);
    const roles = (res.body as { data: { name: string; memberCount: number }[] }).data;
    expect(roles).toHaveLength(12);
    expect(roles.find((r) => r.name === 'Front Desk / Cashier')?.memberCount).toBe(1);
  });

  it('lets only role.manage holders create and edit roles', async () => {
    const h = await makeHotel();
    const gm = client(h.p1.id).as(await sessionCookie(db, h.gm.id));
    const res = await gm.post('/roles', { name: 'Bar', permissions: ['pos.order'] });
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ permission: 'role.manage' });
  });

  it('creates a custom role with permissions and limits, and checks them', async () => {
    const h = await makeHotel();
    const owner = client(h.p1.id).as(await sessionCookie(db, h.owner.id));
    const created = await owner.post('/roles', {
      name: 'Senior cashier',
      permissions: ['folio.read', 'folio.discount'],
      limits: { 'folio.discount': { maxBps: 2000 } },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Senior cashier',
      isSystem: false,
      requiresMfa: false,
      memberCount: 0,
    });

    const bad = async (body: object, path: string) => {
      const res = await owner.post('/roles', {
        name: `R ${Math.random()}`,
        permissions: [],
        ...body,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect((errorOf(res).details?.['issues'] as { path: string }[])[0]?.path).toContain(path);
    };
    await bad({ name: 'Senior cashier' }, 'body.name');
    await bad({ permissions: ['made.up'] }, 'body.permissions');
    await bad({ permissions: ['platform.admin'] }, 'body.permissions');
    await bad(
      { permissions: ['folio.read'], limits: { 'folio.read': { maxBps: 10 } } },
      'body.limits',
    );
    await bad(
      { permissions: ['folio.discount'], limits: { 'folio.discount': { maxCount: 1 } } },
      'body.limits',
    );
    await bad({ permissions: [], limits: { 'folio.discount': { maxBps: 10 } } }, 'body.limits');
  });

  it('applies a permission change to holders on their next request', async () => {
    const h = await makeHotel();
    const owner = client(h.p1.id).as(await sessionCookie(db, h.owner.id));
    const gmCookie = await sessionCookie(db, h.gm.id);
    await client(h.p1.id).as(gmCookie).get('/roles').expect(200);
    const gmPerms = HOTEL_PERMISSION_CODES.filter((c) => c !== 'role.assign');
    await owner.patch(`/roles/${h.role('gm')}`, { permissions: gmPerms }).expect(200);
    expect((await client(h.p1.id).as(gmCookie).get('/roles')).status).toBe(403);
  });

  it('protects built-in names and the Owner role', async () => {
    const h = await makeHotel();
    const owner = client(h.p1.id).as(await sessionCookie(db, h.owner.id));
    const rename = await owner.patch(`/roles/${h.role('gm')}`, { name: 'Boss' });
    expect(errorOf(rename).code).toBe('STATE_TRANSITION_INVALID');
    const strip = await owner.patch(`/roles/${h.role('owner')}`, { permissions: ['owner.read'] });
    expect(errorOf(strip).message).toMatch(/must keep role.manage, role.assign, user.invite/);
    const noMfa = await owner.patch(`/roles/${h.role('owner')}`, { requiresMfa: false });
    expect(errorOf(noMfa).code).toBe('STATE_TRANSITION_INVALID');
    // Limits and other codes on the Owner role are fine.
    await owner
      .patch(`/roles/${h.role('owner')}`, {
        limits: { 'payment.refund': { maxAmountMinor: '5000000' } },
      })
      .expect(200);
    // Custom roles can be renamed.
    const custom = await owner.post('/roles', { name: 'Old', permissions: [] });
    await owner.patch(`/roles/${(custom.body as { id: string }).id}`, { name: 'New' }).expect(200);
  });
});

// ---------------------------------------------------------------------------------------

describe('users (M1-04)', () => {
  it('lists people with a role here, and who the caller may change', async () => {
    const h = await makeHotel();
    const elsewhere = await h.person('front-desk', h.p2.id); // only at the other property
    const res = await client(h.p1.id)
      .as(await sessionCookie(db, h.gm.id))
      .get('/users');
    expect(res.status).toBe(200);
    const users = (
      res.body as { data: { id: string; canManage: boolean; roles: { scope: string }[] }[] }
    ).data;
    expect(users.map((u) => u.id).sort()).toEqual([h.owner.id, h.gm.id, h.fd.id].sort());
    expect(users.find((u) => u.id === elsewhere.id)).toBeUndefined();
    const byId = new Map(users.map((u) => [u.id, u]));
    expect(byId.get(h.fd.id)?.canManage).toBe(true);
    expect(byId.get(h.gm.id)?.canManage).toBe(false); // themselves
    expect(byId.get(h.owner.id)?.canManage).toBe(false); // holds permissions the GM lacks
    expect(byId.get(h.owner.id)?.roles[0]?.scope).toBe('ORGANISATION');
  });

  it('pages the list', async () => {
    const h = await makeHotel();
    const api = client(h.p1.id).as(await sessionCookie(db, h.gm.id));
    const first = await api.get('/users?limit=2');
    const { data, nextCursor } = first.body as { data: unknown[]; nextCursor: string | null };
    expect(data).toHaveLength(2);
    const second = await api.get(`/users?limit=2&cursor=${nextCursor}`);
    expect((second.body as { data: unknown[]; nextCursor: null }).data).toHaveLength(1);
    expect((second.body as { nextCursor: null }).nextCursor).toBeNull();
  });

  it('gives and takes roles within the caller’s own permissions', async () => {
    const h = await makeHotel();
    const gm = client(h.p1.id).as(await sessionCookie(db, h.gm.id));
    const res = await gm.patch(`/users/${h.fd.id}`, {
      roleIds: [h.role('front-desk'), h.role('night-auditor')],
    });
    expect(res.status).toBe(200);
    expect(
      (res.body as { roles: { roleName: string }[] }).roles.map((r) => r.roleName).sort(),
    ).toEqual(['Front Desk / Cashier', 'Night Auditor']);
    // The GM lacks owner-only codes, so can't hand out the Owner role.
    const owner = await gm.patch(`/users/${h.fd.id}`, { roleIds: [h.role('owner')] });
    expect(owner.status).toBe(403);
    expect(errorOf(owner).details?.['roleId']).toBe(h.role('owner'));
  });

  it('never lets anyone change themselves, users above them, or organisation-wide roles without role.manage', async () => {
    const h = await makeHotel();
    const gm = client(h.p1.id).as(await sessionCookie(db, h.gm.id));
    expect(errorOf(await gm.patch(`/users/${h.gm.id}`, { status: 'DISABLED' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    expect((await gm.patch(`/users/${h.owner.id}`, { status: 'DISABLED' })).status).toBe(403);
    const orgWide = await gm.patch(`/users/${h.fd.id}`, { orgRoleIds: [h.role('auditor')] });
    expect(errorOf(orgWide).details).toEqual({ permission: 'role.manage' });
    const unknown = await gm.patch(`/users/${h.fd.id}`, { roleIds: [crypto.randomUUID()] });
    expect(unknown.status).toBe(400);
  });

  it('ends access through a removed role on the very next request (issue 35)', async () => {
    const h = await makeHotel();
    const fdCookie = await sessionCookie(db, h.fd.id);
    const fd = client(h.p1.id).as(fdCookie);
    await fd.get('/permissions').expect(200);
    await client(h.p1.id)
      .as(await sessionCookie(db, h.owner.id))
      .patch(`/users/${h.fd.id}`, { roleIds: [] })
      .expect(200);
    // Still signed in, but this property is gone for them.
    expect(
      (await request(buildTestApp(undefined, { db }).app).get('/api/v1/me').set('Cookie', fdCookie))
        .status,
    ).toBe(200);
    const res = await request(buildTestApp(undefined, { db }).app)
      .get('/api/v1/roles')
      .set('Cookie', fdCookie)
      .set('X-Property-Id', h.p1.id);
    expect(res.status).toBe(404);
  });

  it('disabling signs the user out everywhere and stops sign-in', async () => {
    const h = await makeHotel();
    const fdCookie = await sessionCookie(db, h.fd.id);
    await client(h.p1.id)
      .as(await sessionCookie(db, h.gm.id))
      .patch(`/users/${h.fd.id}`, { status: 'DISABLED' })
      .expect(200);
    const { app } = buildTestApp(undefined, { db });
    expect((await request(app).get('/api/v1/me').set('Cookie', fdCookie)).status).toBe(401);
    const signIn = await request(app)
      .post('/api/v1/auth/sign-in')
      .set('Origin', APP_ORIGIN)
      .send({ login: h.fd.email, password: PASSWORD });
    expect(signIn.status).toBe(401);
  });

  it('resets MFA: off, recovery codes gone, signed out (issue 37)', async () => {
    const h = await makeHotel();
    await db.user.update({
      where: { id: h.fd.id },
      data: { mfaEnabled: true, mfaSecretEnc: new Uint8Array([1, 2, 3]) },
    });
    await db.mfaRecoveryCode.create({ data: { userId: h.fd.id, codeHash: 'x' } });
    const fdCookie = await sessionCookie(db, h.fd.id);
    const res = await client(h.p1.id)
      .as(await sessionCookie(db, h.gm.id))
      .patch(`/users/${h.fd.id}`, { resetMfa: true });
    expect(res.status).toBe(200);
    expect(await db.user.findUniqueOrThrow({ where: { id: h.fd.id } })).toMatchObject({
      mfaEnabled: false,
      mfaSecretEnc: null,
    });
    expect(await db.mfaRecoveryCode.count({ where: { userId: h.fd.id } })).toBe(0);
    expect(
      (await request(buildTestApp(undefined, { db }).app).get('/api/v1/me').set('Cookie', fdCookie))
        .status,
    ).toBe(401);
  });

  it('keeps an active owner, even against an all-powerful custom role', async () => {
    const h = await makeHotel();
    const superRole = await db.role.create({
      data: { organisationId: h.org.id, name: 'Super', permissions: [...HOTEL_PERMISSION_CODES] },
    });
    const admin = await makeUser(db);
    await db.user.update({ where: { id: admin.id }, data: { status: 'ACTIVE' } });
    await db.membership.create({
      data: { userId: admin.id, organisationId: h.org.id, propertyId: null, roleId: superRole.id },
    });
    const api = client(h.p1.id).as(await sessionCookie(db, admin.id));
    const res = await api.patch(`/users/${h.owner.id}`, { status: 'DISABLED' });
    expect(errorOf(res).message).toBe('The organisation needs at least one active owner.');
    expect((await api.patch(`/users/${h.owner.id}`, { orgRoleIds: [] })).status).toBe(409);
  });

  it('creates a one-time reset link for phone-only staff (issue 34)', async () => {
    const h = await makeHotel();
    const attendant = await h.person('hk-attendant', h.p1.id, { phone: '+2348012345678' });
    const gm = client(h.p1.id).as(await sessionCookie(db, h.gm.id));
    const res = await gm.post(`/users/${attendant.id}/password-reset-link`);
    expect(res.status).toBe(201);
    const { link, expiresAt } = res.body as { link: string; expiresAt: string };
    expect(new Date(expiresAt).getTime() - now.getTime()).toBe(24 * 3_600_000);

    const anon = client(h.p1.id).anon;
    await anon
      .post('/auth/password/reset', { token: tokenFrom(link), password: 'a brand new passphrase' })
      .expect(204);
    await anon
      .post('/auth/sign-in', { login: '+2348012345678', password: 'a brand new passphrase' })
      .expect(200);
    expect((await gm.post(`/users/${h.owner.id}/password-reset-link`)).status).toBe(403);
    expect((await gm.post(`/users/${h.gm.id}/password-reset-link`)).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------------------

describe('invitations (M1-04)', () => {
  it('invites by email; the invitee previews, joins with a name and password, and signs in', async () => {
    const h = await makeHotel();
    const c = client(h.p1.id);
    const gm = c.as(await sessionCookie(db, h.gm.id));
    const res = await gm.post('/users/invitations', {
      email: 'New.Clerk@Example.test',
      roleId: h.role('front-desk'),
    });
    expect(res.status).toBe(201);
    expect((res.body as { link: unknown }).link).toBeNull(); // emailed, not shown
    const mail = c.email.lastTo('new.clerk@example.test');
    expect(mail?.tag).toBe('invitation');
    const token = /token=([\w-]+)/.exec(mail?.text ?? '')?.[1] ?? '';

    const list = await gm.get('/users/invitations');
    expect((list.body as { data: { email: string; scope: string }[] }).data).toEqual([
      expect.objectContaining({ email: 'new.clerk@example.test', scope: 'PROPERTY' }),
    ]);

    const preview = await c.anon.post('/auth/invitations/preview', { token });
    expect(preview.body).toEqual({
      organisationName: 'Obi Hotels',
      propertyName: h.p1.name,
      roleName: 'Front Desk / Cashier',
      email: 'new.clerk@example.test',
      phone: null,
      accountExists: false,
    });

    const missing = await c.anon.post('/auth/invitations/accept', { token });
    expect((errorOf(missing).details?.['issues'] as { path: string }[]).map((i) => i.path)).toEqual(
      ['body.name', 'body.password'],
    );
    await c.anon
      .post('/auth/invitations/accept', { token, name: 'Chidi Eze', password: PASSWORD })
      .expect(204);

    const user = await db.user.findUniqueOrThrow({ where: { email: 'new.clerk@example.test' } });
    expect(user).toMatchObject({ name: 'Chidi Eze', status: 'ACTIVE' });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await db.membership.count({ where: { userId: user.id, propertyId: h.p1.id } })).toBe(1);
    await c.anon
      .post('/auth/sign-in', { login: 'new.clerk@example.test', password: PASSWORD })
      .expect(200);
    expect(
      (await c.anon.post('/auth/invitations/accept', { token, name: 'X', password: PASSWORD }))
        .status,
    ).toBe(400);
  });

  it('invites by phone, handing the link to the inviter', async () => {
    const h = await makeHotel();
    const c = client(h.p1.id);
    const res = await c.as(await sessionCookie(db, h.gm.id)).post('/users/invitations', {
      phone: '+2348099990000',
      roleId: h.role('hk-attendant'),
    });
    expect(res.status).toBe(201);
    const link = (res.body as { link: string }).link;
    expect(link).toMatch(/\/accept-invitation\?token=/);
    expect(c.email.sent).toHaveLength(0);
    await c.anon
      .post('/auth/invitations/accept', {
        token: tokenFrom(link),
        name: 'Bisi',
        password: PASSWORD,
      })
      .expect(204);
    await c.anon.post('/auth/sign-in', { login: '+2348099990000', password: PASSWORD }).expect(200);
  });

  it('only invites to roles within the inviter’s permissions, and org-wide only with role.manage', async () => {
    const h = await makeHotel();
    const gm = client(h.p1.id).as(await sessionCookie(db, h.gm.id));
    expect(
      (await gm.post('/users/invitations', { email: 'a@example.test', roleId: h.role('owner') }))
        .status,
    ).toBe(403);
    const orgWide = await gm.post('/users/invitations', {
      email: 'b@example.test',
      roleId: h.role('auditor'),
      scope: 'ORGANISATION',
    });
    expect(errorOf(orgWide).details).toEqual({ permission: 'role.manage' });
    const both = await gm.post('/users/invitations', {
      email: 'c@example.test',
      phone: '+2348000000009',
      roleId: h.role('staff'),
    });
    expect(both.status).toBe(400);
  });

  it('replaces an earlier invitation and can be withdrawn', async () => {
    const h = await makeHotel();
    const c = client(h.p1.id);
    const gm = c.as(await sessionCookie(db, h.gm.id));
    const invite = () =>
      gm.post('/users/invitations', { phone: '+2348011112222', roleId: h.role('staff') });
    const first = tokenFrom(((await invite()).body as { link: string }).link);
    const second = await invite();
    expect((await c.anon.post('/auth/invitations/preview', { token: first })).status).toBe(400);
    const { invitation, link } = second.body as { invitation: { id: string }; link: string };
    await gm.post(`/users/invitations/${invitation.id}/revoke`).expect(204);
    expect(
      (await c.anon.post('/auth/invitations/preview', { token: tokenFrom(link) })).status,
    ).toBe(400);
    expect((await gm.post(`/users/invitations/${invitation.id}/revoke`)).status).toBe(404);
  });

  it('expires after 7 days', async () => {
    const h = await makeHotel();
    const c = client(h.p1.id);
    const res = await c
      .as(await sessionCookie(db, h.gm.id))
      .post('/users/invitations', { phone: '+2348033334444', roleId: h.role('staff') });
    now = new Date(now.getTime() + INVITATION_TTL_MS);
    const accept = await c.anon.post('/auth/invitations/accept', {
      token: tokenFrom((res.body as { link: string }).link),
      name: 'Late',
      password: PASSWORD,
    });
    expect(errorOf(accept).details).toEqual({ reason: 'TOKEN_INVALID' });
  });

  it('adds the role to an existing account only when that account accepts while signed in', async () => {
    const h = await makeHotel();
    // The front-desk user of P1 is invited to P2 as well, by the owner working in P2.
    const c = client(h.p2.id);
    const res = await c.as(await sessionCookie(db, h.owner.id)).post('/users/invitations', {
      email: h.fd.email,
      roleId: h.role('front-desk'),
    });
    expect(res.status).toBe(201);
    const token = /token=([\w-]+)/.exec(c.email.lastTo(h.fd.email ?? '')?.text ?? '')?.[1] ?? '';

    const preview = await c.anon.post('/auth/invitations/preview', { token });
    expect((preview.body as { accountExists: boolean }).accountExists).toBe(true);
    expect((await c.anon.post('/auth/invitations/accept', { token })).status).toBe(401);
    const someoneElse = await c.anon.post(
      '/auth/invitations/accept',
      { token },
      await sessionCookie(db, h.gm.id),
    );
    expect(errorOf(someoneElse).details).toEqual({ reason: 'OTHER_ACCOUNT' });
    await c.anon
      .post('/auth/invitations/accept', { token }, await sessionCookie(db, h.fd.id))
      .expect(204);
    expect(await db.membership.count({ where: { userId: h.fd.id } })).toBe(2);
  });

  it('refuses to invite someone to a role they already have here', async () => {
    const h = await makeHotel();
    const gm = client(h.p1.id).as(await sessionCookie(db, h.gm.id));
    const res = await gm.post('/users/invitations', {
      email: h.fd.email,
      roleId: h.role('front-desk'),
    });
    expect(errorOf(res).code).toBe('STATE_TRANSITION_INVALID');
  });
});
