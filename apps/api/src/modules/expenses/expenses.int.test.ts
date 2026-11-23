import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultApprovalPolicies } from '../approvals/defaults.ts';

// Expenses and petty cash (PRD M10-06 "As finance, I record expenses and petty cash with
// category, cost centre, supplier, receipt photo and approval", expense.manage; M10 rule
// "expenses above limit need approval". T-147.)

const db = testDb();
const now = new Date('2026-11-10T09:00:00Z');
const clock = () => new Date(now);
const TODAY = '2026-11-10';

type Expense = {
  id: string;
  number: number;
  amountMinor: string;
  recordedBy: { id: string };
  approvedBy: { id: string } | null;
  voided: { reason: string } | null;
  float: { id: string } | null;
};
type Float = { id: string; balanceMinor: string };

beforeEach(async () => {
  await resetDb(db);
});

/** A hotel whose Finance role may spend up to ₦50,000 without approval, with a float. */
async function books() {
  const h = await makeHotel(db, now);
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
  await db.role.update({
    where: { id: h.roles['finance'] ?? '' },
    data: { limits: { 'expense.manage': { maxAmountMinor: '5000000' } } },
  });
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => {
    const client = c.as(await sessionCookie(db, userId, clock));
    return {
      ...client,
      send: (path: string, body?: object) =>
        client.post(path, body).set('Idempotency-Key', randomUUID()),
    };
  };
  const ok = async <T>(res: Promise<{ status: number; body: unknown }>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body as T;
  };
  const financeUser = await h.person('finance', h.p1.id);
  const finance = await as(financeUser.id);
  const gm = await as(h.gm.id);
  const fd = await as(h.fd.id);
  const category = await ok<{ id: string }>(
    finance.send('/expense-categories', { code: 'repairs', name: 'Repairs' }),
  );
  const department = await db.department.create({
    data: { organisationId: h.org.id, propertyId: h.p1.id, code: 'MNT', name: 'Maintenance' },
  });
  const float = await ok<Float>(
    finance.send('/petty-cash-floats', { name: 'Front office float', custodianId: financeUser.id }),
  );
  const expense = (over: object = {}) => ({
    spentOn: TODAY,
    categoryId: category.id,
    departmentId: department.id,
    payee: 'Plumber Musa',
    description: 'Fixed the leaking tap in 204',
    amountMinor: '1500000',
    paidFrom: 'PETTY_CASH',
    floatId: float.id,
    ...over,
  });
  const balance = async () =>
    (await ok<{ floats: Float[] }>(finance.get('/expense-setup'))).floats.find(
      (f) => f.id === float.id,
    )?.balanceMinor;
  return {
    ...h,
    gmUser: h.gm,
    fdUser: h.fd,
    ok,
    finance,
    financeUser,
    gm,
    fd,
    category,
    department,
    float,
    expense,
    balance,
  };
}

describe('petty cash floats (M10-06)', () => {
  it('a float holds its top-ups less what is spent from it, and never goes below zero', async () => {
    const b = await books();
    expect(await b.balance()).toBe('0');
    const empty = await b.finance.send('/expenses', b.expense());
    expect(errorOf(empty)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Front office float holds less than this: top it up first',
    });
    await b.ok(
      b.finance.send(`/petty-cash-floats/${b.float.id}/top-ups`, {
        amountMinor: '2000000',
        reference: 'Bank withdrawal 0193',
      }),
    );
    await b.ok(b.finance.send('/expenses', b.expense()));
    expect(await b.balance()).toBe('500000');
    const tooMuch = await b.finance.send('/expenses', b.expense({ amountMinor: '600000' }));
    expect(errorOf(tooMuch).code).toBe('VALIDATION_ERROR');
    // Top-ups are never edited.
    const topUp = await db.pettyCashTopUp.findFirstOrThrow();
    await expect(
      db.pettyCashTopUp.update({ where: { id: topUp.id }, data: { amountMinor: 1n } }),
    ).rejects.toThrow();
  });

  it('only someone who records expenses can hold a float', async () => {
    const b = await books();
    // Front desk holds no expense.manage.
    const wrong = await b.finance.send('/petty-cash-floats', {
      name: 'Bar float',
      custodianId: b.fdUser.id,
    });
    expect(errorOf(wrong).details).toMatchObject({ issues: [{ path: 'body.custodianId' }] });
    const dup = await b.finance.send('/petty-cash-floats', {
      name: 'front office float',
      custodianId: null,
    });
    expect(errorOf(dup).details).toMatchObject({ issues: [{ path: 'body.name' }] });
  });
});

