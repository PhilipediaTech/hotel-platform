import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, IsoDate, page, PageQuery, Uuid } from './primitives.ts';

// Expenses and petty cash (PRD M10-06 "As finance, I record expenses and petty cash with
// category, cost centre, supplier, receipt photo and approval", expense.manage; M10 rule
// "expenses above limit need approval"; T-147). Tab 4 names /expenses; categories and petty
// cash floats get their own routes. The cost centre is the department. An expense within the
// recorder's expense.manage amount limit is recorded at once; above it the answer is 202 and
// it is recorded when a manager approves (action expense.approve). Expenses are voided with a
// reason, never deleted. A float's balance is its top-ups less the expenses paid from it, and
// no expense takes it below zero.

const Positive = AmountMinor.refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, 'More than zero');
const Reason = z.string().trim().min(1, 'Give a reason').max(500);
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();
const Person = z.object({ id: Uuid, name: z.string() });
const Ref = z.object({ id: Uuid, code: z.string(), name: z.string() });

export const ExpensePaidFrom = z.enum(['PETTY_CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE']);

export const ExpenseCategoryItem = z
  .object({ id: Uuid, code: z.string(), name: z.string(), active: z.boolean() })
  .meta({ id: 'ExpenseCategory' });

export const PettyCashFloatItem = z
  .object({
    id: Uuid,
    name: z.string(),
    custodian: Person.nullable(),
    active: z.boolean(),
    /** Top-ups less the expenses paid from it (voided ones excluded). */
    balanceMinor: AmountMinor,
  })
  .meta({ id: 'PettyCashFloat' });

export const ExpenseItem = z
  .object({
    id: Uuid,
    number: z.number().int(),
    spentOn: IsoDate,
    category: Ref,
    /** The cost centre. */
    department: Ref,
    supplier: z.object({ id: Uuid, name: z.string() }).nullable(),
    payee: z.string().nullable(),
    description: z.string(),
    amountMinor: AmountMinor,
    paidFrom: ExpensePaidFrom,
    float: z.object({ id: Uuid, name: z.string() }).nullable(),
    reference: z.string().nullable(),
    receiptFileId: Uuid.nullable(),
    recordedBy: Person,
    recordedAt: Instant,
    /** The manager who approved it, when it was above the recorder's limit. */
    approvedBy: Person.nullable(),
    voided: z.object({ at: Instant, by: Person, reason: z.string() }).nullable(),
  })
  .meta({ id: 'Expense' });

const MANAGE = {
  tags: ['Expenses'],
  propertyScoped: true as const,
  permission: 'expense.manage',
};
const ADDED = 'Tab 4 names /expenses; the routes are designed in T-147.';

export const getExpenseSetup = defineRoute({
  ...MANAGE,
  operationId: 'getExpenseSetup',
  method: 'get',
  path: '/expense-setup',
  summary: 'Categories, petty cash floats with balances, cost centres and suppliers (M10-06)',
  description: ADDED,
  response: z.object({
    categories: z.array(ExpenseCategoryItem),
    floats: z.array(PettyCashFloatItem),
    departments: z.array(Ref),
    suppliers: z.array(z.object({ id: Uuid, name: z.string(), active: z.boolean() })),
    /** Holders of expense.manage, who can hold a float. */
    custodians: z.array(Person),
    currency: z.string(),
    businessDate: IsoDate,
  }),
});

const CategoryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,12}$/, '2 to 12 letters, digits or dashes');
const Name = z.string().trim().min(1).max(80);

export const createExpenseCategory = defineRoute({
  ...MANAGE,
  operationId: 'createExpenseCategory',
  method: 'post',
  path: '/expense-categories',
  summary: 'Add an expense category (M10-06)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: z.object({ code: CategoryCode, name: Name }),
  response: ExpenseCategoryItem,
});

export const updateExpenseCategory = defineRoute({
  ...MANAGE,
  operationId: 'updateExpenseCategory',
  method: 'patch',
  path: '/expense-categories/{categoryId}',
  summary: 'Rename an expense category, or switch it off (M10-06)',
  description: ADDED,
  params: z.object({ categoryId: Uuid }),
  body: z.object({ name: Name.optional(), active: z.boolean().optional() }),
  response: ExpenseCategoryItem,
});

