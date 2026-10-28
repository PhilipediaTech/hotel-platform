import { beforeEach, describe, expect, it } from 'vitest';
import { expectViolation, resetDb, SQLSTATE, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

// Guest and company profiles (PRD M3-15, M3-18, M3-16 basic, M3 rule on merges; tab 4 row
// "Guests"; T-043).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Guest = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  flags: { vip: boolean; doNotRent: boolean; reason: string | null } | null;
  mergedIntoId: string | null;
  marketingConsent: boolean;
  consentAt: string | null;
  preferences: { notes: string | null; tags: string[] };
};

async function hotel() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId, clock));
  const gm = await as(h.gm.id);
  const fd = await as(h.fd.id);
  const add = async (body: object, client = fd) => {
    const res = await client.post('/guests', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Guest;
  };
  const find = async (q: string, client = fd) =>
    ((await client.get(`/guests?q=${encodeURIComponent(q)}`)).body as { data: Guest[] }).data.map(
      (g) => `${g.firstName} ${g.lastName}`,
    );
  return { ...h, as, gm, fd, add, find };
}

const audit = (action: string) =>
  db.auditEvent.findMany({ where: { action }, orderBy: { id: 'asc' } });

describe('guest profiles (M3-15)', () => {
  it('creates a guest for the whole organisation, audited', async () => {
    const h = await hotel();
    const g = await h.add({
      firstName: 'Ada',
      lastName: 'Obi',
      email: 'Ada.Obi@Example.com',
      phone: '+2348031234567',
      nationality: 'ng',
      preferences: { notes: 'High floor', tags: ['quiet'] },
    });
    expect(g).toMatchObject({
      email: 'ada.obi@example.com',
      nationality: 'NG',
      preferences: { notes: 'High floor', tags: ['quiet'] },
      marketingConsent: false,
      mergedIntoId: null,
    });
    const [event] = await audit('guest.created');
    expect(event).toMatchObject({ entityId: g.id, propertyId: null, organisationId: h.org.id });
    // The owner sees the same guest from the second property.
    const owner = hotelClient(db, clock, h.p2.id).as(await sessionCookie(db, h.owner.id, clock));
    expect((await owner.get(`/guests/${g.id}`)).status).toBe(200);
  });

  it('finds guests by name prefixes, phone digits or email; newest first without a search', async () => {
    const h = await hotel();
    await h.add({ firstName: 'Ada', lastName: 'Obi', phone: '+2348031234567' });
    now = new Date('2026-11-10T10:00:00Z');
    await h.add({ firstName: 'Adaeze', lastName: 'Okafor', email: 'adaeze@mail.ng' });
    now = new Date('2026-11-10T11:00:00Z');
    await h.add({ firstName: 'Chidi', lastName: 'Obi' });
    expect(await h.find('ada')).toEqual(['Ada Obi', 'Adaeze Okafor']);
    expect(await h.find('ada ob')).toEqual(['Ada Obi']);
    expect(await h.find('obi')).toEqual(['Ada Obi', 'Chidi Obi']);
    expect(await h.find('0803 123')).toEqual(['Ada Obi']);
    expect(await h.find('ADAEZE@')).toEqual(['Adaeze Okafor']);
    const recent = (await h.fd.get('/guests?limit=2')).body as {
      data: Guest[];
      nextCursor: string;
    };
    expect(recent.data.map((g) => g.firstName)).toEqual(['Chidi', 'Adaeze']);
    const next = (await h.fd.get(`/guests?limit=2&cursor=${recent.nextCursor}`)).body as {
      data: Guest[];
      nextCursor: null;
    };
    expect(next).toMatchObject({ data: [{ firstName: 'Ada' }], nextCursor: null });
  });

  it('edits a profile, recording when marketing consent was given', async () => {
    const h = await hotel();
    const g = await h.add({ firstName: 'Ada', lastName: 'Obi' });
    const on = await h.fd.patch(`/guests/${g.id}`, { marketingConsent: true, lastName: 'Obi-Eze' });
    expect(on.body).toMatchObject({
      marketingConsent: true,
      consentAt: '2026-11-10T09:00:00Z',
      lastName: 'Obi-Eze',
    });
    now = new Date('2026-11-10T10:00:00Z');
    const again = await h.fd.patch(`/guests/${g.id}`, { marketingConsent: true });
    expect((again.body as Guest).consentAt).toBe('2026-11-10T09:00:00Z');
    const off = await h.fd.patch(`/guests/${g.id}`, { marketingConsent: false });
    expect(off.body).toMatchObject({ marketingConsent: false, consentAt: null });
    const [event] = await audit('guest.updated');
    expect(event).toMatchObject({
      before: { lastName: 'Obi', marketingConsent: false },
      after: { lastName: 'Obi-Eze', marketingConsent: true },
    });
    const bad = await h.fd.patch(`/guests/${g.id}`, { phone: '0803 123 4567' });
    expect((errorOf(bad).details?.['issues'] as { path: string }[])[0]?.path).toBe('body.phone');
  });
});

