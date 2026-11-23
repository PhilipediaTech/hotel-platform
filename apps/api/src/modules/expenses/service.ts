import type { ExpenseItem, PettyCashFloatItem, RecordExpenseBody } from '@hotel/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { performOrRequest, type ApprovalActionHandler } from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import type { Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Expenses and petty cash (PRD M10-06; M10 rule "expenses above limit need approval"; T-147).
// An expense is recorded at once within the recorder's expense.manage amount limit (or when
// they hold an approver role); above it, a request waits for a manager (action
// expense.approve) and the expense is recorded when it is approved, re-checked as things
// stand then. A petty cash float's balance is its top-ups less the expenses paid from it; each
// expense paid from it locks the float, so two can't overdraw it together.

export interface ExpenseDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
  });
const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const person = (u: { id: string; name: string }) => ({ id: u.id, name: u.name });
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------
// Setup: categories and floats

async function floatBalances(db: Client, floatIds?: string[]) {
  const where = floatIds ? { floatId: { in: floatIds } } : {};
  const [ins, outs] = await Promise.all([
    db.pettyCashTopUp.groupBy({ by: ['floatId'], where, _sum: { amountMinor: true } }),
    db.expense.groupBy({
      by: ['floatId'],
      where: { ...where, floatId: floatIds ? { in: floatIds } : { not: null }, voidedAt: null },
      _sum: { amountMinor: true },
    }),
  ]);
  const map = new Map<string, bigint>();
  for (const r of ins) map.set(r.floatId, r._sum.amountMinor ?? 0n);
  for (const r of outs) {
    if (r.floatId) map.set(r.floatId, (map.get(r.floatId) ?? 0n) - (r._sum.amountMinor ?? 0n));
  }
  return map;
}

const FLOAT_INCLUDE = {
  custodian: { select: { id: true, name: true } },
} as const satisfies Prisma.PettyCashFloatInclude;
type FloatRow = Prisma.PettyCashFloatGetPayload<{ include: typeof FLOAT_INCLUDE }>;

function floatItem(f: FloatRow, balance: bigint): z.input<typeof PettyCashFloatItem> {
  return {
    id: f.id,
    name: f.name,
    custodian: f.custodian ? person(f.custodian) : null,
    active: f.active,
    balanceMinor: balance.toString(),
  };
}

async function floatView(db: Client, floatId: string) {
  const f = await db.pettyCashFloat.findFirstOrThrow({
    where: { id: floatId },
    include: FLOAT_INCLUDE,
  });
  return floatItem(f, (await floatBalances(db, [floatId])).get(floatId) ?? 0n);
}

/** People at this property whose roles hold expense.manage: they can hold a float. */
async function custodians(db: Client, tenant: TenantContext) {
  const memberships = await db.membership.findMany({
    where: {
      active: true,
      OR: [{ propertyId: tenant.propertyId }, { propertyId: null }],
      role: { permissions: { has: 'expense.manage' } },
      user: { status: 'ACTIVE' },
    },
    select: { user: { select: { id: true, name: true } } },
  });
  const byId = new Map(memberships.map((m) => [m.user.id, person(m.user)]));
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getExpenseSetup(deps: ExpenseDeps, tenant: TenantContext) {
  const db = deps.tenantDb;
  const [categories, floats, departments, suppliers, people, property, balances, today] =
    await Promise.all([
      db.expenseCategory.findMany({ orderBy: { name: 'asc' } }),
      db.pettyCashFloat.findMany({ include: FLOAT_INCLUDE, orderBy: { name: 'asc' } }),
      db.department.findMany({
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
      }),
      db.supplier.findMany({
        select: { id: true, name: true, active: true },
        orderBy: { name: 'asc' },
      }),
      custodians(db, tenant),
      db.property.findUniqueOrThrow({ where: { id: tenant.propertyId } }),
      floatBalances(db),
      businessDate(db, tenant.propertyId, deps.clock),
    ]);
  return {
    categories: categories.map((c) => ({ id: c.id, code: c.code, name: c.name, active: c.active })),
    floats: floats.map((f) => floatItem(f, balances.get(f.id) ?? 0n)),
    departments,
    suppliers,
    custodians: people,
    currency: property.baseCurrency,
    businessDate: today,
  };
}

export async function createExpenseCategory(
  deps: ExpenseDeps,
  body: { code: string; name: string },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    if (await tx.expenseCategory.findFirst({ where: { code: body.code } })) {
      throw invalid('body.code', `${body.code} is already a category here`);
    }
    const c = await tx.expenseCategory.create({
      data: body as unknown as Prisma.ExpenseCategoryUncheckedCreateInput,
    });
    await recordAudit(tx, {
      action: 'expense.category_created',
      entityType: 'expense_category',
      entityId: c.id,
      after: body,
    });
    return { id: c.id, code: c.code, name: c.name, active: c.active };
  });
}

