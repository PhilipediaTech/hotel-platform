import { createHash } from 'node:crypto';
import {
  ACCOUNTING_CONTROLS,
  ACCOUNTING_PAY_METHODS,
  type AccountingExportDetail,
  type AccountingMappingRow,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import type { Clock } from '../../core/clock.ts';
import { COUNTER, nextPropertyCounter } from '../../core/counters.ts';
import { AppError } from '../../core/errors.ts';
import { csv, decimal, exportFile } from '../../core/exports.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Accounting exports (PRD M10-07; Strategy decision 9: a general journal CSV; T-148). One
// journal per closed business day, built from the PMS's own records so that every source
// posts both sides and each day balances (checked before anything is kept):
//   folio line            Dr guest ledger        Cr its revenue code (taxes and fees too)
//     deposit applied     Dr advance deposits    Cr guest ledger      (system code DEPOSIT)
//     folio transfer      guest ledger on both sides                  (system code TRANSFER)
//   payment on a folio    Dr its method          Cr guest ledger
//   payment off a folio   Dr its method          Cr advance deposits  (deposits)
//   city-ledger transfer  Dr city ledger         Cr guest ledger      (method AR_TRANSFER)
//   city-ledger receipt   Dr its method          Cr city ledger
//   expense               Dr its category        Cr the method it was paid from
// Refunds and reversals are the same postings with negative amounts. Voided expenses are left
// out. Amounts are in the base currency (payments by their base amount).

export interface AccountingDeps {
  tenantDb: TenantDb;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = TenantDb | Tx;
type Kind = z.infer<typeof AccountingMappingRow>['kind'];
type Control = (typeof ACCOUNTING_CONTROLS)[number];

const invalid = (path: string, message: string, extra: object = {}) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path, code: 'custom', message }],
    ...extra,
  });

const METHOD_LABEL: Record<(typeof ACCOUNTING_PAY_METHODS)[number], string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  POS_TERMINAL: 'POS terminal',
  CARD_ONLINE: 'Card online',
  VIRTUAL_ACCOUNT: 'Virtual account',
  MOBILE_MONEY: 'Mobile money',
  VOUCHER: 'Voucher',
  CHEQUE: 'Cheque',
  CARD: 'Card (expenses)',
  PETTY_CASH: 'Petty cash',
  COMMISSION_OFFSET: 'Commission set off',
};
const CONTROL_LABEL: Record<Control, string> = {
  GUEST_LEDGER: 'Guest ledger (folios receivable)',
  ADVANCE_DEPOSITS: 'Advance deposits (liability)',
  CITY_LEDGER: 'City ledger (accounts receivable)',
};
/** System codes that move money between ledgers: they post to control accounts. */
const LEDGER_CODES: Record<string, Control> = {
  DEPOSIT: 'ADVANCE_DEPOSITS',
  TRANSFER: 'GUEST_LEDGER',
};

const keyOf = (kind: Kind, key: string) => `${kind}:${key}`;
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

// ---------------------------------------------------------------------------------------
// Mappings

interface Target {
  kind: Kind;
  key: string;
  label: string;
}

/** Everything the journal can post to at this property, labelled. */
async function targets(db: Client): Promise<Target[]> {
  const [codes, categories] = await Promise.all([
    db.revenueCode.findMany({ orderBy: { code: 'asc' } }),
    db.expenseCategory.findMany({ orderBy: { code: 'asc' } }),
  ]);
  return [
    ...ACCOUNTING_CONTROLS.map((key) => ({
      kind: 'CONTROL' as const,
      key,
      label: CONTROL_LABEL[key],
    })),
    ...codes
      .filter((c) => !(c.code in LEDGER_CODES))
      .map((c) => ({ kind: 'REVENUE_CODE' as const, key: c.id, label: `${c.code} · ${c.name}` })),
    ...ACCOUNTING_PAY_METHODS.map((key) => ({
      kind: 'PAY_METHOD' as const,
      key,
      label: METHOD_LABEL[key],
    })),
    ...categories.map((c) => ({
      kind: 'EXPENSE_CATEGORY' as const,
      key: c.id,
      label: `${c.code} · ${c.name}`,
    })),
  ];
}

async function mappingRows(db: Client): Promise<z.input<typeof AccountingMappingRow>[]> {
  const [all, saved] = await Promise.all([targets(db), db.accountingMapping.findMany()]);
  const byKey = new Map(saved.map((m) => [keyOf(m.kind, m.key), m]));
  return all.map((t) => {
    const m = byKey.get(keyOf(t.kind, t.key));
    return { ...t, accountCode: m?.accountCode ?? null, accountName: m?.accountName ?? null };
  });
}

