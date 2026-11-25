import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { inHouse } from '../../../test/in-house.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';

// Corporate accounts at group level (Versions V2; T-163). Dangote Group has an account at P1
// (Lagos, naira), where Ada Obi's ₦123,250 bill can go on account, and one at P2 with an
// invoice already owed there. The owner sees what Dangote owes the whole group; the company's
// own credit limit is the group limit, checked on every transfer.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Item = {
  name: string;
  properties: number;
  groupCurrency: string;
  groupLimitMinor: string | null;
  balanceMinor: string;
  overdueMinor: string;
  overLimit: boolean;
  missingRates: string[];
};
type Detail = Item & {
  accounts: {
    propertyName: string;
    currency: string;
    balanceMinor: string;
    inGroupCurrencyMinor: string | null;
  }[];
  openInvoices: { propertyName: string; number: string; openMinor: string; overdue: boolean }[];
};

async function group(p2Currency = 'NGN', p2OwedMinor = 10_000_000n) {
  const h = await inHouse(db, clock);
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
  await db.property.update({ where: { id: h.p1.id }, data: { name: 'Lagos Hotel' } });
  await db.property.update({
    where: { id: h.p2.id },
    data: { name: 'Accra Hotel', baseCurrency: p2Currency, status: 'LIVE' },
  });
  await h.ok(
    h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
  );
  const account = await h.ok<{ id: string }>(
    h.gm.post('/ar-accounts', {
      companyId: h.company.id,
      creditLimitMinor: '50000000',
      termsDays: 30,
    }),
  );
  // At P2: an account with an invoice due on 1 November (overdue now).
  const theirs = await db.arAccount.create({
    data: {
      organisationId: h.org.id,
      propertyId: h.p2.id,
      companyId: h.company.id,
      creditLimitMinor: 100_000_000n,
    },
  });
  await db.arInvoice.create({
    data: {
      propertyId: h.p2.id,
      arAccountId: theirs.id,
      number: 'AR-00001',
      amountMinor: p2OwedMinor,
      issuedOn: new Date('2026-10-02'),
      dueOn: new Date('2026-11-01'),
    },
  });
  const fin = await h.as(h.finance.id);
  const owner = await h.as(h.owner.id);
  const transfer = (body: object = {}, as = fin) =>
    as.send(`/ar-accounts/${account.id}/transfers`, { folioId: h.folioId, ...body });
  const list = () => h.ok<{ data: Item[] }>(owner.get('/group/companies'));
  const detail = () => h.ok<Detail>(owner.get(`/group/companies/${h.company.id}`));
  const setLimit = (creditLimitMinor: string | null) =>
    db.company.update({
      where: { id: h.company.id },
      data: { creditLimitMinor: creditLimitMinor === null ? null : BigInt(creditLimitMinor) },
    });
  return { ...h, fin, owner, account, transfer, list, detail, setLimit };
}

describe('a company’s account across the group', () => {
  it('adds up what it owes every property, in the group currency once each has a rate', async () => {
    const h = await group('GHS', 100_000n);
    await h.ok(h.transfer({}, h.gm));
    const [before] = (await h.list()).data;
    expect(before).toMatchObject({
      name: 'Dangote Group',
      properties: 2,
      groupCurrency: 'NGN',
      groupLimitMinor: null,
      // The cedi account can't be added without November's rate.
      balanceMinor: '12325000',
      overdueMinor: '0',
      overLimit: false,
      missingRates: ['GHS'],
    });
    await h.ok(
      h.owner.put('/group/rates', {
        month: '2026-11',
        groupCurrency: 'NGN',
        rates: [{ currency: 'GHS', rate: '105.5' }],
      }),
    );
    const d = await h.detail();
    // GH₵1,000.00 × 105.5 = ₦105,500.00, overdue since 1 November.
    expect(d).toMatchObject({
      balanceMinor: String(12_325_000 + 10_550_000),
      overdueMinor: '10550000',
      missingRates: [],
    });
    expect(
      d.accounts.map((a) => [a.propertyName, a.currency, a.balanceMinor, a.inGroupCurrencyMinor]),
    ).toEqual([
      ['Lagos Hotel', 'NGN', '12325000', '12325000'],
      ['Accra Hotel', 'GHS', '100000', '10550000'],
    ]);
    // Oldest due first, across the properties.
    expect(d.openInvoices.map((i) => [i.propertyName, i.number, i.overdue])).toEqual([
      ['Accra Hotel', 'AR-00001', true],
      ['Lagos Hotel', 'AR-00001', false],
    ]);
  });

  it('is the owner’s view: a GM can’t see it', async () => {
    const h = await group();
    expect((await h.gm.get('/group/companies')).status).toBe(403);
    expect(
      (await h.owner.get('/group/companies/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
  });
});

describe('the group credit limit on a transfer', () => {
  it('sends a transfer for approval when the group total would pass the company’s limit', async () => {
    const h = await group();
    // ₦100,000 already owed at Accra; ₦123,250 more at Lagos makes ₦223,250, over ₦200,000.
    await h.setLimit('20000000');
    const asked = await h.transfer({ reason: 'Conference week' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const request = await db.approvalRequest.findFirstOrThrow();
    expect(request.reason).toBe('Conference week (Over the group credit limit)');
    expect(await db.arInvoice.count({ where: { propertyId: h.p1.id } })).toBe(0);
    // Under it, straight through.
    await h.setLimit('30000000');
    expect((await h.transfer({ amountMinor: '1000000' })).status).toBe(201);
    const [item] = (await h.list()).data;
    expect(item).toMatchObject({
      groupLimitMinor: '30000000',
      balanceMinor: '11000000',
      overLimit: false,
    });
  });

  it('asks for approval when a balance can’t be put in the group currency', async () => {
    const h = await group('GHS', 100_000n);
    await h.setLimit('500000000');
    const asked = await h.transfer({ reason: 'Usual terms' });
    expect(asked.status).toBe(202);
    expect((await db.approvalRequest.findFirstOrThrow()).reason).toBe(
      'Usual terms (No group rate this month for GHS: the group limit can’t be checked)',
    );
  });

  it('with no group limit, only the property’s own limit counts', async () => {
    const h = await group();
    await h.setLimit(null);
    expect((await h.transfer()).status).toBe(201);
  });
});