export async function updateExpenseCategory(
  deps: ExpenseDeps,
  categoryId: string,
  body: { name?: string | undefined; active?: boolean | undefined },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.expenseCategory.findFirst({ where: { id: categoryId } });
    if (!before) throw notFound('Category');
    const c = await tx.expenseCategory.update({ where: { id: categoryId }, data: defined(body) });
    await recordAudit(tx, {
      action: 'expense.category_updated',
      entityType: 'expense_category',
      entityId: categoryId,
      before: { name: before.name, active: before.active },
      after: body,
    });
    return { id: c.id, code: c.code, name: c.name, active: c.active };
  });
}

async function checkCustodian(db: Client, tenant: TenantContext, custodianId: string | null) {
  if (custodianId === null) return;
  if (!(await custodians(db, tenant)).some((p) => p.id === custodianId)) {
    throw invalid('body.custodianId', 'Choose someone here who can record expenses');
  }
}

async function nameFree(db: Client, name: string, except?: string) {
  const taken = await db.pettyCashFloat.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(except ? { NOT: { id: except } } : {}),
    },
  });
  if (taken) throw invalid('body.name', `${name} is already a float here`);
}

export async function createPettyCashFloat(
  deps: ExpenseDeps,
  tenant: TenantContext,
  body: { name: string; custodianId: string | null },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    await nameFree(tx, body.name);
    await checkCustodian(tx, tenant, body.custodianId);
    const f = await tx.pettyCashFloat.create({
      data: body as unknown as Prisma.PettyCashFloatUncheckedCreateInput,
    });
    await recordAudit(tx, {
      action: 'expense.float_created',
      entityType: 'petty_cash_float',
      entityId: f.id,
      after: body,
    });
    return floatView(tx, f.id);
  });
}

export async function updatePettyCashFloat(
  deps: ExpenseDeps,
  tenant: TenantContext,
  floatId: string,
  body: {
    name?: string | undefined;
    custodianId?: string | null | undefined;
    active?: boolean | undefined;
  },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await tx.pettyCashFloat.findFirst({ where: { id: floatId } });
    if (!before) throw notFound('Float');
    if (body.name !== undefined) await nameFree(tx, body.name, floatId);
    if (body.custodianId !== undefined) await checkCustodian(tx, tenant, body.custodianId);
    await tx.pettyCashFloat.update({ where: { id: floatId }, data: defined(body) });
    await recordAudit(tx, {
      action: 'expense.float_updated',
      entityType: 'petty_cash_float',
      entityId: floatId,
      before: { name: before.name, custodianId: before.custodianId, active: before.active },
      after: body,
    });
    return floatView(tx, floatId);
  });
}

async function lockFloat(tx: Tx, floatId: string, path: string) {
  await tx.$queryRaw`SELECT id FROM petty_cash_floats WHERE id = ${floatId}::uuid FOR UPDATE`;
  const f = await tx.pettyCashFloat.findFirst({ where: { id: floatId } });
  if (!f) throw invalid(path, 'Choose a petty cash float of this property');
  return f;
}

