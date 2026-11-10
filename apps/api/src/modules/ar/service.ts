import {
  addDays,
  AGEING_BUCKETS,
  localDate,
  type ArAccountBody,
  type ArAccountDetail,
  type ArAccountItem,
  type ArAccountUpdateBody,
  type ArAgeing,
  type ArAllocateBody,
  type ArPaymentBody,
  type ArStatement,
  type ArTransferBody,
  type ArTransferResult,
} from '@hotel/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import {
  isApprovalPending,
  performOrRequest,
  type ApprovalActionHandler,
  type ApprovalPendingResult,
  type ExecuteContext,
} from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import { postingDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import { pgErrorInfo, raisedBy, type Db } from '../../core/db.ts';
import type { EmailProvider } from '../../core/email.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import { houseRights } from '../folios/service.ts';
import { facts, footer, header, money, render, table, totals } from '../payments/documents.ts';
import { systemShift } from '../payments/intents.ts';

// City ledger (PRD M4-21, the M4 rule on AR transfers; T-126). A folio window's balance moves to
// a company's account as an AR_TRANSFER payment on the folio (so the folio settles and the night
// audit's trial balance counts it as an AR transfer) and an invoice on the account, due after the
// account's terms. Payments from the company are recorded on the account and allocated to its
// invoices, oldest first unless finance says otherwise. They are not cashier money and sit on no
// shift. Balances are always worked out from invoices, payments and allocations, never stored.

export interface ArDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
  email: EmailProvider;
}

type TenantTx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | TenantTx;
type Account = z.input<typeof ArAccountItem>;
type Detail = z.input<typeof ArAccountDetail>;

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });
const stateError = (message: string, details?: Record<string, unknown>) =>
  new AppError('STATE_TRANSITION_INVALID', message, details);

const ACCOUNT_INCLUDE = {
  company: { select: { id: true, name: true, kind: true, billingInstructions: true } },
  invoices: {
    include: { allocations: true, folio: { select: { id: true, number: true, name: true } } },
    orderBy: [{ issuedOn: 'asc' }, { number: 'asc' }],
  },
  payments: {
    include: { allocations: { include: { invoice: { select: { number: true } } } } },
    orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.ArAccountInclude;
type AccountRow = Prisma.ArAccountGetPayload<{ include: typeof ACCOUNT_INCLUDE }>;

const allocated = (rows: { amountMinor: bigint }[]) => rows.reduce((s, r) => s + r.amountMinor, 0n);

async function today(db: Client, propertyId: string, clock: Clock) {
  const p = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  return localDate(clock(), p.timeZone);
}

function itemOf(a: AccountRow, on: string): Account {
  let open = 0n;
  let overdue = 0n;
  for (const inv of a.invoices) {
    const left = inv.amountMinor - allocated(inv.allocations);
    open += left;
    if (left > 0n && day(inv.dueOn) < on) overdue += left;
  }
  const unallocated = a.payments.reduce((s, p) => s + p.amountMinor - allocated(p.allocations), 0n);
  return {
    id: a.id,
    company: { id: a.company.id, name: a.company.name, kind: a.company.kind },
    creditLimitMinor: a.creditLimitMinor.toString(),
    termsDays: a.termsDays,
    status: a.status as Account['status'],
    balanceMinor: (open - unallocated).toString(),
    overdueMinor: overdue.toString(),
  };
}

function detailOf(a: AccountRow, on: string): Detail {
  return {
    ...itemOf(a, on),
    invoices: [...a.invoices].reverse().map((inv) => {
      const left = inv.amountMinor - allocated(inv.allocations);
      return {
        id: inv.id,
        number: inv.number,
        folio: inv.folio,
        amountMinor: inv.amountMinor.toString(),
        openMinor: left.toString(),
        issuedOn: day(inv.issuedOn),
        dueOn: day(inv.dueOn),
        status: left > 0n ? ('OPEN' as const) : ('PAID' as const),
      };
    }),
    payments: [...a.payments].reverse().map((p) => ({
      id: p.id,
      method: p.method as Detail['payments'][number]['method'],
      amountMinor: p.amountMinor.toString(),
      unallocatedMinor: (p.amountMinor - allocated(p.allocations)).toString(),
      reference: p.reference,
      receivedOn: day(p.receivedOn),
      note: p.note,
      allocations: p.allocations.map((x) => ({
        invoiceNumber: x.invoice.number,
        amountMinor: x.amountMinor.toString(),
      })),
    })),
  };
}

async function loadAccount(db: Client, accountId: string) {
  const a = await db.arAccount.findFirst({ where: { id: accountId }, include: ACCOUNT_INCLUDE });
  if (!a) throw new AppError('NOT_FOUND', 'Account not found');
  return a;
}

// ── Accounts ────────────────────────────────────────────────────────────────────────────

export async function listAccounts(deps: ArDeps, tenant: TenantContext) {
  const on = await today(deps.tenantDb, tenant.propertyId, deps.clock);
  const rows = await deps.tenantDb.arAccount.findMany({
    include: ACCOUNT_INCLUDE,
    orderBy: { company: { name: 'asc' } },
  });
  return { data: rows.map((r) => itemOf(r, on)) };
}

export async function getAccount(deps: ArDeps, tenant: TenantContext, accountId: string) {
  const on = await today(deps.tenantDb, tenant.propertyId, deps.clock);
  return detailOf(await loadAccount(deps.tenantDb, accountId), on);
}

export async function createAccount(
  deps: ArDeps,
  tenant: TenantContext,
  body: z.output<typeof ArAccountBody>,
) {
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const company = await tx.company.findUnique({ where: { id: body.companyId } });
      if (!company?.active || company.kind === 'EVENT_CLIENT') {
        throw invalid('companyId', 'Choose an active company or travel agent');
      }
      const row = await tx.arAccount.create({
        data: {
          companyId: company.id,
          creditLimitMinor: BigInt(body.creditLimitMinor),
          termsDays: body.termsDays,
          createdAt: deps.clock(),
        } as unknown as Prisma.ArAccountUncheckedCreateInput,
      });
      await recordAudit(tx, {
        action: 'ar.account_opened',
        entityType: 'ar_account',
        entityId: row.id,
        after: {
          companyId: company.id,
          creditLimitMinor: body.creditLimitMinor,
          termsDays: body.termsDays,
        },
      });
      const on = await today(tx, tenant.propertyId, deps.clock);
      return itemOf(await loadAccount(tx, row.id), on);
    });
  } catch (err) {
    if (pgErrorInfo(err)?.constraint === 'ar_accounts_property_id_company_id_key') {
      throw invalid('companyId', 'This company already has an account here');
    }
    throw err;
  }
}

