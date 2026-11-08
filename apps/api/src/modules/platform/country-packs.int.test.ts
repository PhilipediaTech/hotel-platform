import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeUser } from '../../../test/factories.ts';
import { APP_ORIGIN, TEST_CONFIG } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

// Country packs (PRD M14-09; T-111).

const db = testDb();
const now = new Date('2026-11-10T09:00:00Z');
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
});

type MeBody = {
  properties: { id: string; idTypes: string[]; dataProtectionNotice: string | null }[];
};

async function setup() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  await db.property.update({ where: { id: h.p1.id }, data: { status: 'LIVE' } });
  await db.property.update({ where: { id: h.p2.id }, data: { status: 'SETUP' } });
  const admin = await makeUser(db, { email: TEST_CONFIG.platformAdminEmails[0] ?? '' });
  await db.user.update({
    where: { id: admin.id },
    data: { status: 'ACTIVE', mfaEnabled: true, mfaSecretEnc: Buffer.alloc(32, 1) },
  });
  const adminCookie = await sessionCookie(db, admin.id, clock);
  const give = (pack: string, cookie = adminCookie) =>
    request(c.app)
      .put(`/api/v1/platform/tenants/${h.org.id}/country-pack`)
      .set('Cookie', cookie)
      .set('Origin', APP_ORIGIN)
      .send({ pack });
  const me = async () =>
    (
      await request(c.app)
        .get('/api/v1/me')
        .set('Cookie', await sessionCookie(db, h.fd.id, clock))
        .set('Origin', APP_ORIGIN)
    ).body as MeBody;
  return { ...h, give, me };
}

describe('country packs (M14-09)', () => {
  it('setup properties take the defaults; live ones keep their currency', async () => {
    const h = await setup();
    const res = await h.give('KE');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      pack: 'KE',
      applied: [h.p2.name],
      keptAsTheyAre: [h.p1.name],
    });
    expect(await db.property.findUniqueOrThrow({ where: { id: h.p2.id } })).toMatchObject({
      baseCurrency: 'KES',
      timeZone: 'Africa/Nairobi',
      locale: 'en-KE',
    });
    expect(await db.property.findUniqueOrThrow({ where: { id: h.p1.id } })).toMatchObject({
      baseCurrency: 'NGN',
      timeZone: 'Africa/Lagos',
    });
    expect(
      await db.auditEvent.count({
        where: { organisationId: h.org.id, action: 'platform.country_pack_set' },
      }),
    ).toBe(1);
  });

  it('the desk gets the pack’s ID documents and notice; no tax rates come with it', async () => {
    const h = await setup();
    const taxes = await db.taxRule.count({ where: { propertyId: h.p2.id } });
    await h.give('KE');
    const [first] = (await h.me()).properties;
    expect(first?.idTypes).toEqual(['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENCE', 'OTHER']);
    expect(first?.dataProtectionNotice).toContain('Kenya');
    expect(await db.taxRule.count({ where: { propertyId: h.p2.id } })).toBe(taxes);
  });

  it('is for platform staff only', async () => {
    const h = await setup();
    const owner = await sessionCookie(db, h.owner.id, clock);
    expect((await h.give('KE', owner)).status).toBe(403);
    expect((await db.organisation.findUniqueOrThrow({ where: { id: h.org.id } })).countryPack).toBe(
      null,
    );
  });
});
