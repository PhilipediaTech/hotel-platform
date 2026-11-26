import {
  addDays,
  type BalanceRow,
  type CompanyRow,
  type GuestRow,
  type ImportError,
} from '@hotel/shared';
import type { Prisma } from '../../generated/prisma/client.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';

// Migration imports (PRD M1-03 "guests, companies and opening balances"; Versions V2 "stronger
// migration"; T-168). Guests and companies belong to the organisation, as when the desk adds
// them; opening balances are this property's city ledger: one open invoice per line, numbered
// OB-<the old system's reference>, so a file applied twice is refused rather than counted twice.

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = Tx | TenantDb;

export interface Checked {
  errors: ImportError[];
  summary: Record<string, number>;
}

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);
const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');
export const openingNumber = (reference: string) => `OB-${reference}`;

/** Rows whose email or phone repeats an earlier row are refused: one guest, one row. */
function fileDuplicates(rows: GuestRow[], errors: ImportError[]): Set<number> {
  const firstBy = new Map<string, number>();
  const bad = new Set<number>();
  for (const r of rows) {
    for (const [column, value] of [
      ['email', r.email],
      ['phone', r.phone],
    ] as const) {
      if (!value) continue;
      const first = firstBy.get(`${column}:${value}`);
      if (first !== undefined) {
        errors.push({ row: r.row, column, message: `The same ${column} as row ${first}` });
        bad.add(r.row);
      } else firstBy.set(`${column}:${value}`, r.row);
    }
  }
  return bad;
}

/** Guests already in the organisation with one of these emails or phones. */
async function existingGuests(db: Client, rows: GuestRow[]) {
  const emails = rows.flatMap((r) => (r.email ? [r.email] : []));
  const phones = rows.flatMap((r) => (r.phone ? [r.phone] : []));
  if (emails.length === 0 && phones.length === 0) return { emails: new Set(), phones: new Set() };
  const found = await db.guest.findMany({
    where: {
      mergedIntoId: null,
      OR: [{ email: { in: emails } }, { phone: { in: phones } }],
    },
    select: { email: true, phone: true },
  });
  return {
    emails: new Set(found.flatMap((g) => (g.email ? [g.email.toLowerCase()] : []))),
    phones: new Set(found.flatMap((g) => (g.phone ? [g.phone] : []))),
  };
}

const isExisting = (
  r: GuestRow,
  existing: { emails: Set<unknown>; phones: Set<unknown> },
): boolean =>
  (r.email !== null && existing.emails.has(r.email)) ||
  (r.phone !== null && existing.phones.has(r.phone));

export async function checkGuests(
  db: Client,
  rows: GuestRow[],
  tenant: TenantContext,
): Promise<Checked> {
  const errors: ImportError[] = [];
  const bad = fileDuplicates(rows, errors);
  // M3-18: only those who may flag guests may mark VIPs.
  if (!tenant.permissions.has('guest.flag')) {
    for (const r of rows.filter((x) => x.vip)) {
      errors.push({ row: r.row, column: 'vip', message: 'Your role can’t mark guests as VIP' });
    }
  }
  const existing = await existingGuests(db, rows);
  let guestsNew = 0;
  let guestsExisting = 0;
  for (const r of rows) {
    if (bad.has(r.row)) continue;
    if (isExisting(r, existing)) guestsExisting++;
    else guestsNew++;
  }
  return { errors, summary: { guestsNew, guestsExisting } };
}

/** New guests only: one already here (same email or phone) is left as it is. */
export async function applyGuests(tx: Tx, rows: GuestRow[], now: Date) {
  const existing = await existingGuests(tx, rows);
  const fresh = rows.filter((r) => !isExisting(r, existing));
  await tx.guest.createMany({
    data: fresh.map((r) => ({
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      phone: r.phone,
      nationality: r.nationality,
      preferences: { notes: r.notes, tags: r.tags },
      vip: r.vip,
      // A flag always carries its reason (M3-18).
      flagReason: r.vip ? 'VIP in the old system (import)' : null,
      // Consent carried over from the old system, recorded as of the import (NDPA: kept).
      marketingConsent: r.marketingConsent,
      consentAt: r.marketingConsent ? now : null,
    })) as unknown as Prisma.GuestCreateManyInput[],
  });
  return { guestsWritten: fresh.length };
}

export async function checkCompanies(db: Client, rows: CompanyRow[]): Promise<Checked> {
  const errors: ImportError[] = [];
  const existing = new Set(
    (await db.company.findMany({ select: { name: true } })).map((c) => nameKey(c.name)),
  );
  const seen = new Map<string, number>();
  let companiesNew = 0;
  for (const r of rows) {
    const key = nameKey(r.name);
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({ row: r.row, column: 'name', message: `The same company as row ${first}` });
      continue;
    }
    seen.set(key, r.row);
    if (existing.has(key)) {
      errors.push({ row: r.row, column: 'name', message: `${r.name} is already a company here` });
      continue;
    }
    companiesNew++;
  }
  return { errors, summary: { companiesNew } };
}