export async function updateAccount(
  deps: ArDeps,
  tenant: TenantContext,
  accountId: string,
  body: z.output<typeof ArAccountUpdateBody>,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const before = await loadAccount(tx, accountId);
    await tx.arAccount.update({
      where: { id: accountId },
      data: {
        creditLimitMinor: BigInt(body.creditLimitMinor),
        termsDays: body.termsDays,
        status: body.status,
      },
    });
    await recordAudit(tx, {
      action: 'ar.account_updated',
      entityType: 'ar_account',
      entityId: accountId,
      before: {
        creditLimitMinor: before.creditLimitMinor.toString(),
        termsDays: before.termsDays,
        status: before.status,
      },
      after: body,
    });
    const on = await today(tx, tenant.propertyId, deps.clock);
    return itemOf(await loadAccount(tx, accountId), on);
  });
}

// ── Transfer to the city ledger (M4-21, M4 rule) ────────────────────────────────────────

const TransferPayload = z.object({
  accountId: z.string(),
  folioId: z.string(),
  windowNumber: z.number(),
  amountMinor: z.string(),
});
type TransferPayload = z.infer<typeof TransferPayload>;

/** What a folio window owes now (charges less payments, base currency). */
async function windowOwes(tx: TenantTx, windowId: string) {
  const [lines, paid] = await Promise.all([
    tx.folioLine.aggregate({ where: { windowId }, _sum: { amountMinor: true } }),
    tx.payment.aggregate({ where: { windowId }, _sum: { baseAmountMinor: true } }),
  ]);
  return (lines._sum.amountMinor ?? 0n) - (paid._sum.baseAmountMinor ?? 0n);
}

