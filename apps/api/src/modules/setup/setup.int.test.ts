import { localDate } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeRoom, makeRoomType } from '../../../test/factories.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

// Property setup wizard API (PRD M1-02; tab 4 row "Organisation"; T-030): details, region,
// payment methods, the setup checklist and go-live.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date();
});

/** A hotel whose first property has rooms, confirmed taxes and a price (T-031–T-033 steps). */
async function hotel() {
  const h = await makeHotel(db, now);
  const type = await makeRoomType(db, h.p1);
  await makeRoom(db, type);
  const policy = await db.cancellationPolicy.create({
    data: {
      propertyId: h.p1.id,
      name: 'Flexible',
      rules: [],
      noShowFee: { feeType: 'NIGHTS', value: 1 },
    },
  });
  const bar = await db.ratePlan.create({
    data: {
      organisationId: h.org.id,
      propertyId: h.p1.id,
      code: 'BAR',
      name: 'Best available',
      kind: 'BAR',
      cancellationPolicyId: policy.id,
      currency: 'NGN',
    },
  });
  await db.rateDay.create({
    data: {
      propertyId: h.p1.id,
      ratePlanId: bar.id,
      roomTypeId: type.id,
      date: new Date(`${localDate(now, 'Africa/Lagos')}T00:00:00Z`),
      amountMinor: 5_000_000n,
    },
  });
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { taxes: { confirmedAt: now.toISOString(), confirmedById: h.owner.id } } },
  });
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId));
  return { ...h, c, as, path: `/properties/${h.p1.id}` };
}

const COMPLETE = {
  name: 'Obi Lagos Hotel',
  address: { line1: '12 Admiralty Way', city: 'Lekki', state: 'Lagos', country: 'NG' },
  phone: '+2348031234567',
  paymentMethods: ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER'],
};

type Step = { id: string; status: string; required: boolean; ticket: string | null };
type Detail = {
  id: string;
  code: string;
  name: string;
  status: string;
  legalName?: string | null;
  checklist: { steps: Step[]; ready: boolean };
};
/** The response body as a property (or organisation) detail. */
const body = (res: { body: unknown }) => res.body as Detail;
const statuses = (body: { checklist: { steps: Step[] } }) =>
  Object.fromEntries(body.checklist.steps.map((s) => [s.id, s.status]));

const auditOf = (action: string) =>
  db.auditEvent.findMany({ where: { action }, orderBy: { id: 'asc' } });

describe('setup checklist', () => {
  it('starts with details and payment methods to do', async () => {
    const h = await hotel();
    const res = await (await h.as(h.owner.id)).get(h.path);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: h.p1.id,
      status: 'SETUP',
      timeZone: 'Africa/Lagos',
      baseCurrency: 'NGN',
      locale: 'en-NG',
      address: { line1: null, city: 'Lagos', state: null, country: 'NG' },
      taxRegistration: { tin: null, vatNumber: null },
      paymentMethods: [],
    });
    expect(statuses(body(res))).toEqual({
      organisation: 'DONE',
      details: 'TODO',
      region: 'DONE',
      tax: 'DONE',
      'room-types': 'DONE',
      rooms: 'DONE',
      rates: 'DONE',
      'payment-methods': 'TODO',
      staff: 'DONE', // the hotel has a GM and a front-desk agent
    });
    const steps = body(res).checklist.steps;
    expect(steps.find((s) => s.id === 'staff')?.required).toBe(false);
    expect(body(res).checklist.ready).toBe(false);
  });

  it('becomes ready once details and payment methods are saved; edits are audited', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const res = await owner.patch(h.path, {
      ...COMPLETE,
      taxRegistration: { tin: '12345678-0001', vatNumber: '' },
      checkInTime: '13:00',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Obi Lagos Hotel',
      address: { line1: '12 Admiralty Way', line2: null, city: 'Lekki', state: 'Lagos' },
      taxRegistration: { tin: '12345678-0001', vatNumber: null },
      checkInTime: '13:00',
      paymentMethods: ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER'],
    });
    expect(statuses(body(res))['details']).toBe('DONE');
    expect(statuses(body(res))['payment-methods']).toBe('DONE');
    expect(body(res).checklist.ready).toBe(true);

    const [event] = await auditOf('property.updated');
    expect(event).toMatchObject({
      propertyId: h.p1.id,
      actorUserId: h.owner.id,
      entityType: 'property',
      entityId: h.p1.id,
    });
    // Only what changed, before and after.
    expect(Object.keys(event?.after as object).sort()).toEqual([
      'address',
      'checkInTime',
      'name',
      'paymentMethods',
      'phone',
      'taxRegistration',
    ]);
    expect(event?.before).toMatchObject({ checkInTime: '14:00', paymentMethods: [] });

    // Saving the same values again writes no audit event.
    expect((await owner.patch(h.path, { checkInTime: '13:00' })).status).toBe(200);
    expect(await auditOf('property.updated')).toHaveLength(1);
  });

  it('refuses invalid region, times, payment methods and codes with field paths', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const bad = async (body: object) => {
      const res = await owner.patch(h.path, body);
      expect(res.status).toBe(400);
      return (errorOf(res).details?.['issues'] as { path: string }[]).map((i) => i.path);
    };
    expect(await bad({ timeZone: 'Lagos/Nowhere' })).toEqual(['body.timeZone']);
    expect(await bad({ baseCurrency: 'XYZ' })).toEqual(['body.baseCurrency']);
    expect(await bad({ checkOutTime: '25:00' })).toEqual(['body.checkOutTime']);
    expect(await bad({ paymentMethods: ['CASH', 'CASH'] })).toEqual(['body.paymentMethods']);
    // Online card payments arrive with the payment provider (T-070).
    expect(await bad({ paymentMethods: ['CARD_ONLINE'] })).toEqual(['body.paymentMethods.0']);
    expect(await bad({ phone: '0803 123 4567' })).toEqual(['body.phone']);
    expect(await bad({ code: h.p2.code })).toEqual(['body.code']);
    const property = await db.property.findUniqueOrThrow({ where: { id: h.p1.id } });
    expect([property.timeZone, property.baseCurrency, property.code]).toEqual([
      'Africa/Lagos',
      'NGN',
      'P1',
    ]);
  });
});

