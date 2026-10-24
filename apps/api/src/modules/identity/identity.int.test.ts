import type { listMySessions, Me, RouteResponse } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import request from 'supertest';
import { SESSION_POLICY } from '../../core/auth.ts';
import { hashPassword, SCRYPT_PARAMS } from '../../core/passwords.ts';
import { RATE_LIMITS } from '../../core/rate-limit.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeUser } from '../../../test/factories.ts';
import { APP_ORIGIN, buildTestApp, errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { LOCKOUT, TOKEN_TTL_MS } from './service.ts';

const db = testDb();
const PASSWORD = 'correct horse battery staple';
const MINUTE = 60_000;

let now: Date;
const clock = () => new Date(now);
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

function setup() {
  const { app, email } = buildTestApp(undefined, { db, clock });
  const post = (path: string, body?: object, cookie?: string) => {
    const req = request(app).post(`/api/v1${path}`).set('Origin', APP_ORIGIN);
    if (cookie) req.set('Cookie', cookie);
    return body ? req.send(body) : req;
  };
  const get = (path: string, cookie?: string) => {
    const req = request(app).get(`/api/v1${path}`);
    return cookie ? req.set('Cookie', cookie) : req;
  };
  const del = (path: string, cookie: string) =>
    request(app).delete(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie);
  return { app, email, post, get, del };
}

type Api = ReturnType<typeof setup>;

/** Set-Cookie lines of a response (Node always gives an array for this header). */
function setCookies(res: { headers: Record<string, unknown> }): string[] {
  return (res.headers['set-cookie'] as string[] | undefined) ?? [];
}

/** `sid=<token>` from a response's Set-Cookie, ready for a Cookie header. */
function sidCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = setCookies(res);
  const sid = cookies.find((c) => c.startsWith('sid=') && !c.startsWith('sid=;'));
  if (!sid) throw new Error(`No sid cookie in ${JSON.stringify(cookies)}`);
  return sid.split(';')[0] as string;
}

/** Token from the last link emailed to `to`. */
function tokenFromEmail(api: Api, to: string): string {
  const text = api.email.lastTo(to)?.text ?? '';
  const token = /token=([\w-]+)/.exec(text)?.[1];
  if (!token) throw new Error(`No token in email to ${to}: ${text}`);
  return token;
}

const SIGN_UP = {
  name: 'Ada Obi',
  email: 'Ada@Example.test',
  password: PASSWORD,
  organisationName: 'Obi Hotels',
  country: 'NG',
  propertyName: 'Obi Lagos Suites',
};

async function verifiedUser(data: { email?: string; phone?: string } = {}) {
  const user = await makeUser(db, data);
  return db.user.update({
    where: { id: user.id },
    data: {
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
      ...(user.email ? { emailVerifiedAt: new Date() } : {}),
    },
  });
}

async function signedIn(api: Api, login: string, extra: object = {}) {
  const res = await api.post('/auth/sign-in', { login, password: PASSWORD, ...extra });
  expect(res.status).toBe(200);
  return sidCookie(res);
}

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-12T09:00:00Z');
});