async function transferIn(
  ctx: ExecuteContext & { now: Date; clock: Clock },
  p: TransferPayload,
  withinLimitOnly: boolean,
): Promise<string> {
  const { tx, tenant } = ctx;
  await tx.$queryRaw`SELECT id FROM folios WHERE id = ${p.folioId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM ar_accounts WHERE id = ${p.accountId}::uuid FOR UPDATE`;
  const folio = await tx.folio.findFirst({
    where: { id: p.folioId },
    include: { windows: true },
  });
  if (!folio) throw new AppError('NOT_FOUND', 'Folio not found');
  if (folio.status !== 'OPEN') {
    throw stateError('This folio is not open', { status: folio.status });
  }
  houseRights(folio, tenant);
  const window = folio.windows.find((w) => w.number === p.windowNumber);
  if (!window) throw invalid('windowNumber', 'This folio has no such window');
  const amount = BigInt(p.amountMinor);
  const owes = await windowOwes(tx, window.id);
  if (amount > owes) {
    throw invalid('amountMinor', owes > 0n ? 'More than the window owes' : 'Nothing is owed');
  }
  const account = await loadAccount(tx, p.accountId);
  if (account.status !== 'ACTIVE') {
    throw stateError('This account is not taking new charges', { status: account.status });
  }
  const on = await today(tx, tenant.propertyId, ctx.clock);
  const balance = BigInt(itemOf(account, on).balanceMinor);
  // The M4 rule: within the limit, or approved (the approval path runs with an approval ID).
  if (withinLimitOnly && balance + amount > account.creditLimitMinor) {
    throw stateError('Over the credit limit');
  }

  const date = await postingDate(tx, tenant.propertyId, ctx.clock);
  const n = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.AR_INVOICE);
  const number = `AR-${String(n).padStart(5, '0')}`;
  const shiftId = await systemShift(tx as never, tenant.propertyId, ctx.now);
  const payment = await tx.payment.create({
    data: {
      folioId: folio.id,
      windowId: window.id,
      method: 'AR_TRANSFER',
      amountMinor: amount,
      currency: folio.currency,
      baseAmountMinor: amount,
      provider: 'MANUAL',
      externalRef: number,
      businessDate: dbDate(date),
      shiftId,
      receivedById: tenant.userId,
      approvalRequestId: ctx.approvalRequestId,
      note: `Transferred to ${account.company.name}'s account`,
      createdAt: ctx.now,
    } as unknown as Prisma.PaymentUncheckedCreateInput,
  });
  const invoice = await tx.arInvoice.create({
    data: {
      arAccountId: account.id,
      number,
      folioId: folio.id,
      paymentId: payment.id,
      amountMinor: amount,
      issuedOn: dbDate(date),
      dueOn: dbDate(addDays(date, account.termsDays)),
      createdAt: ctx.now,
    } as unknown as Prisma.ArInvoiceUncheckedCreateInput,
  });
  const facts = {
    folioId: folio.id,
    window: p.windowNumber,
    accountId: account.id,
    invoice: number,
    amountMinor: amount.toString(),
    overLimit: balance + amount > account.creditLimitMinor,
  };
  await recordAudit(tx, {
    action: 'ar.transferred',
    entityType: 'ar_invoice',
    entityId: invoice.id,
    approvalRequestId: ctx.approvalRequestId ?? undefined,
    after: facts,
  });
  await recordEvent(tx, {
    type: 'payment.captured',
    payload: { paymentId: payment.id, method: 'AR_TRANSFER', ...facts },
  });
  return invoice.id;
}

export function arTransferHandler(deps: { clock: Clock }): ApprovalActionHandler<TransferPayload> {
  return {
    action: 'ar.over_limit',
    payload: TransferPayload,
    measure: (p) => ({ amountMinor: BigInt(p.amountMinor) }),
    execute: (ctx, p) => transferIn({ ...ctx, now: deps.clock(), clock: deps.clock }, p, false),
  };
}