describe('expenses (M10-06)', () => {
  it('within the limit it is recorded at once, with category, cost centre and payee', async () => {
    const b = await books();
    const e = await b.ok<Expense & { category: { name: string }; department: { name: string } }>(
      b.finance.send(
        '/expenses',
        b.expense({ paidFrom: 'BANK_TRANSFER', floatId: null, reference: 'INV-22' }),
      ),
    );
    expect(e).toMatchObject({
      number: 1,
      amountMinor: '1500000',
      category: { name: 'Repairs' },
      department: { name: 'Maintenance' },
      recordedBy: { id: b.financeUser.id },
      approvedBy: null,
      float: null,
    });
    expect(await db.approvalRequest.count()).toBe(0);
    expect(
      await db.auditEvent.count({ where: { action: 'expense.recorded', entityId: e.id } }),
    ).toBe(1);
  });

  it('above the limit a manager approves it, and only then is it recorded', async () => {
    const b = await books();
    const big = b.expense({ amountMinor: '8000000', paidFrom: 'BANK_TRANSFER', floatId: null });
    const noReason = await b.finance.send('/expenses', big);
    expect(errorOf(noReason).code).toBe('VALIDATION_ERROR');
    const asked = await b.finance.send('/expenses', { ...big, reason: 'New water pump' });
    expect(asked.status).toBe(202);
    expect(await db.expense.count()).toBe(0);
    const { approvalRequestId } = asked.body as { approvalRequestId: string };
    expect(
      await db.approvalRequest.findUniqueOrThrow({ where: { id: approvalRequestId } }),
    ).toMatchObject({ action: 'expense.approve', amountMinor: 8000000n });
    await b.ok(b.gm.send(`/approvals/${approvalRequestId}/approve`, {}));
    const recorded = await db.expense.findFirstOrThrow();
    expect(recorded).toMatchObject({
      amountMinor: 8000000n,
      recordedById: b.financeUser.id,
      approvedById: b.gmUser.id,
      approvalRequestId,
    });
  });

  it('refuses what can’t be recorded before asking anyone', async () => {
    const b = await books();
    const future = await b.finance.send('/expenses', b.expense({ spentOn: '2026-11-11' }));
    expect(errorOf(future).details).toMatchObject({ issues: [{ path: 'body.spentOn' }] });
    const nobody = await b.finance.send('/expenses', b.expense({ payee: null }));
    expect(errorOf(nobody).code).toBe('VALIDATION_ERROR');
    const floatless = await b.finance.send('/expenses', b.expense({ floatId: null }));
    expect(errorOf(floatless).details).toMatchObject({ issues: [{ path: 'body.floatId' }] });
    const noReceipt = await b.finance.send(
      '/expenses',
      b.expense({ paidFrom: 'CARD', floatId: null, receiptFileId: randomUUID() }),
    );
    expect(errorOf(noReceipt).details).toMatchObject({ issues: [{ path: 'body.receiptFileId' }] });
    await b.ok(b.finance.patch(`/expense-categories/${b.category.id}`, { active: false }));
    const offCategory = await b.finance.send(
      '/expenses',
      b.expense({ paidFrom: 'CARD', floatId: null, amountMinor: '90000000', reason: 'x' }),
    );
    expect(errorOf(offCategory).details).toMatchObject({ issues: [{ path: 'body.categoryId' }] });
    expect(await db.approvalRequest.count()).toBe(0);
    // Front desk can't record expenses.
    expect((await b.fd.get('/expenses')).status).toBe(403);
  });

  it('keeps the receipt photo, and voids with a reason, giving the money back to the float', async () => {
    const b = await books();
    await b.ok(
      b.finance.send(`/petty-cash-floats/${b.float.id}/top-ups`, { amountMinor: '2000000' }),
    );
    const file = await db.fileObject.create({
      data: {
        organisationId: b.org.id,
        propertyId: b.p1.id,
        entityType: 'Expense',
        storageKey: `test/${randomUUID()}`,
        contentType: 'image/jpeg',
        sizeBytes: 1000,
        scan: 'CLEAN',
        uploadedById: b.financeUser.id,
      },
    });
    const e = await b.ok<Expense & { receiptFileId: string }>(
      b.finance.send('/expenses', b.expense({ receiptFileId: file.id })),
    );
    expect(e.receiptFileId).toBe(file.id);
    expect(await b.balance()).toBe('500000');
    const noReason = await b.finance.send(`/expenses/${e.id}/void`, { reason: ' ' });
    expect(errorOf(noReason).code).toBe('VALIDATION_ERROR');
    const voided = await b.ok<Expense>(
      b.finance.send(`/expenses/${e.id}/void`, { reason: 'Recorded twice' }),
    );
    expect(voided.voided).toMatchObject({ reason: 'Recorded twice' });
    expect(await b.balance()).toBe('2000000');
    expect(errorOf(await b.finance.send(`/expenses/${e.id}/void`, { reason: 'Again' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    // Still listed; the period total leaves it out.
    const list = await b.ok<{ data: Expense[]; totalMinor: string }>(
      b.finance.get(`/expenses?from=${TODAY}&to=${TODAY}`),
    );
    expect(list.data.map((x) => x.id)).toEqual([e.id]);
    expect(list.totalMinor).toBe('0');
  });
});