describe('go-live', () => {
  it('refuses while required steps are open, listing them', async () => {
    const h = await hotel();
    const res = await (await h.as(h.owner.id)).post(`${h.path}/go-live`);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { steps: ['details', 'payment-methods'] },
    });
    expect((await db.property.findUniqueOrThrow({ where: { id: h.p1.id } })).status).toBe('SETUP');
  });

  it('opens a ready property, audits it, and only once', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    await owner.patch(h.path, COMPLETE);
    const res = await owner.post(`${h.path}/go-live`);
    expect(res.status).toBe(200);
    expect(body(res).status).toBe('LIVE');

    const [event] = await auditOf('property.went_live');
    expect(event).toMatchObject({
      entityId: h.p1.id,
      actorUserId: h.owner.id,
      before: { status: 'SETUP' },
      after: { status: 'LIVE', later: [] },
    });
    const me = await owner.get('/me');
    expect(
      (me.body as { properties: { id: string; status: string }[] }).properties.find(
        (p) => p.id === h.p1.id,
      )?.status,
    ).toBe('LIVE');

    const again = await owner.post(`${h.path}/go-live`);
    expect(again.status).toBe(409);
    expect(errorOf(again).details).toEqual({ status: 'LIVE' });
  });

  it('fixes time zone and currency once live; other fields stay editable', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    await owner.patch(h.path, COMPLETE);
    await owner.post(`${h.path}/go-live`);

    const currency = await owner.patch(h.path, { baseCurrency: 'USD' });
    expect(currency.status).toBe(409);
    expect(errorOf(currency)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { fields: ['baseCurrency'], status: 'LIVE' },
    });
    expect((await owner.patch(h.path, { timeZone: 'Africa/Accra' })).status).toBe(409);
    // Sending the current values is not a change.
    const same = await owner.patch(h.path, {
      timeZone: 'Africa/Lagos',
      baseCurrency: 'NGN',
      name: 'Obi Lagos Hotel & Suites',
    });
    expect(same.status).toBe(200);
    expect(body(same).name).toBe('Obi Lagos Hotel & Suites');
  });
});