export async function transfer(
  deps: ArDeps,
  tenant: TenantContext,
  accountId: string,
  body: z.output<typeof ArTransferBody>,
): Promise<z.input<typeof ArTransferResult> | ApprovalPendingResult> {
  // Worked out before any approval request, so a manager is never asked for the impossible.
  const folio = await deps.tenantDb.folio.findFirst({
    where: { id: body.folioId },
    include: { windows: true },
  });
  if (!folio) throw new AppError('NOT_FOUND', 'Folio not found');
  const window = folio.windows.find((w) => w.number === body.windowNumber);
  if (!window) throw invalid('windowNumber', 'This folio has no such window');
  const owes = await deps.tenantDb.$transaction((tx) => windowOwes(tx, window.id));
  const amount = body.amountMinor ? BigInt(body.amountMinor) : owes;
  if (amount <= 0n) throw invalid('amountMinor', 'Nothing is owed on this window');
  const account = await loadAccount(deps.tenantDb, accountId);
  const on = await today(deps.tenantDb, tenant.propertyId, deps.clock);
  const over = BigInt(itemOf(account, on).balanceMinor) + amount > account.creditLimitMinor;
  const payload = {
    accountId,
    folioId: folio.id,
    windowNumber: body.windowNumber,
    amountMinor: amount.toString(),
  };
  let invoiceId: string;
  try {
    if (!over) {
      invoiceId = await deps.tenantDb.$transaction((tx) =>
        transferIn(
          { tx, tenant, approvalRequestId: null, now: deps.clock(), clock: deps.clock },
          payload,
          true,
        ),
      );
    } else {
      const result = await performOrRequest(
        { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
        tenant,
        arTransferHandler(deps),
        payload,
        body.reason,
      );
      if (isApprovalPending(result)) return result;
      invoiceId = result.resultRef;
    }
  } catch (err) {
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
  const detail = detailOf(await loadAccount(deps.tenantDb, accountId), on);
  const invoice = detail.invoices.find((i) => i.id === invoiceId);
  if (!invoice) throw new Error(`Invoice ${invoiceId} not on account ${accountId}`);
  const { invoices: _i, payments: _p, ...accountItem } = detail;
  return { invoice, account: accountItem };
}

// ── Payments and allocation ─────────────────────────────────────────────────────────────

/** Allocates a payment's unallocated money to the account's open invoices. */
async function allocateIn(
  tx: TenantTx,
  paymentId: string,
  wanted: { invoiceId: string; amountMinor: string }[] | undefined,
  now: Date,
) {
  await tx.$queryRaw`SELECT id FROM ar_payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
  const payment = await tx.arPayment.findFirst({
    where: { id: paymentId },
    include: { allocations: true },
  });
  if (!payment) throw new AppError('NOT_FOUND', 'Payment not found');
  await tx.$queryRaw`SELECT id FROM ar_accounts WHERE id = ${payment.arAccountId}::uuid FOR UPDATE`;
  let left = payment.amountMinor - allocated(payment.allocations);
  const invoices = await tx.arInvoice.findMany({
    where: { arAccountId: payment.arAccountId },
    include: { allocations: true },
    orderBy: [{ dueOn: 'asc' }, { number: 'asc' }],
  });
  const openOf = (id: string) => {
    const inv = invoices.find((i) => i.id === id);
    return inv ? inv.amountMinor - allocated(inv.allocations) : null;
  };
  const plan: { invoiceId: string; amount: bigint }[] = [];
  if (wanted) {
    const total = wanted.reduce((s, w) => s + BigInt(w.amountMinor), 0n);
    if (total > left) throw invalid('allocations', 'More than is left of the payment');
    for (const w of wanted) {
      const open = openOf(w.invoiceId);
      if (open === null) throw invalid('allocations', 'Choose invoices of this account');
      if (BigInt(w.amountMinor) > open) {
        throw invalid('allocations', 'More than is still owed on an invoice');
      }
      plan.push({ invoiceId: w.invoiceId, amount: BigInt(w.amountMinor) });
    }
  } else {
    for (const inv of invoices) {
      if (left <= 0n) break;
      const open = inv.amountMinor - allocated(inv.allocations);
      if (open <= 0n) continue;
      const take = open < left ? open : left;
      plan.push({ invoiceId: inv.id, amount: take });
      left -= take;
    }
  }
  for (const p of plan) {
    await tx.arAllocation.upsert({
      where: { arPaymentId_arInvoiceId: { arPaymentId: payment.id, arInvoiceId: p.invoiceId } },
      create: {
        arPaymentId: payment.id,
        arInvoiceId: p.invoiceId,
        amountMinor: p.amount,
        createdAt: now,
      } as unknown as Prisma.ArAllocationUncheckedCreateInput,
      update: { amountMinor: { increment: p.amount } },
    });
  }
  if (plan.length > 0) {
    await recordAudit(tx, {
      action: 'ar.allocated',
      entityType: 'ar_payment',
      entityId: payment.id,
      after: {
        allocations: plan.map((p) => ({
          invoiceId: p.invoiceId,
          amountMinor: p.amount.toString(),
        })),
      },
    });
  }
  return payment.arAccountId;
}

export async function recordPayment(
  deps: ArDeps,
  tenant: TenantContext,
  accountId: string,
  body: z.output<typeof ArPaymentBody>,
) {
  const now = deps.clock();
  const on = await today(deps.tenantDb, tenant.propertyId, deps.clock);
  if (body.receivedOn > on) throw invalid('receivedOn', 'The date cannot be in the future');
  await deps.tenantDb.$transaction(async (tx) => {
    await loadAccount(tx, accountId);
    const row = await tx.arPayment.create({
      data: {
        arAccountId: accountId,
        method: body.method,
        amountMinor: BigInt(body.amountMinor),
        reference: body.reference,
        receivedOn: dbDate(body.receivedOn),
        note: body.note,
        createdById: tenant.userId,
        createdAt: now,
      } as unknown as Prisma.ArPaymentUncheckedCreateInput,
    });
    await recordAudit(tx, {
      action: 'ar.payment_recorded',
      entityType: 'ar_payment',
      entityId: row.id,
      after: {
        accountId,
        method: body.method,
        amountMinor: body.amountMinor,
        reference: body.reference,
      },
    });
    if (body.allocate) await allocateIn(tx, row.id, undefined, now);
  });
  return detailOf(await loadAccount(deps.tenantDb, accountId), on);
}

export async function allocate(
  deps: ArDeps,
  tenant: TenantContext,
  paymentId: string,
  body: z.output<typeof ArAllocateBody>,
) {
  const accountId = await deps.tenantDb.$transaction((tx) =>
    allocateIn(tx, paymentId, body.allocations, deps.clock()),
  );
  const on = await today(deps.tenantDb, tenant.propertyId, deps.clock);
  return detailOf(await loadAccount(deps.tenantDb, accountId), on);
}

// ── Statement and ageing ────────────────────────────────────────────────────────────────

export async function statement(
  deps: ArDeps,
  tenant: TenantContext,
  accountId: string,
  range: { from: string; to: string },
): Promise<z.input<typeof ArStatement>> {
  const a = await loadAccount(deps.tenantDb, accountId);
  const on = await today(deps.tenantDb, tenant.propertyId, deps.clock);
  let opening = 0n;
  const entries: z.input<typeof ArStatement>['lines'] = [];
  const moves = [
    ...a.invoices.map((i) => ({
      date: day(i.issuedOn),
      kind: 'INVOICE' as const,
      reference: i.number,
      description: i.folio ? `Folio ${i.folio.number}, ${i.folio.name}` : 'Invoice',
      amount: i.amountMinor,
    })),
    ...a.payments.map((p) => ({
      date: day(p.receivedOn),
      kind: 'PAYMENT' as const,
      reference: p.reference ?? p.method,
      description: `Payment, ${p.method.replace('_', ' ').toLowerCase()}`,
      amount: -p.amountMinor,
    })),
  ].sort((x, y) => x.date.localeCompare(y.date) || (x.kind === 'INVOICE' ? -1 : 1));
  let running = 0n;
  for (const m of moves) {
    if (m.date < range.from) {
      opening += m.amount;
      running = opening;
      continue;
    }
    if (m.date > range.to) continue;
    running += m.amount;
    entries.push({
      date: m.date,
      kind: m.kind,
      reference: m.reference,
      description: m.description,
      amountMinor: m.amount.toString(),
      balanceMinor: running.toString(),
    });
  }
  return {
    account: itemOf(a, on),
    from: range.from,
    to: range.to,
    openingMinor: opening.toString(),
    lines: entries,
    closingMinor: running.toString(),
  };
}

export async function statementPdf(
  deps: ArDeps,
  tenant: TenantContext,
  accountId: string,
  range: { from: string; to: string },
) {
  const s = await statement(deps, tenant, accountId, range);
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
  });
  const cur = property.baseCurrency;
  const a = await loadAccount(deps.tenantDb, accountId);
  const content = await render((doc) => {
    header(doc, property, 'STATEMENT');
    facts(doc, [
      ['Account', s.account.company.name],
      ['Period', `${s.from} to ${s.to}`],
      ['Terms', `${s.account.termsDays} days`],
      ['Credit limit', money(BigInt(s.account.creditLimitMinor), cur)],
    ]);
    table(
      doc,
      [
        { title: 'Date', width: 70 },
        { title: 'Reference', width: 90 },
        { title: 'Description', width: 175 },
        { title: 'Amount', width: 80, align: 'right' },
        { title: 'Balance', width: 80, align: 'right' },
      ],
      [
        [s.from, '', 'Opening balance', '', money(BigInt(s.openingMinor), cur)],
        ...s.lines.map((l) => [
          l.date,
          l.reference,
          l.description,
          money(BigInt(l.amountMinor), cur),
          money(BigInt(l.balanceMinor), cur),
        ]),
      ],
    );
    totals(doc, [
      ['Overdue', money(BigInt(s.account.overdueMinor), cur)],
      ['Balance due', money(BigInt(s.closingMinor), cur)],
    ]);
    footer(doc, `Account ${a.company.name}. Amounts in ${cur}.`);
  });
  return { filename: `statement-${s.to}.pdf`, content, text: s };
}

export async function sendStatement(
  deps: ArDeps,
  tenant: TenantContext,
  accountId: string,
  range: { from: string; to: string },
) {
  const a = await loadAccount(deps.tenantDb, accountId);
  const billing = (a.company.billingInstructions ?? {}) as { invoiceEmail?: string | null };
  if (!billing.invoiceEmail) {
    throw stateError('Add the company’s invoice email address on its profile first');
  }
  const { text: s } = await statementPdf(deps, tenant, accountId, range);
  const property = await deps.tenantDb.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
  });
  const cur = property.baseCurrency;
  await deps.email.send({
    to: billing.invoiceEmail,
    subject: `Statement from ${property.name}, ${s.from} to ${s.to}`,
    text: [
      `Account: ${s.account.company.name}`,
      `Opening balance: ${money(BigInt(s.openingMinor), cur)}`,
      ...s.lines.map(
        (l) => `${l.date}  ${l.reference}  ${l.description}  ${money(BigInt(l.amountMinor), cur)}`,
      ),
      `Balance due: ${money(BigInt(s.closingMinor), cur)}`,
      `Of which overdue: ${money(BigInt(s.account.overdueMinor), cur)}`,
    ].join('\n'),
    tag: 'ar-statement',
  });
  const sentAt = deps.clock();
  await recordAudit(deps.tenantDb, {
    action: 'ar.statement_sent',
    entityType: 'ar_account',
    entityId: accountId,
    after: { to: billing.invoiceEmail, from: range.from, until: range.to },
  });
  return { sentTo: billing.invoiceEmail, sentAt: sentAt.toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

function bucketOf(dueOn: string, asOf: string): (typeof AGEING_BUCKETS)[number] {
  const late = Math.round(
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueOn}T00:00:00Z`)) / 86_400_000,
  );
  if (late <= 0) return 'current';
  if (late <= 30) return 'd1to30';
  if (late <= 60) return 'd31to60';
  if (late <= 90) return 'd61to90';
  return 'over90';
}