export const createPettyCashFloat = defineRoute({
  ...MANAGE,
  operationId: 'createPettyCashFloat',
  method: 'post',
  path: '/petty-cash-floats',
  summary: 'Add a petty cash float, held by one person (M10-06)',
  description: ADDED,
  idempotent: true,
  status: 201,
  body: z.object({ name: Name, custodianId: Uuid.nullable() }),
  response: PettyCashFloatItem,
});

export const updatePettyCashFloat = defineRoute({
  ...MANAGE,
  operationId: 'updatePettyCashFloat',
  method: 'patch',
  path: '/petty-cash-floats/{floatId}',
  summary: 'Change who holds a float, or switch it off (M10-06)',
  description: ADDED,
  params: z.object({ floatId: Uuid }),
  body: z.object({
    name: Name.optional(),
    custodianId: Uuid.nullable().optional(),
    active: z.boolean().optional(),
  }),
  response: PettyCashFloatItem,
});

export const topUpPettyCash = defineRoute({
  ...MANAGE,
  operationId: 'topUpPettyCash',
  method: 'post',
  path: '/petty-cash-floats/{floatId}/top-ups',
  summary: 'Put money into a petty cash float (M10-06)',
  description: `${ADDED} Top-ups are never edited or removed.`,
  idempotent: true,
  status: 201,
  params: z.object({ floatId: Uuid }),
  body: z.object({ amountMinor: Positive, reference: OptionalText(60).optional() }),
  response: PettyCashFloatItem,
});

export const listExpenses = defineRoute({
  ...MANAGE,
  operationId: 'listExpenses',
  method: 'get',
  path: '/expenses',
  summary: 'Expenses, newest first, by period, category, cost centre or float (M10-06)',
  description: ADDED,
  query: PageQuery.extend({
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    categoryId: Uuid.optional(),
    departmentId: Uuid.optional(),
    floatId: Uuid.optional(),
  }),
  response: page(ExpenseItem).extend({
    /** Total of the expenses matching the filters (voided ones excluded). */
    totalMinor: AmountMinor,
  }),
});

export const RecordExpenseBody = z
  .object({
    spentOn: IsoDate,
    categoryId: Uuid,
    departmentId: Uuid,
    supplierId: Uuid.nullable().optional(),
    payee: OptionalText(120).optional(),
    description: z.string().trim().min(1).max(200),
    amountMinor: Positive,
    paidFrom: ExpensePaidFrom,
    floatId: Uuid.nullable().optional(),
    reference: OptionalText(60).optional(),
    receiptFileId: Uuid.nullable().optional(),
    /** Needed when the expense is above your limit: the approver sees it. */
    reason: OptionalText(500).optional(),
  })
  .refine((b) => b.supplierId || b.payee, {
    path: ['payee'],
    message: 'Choose a supplier or name who was paid',
  })
  .refine((b) => (b.paidFrom === 'PETTY_CASH') === Boolean(b.floatId), {
    path: ['floatId'],
    message: 'Petty cash names its float; other payments don’t',
  });

export const recordExpense = defineRoute({
  ...MANAGE,
  operationId: 'recordExpense',
  method: 'post',
  path: '/expenses',
  summary: 'Record an expense: within your limit at once, above it a manager approves (M10-06)',
  description: `${ADDED} Measured by the amount against the caller's expense.manage limit, else the expense.approve policy threshold; above it a reason is needed and the answer is 202. Dated no later than the business date. Petty cash can't go below zero.`,
  idempotent: true,
  approval: true,
  status: 201,
  body: RecordExpenseBody,
  response: ExpenseItem,
});

export const voidExpense = defineRoute({
  ...MANAGE,
  operationId: 'voidExpense',
  method: 'post',
  path: '/expenses/{expenseId}/void',
  summary: 'Void a mistaken expense with a reason; it stays on record (M10-06)',
  description: ADDED,
  params: z.object({ expenseId: Uuid }),
  body: z.object({ reason: Reason }),
  response: ExpenseItem,
});

export const EXPENSE_ROUTES = {
  getExpenseSetup,
  createExpenseCategory,
  updateExpenseCategory,
  createPettyCashFloat,
  updatePettyCashFloat,
  topUpPettyCash,
  listExpenses,
  recordExpense,
  voidExpense,
} as const;