describe('permissions and scope', () => {
  it('needs property.setup; a GM sets up their own property but cannot add one', async () => {
    const h = await hotel();
    const fd = await h.as(h.fd.id);
    for (const res of [
      await fd.get(h.path),
      await fd.patch(h.path, { name: 'Mine' }),
      await fd.post(`${h.path}/go-live`),
      await fd.get('/organisation'),
    ]) {
      expect(res.status).toBe(403);
      expect(errorOf(res).details).toEqual({ permission: 'property.setup' });
    }
    const gm = await h.as(h.gm.id);
    expect((await gm.patch(h.path, { checkOutTime: '11:00' })).status).toBe(200);
    const create = await gm
      .post('/properties', { name: 'Abuja Grand' })
      .set('Idempotency-Key', crypto.randomUUID());
    expect(create.status).toBe(403);
    expect(errorOf(create).details).toEqual({ permission: 'property.create' });
  });

  it('answers 404 for another property in the path, even of the same organisation', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    expect((await owner.get(`/properties/${h.p2.id}`)).status).toBe(404);
    expect((await owner.patch(`/properties/${h.p2.id}`, { name: 'X' })).status).toBe(404);
    expect((await owner.post(`/properties/${h.p2.id}/go-live`)).status).toBe(404);
    expect((await db.property.findUniqueOrThrow({ where: { id: h.p2.id } })).name).not.toBe('X');
  });

  it('lists the properties each person can open', async () => {
    const h = await hotel();
    const list = async (userId: string) =>
      ((await (await h.as(userId)).get('/properties')).body as { data: { id: string }[] }).data
        .map((p) => p.id)
        .sort();
    expect(await list(h.owner.id)).toEqual([h.p1.id, h.p2.id].sort());
    expect(await list(h.gm.id)).toEqual([h.p1.id]);
  });
});

describe('organisation', () => {
  it('shows and renames the organisation; an empty legal name clears it', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    expect((await owner.get('/organisation')).body).toEqual({
      id: h.org.id,
      name: 'Obi Hotels',
      legalName: null,
      country: 'NG',
    });
    const res = await owner.patch('/organisation', {
      name: 'Obi Hospitality',
      legalName: 'Obi Hospitality Limited',
    });
    expect(res.body).toMatchObject({
      name: 'Obi Hospitality',
      legalName: 'Obi Hospitality Limited',
    });
    expect(body(await owner.patch('/organisation', { legalName: '' })).legalName).toBeNull();

    const events = await auditOf('organisation.updated');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      propertyId: null,
      entityId: h.org.id,
      before: { name: 'Obi Hotels' }, // the audit writer leaves out nulls
      after: { name: 'Obi Hospitality', legalName: 'Obi Hospitality Limited' },
    });
  });
});

describe('add a property', () => {
  it('creates it in setup with country defaults, departments and approval policies', async () => {
    const h = await hotel();
    const owner = await h.as(h.owner.id);
    const create = (body: object) =>
      owner.post('/properties', body).set('Idempotency-Key', crypto.randomUUID());

    const res = await create({ name: 'Abuja Grand' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: 'AG',
      name: 'Abuja Grand',
      status: 'SETUP',
      timeZone: 'Africa/Lagos',
      baseCurrency: 'NGN',
      address: { country: 'NG' },
    });
    // Only the org-wide owner reaches the new property, so staff is still to do (optional).
    expect(statuses(body(res))).toMatchObject({
      'room-types': 'TODO',
      rooms: 'TODO',
      staff: 'TODO',
      tax: 'TODO', // example taxes, not confirmed yet
    });
    const id = body(res).id;
    // Nigerian organisation: the Lagos example taxes and the default revenue codes.
    expect(await db.taxRule.count({ where: { propertyId: id } })).toBe(3);
    expect(await db.revenueCode.count({ where: { propertyId: id } })).toBe(6);
    expect(await db.department.count({ where: { propertyId: id } })).toBe(5);
    expect(await db.approvalPolicy.count({ where: { propertyId: id } })).toBeGreaterThan(0);
    const [event] = await auditOf('property.created');
    expect(event).toMatchObject({
      propertyId: id,
      after: { name: 'Abuja Grand', propertyCode: 'AG', status: 'SETUP' },
    });

    // The owner's organisation-wide role opens it straight away.
    const me = await owner.get('/me');
    expect((me.body as { properties: { id: string }[] }).properties.map((p) => p.id)).toContain(id);

    // Same initials get a number; a code in use is refused.
    expect(body(await create({ name: 'Abuja Gardens' })).code).toBe('AG2');
    const taken = await create({ name: 'Another', code: 'p1' });
    expect(taken.status).toBe(400);
    expect(errorOf(taken).details?.['issues']).toEqual([
      expect.objectContaining({ path: 'body.code' }),
    ]);
  });
});
