import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';
import { createDefaultTaxes } from '../tax/defaults.ts';

// Folios (PRD M4-01–M4-05, M4 rules 1–3, M4 acceptance on the worked tax example; tab 4
// POST /folios/{id}/lines and /folio-lines/{id}/reverse examples; T-060).

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const TODAY = '2026-11-10';
const TOMORROW = '2026-11-11';

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Line = {
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
type Folio = {
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
type Posted = { lines: Line[]; balanceMinor: string };

/** A live hotel with the Lagos taxes, a Standard room 101 and a guest checked in. */
async function inHouse() {
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

describe('Opening (M4-01)', () => {
  it('opens a guest folio at check-in with window 1 for the guest', async () => {
    const h = await inHouse();
    expect(h.folioId).toMatch(/^[0-9a-f-]{36}$/);
    const f = await h.folio();
    expect(f).toMatchObject({
      number: 'F00001',
      status: 'OPEN',
      name: 'Ada Obi',
      stay: { id: h.stayId, roomNumber: '101' },
      windows: [
        { number: 1, payerType: 'GUEST', payerName: 'Ada Obi', balanceMinor: '0', lines: [] },
      ],
      routingRules: [],
      balanceMinor: '0',
    });
    // Tax codes take no charges of their own.
    expect(f.revenueCodes.map((c) => c.code)).toEqual(['FNB', 'MISC', 'ROOM']);
    const stay = await db.stay.findUniqueOrThrow({ where: { id: h.stayId } });
    expect(stay.folioId).toBe(h.folioId);
    // Asking again answers the same folio; a stay not checked in has none to open.
    expect((await h.ok<Folio>(h.fd.post(`/stays/${h.stayId}/folio`))).id).toBe(h.folioId);
    const list = await h.ok<{
      data: { id: string; roomNumber: string | null; balanceMinor: string }[];
    }>(h.fd.get('/folios'));
    expect(list.data).toEqual([
      expect.objectContaining({ id: h.folioId, roomNumber: '101', balanceMinor: '0' }),
    ]);
  });
});

describe('Posting a charge (M4-02, M4 rules 1–3)', () => {
  it('stores the worked example: ₦100,000 room with service, VAT and consumption tax', async () => {
    const h = await inHouse();
    const res = await h.charge({
      revenueCode: 'ROOM',
      description: 'Room 101 upgrade',
      unitAmountMinor: '10000000',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const posted = res.body as Posted;
    // Service 10% on net, VAT 7.5% on net + service, consumption tax 5% on net (tab 3 issue 18).
    expect(posted.lines.map((l) => [l.kind, l.revenueCode, l.amountMinor])).toEqual([
      ['CHARGE', 'ROOM', '10000000'],
      ['TAX', 'SVC', '1000000'],
      ['TAX', 'VAT', '825000'],
      ['TAX', 'LCT', '500000'],
    ]);
    expect(posted.balanceMinor).toBe('12325000');
    const [charge, ...taxes] = posted.lines;
    expect(charge).toMatchObject({
      businessDate: TODAY,
      windowNumber: 1,
    });
    expect(charge?.postedBy).toBeTruthy();
    for (const t of taxes) expect(t.parentLineId).toBe(charge?.id);
    // Each tax line keeps the version it used (M4 rule 2).
    const stored = await db.folioLine.findMany({ where: { kind: 'TAX' } });
    expect(stored.every((l) => l.taxRuleVersionId !== null)).toBe(true);
  });

  it('posts the tab 4 example: three shirts of laundry with VAT', async () => {
    const h = await inHouse();
    const posted = await h.ok<Posted>(
      h.charge({
        revenueCode: 'MISC',
        description: 'Laundry - 3 shirts',
        quantity: 3,
        unitAmountMinor: '150000',
      }),
    );
    expect(posted.lines.map((l) => [l.kind, l.amountMinor])).toEqual([
      ['CHARGE', '450000'],
      ['TAX', '33750'],
    ]);
    expect(posted.balanceMinor).toBe('483750');
  });

  it('refuses tax codes, unknown windows, closed folios and closed days; lines never change', async () => {
    const h = await inHouse();
    const tax = await h.charge({ revenueCode: 'VAT', description: 'x', unitAmountMinor: '100' });
    expect(errorOf(tax).details).toMatchObject({ issues: [{ path: 'body.revenueCode' }] });
    const window = await h.charge({
      revenueCode: 'MISC',
      description: 'x',
      unitAmountMinor: '100',
      windowNumber: 2,
    });
    expect(errorOf(window).details).toMatchObject({ issues: [{ path: 'body.windowNumber' }] });

    await h.ok(h.charge({ revenueCode: 'MISC', description: 'Water', unitAmountMinor: '50000' }));
    // M4 rule 1: append-only, whatever the app does.
    await expect(db.folioLine.updateMany({ data: { description: 'Changed' } })).rejects.toThrow();
    await expect(db.folioLine.deleteMany()).rejects.toThrow();

    // Tab 3 constraint 5: a closed business day takes no lines.
    await db.businessDay.updateMany({ data: { status: 'CLOSED', closedAt: now } });
    expect(
      errorOf(await h.charge({ revenueCode: 'MISC', description: 'Late', unitAmountMinor: '100' })),
    ).toMatchObject({ code: 'BUSINESS_DAY_CLOSED' });

    await db.folio.update({ where: { id: h.folioId }, data: { status: 'SETTLED' } });
    expect(
      errorOf(await h.charge({ revenueCode: 'MISC', description: 'x', unitAmountMinor: '100' })),
    ).toMatchObject({ code: 'STATE_TRANSITION_INVALID' });

    const hk = await h.person('hk-attendant', h.p1.id);
    const attendant = await h.as(hk.id);
    expect(
      (
        await attendant.send(`/folios/${h.folioId}/lines`, {
          revenueCode: 'MISC',
          description: 'x',
          unitAmountMinor: '1',
        })
      ).status,
    ).toBe(403);
  });

  it('uses the business date of the day it is posted', async () => {
    const h = await inHouse();
    now = new Date('2026-11-11T08:00:00Z');
    const fd = await h.as(h.fdId);
    const posted = await h.ok<Posted>(
      fd.send(`/folios/${h.folioId}/lines`, {
        revenueCode: 'FNB',
        description: 'Breakfast',
        unitAmountMinor: '500000',
      }),
    );
    expect(posted.lines[0]?.businessDate).toBe(TOMORROW);
  });
});

describe('Reversal (M4-03, M4 rule 1)', () => {
  it('reverses a charge with its taxes, keeps both, and only once', async () => {
    const h = await inHouse();
    const posted = await h.ok<Posted>(
      h.charge({ revenueCode: 'ROOM', description: 'Room', unitAmountMinor: '10000000' }),
    );
    const chargeId = posted.lines[0]?.id ?? '';
    // Front desk may not void.
    expect((await h.fd.send(`/folio-lines/${chargeId}/reverse`, { reason: 'x' })).status).toBe(403);

    const res = await h.gm.send(`/folio-lines/${chargeId}/reverse`, {
      reason: 'Charged to wrong room',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const result = res.body as { reversalLineIds: string[]; balanceMinor: string };
    expect(result.reversalLineIds).toHaveLength(4);
    expect(result.balanceMinor).toBe('0');

    const f = await h.folio();
    const lines = f.windows[0]?.lines ?? [];
    expect(lines).toHaveLength(8);
    expect(lines.find((l) => l.id === chargeId)?.reversedByLineId).toEqual(expect.any(String));
    const reversals = lines.filter((l) => l.kind === 'REVERSAL');
    expect(reversals.map((l) => l.amountMinor)).toEqual([
      '-10000000',
      '-1000000',
      '-825000',
      '-500000',
    ]);
    expect(reversals.every((l) => l.reason === 'Charged to wrong room')).toBe(true);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'folio.line_reversed' },
    });
    expect(audit.reason).toBe('Charged to wrong room');

    const again = await h.gm.send(`/folio-lines/${chargeId}/reverse`, { reason: 'Again' });
    expect(errorOf(again)).toMatchObject({ code: 'STATE_TRANSITION_INVALID' });
    const taxLine = posted.lines[1]?.id ?? '';
    expect(errorOf(await h.gm.send(`/folio-lines/${taxLine}/reverse`, { reason: 'x' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
  });

  it('sends a void to a manager when the caller cannot approve it', async () => {
    const h = await inHouse();
    const posted = await h.ok<Posted>(
      h.charge({ revenueCode: 'MISC', description: 'Minibar', unitAmountMinor: '200000' }),
    );
    const finance = await h.as(h.finance.id);
    const res = await finance.send(`/folio-lines/${posted.lines[0]?.id ?? ''}/reverse`, {
      reason: 'Guest did not take it',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING' });
    expect(await db.folioLine.count({ where: { kind: 'REVERSAL' } })).toBe(0);
  });
});

describe('Discounts (M4-04)', () => {
  it('takes a share off the charge and each tax, as its own line with a reason', async () => {
    const h = await inHouse();
    const posted = await h.ok<Posted>(
      h.charge({ revenueCode: 'ROOM', description: 'Room', unitAmountMinor: '10000000' }),
    );
    const chargeId = posted.lines[0]?.id ?? '';
    const res = await h.fd.send(`/folios/${h.folioId}/discounts`, {
      lineId: chargeId,
      percent: 10,
      reason: 'Loyal guest',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const discount = res.body as Posted;
    expect(discount.lines.map((l) => [l.kind, l.revenueCode, l.amountMinor])).toEqual([
      ['DISCOUNT', 'ROOM', '-1000000'],
      ['TAX', 'SVC', '-100000'],
      ['TAX', 'VAT', '-82500'],
      ['TAX', 'LCT', '-50000'],
    ]);
    expect(discount.lines[0]).toMatchObject({ parentLineId: chargeId, reason: 'Loyal guest' });
    expect(discount.balanceMinor).toBe('11092500');

    // An amount: the parts still add up to it exactly.
    const amount = await h.ok<Posted>(
      h.fd.send(`/folios/${h.folioId}/discounts`, {
        lineId: chargeId,
        amountMinor: '100001',
        reason: 'Rounding test',
      }),
    );
    expect(amount.lines.reduce((s, l) => s + BigInt(l.amountMinor), 0n)).toBe(-100001n);

    // Never more than what is left of the charge.
    const tooMuch = await h.fd.send(`/folios/${h.folioId}/discounts`, {
      lineId: chargeId,
      amountMinor: '12325000',
      reason: 'x',
    });
    expect(errorOf(tooMuch).code).toBe('VALIDATION_ERROR');
  });

  it('above 15% goes to a manager; reversing the charge takes its discounts too', async () => {
    const h = await inHouse();
    const posted = await h.ok<Posted>(
      h.charge({ revenueCode: 'FNB', description: 'Dinner', unitAmountMinor: '2000000' }),
    );
    const chargeId = posted.lines[0]?.id ?? '';
    const big = await h.fd.send(`/folios/${h.folioId}/discounts`, {
      lineId: chargeId,
      percent: 20,
      reason: 'Complaint',
    });
    expect(big.status, JSON.stringify(big.body)).toBe(202);
    expect(await db.folioLine.count({ where: { kind: 'DISCOUNT' } })).toBe(0);

    await h.ok(
      h.fd.send(`/folios/${h.folioId}/discounts`, { lineId: chargeId, percent: 15, reason: 'Ok' }),
    );
    await h.ok(h.gm.send(`/folio-lines/${chargeId}/reverse`, { reason: 'Wrong guest' }));
    expect((await h.folio()).balanceMinor).toBe('0');
  });
});

describe('Windows and routing (M4-05)', () => {
  it('routes room and tax to the company window; other charges stay with the guest', async () => {
    const h = await inHouse();
    const f = await h.ok<Folio>(
      h.fd.post(`/folios/${h.folioId}/windows`, { payerType: 'COMPANY', companyId: h.company.id }),
    );
    expect(f.windows.map((w) => [w.number, w.payerType, w.payerName])).toEqual([
      [1, 'GUEST', 'Ada Obi'],
      [2, 'COMPANY', 'Dangote Group'],
    ]);
    const routed = await h.ok<Folio>(
      h.fd.post(`/folios/${h.folioId}/routing-rules`, { revenueGroup: 'ROOM', windowNumber: 2 }),
    );
    expect(routed.routingRules).toEqual([
      expect.objectContaining({ revenueGroup: 'ROOM', windowNumber: 2 }),
    ]);

    const room = await h.ok<Posted>(
      h.charge({ revenueCode: 'ROOM', description: 'Room', unitAmountMinor: '10000000' }),
    );
    expect(room.lines.every((l) => l.windowNumber === 2)).toBe(true);
    await h.ok(h.charge({ revenueCode: 'FNB', description: 'Bar', unitAmountMinor: '100000' }));
    // A window named on the charge wins over the rules.
    await h.ok(
      h.charge({
        revenueCode: 'ROOM',
        description: 'Paid by guest',
        unitAmountMinor: '100',
        windowNumber: 1,
      }),
    );
    const after = await h.folio();
    expect(after.windows.map((w) => w.balanceMinor)).toEqual(['123373', '12325000']);

    // A new rule for ROOM replaces the old one.
    const again = await h.ok<Folio>(
      h.fd.post(`/folios/${h.folioId}/routing-rules`, { revenueGroup: 'ROOM', windowNumber: 1 }),
    );
    expect(again.routingRules).toEqual([expect.objectContaining({ windowNumber: 1 })]);
    const bad = await h.fd.post(`/folios/${h.folioId}/routing-rules`, {
      revenueGroup: 'FNB',
      windowNumber: 5,
    });
    expect(errorOf(bad).details).toMatchObject({ issues: [{ path: 'body.windowNumber' }] });
  });

  it('shows the balance on the front desk lists', async () => {
    const h = await inHouse();
    await h.ok(
      h.charge({ revenueCode: 'MISC', description: 'Laundry', unitAmountMinor: '450000' }),
    );
    const list = await h.ok<{ data: { stayId: string; balanceMinor: string | null }[] }>(
      h.fd.get('/front-desk/in-house'),
    );
    expect(list.data).toEqual([
      expect.objectContaining({ stayId: h.stayId, balanceMinor: '483750' }),
    ]);
  });
});