export async function getAccountingMappings(deps: AccountingDeps) {
  return { data: await mappingRows(deps.tenantDb) };
}

export async function updateAccountingMappings(
  deps: AccountingDeps,
  tenant: TenantContext,
  body: {
    mappings: {
      kind: Kind;
      key: string;
      accountCode: string | null;
      accountName?: string | null | undefined;
    }[];
  },
) {
  return deps.tenantDb.$transaction(async (tx) => {
    const known = new Set((await targets(tx)).map((t) => keyOf(t.kind, t.key)));
    for (const [i, m] of body.mappings.entries()) {
      if (!known.has(keyOf(m.kind, m.key))) {
        throw invalid(`body.mappings.${i}.key`, 'Not something the journal posts to here');
      }
      const where = { kind: m.kind, key: m.key };
      const existing = await tx.accountingMapping.findFirst({ where });
      if (m.accountCode === null) {
        if (existing) await tx.accountingMapping.delete({ where: { id: existing.id } });
      } else if (existing) {
        await tx.accountingMapping.update({
          where: { id: existing.id },
          data: { accountCode: m.accountCode, accountName: m.accountName ?? null },
        });
      } else {
        await tx.accountingMapping.create({
          data: {
            ...where,
            accountCode: m.accountCode,
            accountName: m.accountName ?? null,
          } as unknown as Prisma.AccountingMappingUncheckedCreateInput,
        });
      }
    }
    await recordAudit(tx, {
      action: 'accounting.mappings_updated',
      entityType: 'property',
      entityId: tenant.propertyId,
      after: { mappings: body.mappings },
    });
    return { data: await mappingRows(tx) };
  });
}

// ---------------------------------------------------------------------------------------
// The journal

interface Posting {
  date: string;
  kind: Kind;
  key: string;
  description: string;
  /** Signed: positive is a debit, negative a credit. */
  amount: bigint;
}

/** Every posting of the period, before mapping to account codes. */
async function postings(
  db: Client,
  propertyId: string,
  from: string,
  to: string,
): Promise<Posting[]> {
  const range = { gte: asDate(from), lte: asDate(to) };
  const [lines, payments, arPayments, expenses, property] = await Promise.all([
    db.folioLine.findMany({
      where: { businessDate: range },
      select: {
        businessDate: true,
        amountMinor: true,
        currency: true,
        revenueCode: { select: { id: true, code: true, name: true } },
      },
    }),
    db.payment.findMany({
      where: { businessDate: range },
      select: { businessDate: true, method: true, baseAmountMinor: true, folioId: true },
    }),
    db.arPayment.findMany({
      where: { receivedOn: range },
      select: { receivedOn: true, method: true, amountMinor: true },
    }),
    db.expense.findMany({
      where: { spentOn: range, voidedAt: null },
      select: {
        spentOn: true,
        amountMinor: true,
        paidFrom: true,
        category: { select: { id: true, name: true } },
      },
    }),
    db.property.findUniqueOrThrow({ where: { id: propertyId }, select: { baseCurrency: true } }),
  ]);
  const out: Posting[] = [];
  const post = (p: Posting) => out.push(p);

  for (const l of lines) {
    if (l.currency !== property.baseCurrency) {
      // Folios are kept in the base currency; anything else is a data error to look at.
      throw new AppError('STATE_TRANSITION_INVALID', 'A folio line is not in the base currency', {
        currency: l.currency,
      });
    }
    const date = dateOnly(l.businessDate);
    const charged: bigint = l.amountMinor;
    const control: Control | undefined = LEDGER_CODES[l.revenueCode.code];
    post({
      date,
      kind: 'CONTROL',
      key: 'GUEST_LEDGER',
      description: 'Guest ledger: charges',
      amount: charged,
    });
    if (control === 'ADVANCE_DEPOSITS') {
      post({
        date,
        kind: 'CONTROL',
        key: control,
        description: 'Advance deposits applied',
        amount: -charged,
      });
    } else if (control === 'GUEST_LEDGER') {
      post({
        date,
        kind: 'CONTROL',
        key: control,
        description: 'Guest ledger: charges',
        amount: -charged,
      });
    } else {
      post({
        date,
        kind: 'REVENUE_CODE',
        key: l.revenueCode.id,
        description: `${l.revenueCode.code} ${l.revenueCode.name}`,
        amount: -charged,
      });
    }
  }
  for (const p of payments) {
    const date = dateOnly(p.businessDate);
    const amount = p.baseAmountMinor;
    if (p.method === 'AR_TRANSFER') {
      post({
        date,
        kind: 'CONTROL',
        key: 'CITY_LEDGER',
        description: 'City ledger: transfers from folios',
        amount,
      });
    } else {
      post({
        date,
        kind: 'PAY_METHOD',
        key: p.method,
        description: `Payments: ${METHOD_LABEL[p.method]}`,
        amount,
      });
    }
    if (p.folioId) {
      post({
        date,
        kind: 'CONTROL',
        key: 'GUEST_LEDGER',
        description: 'Guest ledger: payments',
        amount: -amount,
      });
    } else {
      post({
        date,
        kind: 'CONTROL',
        key: 'ADVANCE_DEPOSITS',
        description: 'Advance deposits received',
        amount: -amount,
      });
    }
  }
  for (const p of arPayments) {
    const date = dateOnly(p.receivedOn);
    const method = p.method as (typeof ACCOUNTING_PAY_METHODS)[number];
    post({
      date,
      kind: 'PAY_METHOD',
      key: method,
      description: `City ledger receipts: ${METHOD_LABEL[method] ?? method}`,
      amount: p.amountMinor,
    });
    post({
      date,
      kind: 'CONTROL',
      key: 'CITY_LEDGER',
      description: 'City ledger: receipts',
      amount: -p.amountMinor,
    });
  }
  for (const e of expenses) {
    const date = dateOnly(e.spentOn);
    post({
      date,
      kind: 'EXPENSE_CATEGORY',
      key: e.category.id,
      description: `Expenses: ${e.category.name}`,
      amount: e.amountMinor,
    });
    post({
      date,
      kind: 'PAY_METHOD',
      key: e.paidFrom,
      description: `Expenses paid: ${METHOD_LABEL[e.paidFrom]}`,
      amount: -e.amountMinor,
    });
  }
  return out;
}