describe('sign-up (M1-01)', () => {
  it('creates the owner, organisation, roles, departments and first property, then emails a link', async () => {
    const api = setup();
    const res = await api.post('/auth/sign-up', SIGN_UP);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ verificationSent: true });
    expect(setCookies(res)).toEqual([]);

    const user = await db.user.findUniqueOrThrow({ where: { email: 'ada@example.test' } });
    expect(user).toMatchObject({ name: 'Ada Obi', status: 'ACTIVE', emailVerifiedAt: null });
    expect(user.passwordHash).toMatch(/^scrypt\$/);

    const org = await db.organisation.findFirstOrThrow({
      include: { roles: true, properties: true },
    });
    expect(org).toMatchObject({ name: 'Obi Hotels', country: 'NG' });
    expect(org.roles).toHaveLength(12);
    expect(org.properties).toEqual([
      expect.objectContaining({
        name: 'Obi Lagos Suites',
        code: 'OLS',
        status: 'SETUP',
        timeZone: 'Africa/Lagos',
        baseCurrency: 'NGN',
        locale: 'en-NG',
      }),
    ]);
    expect(await db.department.count()).toBe(5);

    const membership = await db.membership.findFirstOrThrow({ include: { role: true } });
    expect(membership).toMatchObject({ userId: user.id, propertyId: null });
    expect(membership.role).toMatchObject({ name: 'Owner', requiresMfa: true });
    expect(membership.role.permissions).toContain('owner.read');

    const mail = api.email.lastTo('ada@example.test');
    expect(mail?.tag).toBe('verify-email');
    expect(mail?.text).toContain(`${TEST_CONFIG.appOrigin}/verify-email?token=`);
  });

  it('answers the same for a registered email, creates nothing and tells the owner instead', async () => {
    const api = setup();
    await verifiedUser({ email: 'ada@example.test' });
    const res = await api.post('/auth/sign-up', SIGN_UP);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ verificationSent: true });
    expect(await db.user.count()).toBe(1);
    expect(await db.organisation.count()).toBe(0);
    expect(api.email.lastTo('ada@example.test')?.tag).toBe('account-exists');
  });

  it('re-sends the link when an earlier sign-up was never confirmed', async () => {
    const api = setup();
    await api.post('/auth/sign-up', SIGN_UP).expect(201);
    const first = tokenFromEmail(api, 'ada@example.test');
    await api.post('/auth/sign-up', SIGN_UP).expect(201);
    expect(await db.organisation.count()).toBe(1);
    expect(tokenFromEmail(api, 'ada@example.test')).not.toBe(first);
    // The earlier link no longer works.
    expect((await api.post('/auth/email/verify', { token: first })).status).toBe(400);
  });

  it.each([
    ['a short password', { password: 'short' }, 'body.password'],
    ['an unsupported country', { country: 'FR' }, 'body.country'],
    ['a bad email', { email: 'not-an-email' }, 'body.email'],
  ])('rejects %s', async (_case, change, path) => {
    const res = await setup().post('/auth/sign-up', { ...SIGN_UP, ...change });
    expect(res.status).toBe(400);
    expect(errorOf(res).details?.['issues']).toEqual([expect.objectContaining({ path })]);
  });
});

describe('email verification', () => {
  it('verifies once with the emailed token', async () => {
    const api = setup();
    await api.post('/auth/sign-up', SIGN_UP);
    const token = tokenFromEmail(api, 'ada@example.test');
    await api.post('/auth/email/verify', { token }).expect(204);
    const user = await db.user.findUniqueOrThrow({ where: { email: 'ada@example.test' } });
    expect(user.emailVerifiedAt).not.toBeNull();

    const again = await api.post('/auth/email/verify', { token });
    expect(again.status).toBe(400);
    expect(errorOf(again).details).toEqual({ reason: 'TOKEN_INVALID' });
  });

  it('stores only a hash of the token', async () => {
    const api = setup();
    await api.post('/auth/sign-up', SIGN_UP);
    const token = tokenFromEmail(api, 'ada@example.test');
    const row = await db.authToken.findFirstOrThrow();
    expect(row.tokenHash).not.toContain(token);
  });

  it('expires after 24 hours', async () => {
    const api = setup();
    await api.post('/auth/sign-up', SIGN_UP);
    advance(TOKEN_TTL_MS.EMAIL_VERIFY);
    const res = await api.post('/auth/email/verify', {
      token: tokenFromEmail(api, 'ada@example.test'),
    });
    expect(res.status).toBe(400);
  });

  it('re-sends only to unverified accounts, always answering 202', async () => {
    const api = setup();
    await api.post('/auth/sign-up', SIGN_UP);
    const sentBefore = api.email.sent.length;
    await api
      .post('/auth/email/resend', { email: 'nobody@example.test' })
      .expect(202, { accepted: true });
    expect(api.email.sent).toHaveLength(sentBefore);
    await api.post('/auth/email/resend', { email: 'ADA@example.test' }).expect(202);
    expect(api.email.sent).toHaveLength(sentBefore + 1);
  });
});

