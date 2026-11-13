import { createHash, randomUUID } from 'node:crypto';
import {
  addDays,
  localDate,
  RECON_AR_METHODS,
  RECON_PAY_METHODS,
  type BookEntryItem,
  type StatementImportBody,
  type StatementLineItem,
  type StatementLineMatchBody,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { TenantContext } from '../../core/tenancy.ts';

// Bank reconciliation (PRD M4-23; S37; T-128). Finance imports a statement's lines; each line is
// then matched to the payments in the books that it is (a guest's transfer, a refund, one day's
// POS or card takings settled together, a company's receipt on the city ledger), with any
// difference given a reason, or explained by a reason alone (an expense, bank charges, a cash
// lodgement). A payment is matched to one line only. Auto-match only matches where one answer
// fits; anything doubtful is left for finance.

export interface ReconDeps {
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;
type Entry = z.input<typeof BookEntryItem>;
type LineOut = z.input<typeof StatementLineItem>;

const day = (d: Date) => d.toISOString().slice(0, 10);
const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

/** Single payments the bank shows one for one; POS and card takings settle as a day's batch. */
const ONE_FOR_ONE = new Set(['BANK_TRANSFER', 'VIRTUAL_ACCOUNT', 'MOBILE_MONEY', 'CHEQUE']);
const BATCHED = new Set(['POS_TERMINAL', 'CARD_ONLINE']);

const PAYMENT_SELECT = {
  id: true,
  method: true,
  baseAmountMinor: true,
  businessDate: true,
  externalRef: true,
  folio: { select: { name: true } },
  reservation: { select: { confirmationNo: true } },
} satisfies Prisma.PaymentSelect;
const AR_PAYMENT_SELECT = {
  id: true,
  method: true,
  amountMinor: true,
  receivedOn: true,
  reference: true,
  account: { select: { company: { select: { name: true } } } },
} satisfies Prisma.ArPaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;
type ArPaymentRow = Prisma.ArPaymentGetPayload<{ select: typeof AR_PAYMENT_SELECT }>;

function entryOfPayment(p: PaymentRow): Entry {
  return {
    kind: 'PAYMENT',
    id: p.id,
    date: day(p.businessDate),
    method: p.method,
    amountMinor: p.baseAmountMinor.toString(),
    reference: p.externalRef,
    payer: p.folio?.name ?? p.reservation?.confirmationNo ?? '',
  };
}

function entryOfArPayment(p: ArPaymentRow): Entry {
  return {
    kind: 'AR_PAYMENT',
    id: p.id,
    date: day(p.receivedOn),
    method: p.method,
    amountMinor: p.amountMinor.toString(),
    reference: p.reference,
    payer: p.account.company.name,
  };
}

const LINE_INCLUDE = {
  matches: {
    include: {
      payment: { select: PAYMENT_SELECT },
      arPayment: { select: AR_PAYMENT_SELECT },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.BankStatementLineInclude;
type LineRow = Prisma.BankStatementLineGetPayload<{ include: typeof LINE_INCLUDE }>;

function lineItem(l: LineRow): LineOut {
  return {
    id: l.id,
    importId: l.importId,
    bankAccount: l.bankAccount,
    postedOn: day(l.postedOn),
    description: l.description,
    reference: l.reference,
    amountMinor: l.amountMinor.toString(),
    balanceMinor: l.balanceMinor === null ? null : l.balanceMinor.toString(),
    status: l.status as LineOut['status'],
    matches: l.matches.map((m) => ({
      id: m.id,
      kind: m.kind as LineOut['matches'][number]['kind'],
      amountMinor: m.amountMinor.toString(),
      auto: m.auto,
      note: m.note,
      entry: m.payment
        ? entryOfPayment(m.payment)
        : m.arPayment
          ? entryOfArPayment(m.arPayment)
          : null,
    })),
  };
}

async function hotelToday(db: Client, propertyId: string, clock: Clock) {
  const p = await db.property.findUniqueOrThrow({ where: { id: propertyId } });
  return localDate(clock(), p.timeZone);
}

/** Payments in the books, not yet matched, dated in the period. */
async function bookEntries(db: Client, from: string, to: string) {
  const range = { gte: dbDate(from), lte: dbDate(to) };
  const [payments, arPayments] = await Promise.all([
    db.payment.findMany({
      where: {
        method: { in: [...RECON_PAY_METHODS] },
        businessDate: range,
        reconciliation: null,
      },
      select: PAYMENT_SELECT,
      orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }],
    }),
    db.arPayment.findMany({
      where: {
        method: { in: [...RECON_AR_METHODS] },
        receivedOn: range,
        reconciliation: null,
      },
      select: AR_PAYMENT_SELECT,
      orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);
  return [...payments.map(entryOfPayment), ...arPayments.map(entryOfArPayment)].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}

export async function listEntries(deps: ReconDeps, q: { from: string; to: string }) {
  const data = await bookEntries(deps.tenantDb, q.from, q.to);
  const total = data.reduce((s, e) => s + BigInt(e.amountMinor), 0n);
  return { data, totalMinor: total.toString() };
}

export async function listLines(
  deps: ReconDeps,
  q: { from: string; to: string; status?: LineOut['status']; bankAccount?: string },
) {
  const where = {
    postedOn: { gte: dbDate(q.from), lte: dbDate(q.to) },
    ...(q.bankAccount ? { bankAccount: q.bankAccount } : {}),
  };
  const [rows, accounts] = await Promise.all([
    deps.tenantDb.bankStatementLine.findMany({
      where: { ...where, ...(q.status ? { status: q.status } : {}) },
      include: LINE_INCLUDE,
      orderBy: [{ postedOn: 'asc' }, { importedAt: 'asc' }, { id: 'asc' }],
      take: 5000,
    }),
    deps.tenantDb.bankStatementLine.findMany({
      distinct: ['bankAccount'],
      select: { bankAccount: true },
      orderBy: { bankAccount: 'asc' },
    }),
  ]);
  let moneyIn = 0n;
  let moneyOut = 0n;
  let unmatched = 0n;
  let unmatchedCount = 0;
  for (const r of rows) {
    if (r.amountMinor > 0n) moneyIn += r.amountMinor;
    else moneyOut -= r.amountMinor;
    if (r.status === 'UNMATCHED') {
      unmatched += r.amountMinor;
      unmatchedCount += 1;
    }
  }
  return {
    data: rows.map(lineItem),
    summary: {
      moneyInMinor: moneyIn.toString(),
      moneyOutMinor: moneyOut.toString(),
      unmatchedCount,
      unmatchedMinor: unmatched.toString(),
    },
    bankAccounts: accounts.map((a) => a.bankAccount),
  };
}

// ── Import ─────────────────────────────────────────────────────────────────────────────

/** Same account, date, amount, reference and narration: the nth such line in a file is one line. */
function fingerprints(bankAccount: string, lines: z.output<typeof StatementImportBody>['lines']) {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const key = [
      bankAccount.toLowerCase(),
      l.postedOn,
      BigInt(l.amountMinor).toString(),
      (l.reference ?? '').toLowerCase(),
      l.description.toLowerCase(),
    ].join('|');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return createHash('sha256').update(`${key}|${n}`).digest('hex');
  });
}

export async function importStatement(
  deps: ReconDeps,
  tenant: TenantContext,
  body: z.output<typeof StatementImportBody>,
) {
  const today = await hotelToday(deps.tenantDb, tenant.propertyId, deps.clock);
  const late = body.lines.findIndex((l) => l.postedOn > today);
  if (late >= 0) throw invalid(`lines.${late}.postedOn`, 'A statement line cannot be dated ahead');
  const now = deps.clock();
  const importId = randomUUID();
  const prints = fingerprints(body.bankAccount, body.lines);
  return deps.tenantDb.$transaction(async (tx) => {
    const { count } = await tx.bankStatementLine.createMany({
      data: body.lines.map(
        (l, i) =>
          ({
            importId,
            bankAccount: body.bankAccount,
            fileName: body.fileName,
            postedOn: dbDate(l.postedOn),
            description: l.description,
            reference: l.reference,
            amountMinor: BigInt(l.amountMinor),
            balanceMinor: l.balanceMinor === null ? null : BigInt(l.balanceMinor),
            fingerprint: prints[i] as string,
            importedById: tenant.userId,
            importedAt: now,
          }) as unknown as Prisma.BankStatementLineCreateManyInput,
      ),
      skipDuplicates: true,
    });
    await recordAudit(tx, {
      action: 'recon.statement_imported',
      entityType: 'bank_statement',
      entityId: importId,
      after: {
        bankAccount: body.bankAccount,
        fileName: body.fileName,
        lines: body.lines.length,
        imported: count,
      },
    });
    const autoMatched = await autoMatchIn(tx, tenant, now);
    return { importId, imported: count, skipped: body.lines.length - count, autoMatched };
  });
}

// ── Auto-match ─────────────────────────────────────────────────────────────────────────

interface Candidate extends Entry {
  amount: bigint;
}

const refsIn = (line: { description: string; reference: string | null }) =>
  `${line.reference ?? ''} ${line.description}`.toLowerCase();

async function autoMatchIn(tx: Tx, tenant: TenantContext, now: Date): Promise<number> {
  await tx.$queryRaw`SELECT id FROM bank_statement_lines
    WHERE property_id = ${tenant.propertyId}::uuid AND status = 'UNMATCHED' FOR UPDATE`;
  const lines = await tx.bankStatementLine.findMany({
    where: { status: 'UNMATCHED' },
    orderBy: [{ postedOn: 'asc' }, { importedAt: 'asc' }, { id: 'asc' }],
  });
  if (lines.length === 0) return 0;
  const first = day(lines[0]?.postedOn as Date);
  const last = day(lines[lines.length - 1]?.postedOn as Date);
  const free: Candidate[] = (await bookEntries(tx, addDays(first, -3), addDays(last, 1))).map(
    (e) => ({ ...e, amount: BigInt(e.amountMinor) }),
  );
  const used = new Set<string>();
  const done = new Set<string>();
  let matched = 0;
  // Passes until nothing more matches: a line settled by its reference can leave another line
  // with only one payment to fit.
  for (let progress = true; progress;) {
    progress = false;
    for (const line of lines) {
      if (done.has(line.id)) continue;
      const on = day(line.postedOn);
      const open = free.filter((c) => !used.has(c.id));
      let pick: Candidate[] = [];
      // One for one: same amount, from three days before the line to one day after.
      const single = open.filter(
        (c) =>
          ONE_FOR_ONE.has(c.method) &&
          c.amount === line.amountMinor &&
          c.date >= addDays(on, -3) &&
          c.date <= addDays(on, 1),
      );
      const text = refsIn(line);
      const byRef = single.filter(
        (c) => c.reference && c.reference.length >= 4 && text.includes(c.reference.toLowerCase()),
      );
      if (byRef.length === 1) pick = byRef;
      else if (byRef.length === 0 && single.length === 1) pick = single;
      // A day's POS or card takings settled together, for money in.
      if (pick.length === 0 && line.amountMinor > 0n) {
        const batches = new Map<string, Candidate[]>();
        for (const c of open) {
          if (c.kind !== 'PAYMENT' || !BATCHED.has(c.method)) continue;
          if (c.date < addDays(on, -3) || c.date > on) continue;
          const key = `${c.method}|${c.date}`;
          batches.set(key, [...(batches.get(key) ?? []), c]);
        }
        const fits = [...batches.values()].filter(
          (b) => b.reduce((s, c) => s + c.amount, 0n) === line.amountMinor,
        );
        if (fits.length === 1) pick = fits[0] ?? [];
      }
      if (pick.length === 0) continue;
      for (const c of pick) used.add(c.id);
      await tx.reconciliationMatch.createMany({
        data: pick.map(
          (c) =>
            ({
              statementLineId: line.id,
              kind: c.kind,
              paymentId: c.kind === 'PAYMENT' ? c.id : null,
              arPaymentId: c.kind === 'AR_PAYMENT' ? c.id : null,
              amountMinor: c.amount,
              auto: true,
              createdById: tenant.userId,
              createdAt: now,
            }) as unknown as Prisma.ReconciliationMatchCreateManyInput,
        ),
      });
      await tx.bankStatementLine.update({ where: { id: line.id }, data: { status: 'MATCHED' } });
      await recordAudit(tx, {
        action: 'recon.line_matched',
        entityType: 'bank_statement_line',
        entityId: line.id,
        after: { auto: true, entries: pick.map((c) => ({ kind: c.kind, id: c.id })) },
      });
      done.add(line.id);
      matched += 1;
      progress = true;
    }
  }
  return matched;
}

export async function autoMatch(deps: ReconDeps, tenant: TenantContext) {
  const now = deps.clock();
  const matched = await deps.tenantDb.$transaction((tx) => autoMatchIn(tx, tenant, now));
  return { matched };
}

// ── Matching by hand ───────────────────────────────────────────────────────────────────

async function lockLine(tx: Tx, tenant: TenantContext, lineId: string) {
  await tx.$queryRaw`SELECT id FROM bank_statement_lines
    WHERE id = ${lineId}::uuid AND property_id = ${tenant.propertyId}::uuid FOR UPDATE`;
  const line = await tx.bankStatementLine.findUnique({ where: { id: lineId } });
  if (!line) throw new AppError('NOT_FOUND', 'Statement line not found');
  return line;
}

const loadLine = async (tx: Tx, id: string) =>
  lineItem(await tx.bankStatementLine.findUniqueOrThrow({ where: { id }, include: LINE_INCLUDE }));

const alreadyMatched = () =>
  new AppError('STATE_TRANSITION_INVALID', 'This line is already matched; undo the match first');
const taken = (ids: string[]) =>
  new AppError('STATE_TRANSITION_INVALID', 'A payment chosen is already matched to a line', {
    matched: ids,
  });

export async function match(
  deps: ReconDeps,
  tenant: TenantContext,
  lineId: string,
  body: z.output<typeof StatementLineMatchBody>,
) {
  const now = deps.clock();
  const paymentIds = [...new Set(body.paymentIds)];
  const arPaymentIds = [...new Set(body.arPaymentIds)];
  try {
    return await deps.tenantDb.$transaction(async (tx) => {
      const line = await lockLine(tx, tenant, lineId);
      if (line.status !== 'UNMATCHED') throw alreadyMatched();
      const [payments, arPayments] = await Promise.all([
        tx.payment.findMany({
          where: { id: { in: paymentIds } },
          select: { ...PAYMENT_SELECT, reconciliation: { select: { id: true } } },
        }),
        tx.arPayment.findMany({
          where: { id: { in: arPaymentIds } },
          select: { ...AR_PAYMENT_SELECT, reconciliation: { select: { id: true } } },
        }),
      ]);
      if (payments.length !== paymentIds.length || arPayments.length !== arPaymentIds.length) {
        throw new AppError('NOT_FOUND', 'Payment not found');
      }
      const payMethods: readonly string[] = RECON_PAY_METHODS;
      const arMethods: readonly string[] = RECON_AR_METHODS;
      if (
        payments.some((p) => !payMethods.includes(p.method)) ||
        arPayments.some((p) => !arMethods.includes(p.method))
      ) {
        throw invalid('paymentIds', 'Cash, vouchers and ledger transfers never reach the bank');
      }
      const already = [...payments, ...arPayments].filter((p) => p.reconciliation).map((p) => p.id);
      if (already.length > 0) throw taken(already);
      const total =
        payments.reduce((s, p) => s + p.baseAmountMinor, 0n) +
        arPayments.reduce((s, p) => s + p.amountMinor, 0n);
      if (total === 0n || total > 0n !== line.amountMinor > 0n) {
        throw invalid('paymentIds', 'Money in matches payments received; money out, refunds');
      }
      const difference = line.amountMinor - total;
      if (difference !== 0n && !body.differenceNote) {
        throw invalid('differenceNote', 'Say why the payments differ from the line');
      }
      const base = { statementLineId: line.id, createdById: tenant.userId, createdAt: now };
      await tx.reconciliationMatch.createMany({
        data: [
          ...payments.map((p) => ({
            ...base,
            kind: 'PAYMENT',
            paymentId: p.id,
            amountMinor: p.baseAmountMinor,
          })),
          ...arPayments.map((p) => ({
            ...base,
            kind: 'AR_PAYMENT',
            arPaymentId: p.id,
            amountMinor: p.amountMinor,
          })),
          ...(difference === 0n
            ? []
            : [
                { ...base, kind: 'DIFFERENCE', amountMinor: difference, note: body.differenceNote },
              ]),
        ] as unknown as Prisma.ReconciliationMatchCreateManyInput[],
      });
      await tx.bankStatementLine.update({ where: { id: line.id }, data: { status: 'MATCHED' } });
      await recordAudit(tx, {
        action: 'recon.line_matched',
        entityType: 'bank_statement_line',
        entityId: line.id,
        after: {
          auto: false,
          paymentIds,
          arPaymentIds,
          differenceMinor: difference.toString(),
          differenceNote: difference === 0n ? null : body.differenceNote,
        },
      });
      return loadLine(tx, line.id);
    });
  } catch (err) {
    // Two people matching the same payment at once: the unique key answers for the second.
    if ((err as { code?: string }).code === 'P2002') throw taken([...paymentIds, ...arPaymentIds]);
    throw err;
  }
}

export async function explain(
  deps: ReconDeps,
  tenant: TenantContext,
  lineId: string,
  note: string,
) {
  const now = deps.clock();
  return deps.tenantDb.$transaction(async (tx) => {
    const line = await lockLine(tx, tenant, lineId);
    if (line.status !== 'UNMATCHED') throw alreadyMatched();
    await tx.reconciliationMatch.create({
      data: {
        statementLineId: line.id,
        kind: 'EXPLAINED',
        amountMinor: line.amountMinor,
        note,
        createdById: tenant.userId,
        createdAt: now,
      } as unknown as Prisma.ReconciliationMatchUncheckedCreateInput,
    });
    await tx.bankStatementLine.update({ where: { id: line.id }, data: { status: 'MATCHED' } });
    await recordAudit(tx, {
      action: 'recon.line_explained',
      entityType: 'bank_statement_line',
      entityId: line.id,
      after: { note, amountMinor: line.amountMinor.toString() },
    });
    return loadLine(tx, line.id);
  });
}

export async function unmatch(
  deps: ReconDeps,
  tenant: TenantContext,
  lineId: string,
  reason: string,
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const line = await lockLine(tx, tenant, lineId);
    if (line.status !== 'MATCHED') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This line is not matched');
    }
    const before = await tx.reconciliationMatch.findMany({ where: { statementLineId: line.id } });
    await tx.reconciliationMatch.deleteMany({ where: { statementLineId: line.id } });
    await tx.bankStatementLine.update({ where: { id: line.id }, data: { status: 'UNMATCHED' } });
    await recordAudit(tx, {
      action: 'recon.line_unmatched',
      entityType: 'bank_statement_line',
      entityId: line.id,
      before: {
        matches: before.map((m) => ({
          kind: m.kind,
          paymentId: m.paymentId,
          arPaymentId: m.arPaymentId,
          amountMinor: m.amountMinor.toString(),
          auto: m.auto,
          note: m.note,
        })),
      },
      after: { reason },
    });
    return loadLine(tx, line.id);
  });
}