export async function applyCompanies(tx: Tx, rows: CompanyRow[]) {
  await tx.company.createMany({
    data: rows.map((r) => ({
      kind: r.kind,
      name: r.name,
      taxId: r.taxId,
      contacts: r.contactName
        ? [{ name: r.contactName, role: null, phone: r.contactPhone, email: r.contactEmail }]
        : [],
      creditLimitMinor: r.creditLimitMinor === null ? null : BigInt(r.creditLimitMinor),
      paymentTermsDays: r.paymentTermsDays,
      commissionBps: r.commissionBps,
      billingInstructions: { invoiceEmail: r.invoiceEmail, notes: null },
    })) as unknown as Prisma.CompanyCreateManyInput[],
  });
  return { companiesWritten: rows.length };
}

/** Companies by name (any case), active and not an event client: they can hold an account. */
async function accountHolders(db: Client) {
  const companies = await db.company.findMany({ where: { active: true } });
  return new Map(
    companies.filter((c) => c.kind !== 'EVENT_CLIENT').map((c) => [nameKey(c.name), c]),
  );
}

export async function checkBalances(
  db: Client,
  rows: BalanceRow[],
  tenant: TenantContext,
  today: string,
): Promise<Checked> {
  const errors: ImportError[] = [];
  // The city ledger's own permission, beside the import's.
  if (!tenant.permissions.has('ar.manage')) {
    throw new AppError('FORBIDDEN', 'Opening balances need the city ledger permission.', {
      permission: 'ar.manage',
    });
  }
  const holders = await accountHolders(db);
  const taken = new Set(
    (
      await db.arInvoice.findMany({
        where: { number: { in: rows.map((r) => openingNumber(r.reference)) } },
        select: { number: true },
      })
    ).map((i) => i.number),
  );
  const accounts = new Set(
    (await db.arAccount.findMany({ select: { companyId: true } })).map((a) => a.companyId),
  );
  const seen = new Map<string, number>();
  const companies = new Set<string>();
  const newAccounts = new Set<string>();
  let invoicesNew = 0;
  for (const r of rows) {
    const fail = (column: string, message: string) => errors.push({ row: r.row, column, message });
    const company = holders.get(nameKey(r.companyName));
    if (!company) {
      fail('company_name', `No company or travel agent called ${r.companyName}`);
      continue;
    }
    const first = seen.get(r.reference);
    if (first !== undefined) {
      fail('reference', `The same reference as row ${first}`);
      continue;
    }
    seen.set(r.reference, r.row);
    if (taken.has(openingNumber(r.reference))) {
      fail('reference', `${r.reference} was imported before`);
      continue;
    }
    if (r.issuedOn !== null && r.issuedOn > today) {
      fail('issued_on', 'An opening balance is from before today');
      continue;
    }
    if (r.dueOn !== null && r.dueOn < (r.issuedOn ?? today)) {
      fail('due_on', 'Due on or after the issue date (today when it is left empty)');
      continue;
    }
    companies.add(company.id);
    if (!accounts.has(company.id)) newAccounts.add(company.id);
    invoicesNew++;
  }
  return {
    errors,
    summary: { invoicesNew, companiesWithBalances: companies.size, accountsNew: newAccounts.size },
  };
}

/**
 * Opens a city-ledger account where a company has none (its group credit limit, else 0 so
 * new charges need approval; its payment terms, else 30 days) and adds each open invoice.
 */
export async function applyBalances(tx: Tx, rows: BalanceRow[], today: string, now: Date) {
  const holders = await accountHolders(tx);
  const accounts = new Map((await tx.arAccount.findMany()).map((a) => [a.companyId, a] as const));
  let accountsOpened = 0;
  for (const r of rows) {
    const company = holders.get(nameKey(r.companyName));
    if (!company) continue;
    let account = accounts.get(company.id);
    if (!account) {
      account = await tx.arAccount.create({
        data: {
          companyId: company.id,
          creditLimitMinor: company.creditLimitMinor ?? 0n,
          termsDays: company.paymentTermsDays ?? 30,
          createdAt: now,
        } as unknown as Prisma.ArAccountUncheckedCreateInput,
      });
      accounts.set(company.id, account);
      accountsOpened++;
    }
    const issued = r.issuedOn ?? today;
    await tx.arInvoice.create({
      data: {
        arAccountId: account.id,
        number: openingNumber(r.reference),
        folioId: null,
        paymentId: null,
        amountMinor: BigInt(r.amountMinor),
        issuedOn: dbDate(issued),
        dueOn: dbDate(r.dueOn ?? addDays(issued, account.termsDays)),
        createdAt: now,
      } as unknown as Prisma.ArInvoiceUncheckedCreateInput,
    });
  }
  return { invoicesWritten: rows.length, accountsOpened };
}