describe('flags (M3-18)', () => {
  it('lets guest.flag holders set VIP and do-not-rent with a reason; others never see them', async () => {
    const h = await hotel();
    const g = await h.add({ firstName: 'Ada', lastName: 'Obi' });
    const flagged = await h.gm.post(`/guests/${g.id}/flags`, {
      vip: false,
      doNotRent: true,
      reason: 'Damaged room 204',
    });
    expect(flagged.status).toBe(200);
    expect((flagged.body as Guest).flags).toEqual({
      vip: false,
      doNotRent: true,
      reason: 'Damaged room 204',
    });
    // Front desk (no guest.flag) gets no flags at all, and can't set them.
    expect(((await h.fd.get(`/guests/${g.id}`)).body as Guest).flags).toBeNull();
    const refused = await h.fd.post(`/guests/${g.id}/flags`, {
      vip: true,
      doNotRent: false,
      reason: 'x',
    });
    expect(refused.status).toBe(403);
    const noReason = await h.gm.post(`/guests/${g.id}/flags`, { vip: true, doNotRent: false });
    expect((errorOf(noReason).details?.['issues'] as { path: string }[])[0]?.path).toBe(
      'body.reason',
    );
    const cleared = await h.gm.post(`/guests/${g.id}/flags`, { vip: false, doNotRent: false });
    expect((cleared.body as Guest).flags).toEqual({ vip: false, doNotRent: false, reason: null });
    const [event] = await audit('guest.flagged');
    expect(event).toMatchObject({ reason: 'Damaged room 204', after: { doNotRent: true } });
  });
});

describe('merging duplicates (M3 rule)', () => {
  it('keeps the older profile whichever is named, fills gaps, combines flags and audits both IDs', async () => {
    const h = await hotel();
    const old = await h.add({
      firstName: 'Ada',
      lastName: 'Obi',
      phone: '+2348031234567',
      preferences: { tags: ['quiet'] },
    });
    now = new Date('2026-11-10T09:30:00Z');
    const dup = await h.add({
      firstName: 'Ada',
      lastName: 'Obi',
      email: 'ada@example.com',
      preferences: { notes: 'Vegetarian', tags: ['quiet', 'late'] },
    });
    await h.gm.post(`/guests/${dup.id}/flags`, {
      vip: true,
      doNotRent: false,
      reason: 'Company CEO',
    });

    const res = await h.gm.post(`/guests/${dup.id}/merge`, { otherGuestId: old.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: old.id,
      phone: '+2348031234567',
      email: 'ada@example.com',
      preferences: { notes: 'Vegetarian', tags: ['quiet', 'late'] },
      flags: { vip: true, doNotRent: false, reason: 'Company CEO' },
    });
    expect(((await h.gm.get(`/guests/${dup.id}`)).body as Guest).mergedIntoId).toBe(old.id);
    expect(await h.find('ada')).toEqual(['Ada Obi']);
    const [event] = await audit('guest.merged');
    expect(event).toMatchObject({ entityId: old.id, after: { keptId: old.id, mergedId: dup.id } });

    const edit = await h.fd.patch(`/guests/${dup.id}`, { firstName: 'X' });
    expect(errorOf(edit)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { mergedIntoId: old.id },
    });
    expect((await h.gm.post(`/guests/${old.id}/merge`, { otherGuestId: dup.id })).status).toBe(409);
    expect((await h.gm.post(`/guests/${old.id}/merge`, { otherGuestId: old.id })).status).toBe(400);
  });
});

describe('companies (M3-16 basic)', () => {
  it('adds, lists and edits companies and travel agents', async () => {
    const h = await hotel();
    const res = await h.gm.post('/companies', {
      kind: 'COMPANY',
      name: 'Dangote Group',
      taxId: '01234567-0001',
      contacts: [
        {
          name: 'Bola Ade',
          role: 'Travel desk',
          phone: '+2348012345678',
          email: 'Travel@Dangote.example',
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      contacts: [
        {
          name: 'Bola Ade',
          role: 'Travel desk',
          phone: '+2348012345678',
          email: 'travel@dangote.example',
        },
      ],
      active: true,
    });
    await h.gm.post('/companies', { kind: 'TRAVEL_AGENT', name: 'Wakanow' });
    const list = async (query: string) =>
      ((await h.fd.get(`/companies${query}`)).body as { data: { name: string }[] }).data.map(
        (c) => c.name,
      );
    expect(await list('')).toEqual(['Dangote Group', 'Wakanow']);
    expect(await list('?q=gote')).toEqual(['Dangote Group']);
    expect(await list('?kind=TRAVEL_AGENT')).toEqual(['Wakanow']);
    const id = (res.body as { id: string }).id;
    const edited = await h.gm.patch(`/companies/${id}`, { active: false });
    expect(edited.body).toMatchObject({ active: false });
    expect((await audit('company.updated'))[0]).toMatchObject({
      before: { active: true },
      after: { active: false },
    });
    // Front desk can look companies up but not change them.
    expect((await h.fd.get(`/companies/${id}`)).status).toBe(200);
    expect((await h.fd.post('/companies', { kind: 'COMPANY', name: 'X' })).status).toBe(403);
  });
});

describe('database guards', () => {
  it('needs a reason with a flag and a time with consent, and never merges into itself', async () => {
    const h = await hotel();
    const g = await h.add({ firstName: 'Ada', lastName: 'Obi' });
    await expectViolation(
      db.guest.update({ where: { id: g.id }, data: { vip: true } }),
      SQLSTATE.CHECK,
      'guests_flag_reason_check',
    );
    await expectViolation(
      db.guest.update({ where: { id: g.id }, data: { marketingConsent: true } }),
      SQLSTATE.CHECK,
      'guests_consent_check',
    );
    await expectViolation(
      db.guest.update({ where: { id: g.id }, data: { mergedIntoId: g.id } }),
      SQLSTATE.CHECK,
      'guests_not_merged_into_self_check',
    );
  });
});
