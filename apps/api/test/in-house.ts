import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Clock } from '../src/core/clock.ts';
import type { Db } from '../src/core/db.ts';
import { createDefaultApprovalPolicies } from '../src/modules/approvals/defaults.ts';
import { createDefaultTaxes } from '../src/modules/tax/defaults.ts';
import { hotelClient, makeHotel } from './hotel.ts';
import { sessionCookie } from './tenancy.ts';

export const TODAY = '2026-11-10';

export type Line = {
  id: string;
  windowNumber: number;
  businessDate: string;
  kind: string;
  revenueCode: string;
  description: string;
  quantity: number;
  amountMinor: string;
  parentLineId: string | null;
  reversesLineId: string | null;
  reversedByLineId: string | null;
  postedBy: string | null;
  reason: string | null;
};
export type Folio = {
  id: string;
  number: string;
  status: string;
  name: string;
  stay: { id: string; roomNumber: string | null } | null;
  windows: {
    number: number;
    payerType: string;
    payerName: string;
    balanceMinor: string;
    lines: Line[];
  }[];
  routingRules: { revenueGroup: string | null; revenueCode: string | null; windowNumber: number }[];
  revenueCodes: { code: string }[];
  balanceMinor: string;
};
export type Posted = { lines: Line[]; balanceMinor: string };

/**
 * A live hotel with the Lagos taxes, a Standard room 101 and a guest (Ada Obi, Dangote Group)
 * checked in with a folio, dated TODAY on the test clock (T-060, T-062).
 */
export async function inHouse(db: Db, clock: Clock) {
  const h = await makeHotel(db, clock());
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
  const fdId = h.fd.id;
  const fd = await as(fdId);
  const ok = async <T>(res: Promise<{ status: number; body: unknown }>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body as T;
  };
  const type = await ok<{ id: string }>(gm.post('/room-types', { code: 'STD', name: 'Standard' }));
  const room = await ok<{ id: string }>(gm.post('/rooms', { number: '101', roomTypeId: type.id }));
  const policy = await ok<{ id: string }>(
    gm.post('/cancellation-policies', {
      name: 'Flexible',
      rules: [{ daysBefore: 1, feeType: 'NIGHTS', value: 1 }],
      noShowFee: { feeType: 'NIGHTS', value: 1 },
    }),
  );
  const bar = await ok<{ id: string }>(
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
      roomTypeIds: [type.id],
      from: TODAY,
      to: '2026-12-31',
      set: { amountMinor: '10000000' },
    }),
  );
  const quote = await ok<{ quoteId: string }>(
    fd.post('/quotes', {
      roomTypeId: type.id,
      ratePlanId: bar.id,
      arrival: TODAY,
      departure: '2026-11-12',
      adults: 1,
    }),
  );
  const company = await db.company.create({
    data: { organisationId: h.org.id, kind: 'COMPANY', name: 'Dangote Group' },
  });
  const r = await ok<{ id: string; stays: { id: string; version: number }[] }>(
    fd.send('/reservations', {
      source: 'PHONE',
      booker: { firstName: 'Ada', lastName: 'Obi' },
      companyId: company.id,
      stays: [{ quoteId: quote.quoteId }],
    }),
  );
  const stay = r.stays[0] as { id: string; version: number };
  await db.room.update({ where: { id: room.id }, data: { hkStatus: 'CLEAN' } });
  const checkedIn = await ok<{ folioId: string | null }>(
    fd
      .post(`/stays/${stay.id}/check-in`, {
        roomId: room.id,
        registration: {
          nationality: 'NG',
          purpose: 'BUSINESS',
          idType: 'PASSPORT',
          idNumber: 'A1234567',
        },
      })
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${stay.version}"`),
  );
  const folioId = checkedIn.folioId ?? '';
  const folio = async (as = fd) => ok<Folio>(as.get(`/folios/${folioId}`));
  const charge = (body: object, as = fd) => as.send(`/folios/${folioId}/lines`, body);
  const finance = await h.person('finance', h.p1.id);
  return {
    ...h,
    fdId,
    as,
    gm,
    fd,
    ok,
    folioId,
    folio,
    charge,
    stayId: stay.id,
    reservationId: r.id,
    company,
    finance,
  };
}
