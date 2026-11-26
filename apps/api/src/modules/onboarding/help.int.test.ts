import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeUser } from '../../../test/factories.ts';
import { APP_ORIGIN, TEST_CONFIG } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

// Help centre (Versions V2 "enhanced onboarding, support tooling"; T-173).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-16T09:00:00Z');
});

type Article = { id: string; slug: string; title: string; published: boolean; pages: string[] };

describe('the help centre', () => {
  it('the platform team writes and publishes; staff find published articles by page and words', async () => {
    const h = await makeHotel(db, now);
    const c = hotelClient(db, clock, h.p1.id);
    const admin = await makeUser(db, { email: TEST_CONFIG.platformAdminEmails[0] ?? '' });
    await db.user.update({
      where: { id: admin.id },
      data: { status: 'ACTIVE', mfaEnabled: true, mfaSecretEnc: Buffer.alloc(32, 1) },
    });
    const adminCookie = await sessionCookie(db, admin.id, clock);
    const asAdmin = (method: 'get' | 'post' | 'put', path: string, body?: object) => {
      const req = request(c.app)
        [method](`/api/v1${path}`)
        .set('Cookie', adminCookie)
        .set('Origin', APP_ORIGIN);
      return body ? req.send(body) : req;
    };
    const fd = c.as(await sessionCookie(db, h.fd.id, clock));
    const titles = async (query: string) =>
      ((await fd.get(`/help/articles${query}`)).body as { data: Article[] }).data.map(
        (a) => a.title,
      );

    const refund = await asAdmin('post', '/platform/help/articles', {
      slug: 'Refund-A-Payment',
      title: 'Refund a payment',
      body: 'Open the bill.\n\n1. Choose the payment.\n2. Refund it.',
      pages: ['/folios?tab=payments'],
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body).toMatchObject({
      slug: 'refund-a-payment',
      published: false,
      pages: ['/folios'],
    });
    await asAdmin('post', '/platform/help/articles', {
      slug: 'check-in',
      title: 'Check a guest in',
      body: 'Arrivals are on the front desk.',
      pages: ['/front-desk'],
      published: true,
    });

    // A draft is not for hotels.
    expect(await titles('')).toEqual(['Check a guest in']);
    expect((await fd.get('/help/articles/refund-a-payment')).status).toBe(404);

    const id = (refund.body as Article).id;
    const published = await asAdmin('put', `/platform/help/articles/${id}`, {
      slug: 'refund-a-payment',
      title: 'Refund a payment',
      body: 'Open the bill.\n\n1. Choose the payment.\n2. Refund it.',
      pages: ['/folios'],
      published: true,
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body).toMatchObject({ updatedBy: { id: admin.id } });

    // The page's own articles; a search over title and body.
    expect(await titles('?page=%2Ffolios%3Ftab%3Dpayments')).toEqual(['Refund a payment']);
    expect(await titles('?q=arrivals')).toEqual(['Check a guest in']);
    expect(await titles('?q=refund%20bill')).toEqual(['Refund a payment']);
    const one = await fd.get('/help/articles/refund-a-payment');
    expect(one.body).toMatchObject({ title: 'Refund a payment', published: true });

    // One article per slug; only the platform team writes.
    const twice = await asAdmin('post', '/platform/help/articles', {
      slug: 'check-in',
      title: 'Again',
      body: 'Again',
    });
    expect(twice.status).toBe(400);
    expect(
      (await fd.post('/platform/help/articles', { slug: 'x-y', title: 'X', body: 'Y' })).status,
    ).toBe(403);
    const all = await asAdmin('get', '/platform/help/articles');
    expect((all.body as { data: Article[] }).data).toHaveLength(2);
  });
});