describe('sign-in (M1-06)', () => {
  it('signs in with email, sets an httpOnly SameSite=Lax cookie and returns me', async () => {
    const api = setup();
    await api.post('/auth/sign-up', SIGN_UP);
    await api.post('/auth/email/verify', { token: tokenFromEmail(api, 'ada@example.test') });

    const res = await api.post('/auth/sign-in', { login: 'ADA@example.test', password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = setCookies(res)[0] ?? '';
    expect(cookie).toMatch(/^sid=[\w-]{43}; Path=\/; Expires=.+; HttpOnly; SameSite=Lax$/);

    const me = res.body as z.output<typeof Me>;
    expect(me.user).toMatchObject({ name: 'Ada Obi', email: 'ada@example.test' });
    expect(me.session).toMatchObject({ sharedDevice: false, mfaPassed: false });
    expect(me.properties).toEqual([expect.objectContaining({ name: 'Obi Lagos Suites' })]);
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0]).toMatchObject({ propertyId: null, role: { name: 'Owner' } });

    const session = await db.session.findFirstOrThrow();
    expect(session.tokenHash).not.toBe(sidCookie(res).slice(4));
  });

  it('signs in with a phone number', async () => {
    const api = setup();
    await verifiedUser({ phone: '+2348012345678' });
    await signedIn(api, '+2348012345678');
  });

  it('refuses an unverified email only after a correct password', async () => {
    const api = setup();
    await api.post('/auth/sign-up', SIGN_UP);
    const wrong = await api.post('/auth/sign-in', {
      login: SIGN_UP.email,
      password: 'wrong password!',
    });
    expect(wrong.status).toBe(401);
    const right = await api.post('/auth/sign-in', { login: SIGN_UP.email, password: PASSWORD });
    expect(right.status).toBe(403);
    expect(errorOf(right).details).toEqual({ reason: 'EMAIL_NOT_VERIFIED' });
  });

  it('gives the same answer for an unknown login, a wrong password and a disabled account', async () => {
    const api = setup();
    const user = await verifiedUser();
    const disabled = await verifiedUser();
    await db.user.update({ where: { id: disabled.id }, data: { status: 'DISABLED' } });
    const answers = await Promise.all([
      api.post('/auth/sign-in', { login: 'nobody@example.test', password: PASSWORD }),
      api.post('/auth/sign-in', { login: user.email, password: 'wrong password!' }),
      api.post('/auth/sign-in', { login: disabled.email, password: PASSWORD }),
    ]);
    for (const res of answers) expect(res.status).toBe(401);
    expect(new Set(answers.map((r) => errorOf(r).message)).size).toBe(1);
  });

  it('locks the account for 15 minutes after five wrong passwords', async () => {
    const api = setup();
    const user = await verifiedUser();
    for (let i = 0; i < LOCKOUT.maxFailures; i++) {
      await api
        .post('/auth/sign-in', { login: user.email, password: 'wrong password!' })
        .expect(401);
    }
    // Locked: even the right password is refused, with the same message.
    const locked = await api.post('/auth/sign-in', { login: user.email, password: PASSWORD });
    expect(locked.status).toBe(401);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).lockedUntil).toEqual(
      new Date(now.getTime() + LOCKOUT.durationMs),
    );

    advance(LOCKOUT.durationMs - 1000);
    await api.post('/auth/sign-in', { login: user.email, password: PASSWORD }).expect(401);
    advance(1000);
    await signedIn(api, user.email ?? '');
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after).toMatchObject({ failedLogins: 0, lockedUntil: null });
  });

  it('forgets earlier failures after a successful sign-in', async () => {
    const api = setup();
    const user = await verifiedUser();
    for (let i = 0; i < LOCKOUT.maxFailures - 1; i++) {
      await api.post('/auth/sign-in', { login: user.email, password: 'wrong password!' });
    }
    await signedIn(api, user.email ?? '');
    await api.post('/auth/sign-in', { login: user.email, password: 'wrong password!' });
    await signedIn(api, user.email ?? '');
  });

  it('re-hashes a password stored with older scrypt settings', async () => {
    const api = setup();
    const user = await verifiedUser();
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(PASSWORD, { ...SCRYPT_PARAMS, N: 2 ** 14 }) },
    });
    await signedIn(api, user.email ?? '');
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toMatch(/^scrypt\$32768\$/);
  });

  it('replaces the browser’s previous session', async () => {
    const api = setup();
    const a = await verifiedUser();
    const b = await verifiedUser();
    const first = await signedIn(api, a.email ?? '');
    const res = await api.post('/auth/sign-in', { login: b.email, password: PASSWORD }, first);
    expect(res.status).toBe(200);
    expect(await db.session.count({ where: { revokedAt: null } })).toBe(1);
  });
});

