import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';

// City ledger (PRD M4-21 "AR accounts, transfer folios to AR, record AR payments, allocate them
// to invoices, issue statements and see ageing"; M4 rule "AR transfer allowed only if the account
// is active and (balance + transfer) ≤ credit limit, or approval is given"; M4 trial balance
// counts AR transfers; T-126).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Account = { id: string; balanceMinor: string; overdueMinor: string; status: string };
type Detail = Account & {
  invoices: { id: string; number: string; openMinor: string; dueOn: string; status: string }[];
  payments: { id: string; unallocatedMinor: string; allocations: { invoiceNumber: string }[] }[];
};

async function hotel(limit = '50000000') {
  const h = await inHouse(db, clock);
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
  // ₦100,000 on the guest's folio, plus its taxes.
  await h.ok(
    h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
  );
  const fin = await h.as(h.finance.id);
  const account = await h.ok<Account>(
    h.gm.post('/ar-accounts', { companyId: h.company.id, creditLimitMinor: limit, termsDays: 30 }),
  );
  const owed = async () => BigInt((await h.folio()).balanceMinor);
  const transfer = (body: object = {}, as = h.gm) =>
    as.send(`/ar-accounts/${account.id}/transfers`, { folioId: h.folioId, ...body });
  const detail = () => h.ok<Detail>(h.gm.get(`/ar-accounts/${account.id}`));
  return { ...h, fin, account, owed, transfer, detail };
}

describe('accounts', () => {
  it('opens one account per company, not for event clients', async () => {
    const h = await hotel();
    const again = await h.gm.post('/ar-accounts', {
      companyId: h.company.id,
      creditLimitMinor: '1',
    });
    expect(errorOf(again).message).toContain('already has an account');
    const client = await db.company.create({
      data: { organisationId: h.org.id, kind: 'EVENT_CLIENT', name: 'Bride' },
    });
    expect(
      (await h.gm.post('/ar-accounts', { companyId: client.id, creditLimitMinor: '1' })).status,
    ).toBe(400);
    expect((await h.fd.get('/ar-accounts')).status).toBe(403);
  });
});

describe('transfer to the city ledger (M4-21, M4 rule)', () => {
  it('settles the folio window and raises an invoice due after the account’s terms', async () => {
    const h = await hotel();
    const before = await h.owed();
    const result = await h.ok<{
      invoice: { number: string; dueOn: string; amountMinor: string };
      account: Account;
    }>(h.transfer());
    expect(result.invoice).toMatchObject({ number: 'AR-00001', amountMinor: before.toString() });
    expect(result.invoice.dueOn).toBe('2026-12-10');
    expect(result.account.balanceMinor).toBe(before.toString());
    expect(await h.owed()).toBe(0n);
    const payment = await db.payment.findFirstOrThrow({ where: { method: 'AR_TRANSFER' } });
    expect(payment).toMatchObject({
      folioId: h.folioId,
      baseAmountMinor: before,
      externalRef: 'AR-00001',
    });
  });

  it('refuses more than the window owes, and an account on hold', async () => {
    const h = await hotel();
    const owed = await h.owed();
    expect((await h.transfer({ amountMinor: (owed + 1n).toString() })).status).toBe(400);
    await h.ok(
      h.gm.put(`/ar-accounts/${h.account.id}`, {
        creditLimitMinor: '50000000',
        termsDays: 30,
        status: 'ON_HOLD',
      }),
    );
    const held = await h.transfer();
    expect(held.status).toBe(409);
    expect(errorOf(held).message).toContain('not taking new charges');
  });

  it('over the credit limit needs a manager’s approval (ar.over_limit)', async () => {
    const h = await hotel('100000');
    const asked = await h.transfer({ reason: 'Annual contract, invoice next week' }, h.fin);
    expect(asked.status).toBe(202);
    const { approvalRequestId } = asked.body as { approvalRequestId: string };
    expect(await db.arInvoice.count()).toBe(0);
    await h.gm.post(`/approvals/${approvalRequestId}/approve`, {}).expect(200);
    expect(await db.arInvoice.count()).toBe(1);
    expect(await h.owed()).toBe(0n);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'ar.transferred' } });
    expect(audit).toMatchObject({ approvalRequestId });
    expect((audit.after as { overLimit: boolean }).overLimit).toBe(true);
  });

  it('within the limit needs no approval, and a manager’s own goes straight through', async () => {
    const h = await hotel('100000');
    expect((await h.transfer({ amountMinor: '50000' }, h.fin)).status).toBe(201);
    expect((await h.transfer({ amountMinor: '1000000' })).status).toBe(201);
  });
});

