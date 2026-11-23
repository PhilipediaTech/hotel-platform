import { beforeEach, describe, expect, it } from 'vitest';
import { moveBusinessDay } from '../../../test/business-day.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse, TODAY } from '../../../test/in-house.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';

// Accounting exports (PRD M10-07 "As finance, I export accounting files for a period",
// accounting.export; Strategy decision 9: a general journal CSV, chosen 2026-11-23; T-148).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Mapping = { kind: string; key: string; label: string; accountCode: string | null };
type Line = {
  journal: string;
  date: string;
  accountCode: string;
  description: string;
  debitMinor: string;
  creditMinor: string;
};
type Export = {
  id: string;
  number: number;
  journalCount: number;
  lineCount: number;
  debitTotalMinor: string;
  sha256: string;
  lines: Line[];
};

/**
 * One full day at the hotel, 10 November: a ₦40,000 cash deposit before arrival, check-in
 * (the deposit applied), a ₦100,000 room charge with its taxes, ₦20,000 paid in cash on the
 * folio, the rest sent to the company's city-ledger account, ₦30,000 received on that account
 * by bank transfer, and a ₦15,000 repair paid from the bank. Then the night is closed.
 */
async function day() {
  const h = await inHouse(db, clock, { guarantee: 'DEPOSIT', checkIn: false });
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
  await db.property.update({
    where: { id: h.p1.id },
    data: { settings: { paymentMethods: ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER'] } },
  });
  await h.ok(h.fd.send('/shifts', { floatMinor: '0' }));
  await h.ok(
    h.fd.send('/payments', {
      reservationId: h.reservationId,
      method: 'CASH',
      amountMinor: '4000000',
    }),
  );
  await h.checkIn();
  await h.ok(
    h.charge({ revenueCode: 'ROOM', description: 'Room 101', unitAmountMinor: '10000000' }),
  );
  await h.ok(
    h.fd.send('/payments', { folioId: h.folioId, method: 'CASH', amountMinor: '2000000' }),
  );
  const account = await h.ok<{ id: string }>(
    h.gm.post('/ar-accounts', {
      companyId: h.company.id,
      creditLimitMinor: '100000000',
      termsDays: 30,
    }),
  );
  await h.ok(h.gm.send(`/ar-accounts/${account.id}/transfers`, { folioId: h.folioId }));
  await db.arPayment.create({
    data: {
      propertyId: h.p1.id,
      arAccountId: account.id,
      method: 'BANK_TRANSFER',
      amountMinor: 3000000n,
      receivedOn: new Date(`${TODAY}T00:00:00Z`),
      createdById: h.gmId,
    },
  });
  const finance = await h.as(h.finance.id);
  const category = await h.ok<{ id: string }>(
    finance.send('/expense-categories', { code: 'REPAIRS', name: 'Repairs' }),
  );
  const dept = await db.department.create({
    data: { organisationId: h.org.id, propertyId: h.p1.id, code: 'MNT', name: 'Maintenance' },
  });
  await h.ok(
    h.gm.send('/expenses', {
      spentOn: TODAY,
      categoryId: category.id,
      departmentId: dept.id,
      payee: 'Plumber Musa',
      description: 'Tap in 101',
      amountMinor: '1500000',
      paidFrom: 'BANK_TRANSFER',
    }),
  );
  await moveBusinessDay(db, h.p1.id, '2026-11-11');
  const mapAll = async (except: (m: Mapping) => boolean = () => false) => {
    const { data } = await h.ok<{ data: Mapping[] }>(finance.get('/accounting-mappings'));
    await h.ok(
      finance.put('/accounting-mappings', {
        mappings: data
          .filter((m) => !except(m))
          .map((m, i) => ({
            kind: m.kind,
            key: m.key,
            accountCode: `${1000 + i}`,
            accountName: m.label,
          })),
      }),
    );
    return data;
  };
  const exportDay = (from = TODAY, to = TODAY) => finance.send('/accounting-exports', { from, to });
  return { ...h, finance, account, category, mapAll, exportDay };
}

const sum = (xs: string[]) => xs.reduce((s, x) => s + BigInt(x), 0n);

describe('account mapping (M10-07)', () => {
  it('lists every account the journal posts to, and keeps the hotel’s codes', async () => {
    const h = await day();
    const rows = await h.mapAll();
    expect(rows.map((r) => `${r.kind}:${r.key}`)).toEqual(
      expect.arrayContaining([
        'CONTROL:GUEST_LEDGER',
        'CONTROL:ADVANCE_DEPOSITS',
        'CONTROL:CITY_LEDGER',
        'PAY_METHOD:CASH',
        `EXPENSE_CATEGORY:${h.category.id}`,
      ]),
    );
    // The system codes that move money between ledgers post to the control accounts instead.
    expect(rows.some((r) => r.label.startsWith('DEPOSIT ·'))).toBe(false);
    const saved = await h.ok<{ data: Mapping[] }>(h.finance.get('/accounting-mappings'));
    expect(saved.data.every((r) => r.accountCode !== null)).toBe(true);
    const cleared = await h.ok<{ data: Mapping[] }>(
      h.finance.put('/accounting-mappings', {
        mappings: [{ kind: 'PAY_METHOD', key: 'VOUCHER', accountCode: null }],
      }),
    );
    expect(cleared.data.find((r) => r.key === 'VOUCHER')?.accountCode).toBeNull();
    const unknown = await h.finance.put('/accounting-mappings', {
      mappings: [{ kind: 'PAY_METHOD', key: 'GOLD_BARS', accountCode: '1' }],
    });
    expect(errorOf(unknown).code).toBe('VALIDATION_ERROR');
    expect((await h.fd.get('/accounting-mappings')).status).toBe(403);
  });
});

describe('the general journal (M10-07)', () => {
  it('balances each day and agrees with the guest and deposit ledgers', async () => {
    const h = await day();
    await h.mapAll();
    const e = await h.ok<Export>(h.exportDay());
    expect(e).toMatchObject({ number: 1, journalCount: 1 });
    const debits = sum(e.lines.map((l) => l.debitMinor));
    const credits = sum(e.lines.map((l) => l.creditMinor));
    expect(debits).toBe(credits);
    expect(BigInt(e.debitTotalMinor)).toBe(debits);
    expect(e.lines.every((l) => l.journal === `J-${TODAY}` && l.date === TODAY)).toBe(true);

    const codeOf = async (kind: string, key: string) =>
      (await db.accountingMapping.findFirstOrThrow({ where: { kind: kind as never, key } }))
        .accountCode;
    const net = (code: string) =>
      sum(e.lines.filter((l) => l.accountCode === code).map((l) => l.debitMinor)) -
      sum(e.lines.filter((l) => l.accountCode === code).map((l) => l.creditMinor));

    // The guest ledger in the journal is what the folios owe at the close (opening was nil).
    const lines = await db.folioLine.aggregate({ _sum: { amountMinor: true } });
    const folioPaid = await db.payment.aggregate({
      where: { folioId: { not: null } },
      _sum: { baseAmountMinor: true },
    });
    const guestLedger = (lines._sum.amountMinor ?? 0n) - (folioPaid._sum.baseAmountMinor ?? 0n);
    expect(net(await codeOf('CONTROL', 'GUEST_LEDGER'))).toBe(guestLedger);
    // The deposit was received and applied the same day: nothing held at the close.
    const deposits = await db.depositLedgerEntry.aggregate({ _sum: { amountMinor: true } });
    expect(net(await codeOf('CONTROL', 'ADVANCE_DEPOSITS'))).toBe(
      -(deposits._sum.amountMinor ?? 0n),
    );
    // Cash: the deposit and the folio payment. Bank: the city-ledger receipt less the repair.
    expect(net(await codeOf('PAY_METHOD', 'CASH'))).toBe(6000000n);
    expect(net(await codeOf('PAY_METHOD', 'BANK_TRANSFER'))).toBe(1500000n);
    expect(net(await codeOf('EXPENSE_CATEGORY', h.category.id))).toBe(1500000n);
    // City ledger: what was sent to it, less the ₦30,000 received.
    const sent = await db.payment.aggregate({
      where: { method: 'AR_TRANSFER' },
      _sum: { baseAmountMinor: true },
    });
    expect(net(await codeOf('CONTROL', 'CITY_LEDGER'))).toBe(
      (sent._sum.baseAmountMinor ?? 0n) - 3000000n,
    );
    // Room revenue is credited net of tax; the taxes go to their own codes.
    const room = await db.revenueCode.findFirstOrThrow({ where: { code: 'ROOM' } });
    expect(net(await codeOf('REVENUE_CODE', room.id))).toBe(-10000000n);
    expect(
      e.lines.some((l) => l.description.startsWith('VAT') || l.description.includes('VAT')),
    ).toBe(true);
  });

  it('downloads the file as CSV, exactly as kept', async () => {
    const h = await day();
    await h.mapAll();
    const e = await h.ok<Export>(h.exportDay());
    const file = await h.finance.get(`/accounting-exports/${e.id}?format=csv`).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    const text = String(file.text ?? (file.body as Buffer).toString('utf8'));
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const [header, first] = text.slice(1).split('\r\n');
    expect(header).toBe(
      'Journal,Date,Account code,Account name,Description,Debit,Credit,Reference',
    );
    expect(first).toMatch(/^J-2026-11-10,2026-11-10,\d+,/);
    expect(first).toContain('PMS P1 2026-11-10');
    const kept = await db.accountingExport.findUniqueOrThrow({ where: { id: e.id } });
    expect(text.slice(1)).toBe(kept.content);
    // Kept as sent: never edited.
    await expect(
      db.accountingExport.update({ where: { id: e.id }, data: { content: 'x' } }),
    ).rejects.toThrow();
    const list = await h.ok<{ data: { id: string }[]; lastClosedDay: string }>(
      h.finance.get('/accounting-exports'),
    );
    expect(list).toMatchObject({ data: [{ id: e.id }], lastClosedDay: TODAY });
  });

  it('refuses an open day, a long period, and anything used without an account code', async () => {
    const h = await day();
    const open = await h.exportDay(TODAY, '2026-11-11');
    expect(errorOf(open)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Only closed business days can be exported: up to 2026-11-10',
    });
    const long = await h.exportDay('2026-07-01', TODAY);
    expect(errorOf(long).message).toBe('At most 93 days in one export');
    await h.mapAll((m) => m.key === 'CASH' || m.key === 'CITY_LEDGER');
    const unmapped = await h.exportDay();
    const missing = (
      errorOf(unmapped).details as { missing: { kind: string; key: string; label: string }[] }
    ).missing;
    expect(missing).toEqual(
      expect.arrayContaining([
        { kind: 'PAY_METHOD', key: 'CASH', label: 'Cash' },
        { kind: 'CONTROL', key: 'CITY_LEDGER', label: 'City ledger (accounts receivable)' },
      ]),
    );
    expect(await db.accountingExport.count()).toBe(0);
    // A day with nothing in it gives an empty journal, still kept.
    await h.mapAll();
    const quiet = await h.ok<Export>(h.exportDay('2026-11-01', '2026-11-01'));
    expect(quiet).toMatchObject({ journalCount: 0, lineCount: 0, debitTotalMinor: '0' });
    expect((await h.fd.get('/accounting-exports')).status).toBe(403);
  });
});