export async function topUpPettyCash(
  deps: ExpenseDeps,
  tenant: TenantContext,
  floatId: string,
  body: { amountMinor: string; reference?: string | null | undefined },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM petty_cash_floats WHERE id = ${floatId}::uuid FOR UPDATE`;
    const f = await tx.pettyCashFloat.findFirst({ where: { id: floatId } });
    if (!f) throw notFound('Float');
    if (!f.active) throw new AppError('STATE_TRANSITION_INVALID', 'This float is switched off');
    await tx.pettyCashTopUp.create({
      data: {
        floatId,
        amountMinor: BigInt(body.amountMinor),
        reference: body.reference ?? null,
        byUserId: tenant.userId,
      } as unknown as Prisma.PettyCashTopUpUncheckedCreateInput,
    });
    await recordAudit(tx, {
      action: 'expense.float_topped_up',
      entityType: 'petty_cash_float',
      entityId: floatId,
      after: { amountMinor: body.amountMinor, reference: body.reference ?? null },
    });
    return floatView(tx, floatId);
  });
}

// ---------------------------------------------------------------------------------------
// Expenses

const EXPENSE_INCLUDE = {
  category: { select: { id: true, code: true, name: true } },
  department: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, name: true } },
  float: { select: { id: true, name: true } },
  recordedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  voidedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.ExpenseInclude;
type ExpenseRow = Prisma.ExpenseGetPayload<{ include: typeof EXPENSE_INCLUDE }>;

function expenseItem(e: ExpenseRow): z.input<typeof ExpenseItem> {
  return {
    id: e.id,
    number: e.number,
    spentOn: dateOnly(e.spentOn),
    category: e.category,
    department: e.department,
    supplier: e.supplier,
    payee: e.payee,
    description: e.description,
    amountMinor: e.amountMinor.toString(),
    paidFrom: e.paidFrom,
    float: e.float,
    reference: e.reference,
    receiptFileId: e.receiptFileId,
    recordedBy: person(e.recordedBy),
    recordedAt: e.recordedAt.toISOString(),
    approvedBy: e.approvedBy ? person(e.approvedBy) : null,
    voided:
      e.voidedAt && e.voidedBy && e.voidReason
        ? { at: e.voidedAt.toISOString(), by: person(e.voidedBy), reason: e.voidReason }
        : null,
  };
}

async function expenseView(db: Client, id: string) {
  return expenseItem(
    await db.expense.findFirstOrThrow({ where: { id }, include: EXPENSE_INCLUDE }),
  );
}

const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function listExpenses(
  deps: ExpenseDeps,
  query: {
    limit: number;
    cursor?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    categoryId?: string | undefined;
    departmentId?: string | undefined;
    floatId?: string | undefined;
  },
) {
  const where: Prisma.ExpenseWhereInput = {
    ...defined({
      categoryId: query.categoryId,
      departmentId: query.departmentId,
      floatId: query.floatId,
    }),
    ...(query.from || query.to
      ? {
          spentOn: {
            ...(query.from ? { gte: new Date(`${query.from}T00:00:00Z`) } : {}),
            ...(query.to ? { lte: new Date(`${query.to}T00:00:00Z`) } : {}),
          },
        }
      : {}),
  };
  const offset = decodeCursor(query.cursor);
  const [rows, total] = await Promise.all([
    deps.tenantDb.expense.findMany({
      where,
      include: EXPENSE_INCLUDE,
      orderBy: [{ spentOn: 'desc' }, { number: 'desc' }],
      skip: offset,
      take: query.limit + 1,
    }),
    deps.tenantDb.expense.aggregate({
      where: { ...where, voidedAt: null },
      _sum: { amountMinor: true },
    }),
  ]);
  return {
    data: rows.slice(0, query.limit).map(expenseItem),
    nextCursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
    totalMinor: (total._sum.amountMinor ?? 0n).toString(),
  };
}

/** What an approval request stores: the expense as asked, without the request's reason. */
const ExpenseStored = z.object({
  spentOn: z.string(),
  categoryId: z.string(),
  departmentId: z.string(),
  supplierId: z.string().nullable(),
  payee: z.string().nullable(),
  description: z.string(),
  amountMinor: z.string(),
  paidFrom: z.enum(['PETTY_CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE']),
  floatId: z.string().nullable(),
  reference: z.string().nullable(),
  receiptFileId: z.string().nullable(),
});
type ExpensePayload = z.output<typeof ExpenseStored>;

/** Checks everything the expense names, as things stand now. */
async function checkExpense(tx: Tx, propertyId: string, clock: Clock, p: ExpensePayload) {
  if (p.spentOn > (await businessDate(tx, propertyId, clock))) {
    throw invalid('body.spentOn', 'An expense can’t be dated after the business date');
  }
  if (!(await tx.expenseCategory.findFirst({ where: { id: p.categoryId, active: true } }))) {
    throw invalid('body.categoryId', 'Choose an active category of this property');
  }
  if (!(await tx.department.findFirst({ where: { id: p.departmentId } }))) {
    throw invalid('body.departmentId', 'Choose a cost centre of this property');
  }
  if (
    p.supplierId &&
    !(await tx.supplier.findFirst({ where: { id: p.supplierId, active: true } }))
  ) {
    throw invalid('body.supplierId', 'Choose an active supplier of this property');
  }
  if (p.receiptFileId) {
    const file = await tx.fileObject.findFirst({
      where: { id: p.receiptFileId, entityType: 'Expense', scan: { not: 'INFECTED' } },
    });
    if (!file) throw invalid('body.receiptFileId', 'Upload the receipt photo first');
  }
}

async function executeRecord(
  ctx: { tx: Tx; tenant: TenantContext; approvalRequestId: string | null; clock: Clock },
  p: ExpensePayload,
) {
  const { tx, tenant } = ctx;
  await checkExpense(tx, tenant.propertyId, ctx.clock, p);
  const amount = BigInt(p.amountMinor);
  if (p.floatId) {
    const f = await lockFloat(tx, p.floatId, 'body.floatId');
    if (!f.active) throw invalid('body.floatId', 'This float is switched off');
    const balance = (await floatBalances(tx, [f.id])).get(f.id) ?? 0n;
    if (balance < amount) {
      throw invalid('body.amountMinor', `${f.name} holds less than this: top it up first`);
    }
  }
  // Recorded by the requester; through a request, approved by the manager who decided.
  const decided = ctx.approvalRequestId
    ? await tx.approvalRequest.findFirst({
        where: { id: ctx.approvalRequestId },
        select: { decidedById: true },
      })
    : null;
  const number = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.EXPENSE);
  const e = await tx.expense.create({
    data: {
      number,
      spentOn: new Date(`${p.spentOn}T00:00:00Z`),
      categoryId: p.categoryId,
      departmentId: p.departmentId,
      supplierId: p.supplierId,
      payee: p.payee,
      description: p.description,
      amountMinor: amount,
      paidFrom: p.paidFrom,
      floatId: p.floatId,
      reference: p.reference,
      receiptFileId: p.receiptFileId,
      recordedById: tenant.userId,
      approvedById: decided?.decidedById ?? null,
      approvalRequestId: ctx.approvalRequestId,
    } as unknown as Prisma.ExpenseUncheckedCreateInput,
  });
  await recordAudit(tx, {
    action: 'expense.recorded',
    entityType: 'expense',
    entityId: e.id,
    approvalRequestId: ctx.approvalRequestId ?? undefined,
    after: { number, ...p },
  });
  return e.id;
}

export function expenseApproveHandler(deps: {
  clock: Clock;
}): ApprovalActionHandler<ExpensePayload> {
  return {
    action: 'expense.approve',
    payload: ExpenseStored,
    measure: (p) => ({ amountMinor: BigInt(p.amountMinor) }),
    execute: (ctx, p) => executeRecord({ ...ctx, clock: deps.clock }, p),
  };
}

/** M10-06: within the recorder's limit the expense is recorded now; above it a manager decides. */
export async function recordExpense(
  deps: ExpenseDeps,
  tenant: TenantContext,
  body: z.output<typeof RecordExpenseBody>,
) {
  const payload: ExpensePayload = {
    spentOn: body.spentOn,
    categoryId: body.categoryId,
    departmentId: body.departmentId,
    supplierId: body.supplierId ?? null,
    payee: body.payee ?? null,
    description: body.description,
    amountMinor: body.amountMinor,
    paidFrom: body.paidFrom,
    floatId: body.floatId ?? null,
    reference: body.reference ?? null,
    receiptFileId: body.receiptFileId ?? null,
  };
  // Refuse what can't be recorded before asking anyone to approve it.
  await deps.tenantDb.$transaction((tx) =>
    checkExpense(tx, tenant.propertyId, deps.clock, payload),
  );
  const result = await performOrRequest(
    { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
    tenant,
    expenseApproveHandler(deps),
    payload,
    body.reason ?? '',
  );
  if (!('resultRef' in result)) return result;
  return expenseView(deps.tenantDb, result.resultRef);
}

export async function voidExpense(
  deps: ExpenseDeps,
  tenant: TenantContext,
  expenseId: string,
  body: { reason: string },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM expenses WHERE id = ${expenseId}::uuid FOR UPDATE`;
    const e = await tx.expense.findFirst({ where: { id: expenseId } });
    if (!e) throw notFound('Expense');
    if (e.voidedAt)
      throw new AppError('STATE_TRANSITION_INVALID', 'This expense is already voided');
    await tx.expense.update({
      where: { id: expenseId },
      data: { voidedAt: deps.clock(), voidedById: tenant.userId, voidReason: body.reason },
    });
    await recordAudit(tx, {
      action: 'expense.voided',
      entityType: 'expense',
      entityId: expenseId,
      reason: body.reason,
      after: { number: e.number, amountMinor: e.amountMinor.toString() },
    });
    return expenseView(tx, expenseId);
  });
}