interface Line {
  date: string;
  kind: Kind;
  key: string;
  description: string;
  amount: bigint;
}

/** Postings summed per day, account and description; zero lines dropped. */
function summarise(all: Posting[]): Line[] {
  const sums = new Map<string, Line>();
  for (const p of all) {
    const k = `${p.date}|${p.kind}|${p.key}|${p.description}`;
    const line = sums.get(k) ?? { ...p, amount: 0n };
    line.amount += p.amount;
    sums.set(k, line);
  }
  return [...sums.values()]
    .filter((l) => l.amount !== 0n)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        // Debits first, then credits, each by description.
        Number(b.amount > 0n) - Number(a.amount > 0n) ||
        a.description.localeCompare(b.description),
    );
}

const HEADER = [
  'Journal',
  'Date',
  'Account code',
  'Account name',
  'Description',
  'Debit',
  'Credit',
  'Reference',
] as const;

/** Parses the CSV this module writes (RFC 4180, no BOM). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') continue;
    else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  return rows;
}

const toMinor = (major: string) => {
  if (!major) return '0';
  const [whole = '0', frac = ''] = major.split('.');
  return (BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'))).toString();
};

// ---------------------------------------------------------------------------------------
// Exports

const EXPORT_INCLUDE = {
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.AccountingExportInclude;
type ExportRow = Prisma.AccountingExportGetPayload<{ include: typeof EXPORT_INCLUDE }>;

function summary(e: ExportRow) {
  return {
    id: e.id,
    number: e.number,
    from: dateOnly(e.fromDate),
    to: dateOnly(e.toDate),
    journalCount: e.journalCount,
    lineCount: e.lineCount,
    debitTotalMinor: e.debitTotalMinor.toString(),
    sha256: e.sha256,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
  };
}

function detail(e: ExportRow): z.input<typeof AccountingExportDetail> {
  const [, ...rows] = parseCsv(e.content);
  return {
    ...summary(e),
    lines: rows.map(
      ([
        journal = '',
        date = '',
        accountCode = '',
        accountName = '',
        description = '',
        debit = '',
        credit = '',
      ]) => ({
        journal,
        date,
        accountCode,
        accountName,
        description,
        debitMinor: toMinor(debit),
        creditMinor: toMinor(credit),
      }),
    ),
  };
}

/** The last day the night audit has closed: the one before the current business date. */
async function lastClosedDay(deps: AccountingDeps, tenant: TenantContext) {
  const today = await businessDate(deps.tenantDb, tenant.propertyId, deps.clock);
  const d = asDate(today);
  d.setUTCDate(d.getUTCDate() - 1);
  return dateOnly(d);
}

export async function listAccountingExports(deps: AccountingDeps, tenant: TenantContext) {
  const rows = await deps.tenantDb.accountingExport.findMany({
    include: EXPORT_INCLUDE,
    orderBy: { number: 'desc' },
    take: 100,
  });
  return { data: rows.map(summary), lastClosedDay: await lastClosedDay(deps, tenant) };
}