describe('payments, allocation, statement and ageing', () => {
  it('allocates a payment to the oldest invoices first, and keeps what is left over', async () => {
    const h = await hotel();
    await h.ok(h.transfer({ amountMinor: '3000000' }));
    now = new Date('2026-11-11T09:00:00Z');
    const fin = await h.as(h.finance.id);
    await h.ok(
      fin.send(`/ar-accounts/${h.account.id}/transfers`, {
        folioId: h.folioId,
        amountMinor: '2000000',
      }),
    );
    const paid = await h.ok<Detail>(
      fin.send(`/ar-accounts/${h.account.id}/payments`, {
        method: 'BANK_TRANSFER',
        amountMinor: '4000000',
        reference: 'GTB-1',
        receivedOn: '2026-11-11',
      }),
    );
    const byNumber = Object.fromEntries(paid.invoices.map((i) => [i.number, i]));
    expect(byNumber['AR-00001']).toMatchObject({ openMinor: '0', status: 'PAID' });
    expect(byNumber['AR-00002']).toMatchObject({ openMinor: '1000000', status: 'OPEN' });
    expect(paid.balanceMinor).toBe('1000000');

    // A second payment left unallocated, then allocated by hand.
    const second = await h.ok<Detail>(
      fin.send(`/ar-accounts/${h.account.id}/payments`, {
        method: 'CHEQUE',
        amountMinor: '1500000',
        receivedOn: '2026-11-11',
        allocate: false,
      }),
    );
    expect(second.balanceMinor).toBe('-500000');
    const cheque = second.payments.find((p) => p.unallocatedMinor === '1500000');
    const inv2 = second.invoices.find((i) => i.number === 'AR-00002');
    const tooMuch = await fin.post(`/ar-payments/${cheque?.id}/allocate`, {
      allocations: [{ invoiceId: inv2?.id, amountMinor: '1500000' }],
    });
    expect(tooMuch.status).toBe(400);
    const done = await h.ok<Detail>(
      fin.post(`/ar-payments/${cheque?.id}/allocate`, {
        allocations: [{ invoiceId: inv2?.id, amountMinor: '1000000' }],
      }),
    );
    expect(done.invoices.every((i) => i.status === 'PAID')).toBe(true);
    expect(done.payments.find((p) => p.id === cheque?.id)?.unallocatedMinor).toBe('500000');
    expect(
      (await (await h.as(h.fdId)).post(`/ar-payments/${cheque?.id}/allocate`, {})).status,
    ).toBe(403);
  });

  it('a statement runs from an opening balance to a closing one, as JSON and PDF', async () => {
    const h = await hotel();
    await h.ok(h.transfer({ amountMinor: '3000000' }));
    await h.ok(
      h.gm.send(`/ar-accounts/${h.account.id}/payments`, {
        method: 'BANK_TRANSFER',
        amountMinor: '1000000',
        receivedOn: '2026-11-10',
      }),
    );
    const s = await h.ok<{
      openingMinor: string;
      closingMinor: string;
      lines: { kind: string; balanceMinor: string }[];
    }>(h.gm.get(`/ar-accounts/${h.account.id}/statement?from=2026-11-01&to=2026-11-30`));
    expect(s.openingMinor).toBe('0');
    expect(s.lines.map((l) => [l.kind, l.balanceMinor])).toEqual([
      ['INVOICE', '3000000'],
      ['PAYMENT', '2000000'],
    ]);
    expect(s.closingMinor).toBe('2000000');
    const later = await h.ok<{ openingMinor: string; lines: unknown[] }>(
      h.gm.get(`/ar-accounts/${h.account.id}/statement?from=2026-12-01&to=2026-12-31`),
    );
    expect(later).toMatchObject({ openingMinor: '2000000', lines: [] });
    const pdf = await h.gm.get(
      `/ar-accounts/${h.account.id}/statement.pdf?from=2026-11-01&to=2026-11-30`,
    );
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('sends the statement to the company’s invoice address', async () => {
    const h = await hotel();
    const range = { from: '2026-11-01', to: '2026-11-30' };
    const refused = await h.gm.post(`/ar-accounts/${h.account.id}/statement/send`, range);
    expect(errorOf(refused).message).toContain('invoice email');
    await db.company.update({
      where: { id: h.company.id },
      data: { billingInstructions: { invoiceEmail: 'accounts@dangote.test', notes: null } },
    });
    const sent = await h.ok<{ sentTo: string }>(
      h.gm.post(`/ar-accounts/${h.account.id}/statement/send`, range),
    );
    expect(sent.sentTo).toBe('accounts@dangote.test');
    expect(h.email.sent.at(-1)).toMatchObject({ to: 'accounts@dangote.test', tag: 'ar-statement' });
  });

  it('ages what is owed by how long it is past due', async () => {
    const h = await hotel();
    await h.ok(h.transfer({ amountMinor: '3000000' }));
    await h.ok(h.transfer({ amountMinor: '1000000' }));
    // Both due 10 December; on 20 January they are 41 days overdue.
    const aged = await h.ok<{
      totals: Record<string, string>;
      accounts: { company: string; totalMinor: string }[];
    }>(h.gm.get('/reports/ar-ageing?asOf=2027-01-20'));
    expect(aged.totals).toMatchObject({ current: '0', d31to60: '4000000', totalMinor: '4000000' });
    expect(aged.accounts).toEqual([
      expect.objectContaining({ company: 'Dangote Group', totalMinor: '4000000' }),
    ]);
    const now2 = await h.ok<{ totals: Record<string, string> }>(
      h.gm.get('/reports/ar-ageing?asOf=2026-11-20'),
    );
    expect(now2.totals['current']).toBe('4000000');
    const account = await h.ok<Account>(h.gm.get(`/ar-accounts/${h.account.id}`));
    expect(account.overdueMinor).toBe('0');
  });
});
