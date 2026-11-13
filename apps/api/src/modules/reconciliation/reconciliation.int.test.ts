import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Bank reconciliation (PRD M4-23 "As finance, I import a bank statement CSV and match lines to
// transfers, POS settlements and expenses", recon.manage; S37; T-128).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Entry = { kind: string; id: string; date: string; method: string; amountMinor: string };
type Line = {
  id: string;
  postedOn: string;
  description: string;
  amountMinor: string;
  status: string;
  matches: {
    kind: string;
    amountMinor: string;
    auto: boolean;
    note: string | null;
    entry: Entry | null;
  }[];
};
type Lines = {
  data: Line[];
  summary: {
    moneyInMinor: string;
    moneyOutMinor: string;
    unmatchedCount: number;
    unmatchedMinor: string;
  };
  bankAccounts: string[];
};
type Imported = { importId: string; imported: number; skipped: number; autoMatched: number };

const GTB = 'GTBank 0123456789';
const line = (
  postedOn: string,
  amountMinor: string,
  description = 'TRANSFER',
  reference?: string,
) => ({
  postedOn,
  description,
  amountMinor,
  ...(reference ? { reference } : {}),
});

async function hotel() {
  const h = await inHouse(db, clock);
  const fin = await h.as(h.finance.id);
  const shift = await db.cashierShift.create({ data: { propertyId: h.p1.id, userId: h.fdId } });
  /** A payment in the books, as the desk would have taken it. */
  const pay = async (
    method: string,
    amount: bigint,
    date: string,
    externalRef?: string,
    refundsPaymentId?: string,
  ) =>
    db.payment.create({
      data: {
        propertyId: h.p1.id,
        reservationId: h.reservationId,
        method: method as 'BANK_TRANSFER',
        amountMinor: amount,
        baseAmountMinor: amount,
        currency: 'NGN',
        businessDate: new Date(`${date}T00:00:00Z`),
        shiftId: shift.id,
        ...(externalRef ? { provider: 'MANUAL', externalRef } : {}),
        ...(refundsPaymentId ? { refundsPaymentId } : {}),
      },
    });
  const importLines = (lines: object[], as = fin) =>
    as.send('/bank-statements', { bankAccount: GTB, fileName: 'nov.csv', lines });
  const lines = (q = 'from=2026-11-01&to=2026-11-10') =>
    h.ok<Lines>(fin.get(`/bank-statement-lines?${q}`));
  const byDesc = async (description: string) => {
    const found = (await lines()).data.find((l) => l.description === description);
    if (!found) throw new Error(`No line ${description}`);
    return found;
  };
  return { ...h, fin, pay, importLines, lines, byDesc };
}

describe('importing a statement (M4-23)', () => {
  it('keeps each line once, however often overlapping statements are imported', async () => {
    const h = await hotel();
    const first = await h.ok<Imported>(
      h.importLines([
        line('2026-11-05', '15000000', 'TRF FROM ADA OBI'),
        line('2026-11-06', '-400', 'SMS ALERT'),
        line('2026-11-06', '-400', 'SMS ALERT'),
      ]),
    );
    expect(first).toMatchObject({ imported: 3, skipped: 0, autoMatched: 0 });
    // The next statement repeats 6 November and adds a third alert that day.
    const second = await h.ok<Imported>(
      h.importLines([
        line('2026-11-06', '-400', 'SMS ALERT'),
        line('2026-11-06', '-400', 'SMS ALERT'),
        line('2026-11-06', '-400', 'SMS ALERT'),
        line('2026-11-07', '-150000', 'COT CHARGES'),
      ]),
    );
    expect(second).toMatchObject({ imported: 2, skipped: 2 });
    const all = await h.lines();
    expect(all.data).toHaveLength(5);
    expect(all.summary).toEqual({
      moneyInMinor: '15000000',
      moneyOutMinor: '151200',
      unmatchedCount: 5,
      unmatchedMinor: '14848800',
    });
    expect(all.bankAccounts).toEqual([GTB]);
  });

  it('refuses lines dated ahead, and staff without recon.manage', async () => {
    const h = await hotel();
    const ahead = await h.importLines([line('2026-11-11', '100')]);
    expect(ahead.status).toBe(400);
    expect((await h.importLines([line('2026-11-05', '0')])).status).toBe(400);
    expect((await h.importLines([line('2026-11-05', '100')], h.fd)).status).toBe(403);
    expect((await h.fd.get('/bank-statement-lines?from=2026-11-01&to=2026-11-10')).status).toBe(
      403,
    );
  });
});

describe('auto-match (M4-23)', () => {
  it('matches a transfer of the same amount near the date when only one fits', async () => {
    const h = await hotel();
    const transfer = await h.pay('BANK_TRANSFER', 15000000n, '2026-11-04');
    await h.pay('BANK_TRANSFER', 15000000n, '2026-10-30'); // too early
    await h.pay('CASH', 2000000n, '2026-11-05'); // never at the bank
    const result = await h.ok<Imported>(
      h.importLines([
        line('2026-11-05', '15000000', 'TRF FROM ADA OBI'),
        line('2026-11-05', '2000000', 'LODGEMENT'),
      ]),
    );
    expect(result.autoMatched).toBe(1);
    const matched = await h.byDesc('TRF FROM ADA OBI');
    expect(matched).toMatchObject({ status: 'MATCHED' });
    expect(matched.matches).toHaveLength(1);
    expect(matched.matches[0]).toMatchObject({
      kind: 'PAYMENT',
      auto: true,
      amountMinor: '15000000',
      entry: { id: transfer.id },
    });
    expect((await h.byDesc('LODGEMENT')).status).toBe('UNMATCHED');
  });

  it('leaves two equal transfers for finance, unless the line names the reference', async () => {
    const h = await hotel();
    const first = await h.pay('BANK_TRANSFER', 5000000n, '2026-11-05', 'FT111');
    const named = await h.pay('BANK_TRANSFER', 5000000n, '2026-11-05', 'FT222');
    expect(
      (await h.ok<Imported>(h.importLines([line('2026-11-05', '5000000', 'TRF A')]))).autoMatched,
    ).toBe(0);
    // The second line names FT222, which leaves FT111 the only fit for the first.
    expect(
      (await h.ok<Imported>(h.importLines([line('2026-11-05', '5000000', 'TRF B REF FT222')])))
        .autoMatched,
    ).toBe(2);
    expect((await h.byDesc('TRF B REF FT222')).matches[0]?.entry?.id).toBe(named.id);
    expect((await h.byDesc('TRF A')).matches[0]?.entry?.id).toBe(first.id);
    expect(
      (await h.ok<{ matched: number }>(h.fin.send('/reconciliation/auto-match', {}))).matched,
    ).toBe(0);
  });

  it('matches a day’s POS takings settled as one credit, refunds and city-ledger receipts', async () => {
    const h = await hotel();
    await h.pay('POS_TERMINAL', 3000000n, '2026-11-04');
    await h.pay('POS_TERMINAL', 2500000n, '2026-11-04');
    await h.pay('POS_TERMINAL', 900000n, '2026-11-05');
    // A transfer received in October, refunded in November.
    const paid = await h.pay('BANK_TRANSFER', 1000000n, '2026-10-20');
    await h.pay('BANK_TRANSFER', -1000000n, '2026-11-06', undefined, paid.id);
    const account = await h.ok<{ id: string }>(
      h.gm.post('/ar-accounts', { companyId: h.company.id, creditLimitMinor: '50000000' }),
    );
    await h.ok(
      h.gm.send(`/ar-accounts/${account.id}/payments`, {
        method: 'BANK_TRANSFER',
        amountMinor: '7500000',
        receivedOn: '2026-11-07',
        reference: 'DANGOTE-NOV',
      }),
    );
    const result = await h.ok<Imported>(
      h.importLines([
        line('2026-11-05', '5500000', 'POS SETTLEMENT'),
        line('2026-11-06', '-1000000', 'TRF TO ADA OBI'),
        line('2026-11-08', '7500000', 'DANGOTE GROUP'),
      ]),
    );
    expect(result.autoMatched).toBe(3);
    expect((await h.byDesc('POS SETTLEMENT')).matches.map((m) => m.amountMinor).sort()).toEqual([
      '2500000',
      '3000000',
    ]);
    expect((await h.byDesc('DANGOTE GROUP')).matches[0]).toMatchObject({ kind: 'AR_PAYMENT' });
    const left = await h.ok<{ data: Entry[] }>(
      h.fin.get('/reconciliation/book-entries?from=2026-11-01&to=2026-11-10'),
    );
    expect(left.data.map((e) => e.amountMinor)).toEqual(['900000']);
  });
});

describe('matching by hand (M4-23)', () => {
  it('matches settlements net of bank charges with a note, and a payment only once', async () => {
    const h = await hotel();
    const a = await h.pay('CARD_ONLINE', 4000000n, '2026-11-04');
    const b = await h.pay('CARD_ONLINE', 6000000n, '2026-11-05');
    await h.importLines([
      line('2026-11-06', '9850000', 'PAYSTACK SETTLEMENT'),
      line('2026-11-06', '7000000', 'OTHER'),
    ]);
    const settlement = await h.byDesc('PAYSTACK SETTLEMENT');
    const path = `/bank-statement-lines/${settlement.id}/match`;
    const noNote = await h.fin.send(path, { paymentIds: [a.id, b.id] });
    expect(noNote.status).toBe(400);
    const done = await h.ok<Line>(
      h.fin.send(path, { paymentIds: [a.id, b.id], differenceNote: 'Gateway fees 1.5%' }),
    );
    expect(done.status).toBe('MATCHED');
    expect(done.matches.find((m) => m.kind === 'DIFFERENCE')).toMatchObject({
      amountMinor: '-150000',
      note: 'Gateway fees 1.5%',
      auto: false,
    });
    expect((await h.fin.send(path, { paymentIds: [a.id] })).status).toBe(409);
    const other = await h.byDesc('OTHER');
    const reused = await h.fin.send(`/bank-statement-lines/${other.id}/match`, {
      paymentIds: [a.id],
    });
    expect(reused.status).toBe(409);
    expect(errorOf(reused).code).toBe('STATE_TRANSITION_INVALID');

    // Undone, the payment is free again.
    const undone = await h.ok<Line>(
      h.fin.send(`/bank-statement-lines/${settlement.id}/unmatch`, { reason: 'Wrong batch' }),
    );
    expect(undone).toMatchObject({ status: 'UNMATCHED', matches: [] });
    expect(
      (
        await h.ok<Line>(
          h.fin.send(`/bank-statement-lines/${other.id}/match`, {
            paymentIds: [a.id],
            differenceNote: 'Settled with other takings',
          }),
        )
      ).status,
    ).toBe('MATCHED');
    expect(
      (await h.fin.send(`/bank-statement-lines/${settlement.id}/unmatch`, { reason: 'Again' }))
        .status,
    ).toBe(409);
  });

  it('explains an expense or bank charge with no payment behind it', async () => {
    const h = await hotel();
    const cash = await h.pay('CASH', 400n, '2026-11-06');
    await h.importLines([line('2026-11-06', '-250000', 'DIESEL SUPPLIER')]);
    const diesel = await h.byDesc('DIESEL SUPPLIER');
    // Cash never reaches the bank; money out is not matched to money in.
    expect(
      (await h.fin.send(`/bank-statement-lines/${diesel.id}/match`, { paymentIds: [cash.id] }))
        .status,
    ).toBe(400);
    const refund = await h.pay('BANK_TRANSFER', 300000n, '2026-11-06');
    expect(
      (await h.fin.send(`/bank-statement-lines/${diesel.id}/match`, { paymentIds: [refund.id] }))
        .status,
    ).toBe(400);
    const explained = await h.ok<Line>(
      h.fin.send(`/bank-statement-lines/${diesel.id}/explain`, {
        note: 'Diesel for the generator',
      }),
    );
    expect(explained.matches).toEqual([
      expect.objectContaining({
        kind: 'EXPLAINED',
        amountMinor: '-250000',
        note: 'Diesel for the generator',
      }),
    ]);
    expect(
      (await h.fin.send(`/bank-statement-lines/${diesel.id}/explain`, { note: 'Twice' })).status,
    ).toBe(409);
    const unmatched = await h.lines('from=2026-11-01&to=2026-11-10&status=UNMATCHED');
    expect(unmatched.data).toEqual([]);
    const audit = await db.auditEvent.findMany({
      where: { action: { startsWith: 'recon.' } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'recon.statement_imported',
      'recon.line_explained',
    ]);
  });
});
