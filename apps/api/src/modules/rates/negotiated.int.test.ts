import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';
import { createDefaultTaxes } from '../tax/defaults.ts';

// Negotiated rates and full company profiles (PRD M2-11 "negotiated rates for a company or
// travel agent", rate.manage; M3-16 "company and travel-agent profiles with contacts, rates,
// credit limit and billing instructions", company.manage; T-125).

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const TODAY = '2026-11-10';
const ARRIVE = '2026-11-12';
const LEAVE = '2026-11-14';

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Plan = { id: string; kind: string; companyId: string | null };
type Availability = {
  roomTypes: { plans: { ratePlanId: string; code: string; roomMinor: string | null }[] }[];
};

async function hotel() {
  const h = await makeHotel(db, now);
  await db.property.update({ where: { id: h.p1.id }, data: { status: 'LIVE' } });
  await createDefaultTaxes(db, { id: h.p1.id, country: 'NG', settings: {} }, TODAY);
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => {
    const client = c.as(await sessionCookie(db, userId, clock));
    return {
      ...client,
      send: (path: string, body?: object) =>
        client.post(path, body).set('Idempotency-Key', randomUUID()),
    };
  };
  const gm = await as(h.gm.id);
  const fd = await as(h.fd.id);
  const ok = async <T>(res: Promise<{ status: number; body: unknown }>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body as T;
  };
  const std = await ok<{ id: string }>(gm.post('/room-types', { code: 'STD', name: 'Standard' }));
  await ok(gm.post('/rooms', { number: '101', roomTypeId: std.id }));
  const policy = await ok<{ id: string }>(
    gm.post('/cancellation-policies', {
      name: 'Two days',
      rules: [{ daysBefore: 2, feeType: 'NIGHTS', value: 1 }],
      noShowFee: { feeType: 'NIGHTS', value: 1 },
    }),
  );
  const bar = await ok<Plan>(
    gm.post('/rate-plans', {
      cancellationPolicyId: policy.id,
      code: 'BAR',
      name: 'Best available',
      kind: 'BAR',
    }),
  );
  await ok(
    gm.put('/rate-calendar', {
      ratePlanId: bar.id,
      roomTypeIds: [std.id],
      from: TODAY,
      to: '2026-12-31',
      set: { amountMinor: '5000000' },
    }),
  );
  const company = await ok<{ id: string }>(
    gm.post('/companies', { kind: 'COMPANY', name: 'Dangote Group' }),
  );
  const other = await ok<{ id: string }>(
    gm.post('/companies', { kind: 'TRAVEL_AGENT', name: 'Wakanow' }),
  );
  const negotiated = (over: object = {}) =>
    gm.post('/rate-plans', {
      cancellationPolicyId: policy.id,
      code: 'DANGOTE',
      name: 'Dangote corporate',
      kind: 'NEGOTIATED',
      companyId: company.id,
      parentRatePlanId: bar.id,
      derivationBps: -2000,
      ...over,
    });
  const availability = (companyId?: string) =>
    ok<Availability>(
      fd.get(
        `/availability?arrival=${ARRIVE}&departure=${LEAVE}&adults=1${companyId ? `&companyId=${companyId}` : ''}`,
      ),
    );
  const quote = (ratePlanId: string, companyId?: string) =>
    fd.post('/quotes', {
      roomTypeId: std.id,
      ratePlanId,
      arrival: ARRIVE,
      departure: LEAVE,
      adults: 1,
      ...(companyId ? { companyId } : {}),
    });
  const book = (quoteId: string, companyId: string | null) =>
    fd.send('/reservations', {
      source: 'CORPORATE',
      booker: { firstName: 'Aliko', lastName: 'Guest' },
      companyId,
      stays: [{ quoteId }],
    });
  return { ...h, gm, fd, ok, std, bar, company, other, negotiated, availability, quote, book };
}

