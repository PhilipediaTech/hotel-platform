import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Group dashboards (PRD M1-13, M12-07; S46; T-161). The organisation has two properties: P1 in
// naira and P2, moved to Accra, in cedis. Night audit's kept figures for November are made
// directly (night audit itself is tested on its own); the owner sees both side by side and the
// group's totals in naira once November's cedi rate is set.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Row = {
  code: string;
  currency: string;
  days: number;
  through: string | null;
  roomsSold: number;
  roomsAvailable: number;
  occupancyBps: number;
  roomRevenueMinor: string;
  revenueMinor: string;
  adrMinor: string;
  revparMinor: string;
  rate: string | null;
  inGroupCurrency: {
    roomRevenueMinor: string;
    revenueMinor: string;
    adrMinor: string;
    revparMinor: string;
  } | null;
};
type Dashboard = {
  month: string;
  groupCurrency: string;
  properties: Row[];
  totals: Record<string, number | string>;
  missingRates: string[];
};
type Rates = {
  month: string;
  groupCurrency: string;
  rates: { currency: string; rate: string | null; setBy: string | null }[];
};

const flash = (sold: number, available: number, roomMinor: number, fnbMinor = 0) => ({
  roomsTotal: available,
  outOfOrder: 0,
  roomsAvailable: available,
  roomsSold: sold,
  occupancyBps: Math.round((sold * 10_000) / available),
  roomRevenueMinor: String(roomMinor),
  dayUses: 0,
  dayUseRevenueMinor: '0',
  adrMinor: '0',
  revparMinor: '0',
  revenueByGroup: [
    { group: 'FNB', amountMinor: String(fnbMinor) },
    { group: 'ROOM', amountMinor: String(roomMinor) },
    { group: 'TAX', amountMinor: String(Math.round((roomMinor + fnbMinor) * 0.075)) },
  ],
  paymentsByMethod: [],
  arrivals: 0,
  departures: 0,
  noShows: 0,
});

async function group() {
  const h = await inHouse(db, clock, { checkIn: false });
  await db.property.update({
    where: { id: h.p2.id },
    data: { baseCurrency: 'GHS', name: 'Accra Hotel', timeZone: 'Africa/Accra' },
  });
  const kept = (propertyId: string, date: string, f: ReturnType<typeof flash>) =>
    db.nightAuditRun.create({
      data: {
        propertyId,
        businessDate: new Date(date),
        status: 'COMPLETED',
        currentStep: 10,
        finishedAt: new Date(`${date}T23:00:00Z`),
        summary: { reports: { flash: f } } as never,
      },
    });
  // P1 in naira: two closed days of November, and one in October.
  await kept(h.p1.id, '2026-11-01', flash(8, 10, 8_000_000, 2_000_000));
  await kept(h.p1.id, '2026-11-02', flash(6, 10, 6_000_000));
  await kept(h.p1.id, '2026-10-31', flash(10, 10, 10_000_000));
  // P2 in cedis: one closed day.
  await kept(h.p2.id, '2026-11-01', flash(3, 5, 150_000, 50_000));
  const owner = await h.as(h.owner.id);
  const dashboard = (month = '2026-11', as = owner) =>
    h.ok<Dashboard>(as.get(`/group/dashboard?month=${month}`));
  const setRates = (body: object, as = owner) => as.put('/group/rates', body);
  return { ...h, ownerSession: owner, dashboard, setRates };
}