describe('sessions', () => {
  it('needs a session for /me, and says when one has ended', async () => {
    const api = setup();
    expect(errorOf(await api.get('/me')).code).toBe('UNAUTHENTICATED');
    expect(errorOf(await api.get('/me', 'sid=made-up-token')).code).toBe('SESSION_EXPIRED');
  });

  it('ends a personal session after 12 idle hours, keeping it alive while used', async () => {
    const api = setup();
    const user = await verifiedUser();
    const cookie = await signedIn(api, user.email ?? '');
    advance(SESSION_POLICY.personal.idleMs - MINUTE);
    await api.get('/me', cookie).expect(200); // activity slides the idle window
    advance(SESSION_POLICY.personal.idleMs - MINUTE);
    await api.get('/me', cookie).expect(200);
    advance(SESSION_POLICY.personal.idleMs);
    const res = await api.get('/me', cookie);
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('SESSION_EXPIRED');
    expect(setCookies(res)[0]).toMatch(/^sid=;/); // cleared
  });

  it('ends a shared-device session after 30 idle minutes', async () => {
    const api = setup();
    const user = await verifiedUser();
    const cookie = await signedIn(api, user.email ?? '', {
      sharedDevice: true,
      deviceLabel: 'Front desk tablet',
    });
    advance(29 * MINUTE);
    await api.get('/me', cookie).expect(200);
    advance(30 * MINUTE);
    expect((await api.get('/me', cookie)).status).toBe(401);
  });

  it('ends a session at its absolute limit even when active', async () => {
    const api = setup();
    const user = await verifiedUser();
    const cookie = await signedIn(api, user.email ?? '');
    advance(SESSION_POLICY.personal.maxAgeMs);
    await db.session.updateMany({ data: { lastSeenAt: new Date(now.getTime() - MINUTE) } });
    expect((await api.get('/me', cookie)).status).toBe(401);
  });

  it('signs out: revokes the session and clears the cookie', async () => {
    const api = setup();
    const user = await verifiedUser();
    const cookie = await signedIn(api, user.email ?? '');
    const res = await api.post('/auth/sign-out', undefined, cookie);
    expect(res.status).toBe(204);
    expect(setCookies(res)[0]).toMatch(/^sid=;/);
    expect(errorOf(await api.get('/me', cookie)).code).toBe('SESSION_EXPIRED');
    // Signing out twice (or with no session) is harmless.
    await api.post('/auth/sign-out', undefined, cookie).expect(204);
  });

  it('lists my sessions and signs out another device', async () => {
    const api = setup();
    const user = await verifiedUser();
    const laptop = await signedIn(api, user.email ?? '', { deviceLabel: 'Laptop' });
    const tablet = await signedIn(api, user.email ?? '', {
      deviceLabel: 'Tablet',
      sharedDevice: true,
    });

    const list = await api.get('/me/sessions', laptop);
    expect(list.status).toBe(200);
    const sessions = (list.body as RouteResponse<typeof listMySessions>).data;
    expect(sessions.map((s) => [s.deviceLabel, s.current]).sort()).toEqual([
      ['Laptop', true],
      ['Tablet', false],
    ]);

    const tabletId = sessions.find((s) => s.deviceLabel === 'Tablet')?.id;
    await api.del(`/me/sessions/${tabletId}`, laptop).expect(204);
    expect((await api.get('/me', tablet)).status).toBe(401);
    await api.get('/me', laptop).expect(200);
  });

  it('answers 404 for another user’s session', async () => {
    const api = setup();
    const mine = await signedIn(api, (await verifiedUser()).email ?? '');
    await signedIn(api, (await verifiedUser()).email ?? '');
    const theirs = await db.session.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    const res = await api.del(`/me/sessions/${theirs.id}`, mine);
    expect(res.status).toBe(404);
    expect((await db.session.findUniqueOrThrow({ where: { id: theirs.id } })).revokedAt).toBeNull();
  });
});