describe('negotiated rates (M2-11)', () => {
  it('belong to one company or agent, are never public, and only they have one', async () => {
    const h = await hotel();
    const plan = await h.ok<Plan>(h.negotiated());
    expect(plan).toMatchObject({ kind: 'NEGOTIATED', companyId: h.company.id });
    const path = async (over: object) =>
      (
        errorOf(await h.negotiated({ code: `N${randomUUID().slice(0, 4)}`, ...over })).details as {
          issues: { path: string }[];
        }
      ).issues[0]?.path;
    expect(await path({ companyId: null })).toBe('body.companyId');
    expect(await path({ isPublic: true })).toBe('body.isPublic');
    const client = await h.ok<{ id: string }>(
      h.gm.post('/companies', { kind: 'EVENT_CLIENT', name: 'Wedding couple' }),
    );
    expect(await path({ companyId: client.id })).toBe('body.companyId');
    expect(await path({ kind: 'DERIVED' })).toBe('body.companyId');
  });

  it('are offered only when the booking is for their company', async () => {
    const h = await hotel();
    const plan = await h.ok<Plan>(h.negotiated());
    const codes = (a: Availability) => a.roomTypes[0]?.plans.map((p) => p.code).sort();
    expect(codes(await h.availability())).toEqual(['BAR']);
    expect(codes(await h.availability(h.other.id))).toEqual(['BAR']);
    const mine = await h.availability(h.company.id);
    expect(codes(mine)).toEqual(['BAR', 'DANGOTE']);
    // 20% off BAR's ₦50,000 for 2 nights.
    expect(mine.roomTypes[0]?.plans.find((p) => p.ratePlanId === plan.id)?.roomMinor).toBe(
      '8000000',
    );
  });

  it('are quoted and booked only for their company', async () => {
    const h = await hotel();
    const plan = await h.ok<Plan>(h.negotiated());
    expect((await h.quote(plan.id)).status).toBe(400);
    expect((await h.quote(plan.id, h.other.id)).status).toBe(400);
    const q = await h.ok<{ quoteId: string }>(h.quote(plan.id, h.company.id));
    const wrong = await h.book(q.quoteId, h.other.id);
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).message).toContain('is for one company');
    const booked = await h.ok<{ company: { id: string } }>(h.book(q.quoteId, h.company.id));
    expect(booked.company.id).toBe(h.company.id);
  });

  it('can have prices of their own instead of following BAR', async () => {
    const h = await hotel();
    const own = await h.ok<Plan>(
      h.negotiated({ code: 'OWN', parentRatePlanId: null, derivationBps: null }),
    );
    await h.ok(
      h.gm.put('/rate-calendar', {
        ratePlanId: own.id,
        roomTypeIds: [h.std.id],
        from: TODAY,
        to: '2026-12-31',
        set: { amountMinor: '3000000' },
      }),
    );
    const mine = await h.availability(h.company.id);
    expect(mine.roomTypes[0]?.plans.find((p) => p.ratePlanId === own.id)?.roomMinor).toBe(
      '6000000',
    );
  });
});

describe('company profiles (M3-16)', () => {
  it('keep credit limit, terms, commission and billing instructions, audited', async () => {
    const h = await hotel();
    const saved = await h.ok<Record<string, unknown>>(
      h.gm.patch(`/companies/${h.other.id}`, {
        creditLimitMinor: '50000000',
        paymentTermsDays: 30,
        commissionBps: 1000,
        billingInstructions: { invoiceEmail: 'accounts@wakanow.test', notes: 'Room only' },
      }),
    );
    expect(saved).toMatchObject({
      creditLimitMinor: '50000000',
      paymentTermsDays: 30,
      commissionBps: 1000,
      billingInstructions: { invoiceEmail: 'accounts@wakanow.test', notes: 'Room only' },
    });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'company.updated' } });
    expect(audit.after).toMatchObject({ creditLimitMinor: '50000000', commissionBps: 1000 });
    expect((await h.gm.patch(`/companies/${h.other.id}`, { commissionBps: 6000 })).status).toBe(
      400,
    );
    expect((await h.gm.patch(`/companies/${h.other.id}`, { creditLimitMinor: '-1' })).status).toBe(
      400,
    );
    const fresh = await h.ok<Record<string, unknown>>(h.fd.get(`/companies/${h.company.id}`));
    expect(fresh).toMatchObject({
      creditLimitMinor: null,
      billingInstructions: { invoiceEmail: null, notes: null },
    });
  });
});