export async function ageing(
  deps: ArDeps,
  tenant: TenantContext,
  asOfQuery?: string,
): Promise<z.input<typeof ArAgeing>> {
  const asOf = asOfQuery ?? (await today(deps.tenantDb, tenant.propertyId, deps.clock));
  const rows = await deps.tenantDb.arAccount.findMany({
    include: ACCOUNT_INCLUDE,
    orderBy: { company: { name: 'asc' } },
  });
  const zero = () =>
    Object.fromEntries(AGEING_BUCKETS.map((b) => [b, 0n])) as Record<
      (typeof AGEING_BUCKETS)[number],
      bigint
    >;
  const totals = zero();
  const accounts: z.input<typeof ArAgeing>['accounts'] = [];
  for (const a of rows) {
    const b = zero();
    for (const inv of a.invoices) {
      if (day(inv.issuedOn) > asOf) continue;
      const paidBy = inv.allocations
        .filter((x) => day(x.createdAt) <= asOf)
        .reduce((s, x) => s + x.amountMinor, 0n);
      const open = inv.amountMinor - paidBy;
      if (open <= 0n) continue;
      b[bucketOf(day(inv.dueOn), asOf)] += open;
    }
    const total = AGEING_BUCKETS.reduce((s, k) => s + b[k], 0n);
    if (total === 0n) continue;
    for (const k of AGEING_BUCKETS) totals[k] += b[k];
    accounts.push({
      accountId: a.id,
      company: a.company.name,
      buckets: Object.fromEntries(AGEING_BUCKETS.map((k) => [k, b[k].toString()])) as never,
      totalMinor: total.toString(),
    });
  }
  return {
    asOf,
    totals: {
      ...(Object.fromEntries(AGEING_BUCKETS.map((k) => [k, totals[k].toString()])) as Record<
        (typeof AGEING_BUCKETS)[number],
        string
      >),
      totalMinor: AGEING_BUCKETS.reduce((s, k) => s + totals[k], 0n).toString(),
    },
    accounts,
  };
}
