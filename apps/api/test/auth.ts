import request from 'supertest';
import { expect } from 'vitest';
import type { Clock } from '../src/core/clock.ts';
import type { Db } from '../src/core/db.ts';
import { hashPassword } from '../src/core/passwords.ts';
import { makeUser } from './factories.ts';
import { APP_ORIGIN, buildTestApp } from './helpers.ts';

// HTTP helpers for integration tests of sign-in, sessions, MFA and PIN switch.

export const PASSWORD = 'correct horse battery staple';

/** The app on a real database, with cookie-aware request helpers. */
export function authApi(db: Db, clock: Clock) {
  const { app, email } = buildTestApp(undefined, { db, clock });
  const post = (path: string, body?: object, cookie?: string) => {
    const req = request(app).post(`/api/v1${path}`).set('Origin', APP_ORIGIN);
    if (cookie) req.set('Cookie', cookie);
    return body ? req.send(body) : req;
  };
  const put = (path: string, body: object, cookie: string) =>
    request(app).put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const get = (path: string, cookie?: string) => {
    const req = request(app).get(`/api/v1${path}`);
    return cookie ? req.set('Cookie', cookie) : req;
  };
  const del = (path: string, cookie: string) =>
    request(app).delete(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie);
  return { app, email, post, put, get, del };
}

export type AuthApi = ReturnType<typeof authApi>;

/** Set-Cookie lines of a response (Node always gives an array for this header). */
export function setCookies(res: { headers: Record<string, unknown> }): string[] {
  return (res.headers['set-cookie'] as string[] | undefined) ?? [];
}

/** `name=<value>` from a response's Set-Cookie, ready for a Cookie header; undefined if not set. */
export function cookieFrom(
  res: { headers: Record<string, unknown> },
  name: string,
): string | undefined {
  const line = setCookies(res).find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));
  return line?.split(';')[0];
}

/** `sid=<token>` from a response; fails the test if there is none. */
export function sidCookie(res: { headers: Record<string, unknown> }): string {
  const sid = cookieFrom(res, 'sid');
  if (!sid) throw new Error(`No sid cookie in ${JSON.stringify(setCookies(res))}`);
  return sid;
}

/** Token from the last link emailed to `to`. */
export function tokenFromEmail(api: AuthApi, to: string): string {
  const text = api.email.lastTo(to)?.text ?? '';
  const token = /token=([\w-]+)/.exec(text)?.[1];
  if (!token) throw new Error(`No token in email to ${to}: ${text}`);
  return token;
}

/** An active user with PASSWORD (and a verified email if it has one). */
export async function verifiedUser(db: Db, data: { email?: string; phone?: string } = {}) {
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

/** Signs in and returns the response (asserting 200). */
export async function signIn(api: AuthApi, login: string, extra: object = {}, cookie?: string) {
  const res = await api.post('/auth/sign-in', { login, password: PASSWORD, ...extra }, cookie);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
}