const MAX_DAYS = 93;
const BOM_AT_START = new RegExp(`^${String.fromCharCode(0xfeff)}`);

export async function createAccountingExport(
  deps: AccountingDeps,
  tenant: TenantContext,
  body: { from: string; to: string },
) {
  const days = (asDate(body.to).getTime() - asDate(body.from).getTime()) / 86_400_000 + 1;
  if (days > MAX_DAYS) throw invalid('body.to', `At most ${MAX_DAYS} days in one export`);
  const closed = await lastClosedDay(deps, tenant);
  if (body.to > closed) {
    throw invalid('body.to', `Only closed business days can be exported: up to ${closed}`);
  }
  return deps.tenantDb.$transaction(async (tx) => {
    const [lines, mappings, property] = await Promise.all([
      postings(tx, tenant.propertyId, body.from, body.to).then(summarise),
      tx.accountingMapping.findMany(),
      tx.property.findUniqueOrThrow({ where: { id: tenant.propertyId }, select: { code: true } }),
    ]);
    const account = new Map(mappings.map((m) => [keyOf(m.kind, m.key), m]));
    // Everything used in the period needs an account code before anything is exported.
    const labels = new Map((await targets(tx)).map((t) => [keyOf(t.kind, t.key), t.label]));
    const missing = [
      ...new Map(
        lines
          .filter((l) => !account.has(keyOf(l.kind, l.key)))
          .map((l) => [
            keyOf(l.kind, l.key),
            { kind: l.kind, key: l.key, label: labels.get(keyOf(l.kind, l.key)) ?? l.key },
          ]),
      ).values(),
    ];
    if (missing.length > 0) {
      throw invalid(
        'body',
        `Give an account code to ${missing.length === 1 ? '1 item' : `${missing.length} items`} first`,
        { missing },
      );
    }
    // Each day's journal balances: debits equal credits (a bug otherwise, never exported).
    const byDay = new Map<string, bigint>();
    for (const l of lines) byDay.set(l.date, (byDay.get(l.date) ?? 0n) + l.amount);
    for (const [date, net] of byDay) {
      if (net !== 0n) throw new Error(`Accounting journal for ${date} is out by ${net}`);
    }
    const debitTotal = lines.reduce((s, l) => (l.amount > 0n ? s + l.amount : s), 0n);
    const rows = [
      [...HEADER],
      ...lines.map((l) => {
        const m = account.get(keyOf(l.kind, l.key));
        return [
          `J-${l.date}`,
          l.date,
          m?.accountCode ?? '',
          m?.accountName ?? labels.get(keyOf(l.kind, l.key)) ?? '',
          l.description,
          l.amount > 0n ? decimal(l.amount) : '',
          l.amount < 0n ? decimal(-l.amount) : '',
          `PMS ${property.code} ${l.date}`,
        ];
      }),
    ];
    const content = new TextDecoder().decode(csv(rows)).replace(BOM_AT_START, '');
    const number = await nextPropertyCounter(tx, tenant.propertyId, COUNTER.ACCOUNTING_EXPORT);
    const created = await tx.accountingExport.create({
      data: {
        number,
        fromDate: asDate(body.from),
        toDate: asDate(body.to),
        journalCount: byDay.size,
        lineCount: lines.length,
        debitTotalMinor: debitTotal,
        content,
        sha256: createHash('sha256').update(content).digest('hex'),
        createdById: tenant.userId,
      } as unknown as Prisma.AccountingExportUncheckedCreateInput,
      include: EXPORT_INCLUDE,
    });
    await recordAudit(tx, {
      action: 'accounting.exported',
      entityType: 'accounting_export',
      entityId: created.id,
      after: {
        number,
        from: body.from,
        to: body.to,
        lines: lines.length,
        debitTotalMinor: debitTotal.toString(),
        sha256: created.sha256,
      },
    });
    return detail(created);
  });
}

export async function getAccountingExport(
  deps: AccountingDeps,
  exportId: string,
  query: { format: 'json' | 'csv' },
) {
  const e = await deps.tenantDb.accountingExport.findFirst({
    where: { id: exportId },
    include: EXPORT_INCLUDE,
  });
  if (!e) throw new AppError('NOT_FOUND', 'Export not found');
  if (query.format === 'csv') {
    return exportFile(
      `journal-${dateOnly(e.fromDate)}-to-${dateOnly(e.toDate)}-${e.number}.csv`,
      'text/csv',
      new TextEncoder().encode(String.fromCharCode(0xfeff) + e.content),
    );
  }
  return detail(e);
}
