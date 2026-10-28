import type { Router } from 'express';
import request from 'supertest';
import type { ApprovalActionHandler } from '../src/core/approvals.ts';
import type { Clock } from '../src/core/clock.ts';
import type { Db } from '../src/core/db.ts';
import { hashPassword } from '../src/core/passwords.ts';
import { ROLE_TEMPLATES } from '../src/modules/identity/role-templates.ts';
import { PASSWORD } from './auth.ts';
import { makeOrganisation, makeProperty, makeUser } from './factories.ts';
import { APP_ORIGIN, buildTestApp } from './helpers.ts';

// A hotel for access and audit tests: the role templates, two properties, three people.

/** An organisation like a fresh sign-up: the role templates, two properties, three people. */
export async function makeHotel(db: Db, now: Date) {
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

export function hotelClient(
  db: Db,
  clock: Clock,
  propertyId: string,
  extra: { routes?: Router; approvalHandlers?: readonly ApprovalActionHandler<never>[] } = {},
) {
  const { app, email, files } = buildTestApp(extra.routes, {
    db,
    clock,
    ...(extra.approvalHandlers ? { approvalHandlers: extra.approvalHandlers } : {}),
  });
  const as = (cookie: string) => {
    const withHeaders = (req: request.Test) =>
      req.set('Cookie', cookie).set('X-Property-Id', propertyId).set('Origin', APP_ORIGIN);
    return {
      get: (path: string) => withHeaders(request(app).get(`/api/v1${path}`)),
      post: (path: string, body?: object) =>
        withHeaders(request(app).post(`/api/v1${path}`)).send(body ?? {}),
      patch: (path: string, body: object) =>
        withHeaders(request(app).patch(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        withHeaders(request(app).put(`/api/v1${path}`)).send(body),
    };
  };
  const anon = {
    post: (path: string, body: object, cookie?: string) => {
      const req = request(app).post(`/api/v1${path}`).set('Origin', APP_ORIGIN);
      return (cookie ? req.set('Cookie', cookie) : req).send(body);
    },
  };
  return { app, email, files, as, anon };
}