describe('the group dashboard (M1-13, M12-07)', () => {
  it('shows each property in its own currency, and money totals only with a rate', async () => {
    const h = await group();
    const before = await h.dashboard();
    expect(before.groupCurrency).toBe('NGN');
    const [lagos, accra] = before.properties;
    expect(lagos).toMatchObject({
      code: 'P1',
      currency: 'NGN',
      days: 2,
      through: '2026-11-02',
      roomsSold: 14,
      roomsAvailable: 20,
      occupancyBps: 7000,
      roomRevenueMinor: '14000000',
      // Revenue before tax: rooms and food and drink, never the tax.
      revenueMinor: '16000000',
      adrMinor: '1000000',
      revparMinor: '700000',
      rate: '1',
      inGroupCurrency: { roomRevenueMinor: '14000000', revenueMinor: '16000000' },
    });
    expect(accra).toMatchObject({
      currency: 'GHS',
      days: 1,
      roomRevenueMinor: '150000',
      revenueMinor: '200000',
      rate: null,
      inGroupCurrency: null,
    });
    // Rooms count every property; money only what can be put in naira.
    expect(before.totals).toMatchObject({
      roomsSold: 17,
      roomsAvailable: 25,
      occupancyBps: 6800,
      roomRevenueMinor: '14000000',
      revenueMinor: '16000000',
      propertiesInMoneyTotals: 1,
    });
    expect(before.missingRates).toEqual(['GHS']);

    // November's rate: 1 GHS = 105.5 NGN.
    const set = await h.setRates({
      month: '2026-11',
      groupCurrency: 'NGN',
      rates: [{ currency: 'GHS', rate: '105.5' }],
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((set.body as Rates).rates).toEqual([
      expect.objectContaining({ currency: 'GHS', rate: '105.5' }) as unknown,
    ]);
    const after = await h.dashboard();
    expect(after.properties[1]).toMatchObject({
      rate: '105.5',
      // 1,500.00 GHS × 105.5 = 158,250.00 NGN; 2,000.00 GHS = 211,000.00 NGN.
      inGroupCurrency: { roomRevenueMinor: '15825000', revenueMinor: '21100000' },
    });
    expect(after.totals).toMatchObject({
      roomRevenueMinor: '29825000',
      revenueMinor: '37100000',
      // ADR over the properties in the money totals: 29,825,000 ÷ 17 sold.
      adrMinor: String(Math.floor(29_825_000 / 17)),
      revparMinor: String(Math.floor(29_825_000 / 25)),
      propertiesInMoneyTotals: 2,
    });
    expect(after.missingRates).toEqual([]);
    // Another month: its own figures, and no rate yet for it.
    const october = await h.dashboard('2026-10');
    expect(october.properties.map((p) => [p.code, p.days])).toEqual([
      ['P1', 1],
      ['P2', 0],
    ]);
    // No cedi takings in October: nothing missing.
    expect(october.missingRates).toEqual([]);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'group.rates_set' } });
    expect(audit.after).toMatchObject({ month: '2026-11', rates: ['GHS 105.5'] });
  });

  it('changes the group currency: the naira property then needs a rate', async () => {
    const h = await group();
    const res = await h.setRates({ month: '2026-11', groupCurrency: 'GHS', rates: [] });
    expect((res.body as Rates).rates).toEqual([
      { currency: 'NGN', rate: null, setBy: null, setAt: null },
    ]);
    const d = await h.dashboard();
    expect(d.groupCurrency).toBe('GHS');
    expect(d.missingRates).toEqual(['NGN']);
    expect(d.totals).toMatchObject({ revenueMinor: '200000', propertiesInMoneyTotals: 1 });
  });

  it('only the currencies the group uses, never the group currency itself', async () => {
    const h = await group();
    const usd = await h.setRates({
      month: '2026-11',
      groupCurrency: 'NGN',
      rates: [
        { currency: 'USD', rate: '1580' },
        { currency: 'NGN', rate: '1' },
      ],
    });
    expect(usd.status).toBe(400);
    expect(errorOf(usd).details).toMatchObject({
      issues: [
        {
          path: 'body.rates.0.currency',
          message: 'No property of the group keeps its books in this currency',
        },
        { path: 'body.rates.1.currency', message: 'The group currency needs no rate' },
      ],
    });
    expect(await db.groupExchangeRate.count()).toBe(0);
  });

  it('is the owner’s: a GM can’t see it, and a property-level grant shows that property only', async () => {
    const h = await group();
    expect((await h.gm.get('/group/dashboard?month=2026-11')).status).toBe(403);
    const role = await db.role.create({
      data: {
        organisationId: h.org.id,
        name: 'Lagos group reports',
        permissions: ['report.group'],
      },
    });
    const analyst = await h.person('front-desk', h.p1.id);
    await db.membership.create({
      data: { userId: analyst.id, organisationId: h.org.id, propertyId: h.p1.id, roleId: role.id },
    });
    const d = await h.dashboard('2026-11', await h.as(analyst.id));
    expect(d.properties.map((p) => p.code)).toEqual(['P1']);
    expect(d.missingRates).toEqual([]);
  });
});