describe('password reset', () => {
  it('always answers 202 and only emails real accounts', async () => {
    const api = setup();
    await api.post('/auth/password/reset-request', { email: 'nobody@example.test' }).expect(202);
    expect(api.email.sent).toHaveLength(0);
  });

  it('sets a new password, signs out everywhere and clears a lockout', async () => {
    const api = setup();
    const user = await verifiedUser();
    const email = user.email ?? '';
    const cookie = await signedIn(api, email);
    for (let i = 0; i < LOCKOUT.maxFailures; i++) {
      await api.post('/auth/sign-in', { login: email, password: 'wrong password!' });
    }

    await api.post('/auth/password/reset-request', { email }).expect(202);
    const token = tokenFromEmail(api, email);
    await api
      .post('/auth/password/reset', { token, password: 'a brand new passphrase' })
      .expect(204);

    expect((await api.get('/me', cookie)).status).toBe(401);
    await api.post('/auth/sign-in', { login: email, password: PASSWORD }).expect(401);
    await api
      .post('/auth/sign-in', { login: email, password: 'a brand new passphrase' })
      .expect(200);
    // Single use.
    expect(
      (await api.post('/auth/password/reset', { token, password: 'another new passphrase' }))
        .status,
    ).toBe(400);
  });

  it('expires after one hour', async () => {
    const api = setup();
    const user = await verifiedUser();
    await api.post('/auth/password/reset-request', { email: user.email });
    advance(TOKEN_TTL_MS.PASSWORD_RESET);
    const res = await api.post('/auth/password/reset', {
      token: tokenFromEmail(api, user.email ?? ''),
      password: 'a brand new passphrase',
    });
    expect(res.status).toBe(400);
  });

  it('counts as proof of the email for an unverified owner', async () => {
    const api = setup();
    await api.post('/auth/sign-up', SIGN_UP);
    await api.post('/auth/password/reset-request', { email: SIGN_UP.email });
    const token = tokenFromEmail(api, 'ada@example.test');
    await api
      .post('/auth/password/reset', { token, password: 'a brand new passphrase' })
      .expect(204);
    await api
      .post('/auth/sign-in', { login: SIGN_UP.email, password: 'a brand new passphrase' })
      .expect(200);
  });
});

describe('CSRF Origin check (middleware step 6)', () => {
  it('refuses a state-changing request without an allowed Origin', async () => {
    const { app } = setup();
    const body = { login: 'x@example.test', password: PASSWORD };
    for (const origin of [
      undefined,
      'https://evil.example',
      'http://app.test.localhost.evil.example',
    ]) {
      const req = request(app).post('/api/v1/auth/sign-in');
      const res = await (origin ? req.set('Origin', origin) : req).send(body);
      expect(res.status).toBe(403);
      expect(errorOf(res).details).toEqual({ reason: 'ORIGIN_NOT_ALLOWED' });
    }
  });

  it('accepts the booking site origin and lets GETs through without one', async () => {
    const { app } = setup();
    const fromSite = await request(app)
      .post('/api/v1/auth/password/reset-request')
      .set('Origin', TEST_CONFIG.siteOrigin)
      .send({ email: 'x@example.test' });
    expect(fromSite.status).toBe(202);
    expect((await request(app).get('/api/v1/openapi.json')).status).toBe(200);
  });
});

describe('rate limits (middleware step 8)', () => {
  it(`allows ${RATE_LIMITS.authPerIp} auth requests per IP per minute, then 429 with Retry-After`, async () => {
    const api = setup();
    for (let i = 0; i < RATE_LIMITS.authPerIp; i++) {
      await api.post('/auth/email/resend', { email: 'x@example.test' }).expect(202);
    }
    const limited = await api.post('/auth/email/resend', { email: 'x@example.test' });
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBe('60');
    advance(MINUTE);
    await api.post('/auth/email/resend', { email: 'x@example.test' }).expect(202);
  });

  it(`allows ${RATE_LIMITS.perUser} requests per user per minute`, async () => {
    const api = setup();
    const user = await verifiedUser();
    const cookie = await signedIn(api, user.email ?? '');
    advance(MINUTE); // a fresh window
    const windowStart = new Date(now.getTime() - (now.getTime() % MINUTE));
    await db.rateLimitHit.create({
      data: { key: `user:${user.id}`, windowStart, count: RATE_LIMITS.perUser - 1 },
    });
    await api.get('/me', cookie).expect(200);
    expect((await api.get('/me', cookie)).status).toBe(429);
  });
});
